import { Controller, Get, Query } from '@nestjs/common';
import { PrMetricsService, Granularity } from './pr-metrics.service';

@Controller('metrics/pull-requests')
export class PrMetricsController {
  constructor(private readonly prMetrics: PrMetricsService) {}

  /**
   * GET /metrics/pull-requests/summary
   * Returns total, open, closed, merged counts and merge rate.
   * Query params: repositoryId?, workspaceId?, from?, to?
   */
  @Get('summary')
  async getSummary(
    @Query('repositoryId') repositoryId?: string,
    @Query('workspaceId') workspaceId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.prMetrics.getCountSummary({
      repositoryId,
      workspaceId,
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
    });
  }

  /**
   * GET /metrics/pull-requests/durations
   * Returns average time to merge and average time to close (in seconds).
   * Query params: repositoryId?, workspaceId?, from?, to?
   */
  @Get('durations')
  async getDurations(
    @Query('repositoryId') repositoryId?: string,
    @Query('workspaceId') workspaceId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.prMetrics.getDurationMetrics({
      repositoryId,
      workspaceId,
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
    });
  }

  /**
   * GET /metrics/pull-requests/created-over-time
   * Returns PR creation counts bucketed by day or week.
   * Query params: repositoryId?, workspaceId?, from (required), to (required), granularity? (day|week)
   */
  @Get('created-over-time')
  async getCreatedOverTime(
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('repositoryId') repositoryId?: string,
    @Query('workspaceId') workspaceId?: string,
    @Query('granularity') granularity?: Granularity,
  ) {
    const data = await this.prMetrics.getPrsCreatedOverTime({
      repositoryId,
      workspaceId,
      from: new Date(from),
      to: new Date(to),
      granularity,
    });
    return { data };
  }

  /**
   * GET /metrics/pull-requests/merged-over-time
   * Returns PR merge counts bucketed by day or week (by mergedAt date).
   * Query params: repositoryId?, workspaceId?, from (required), to (required), granularity? (day|week)
   */
  @Get('merged-over-time')
  async getMergedOverTime(
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('repositoryId') repositoryId?: string,
    @Query('workspaceId') workspaceId?: string,
    @Query('granularity') granularity?: Granularity,
  ) {
    const data = await this.prMetrics.getPrsMergedOverTime({
      repositoryId,
      workspaceId,
      from: new Date(from),
      to: new Date(to),
      granularity,
    });
    return { data };
  }
}
