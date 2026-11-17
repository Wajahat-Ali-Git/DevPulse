import { Injectable } from '@nestjs/common';
import { Logger } from '@devpulse/logger';
import { GitHubClient, GitHubRepository, GitHubCommit, GitHubPullRequest } from '@devpulse/github';
import {
  SyncUserRepositoriesPayload,
  SyncSingleRepositoryPayload,
  SyncRepositoryCommitsPayload,
  SyncRepositoryPullRequestsPayload,
  RepositorySyncJobPayload,
} from '@devpulse/types';

export interface GitHubSyncProcessorOptions {
  token?: string;
  baseUrl?: string;
  userAgent?: string;
  timeoutMs?: number;
  maxRetries?: number;
}

export interface SyncRepositoriesProgress {
  page: number;
  perPage: number;
  totalProcessed: number;
  hasMore: boolean;
  percentage?: number;
}

export interface SyncRepositoriesResult {
  repositories: GitHubRepository[];
  totalCount: number;
  syncId?: string;
  userId?: string;
  githubAccountId?: string;
  scope?: string;
  pagesProcessed?: number;
  progressHistory?: SyncRepositoriesProgress[];
}

export interface SyncCommitsProgress {
  page: number;
  perPage: number;
  totalProcessed: number;
  hasMore: boolean;
  percentage?: number;
}

export interface SyncCommitsResult {
  repositoryId?: string;
  fullName: string;
  commits: GitHubCommit[];
  totalCount: number;
  pagesProcessed?: number;
  progressHistory?: SyncCommitsProgress[];
  since?: string;
  until?: string;
}

export interface SyncPullRequestsResult {
  repositoryId?: string;
  fullName: string;
  pullRequests: GitHubPullRequest[];
  totalCount: number;
}

export interface RepositorySyncProcessorResult {
  success: boolean;
  jobName: string;
  processedAt: string;
  details?: Record<string, any>;
  data?: SyncRepositoriesResult | SyncCommitsResult | SyncPullRequestsResult | GitHubRepository;
}

/**
 * Worker processor that interfaces with the `@devpulse/github` integration package
 * to execute repository, commit, and pull-request synchronizations.
 */
@Injectable()
export class GitHubSyncProcessor {
  private readonly logger = new Logger({ service: 'worker', context: GitHubSyncProcessor.name });

  /**
   * Instantiates a GitHubClient instance for the synchronization task.
   */
  createGitHubClient(options: GitHubSyncProcessorOptions = {}): GitHubClient {
    return new GitHubClient({
      token: options.token,
      baseUrl: options.baseUrl,
      userAgent: options.userAgent || 'DevPulse-Worker-GitHubSync/1.0',
      timeoutMs: options.timeoutMs ?? 15000,
      maxRetries: options.maxRetries ?? 2,
      retryOnRateLimit: true,
    });
  }

  /**
   * Synchronizes repositories for an authenticated user using GitHubRepositoriesApi
   * with full pagination support and progress reporting.
   */
  async syncUserRepositories(
    payload: SyncUserRepositoriesPayload | RepositorySyncJobPayload,
    clientOptions: GitHubSyncProcessorOptions = {},
    customClient?: GitHubClient,
    onProgress?: (progress: SyncRepositoriesProgress) => Promise<void> | void,
  ): Promise<SyncRepositoriesResult> {
    const client = customClient || this.createGitHubClient(clientOptions);
    const perPage = 100;
    const allRepos: GitHubRepository[] = [];
    const progressHistory: SyncRepositoriesProgress[] = [];

    this.logger.info(
      `Invoking GitHub API to fetch repositories with pagination for user "${payload.userId}" (scope: ${payload.scope || 'all'})`,
      {
        userId: payload.userId,
        githubAccountId: (payload as any).githubAccountId,
        syncId: (payload as any).syncId,
        scope: payload.scope,
      },
    );

    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const pageRepos = await client.repositories.listForAuthenticatedUser({
        visibility: 'all',
        sort: 'updated',
        direction: 'desc',
        per_page: perPage,
        page,
      });

      const count = pageRepos ? pageRepos.length : 0;
      if (count > 0) {
        allRepos.push(...pageRepos);
      }

      hasMore = count === perPage;

      const progressUpdate: SyncRepositoriesProgress = {
        page,
        perPage,
        totalProcessed: allRepos.length,
        hasMore,
        percentage: hasMore ? Math.min(page * 25, 95) : 100,
      };
      progressHistory.push(progressUpdate);

      if (onProgress) {
        try {
          await onProgress(progressUpdate);
        } catch (err: any) {
          this.logger.warn(`Failed to report sync progress update for page ${page}: ${err?.message}`);
        }
      }

      this.logger.info(
        `Retrieved page ${page} of repositories (${count} items, total so far: ${allRepos.length}) for user "${payload.userId}"`,
        {
          userId: payload.userId,
          page,
          pageCount: count,
          totalCount: allRepos.length,
          hasMore,
        },
      );

      page++;
    }

