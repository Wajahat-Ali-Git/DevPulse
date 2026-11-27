import { Injectable } from '@nestjs/common';
import { Prisma } from '@devpulse/database';
import { Logger } from '@devpulse/logger';
import { DatabaseService } from '../database.service';

export type Granularity = 'day' | 'week';

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export interface PrCountSummary {
  total: number;
  open: number;
  closed: number;
  merged: number;
  /** merged / (closed + merged) × 100  — null when denominator is 0 */
  mergeRatePercent: number | null;
}

export interface PrDurationMetrics {
  /** Average seconds from githubCreatedAt → mergedAt (merged PRs only, both timestamps required) */
  avgSecondsToMerge: number | null;
  /** Average seconds from githubCreatedAt → closedAt (closed+merged PRs, both timestamps required) */
  avgSecondsToClose: number | null;
}

export interface PrCountByDate {
  date: string;
  count: number;
}

// ---------------------------------------------------------------------------
// Raw query row types
// ---------------------------------------------------------------------------

interface RawStateCountRow {
  state: string;
  count: bigint;
}

interface RawDurationRow {
  avg_seconds: string | null; // Postgres returns numeric as string
}

interface RawDateCountRow {
  period: Date;
  count: bigint;
}

@Injectable()
export class PrMetricsService {
  private readonly logger = new Logger({ service: 'api', context: 'PrMetricsService' });

  constructor(private readonly database: DatabaseService) {}

  // ---------------------------------------------------------------------------
  // Count summary
  // ---------------------------------------------------------------------------

  async getCountSummary(options: {
    repositoryId?: string;
    workspaceId?: string;
    from?: Date;
    to?: Date;
  }): Promise<PrCountSummary> {
    const { repositoryId, workspaceId, from, to } = options;

    // Build the WHERE clause fragments
    const repoFilter = repositoryId
      ? Prisma.sql`AND pr.repository_id = ${repositoryId}`
      : Prisma.empty;

    const wsFilter = workspaceId
      ? Prisma.sql`AND r.workspace_id = ${workspaceId}`
      : Prisma.empty;

    const fromFilter = from
      ? Prisma.sql`AND pr.github_created_at >= ${from}`
      : Prisma.empty;

    const toFilter = to
      ? Prisma.sql`AND pr.github_created_at <= ${to}`
      : Prisma.empty;

    // Need repo join only when filtering by workspaceId
    const repoJoin = workspaceId
      ? Prisma.sql`INNER JOIN repositories r ON r.id = pr.repository_id`
      : Prisma.sql`LEFT JOIN repositories r ON r.id = pr.repository_id`;

    const rows = await this.database.client.$queryRaw<RawStateCountRow[]>`
      SELECT
        pr.state::text AS state,
        COUNT(*)::bigint AS count
      FROM pull_requests pr
      ${repoJoin}
      WHERE 1 = 1
        ${repoFilter}
        ${wsFilter}
        ${fromFilter}
        ${toFilter}
      GROUP BY pr.state
    `;

    const countByState: Record<string, number> = {};
    for (const row of rows) {
      countByState[row.state] = Number(row.count);
    }

    const open = countByState['OPEN'] ?? 0;
    const closed = countByState['CLOSED'] ?? 0;
    const merged = countByState['MERGED'] ?? 0;
    const total = open + closed + merged;
    const eligibleClosed = closed + merged;
    const mergeRatePercent = eligibleClosed > 0
      ? Math.round((merged / eligibleClosed) * 10000) / 100
      : null;

    this.logger.info('getCountSummary', { repositoryId, workspaceId, total, open, closed, merged });

    return { total, open, closed, merged, mergeRatePercent };
  }

  // ---------------------------------------------------------------------------
  // Duration metrics (time to merge, time to close)
  // ---------------------------------------------------------------------------

