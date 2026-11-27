import { Injectable } from '@nestjs/common';
import { Prisma } from '@devpulse/database';
import { Logger } from '@devpulse/logger';
import { DatabaseService } from '../database.service';

export type Granularity = 'day' | 'week';

export interface CommitCountByDate {
  date: string;
  count: number;
}

export interface ContributorSummary {
  resolvedCount: number;
  unresolvedCount: number;
  totalCount: number;
  contributors: Array<{
    authorUserId: string | null;
    authorEmail: string;
    authorName: string;
    commitCount: number;
    isResolved: boolean;
  }>;
}

export interface RepositoryDistributionEntry {
  repositoryId: string;
  fullName: string;
  commitCount: number;
}

export interface CommitTrendEntry {
  periodStart: string;
  count: number;
}

// Raw query result rows -------------------------------------------------------

interface RawCountRow {
  count: bigint;
}

interface RawDateCountRow {
  period: Date;
  count: bigint;
}

interface RawContributorRow {
  author_user_id: string | null;
  author_email: string;
  author_name: string;
  commit_count: bigint;
}

interface RawDistributionRow {
  repository_id: string;
  full_name: string;
  commit_count: bigint;
}

@Injectable()
export class CommitMetricsService {
  private readonly logger = new Logger({ service: 'api', context: 'CommitMetricsService' });

  constructor(private readonly database: DatabaseService) {}

  // ---------------------------------------------------------------------------
  // Total commits
  // ---------------------------------------------------------------------------

  async getTotalCommits(options: {
    repositoryId?: string;
    from?: Date;
    to?: Date;
  }): Promise<number> {
    const { repositoryId, from, to } = options;

    const where: Prisma.CommitWhereInput = {};
    if (repositoryId) where.repositoryId = repositoryId;
    if (from || to) {
      where.authorDate = {};
      if (from) where.authorDate.gte = from;
      if (to) where.authorDate.lte = to;
    }

    const count = await this.database.client.commit.count({ where });
    this.logger.info('getTotalCommits', { repositoryId, from, to, count });
    return count;
  }

  // ---------------------------------------------------------------------------
  // Daily commit counts
  // ---------------------------------------------------------------------------

  async getDailyCommitCounts(options: {
    repositoryId?: string;
    from: Date;
    to: Date;
  }): Promise<CommitCountByDate[]> {
    const { repositoryId, from, to } = options;

    const rows = await this.database.client.$queryRaw<RawDateCountRow[]>`
      SELECT
        DATE_TRUNC('day', author_date) AS period,
        COUNT(*)::bigint                AS count
      FROM commits
      WHERE author_date BETWEEN ${from} AND ${to}
        ${repositoryId ? Prisma.sql`AND repository_id = ${repositoryId}` : Prisma.empty}
      GROUP BY 1
      ORDER BY 1
    `;

    return rows.map((r) => ({
      date: r.period.toISOString().slice(0, 10),
      count: Number(r.count),
    }));
  }

  // ---------------------------------------------------------------------------
  // Weekly commit counts
  // ---------------------------------------------------------------------------

  async getWeeklyCommitCounts(options: {
    repositoryId?: string;
    from: Date;
    to: Date;
  }): Promise<CommitCountByDate[]> {
    const { repositoryId, from, to } = options;

    const rows = await this.database.client.$queryRaw<RawDateCountRow[]>`
      SELECT
        DATE_TRUNC('week', author_date) AS period,
        COUNT(*)::bigint                 AS count
      FROM commits
      WHERE author_date BETWEEN ${from} AND ${to}
        ${repositoryId ? Prisma.sql`AND repository_id = ${repositoryId}` : Prisma.empty}
      GROUP BY 1
      ORDER BY 1
    `;

    return rows.map((r) => ({
      date: r.period.toISOString().slice(0, 10),
      count: Number(r.count),
    }));
  }

  // ---------------------------------------------------------------------------
  // Unique contributors
  // ---------------------------------------------------------------------------

