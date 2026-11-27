import { Controller, Get, Query } from '@nestjs/common';
import { CommitMetricsService, Granularity } from './commit-metrics.service';

@Controller('metrics/commits')
export class CommitMetricsController {
  constructor(private readonly commitMetrics: CommitMetricsService) {}

  /**
   * GET /metrics/commits/total
   * Query params: repositoryId?, from?, to?
   */
  @Get('total')
  async getTotal(
    @Query('repositoryId') repositoryId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const count = await this.commitMetrics.getTotalCommits({
      repositoryId,
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
    });
    return { count };
  }

  /**
   * GET /metrics/commits/period
   * Query params: repositoryId?, from (required), to (required)
   */
  @Get('period')
  async getPeriod(
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('repositoryId') repositoryId?: string,
  ) {
    return this.commitMetrics.getCommitsOverPeriod({
      repositoryId,
      from: new Date(from),
      to: new Date(to),
    });
  }

  /**
   * GET /metrics/commits/daily
   * Query params: repositoryId?, from (required), to (required)
   */
  @Get('daily')
  async getDaily(
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('repositoryId') repositoryId?: string,
  ) {
    const data = await this.commitMetrics.getDailyCommitCounts({
      repositoryId,
      from: new Date(from),
      to: new Date(to),
    });
    return { data };
  }

  /**
   * GET /metrics/commits/weekly
   * Query params: repositoryId?, from (required), to (required)
   */
  @Get('weekly')
  async getWeekly(
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('repositoryId') repositoryId?: string,
  ) {
    const data = await this.commitMetrics.getWeeklyCommitCounts({
      repositoryId,
      from: new Date(from),
      to: new Date(to),
    });
    return { data };
  }

  /**
   * GET /metrics/commits/contributors
   * Query params: repositoryId?, from?, to?
   */
  @Get('contributors')
  async getContributors(
    @Query('repositoryId') repositoryId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.commitMetrics.getUniqueContributors({
      repositoryId,
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
    });
  }

  /**
   * GET /metrics/commits/trend
   * Query params: repositoryId?, from (required), to (required), granularity? (day|week)
   */
  @Get('trend')
  async getTrend(
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('repositoryId') repositoryId?: string,
    @Query('granularity') granularity?: Granularity,
  ) {
    const data = await this.commitMetrics.getCommitActivityTrend({
      repositoryId,
      from: new Date(from),
      to: new Date(to),
      granularity,
    });
    return { data };
  }

  /**
   * GET /metrics/commits/distribution
   * Query params: workspaceId?, from?, to?
   */
  @Get('distribution')
  async getDistribution(
    @Query('workspaceId') workspaceId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const data = await this.commitMetrics.getRepositoryContributionDistribution({
      workspaceId,
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
    });
    return { data };
  }
}