  async getDurationMetrics(options: {
    repositoryId?: string;
    workspaceId?: string;
    from?: Date;
    to?: Date;
  }): Promise<PrDurationMetrics> {
    const { repositoryId, workspaceId, from, to } = options;

    const repoFilter = repositoryId
      ? Prisma.sql`AND pr.repository_id = ${repositoryId}`
      : Prisma.empty;

    const wsFilter = workspaceId
      ? Prisma.sql`AND r.workspace_id = ${workspaceId}`
      : Prisma.empty;

    const fromFilter = from
      ? Prisma.sql`AND pr.github_created_at >= ${from}`
      : Prisma.empty;

    const toFilter = to
      ? Prisma.sql`AND pr.github_created_at <= ${to}`
      : Prisma.empty;

    const repoJoin = workspaceId
      ? Prisma.sql`INNER JOIN repositories r ON r.id = pr.repository_id`
      : Prisma.sql`LEFT JOIN repositories r ON r.id = pr.repository_id`;

    // Average time to merge — only MERGED PRs with both timestamps present
    const mergeRows = await this.database.client.$queryRaw<RawDurationRow[]>`
      SELECT
        AVG(EXTRACT(EPOCH FROM (pr.merged_at - pr.github_created_at)))::text AS avg_seconds
      FROM pull_requests pr
      ${repoJoin}
      WHERE pr.state = 'MERGED'
        AND pr.merged_at IS NOT NULL
        AND pr.github_created_at IS NOT NULL
        AND pr.merged_at > pr.github_created_at
        ${repoFilter}
        ${wsFilter}
        ${fromFilter}
        ${toFilter}
    `;

    // Average time to close — CLOSED and MERGED PRs with both timestamps present
    const closeRows = await this.database.client.$queryRaw<RawDurationRow[]>`
      SELECT
        AVG(EXTRACT(EPOCH FROM (pr.closed_at - pr.github_created_at)))::text AS avg_seconds
      FROM pull_requests pr
      ${repoJoin}
      WHERE pr.state IN ('CLOSED', 'MERGED')
        AND pr.closed_at IS NOT NULL
        AND pr.github_created_at IS NOT NULL
        AND pr.closed_at > pr.github_created_at
        ${repoFilter}
        ${wsFilter}
        ${fromFilter}
        ${toFilter}
    `;

    const avgSecondsToMerge = mergeRows[0]?.avg_seconds != null
      ? Math.round(Number(mergeRows[0].avg_seconds))
      : null;

    const avgSecondsToClose = closeRows[0]?.avg_seconds != null
      ? Math.round(Number(closeRows[0].avg_seconds))
      : null;

    this.logger.info('getDurationMetrics', { repositoryId, avgSecondsToMerge, avgSecondsToClose });

    return { avgSecondsToMerge, avgSecondsToClose };
  }

  // ---------------------------------------------------------------------------
  // PRs created over time (daily or weekly)
  // ---------------------------------------------------------------------------

  async getPrsCreatedOverTime(options: {
    repositoryId?: string;
    workspaceId?: string;
    from: Date;
    to: Date;
    granularity?: Granularity;
  }): Promise<PrCountByDate[]> {
    const { repositoryId, workspaceId, from, to, granularity = 'day' } = options;
    const truncUnit = granularity === 'week' ? Prisma.sql`'week'` : Prisma.sql`'day'`;

    const repoFilter = repositoryId
      ? Prisma.sql`AND pr.repository_id = ${repositoryId}`
      : Prisma.empty;

    const wsFilter = workspaceId
      ? Prisma.sql`AND r.workspace_id = ${workspaceId}`
      : Prisma.empty;

    const repoJoin = workspaceId
      ? Prisma.sql`INNER JOIN repositories r ON r.id = pr.repository_id`
      : Prisma.sql`LEFT JOIN repositories r ON r.id = pr.repository_id`;

    const rows = await this.database.client.$queryRaw<RawDateCountRow[]>`
      SELECT
        DATE_TRUNC(${truncUnit}, pr.github_created_at) AS period,
        COUNT(*)::bigint                                AS count
      FROM pull_requests pr
      ${repoJoin}
      WHERE pr.github_created_at BETWEEN ${from} AND ${to}
        ${repoFilter}
        ${wsFilter}
      GROUP BY 1
      ORDER BY 1
    `;

    return rows.map((r) => ({
      date: r.period.toISOString().slice(0, 10),
      count: Number(r.count),
    }));
  }

  // ---------------------------------------------------------------------------
  // PRs merged over time (daily or weekly)
  // ---------------------------------------------------------------------------

  async getPrsMergedOverTime(options: {
    repositoryId?: string;
    workspaceId?: string;
    from: Date;
    to: Date;
    granularity?: Granularity;
  }): Promise<PrCountByDate[]> {
    const { repositoryId, workspaceId, from, to, granularity = 'day' } = options;
    const truncUnit = granularity === 'week' ? Prisma.sql`'week'` : Prisma.sql`'day'`;

    const repoFilter = repositoryId
      ? Prisma.sql`AND pr.repository_id = ${repositoryId}`
      : Prisma.empty;

    const wsFilter = workspaceId
      ? Prisma.sql`AND r.workspace_id = ${workspaceId}`
      : Prisma.empty;

    const repoJoin = workspaceId
      ? Prisma.sql`INNER JOIN repositories r ON r.id = pr.repository_id`
      : Prisma.sql`LEFT JOIN repositories r ON r.id = pr.repository_id`;

    const rows = await this.database.client.$queryRaw<RawDateCountRow[]>`
      SELECT
        DATE_TRUNC(${truncUnit}, pr.merged_at) AS period,
        COUNT(*)::bigint                        AS count
      FROM pull_requests pr
      ${repoJoin}
      WHERE pr.state = 'MERGED'
        AND pr.merged_at IS NOT NULL
        AND pr.merged_at BETWEEN ${from} AND ${to}
        ${repoFilter}
        ${wsFilter}
      GROUP BY 1
      ORDER BY 1
    `;

    return rows.map((r) => ({
      date: r.period.toISOString().slice(0, 10),
      count: Number(r.count),
    }));
  }
}