  async getUniqueContributors(options: {
    repositoryId?: string;
    from?: Date;
    to?: Date;
  }): Promise<ContributorSummary> {
    const { repositoryId, from, to } = options;

    const rows = await this.database.client.$queryRaw<RawContributorRow[]>`
      SELECT
        author_user_id,
        author_email,
        MAX(author_name)   AS author_name,
        COUNT(*)::bigint   AS commit_count
      FROM commits
      WHERE 1 = 1
        ${repositoryId ? Prisma.sql`AND repository_id = ${repositoryId}` : Prisma.empty}
        ${from ? Prisma.sql`AND author_date >= ${from}` : Prisma.empty}
        ${to ? Prisma.sql`AND author_date <= ${to}` : Prisma.empty}
      GROUP BY author_user_id, author_email
      ORDER BY commit_count DESC
    `;

    const contributors = rows.map((r) => ({
      authorUserId: r.author_user_id ?? null,
      authorEmail: r.author_email,
      authorName: r.author_name,
      commitCount: Number(r.commit_count),
      isResolved: r.author_user_id !== null,
    }));

    const resolvedCount = contributors.filter((c) => c.isResolved).length;
    const unresolvedCount = contributors.length - resolvedCount;

    return { resolvedCount, unresolvedCount, totalCount: contributors.length, contributors };
  }

  // ---------------------------------------------------------------------------
  // Commit activity trend (daily or weekly)
  // ---------------------------------------------------------------------------

  async getCommitActivityTrend(options: {
    repositoryId?: string;
    from: Date;
    to: Date;
    granularity?: Granularity;
  }): Promise<CommitTrendEntry[]> {
    const { repositoryId, from, to, granularity = 'day' } = options;

    const truncUnit = granularity === 'week' ? Prisma.sql`'week'` : Prisma.sql`'day'`;

    const rows = await this.database.client.$queryRaw<RawDateCountRow[]>`
      SELECT
        DATE_TRUNC(${truncUnit}, author_date) AS period,
        COUNT(*)::bigint                       AS count
      FROM commits
      WHERE author_date BETWEEN ${from} AND ${to}
        ${repositoryId ? Prisma.sql`AND repository_id = ${repositoryId}` : Prisma.empty}
      GROUP BY 1
      ORDER BY 1
    `;

    return rows.map((r) => ({
      periodStart: r.period.toISOString().slice(0, 10),
      count: Number(r.count),
    }));
  }

  // ---------------------------------------------------------------------------
  // Repository contribution distribution
  // ---------------------------------------------------------------------------

  async getRepositoryContributionDistribution(options: {
    workspaceId?: string;
    from?: Date;
    to?: Date;
  }): Promise<RepositoryDistributionEntry[]> {
    const { workspaceId, from, to } = options;

    const rows = await this.database.client.$queryRaw<RawDistributionRow[]>`
      SELECT
        c.repository_id,
        r.full_name,
        COUNT(c.id)::bigint AS commit_count
      FROM commits c
      INNER JOIN repositories r ON r.id = c.repository_id
      WHERE 1 = 1
        ${workspaceId ? Prisma.sql`AND r.workspace_id = ${workspaceId}` : Prisma.empty}
        ${from ? Prisma.sql`AND c.author_date >= ${from}` : Prisma.empty}
        ${to ? Prisma.sql`AND c.author_date <= ${to}` : Prisma.empty}
      GROUP BY c.repository_id, r.full_name
      ORDER BY commit_count DESC
    `;

    return rows.map((r) => ({
      repositoryId: r.repository_id,
      fullName: r.full_name,
      commitCount: Number(r.commit_count),
    }));
  }

  // ---------------------------------------------------------------------------
  // Commits over period (count + list)
  // ---------------------------------------------------------------------------

  async getCommitsOverPeriod(options: {
    repositoryId?: string;
    from: Date;
    to: Date;
  }): Promise<{ count: number }> {
    const { repositoryId, from, to } = options;

    const rows = await this.database.client.$queryRaw<RawCountRow[]>`
      SELECT COUNT(*)::bigint AS count
      FROM commits
      WHERE author_date BETWEEN ${from} AND ${to}
        ${repositoryId ? Prisma.sql`AND repository_id = ${repositoryId}` : Prisma.empty}
    `;

    const count = Number(rows[0]?.count ?? 0);
    this.logger.info('getCommitsOverPeriod', { repositoryId, from, to, count });
    return { count };
  }
}