    this.logger.info(
      `Completed repository synchronization across ${page - 1} page(s), total: ${allRepos.length} repositories for user "${payload.userId}"`,
      {
        userId: payload.userId,
        pagesProcessed: page - 1,
        totalCount: allRepos.length,
      },
    );

    return {
      repositories: allRepos,
      totalCount: allRepos.length,
      syncId: (payload as any).syncId,
      userId: payload.userId,
      githubAccountId: (payload as any).githubAccountId,
      scope: payload.scope || 'all',
      pagesProcessed: page - 1,
      progressHistory,
    };
  }

  /**
   * Synchronizes a single repository by owner and name using GitHubRepositoriesApi.
   */
  async syncSingleRepository(
    payload: SyncSingleRepositoryPayload,
    clientOptions: GitHubSyncProcessorOptions = {},
    customClient?: GitHubClient,
  ): Promise<GitHubRepository> {
    const client = customClient || this.createGitHubClient(clientOptions);
    const [owner, name] = payload.fullName.split('/');

    if (!owner || !name) {
      throw new Error(`Invalid repository full name format: "${payload.fullName}". Expected "owner/repo".`);
    }

    this.logger.info(`Invoking GitHub API to get repository "${payload.fullName}"`, {
      repositoryId: payload.repositoryId,
      fullName: payload.fullName,
    });

    const repository = await client.repositories.get(owner, name);

    this.logger.info(`Successfully retrieved repository "${payload.fullName}" (GitHub ID: ${repository.id})`, {
      repositoryId: payload.repositoryId,
      githubRepoId: repository.id,
    });

    return repository;
  }

  /**
   * Synchronizes commits for a repository using GitHubCommitsApi with pagination support
   * and progress tracking. Supports incremental retrieval using the since parameter.
   */
  async syncRepositoryCommits(
    payload: SyncRepositoryCommitsPayload,
    clientOptions: GitHubSyncProcessorOptions = {},
    customClient?: GitHubClient,
    onProgress?: (progress: SyncCommitsProgress) => Promise<void> | void,
  ): Promise<SyncCommitsResult> {
    const client = customClient || this.createGitHubClient(clientOptions);
    const [owner, name] = payload.fullName.split('/');

    if (!owner || !name) {
      throw new Error(`Invalid repository full name format: "${payload.fullName}". Expected "owner/repo".`);
    }

    this.logger.info(`Invoking GitHub API to list commits for "${payload.fullName}" with pagination`, {
      repositoryId: payload.repositoryId,
      fullName: payload.fullName,
      since: payload.since,
      until: payload.until,
    });

    const perPage = payload.perPage || 100;
    const allCommits: GitHubCommit[] = [];
    const progressHistory: SyncCommitsProgress[] = [];

    // If a specific page is requested, fetch only that single page
    if (payload.page) {
      const commits = await client.commits.list(owner, name, {
        since: payload.since,
        until: payload.until,
        page: payload.page,
        per_page: perPage,
      });

      const count = commits ? commits.length : 0;
      allCommits.push(...commits);
      const progressUpdate: SyncCommitsProgress = {
        page: payload.page,
        perPage,
        totalProcessed: count,
        hasMore: count === perPage,
        percentage: 100,
      };
      progressHistory.push(progressUpdate);

      if (onProgress) {
        try {
          await onProgress(progressUpdate);
        } catch (err: any) {
          this.logger.warn(`Failed to report commit sync progress for page ${payload.page}: ${err?.message}`);
        }
      }

      return {
        repositoryId: payload.repositoryId,
        fullName: payload.fullName,
        commits: allCommits,
        totalCount: allCommits.length,
        pagesProcessed: 1,
        progressHistory,
        since: payload.since,
        until: payload.until,
      };
    }

    // Otherwise, paginated retrieval across all available pages
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const pageCommits = await client.commits.list(owner, name, {
        since: payload.since,
        until: payload.until,
        page,
        per_page: perPage,
      });

      const count = pageCommits ? pageCommits.length : 0;
      if (count > 0) {
        allCommits.push(...pageCommits);
      }

      hasMore = count === perPage;

      const progressUpdate: SyncCommitsProgress = {
        page,
        perPage,
        totalProcessed: allCommits.length,
        hasMore,
        percentage: hasMore ? Math.min(page * 20, 95) : 100,
      };
      progressHistory.push(progressUpdate);

      if (onProgress) {
        try {
          await onProgress(progressUpdate);
        } catch (err: any) {
          this.logger.warn(`Failed to report commit sync progress for page ${page}: ${err?.message}`);
        }
      }

      this.logger.info(
        `Retrieved page ${page} of commits (${count} items, total so far: ${allCommits.length}) for "${payload.fullName}"`,
        {
          repositoryId: payload.repositoryId,
          fullName: payload.fullName,
          page,
          pageCount: count,
          totalCount: allCommits.length,
          hasMore,
        },
      );

      page++;
    }

    this.logger.info(
      `Completed commit synchronization across ${page - 1} page(s), total: ${allCommits.length} commits for "${payload.fullName}"`,
      {
        repositoryId: payload.repositoryId,
        fullName: payload.fullName,
        pagesProcessed: page - 1,
        totalCount: allCommits.length,
        since: payload.since,
      },
    );

    return {
      repositoryId: payload.repositoryId,
      fullName: payload.fullName,
      commits: allCommits,
      totalCount: allCommits.length,
      pagesProcessed: page - 1,
      progressHistory,
      since: payload.since,
      until: payload.until,
    };
  }

  /**
   * Synchronizes pull requests for a repository using GitHubPullRequestsApi.
   */
  async syncRepositoryPullRequests(
    payload: SyncRepositoryPullRequestsPayload,
    clientOptions: GitHubSyncProcessorOptions = {},
    customClient?: GitHubClient,
  ): Promise<SyncPullRequestsResult> {
    const client = customClient || this.createGitHubClient(clientOptions);
    const [owner, name] = payload.fullName.split('/');

    if (!owner || !name) {
      throw new Error(`Invalid repository full name format: "${payload.fullName}". Expected "owner/repo".`);
    }

    this.logger.info(`Invoking GitHub API to list pull requests for "${payload.fullName}" (state: ${payload.state || 'all'})`, {
      repositoryId: payload.repositoryId,
      fullName: payload.fullName,
      state: payload.state,
    });

    const pullRequests = await client.pullRequests.list(owner, name, {
      state: (payload.state as any) || 'all',
      sort: 'updated',
      direction: 'desc',
      per_page: 100,
    });

    this.logger.info(`Successfully fetched ${pullRequests.length} pull requests for "${payload.fullName}"`, {
      repositoryId: payload.repositoryId,
      count: pullRequests.length,
    });

    return {
      repositoryId: payload.repositoryId,
      fullName: payload.fullName,
      pullRequests,
      totalCount: pullRequests.length,
    };
  }
}

