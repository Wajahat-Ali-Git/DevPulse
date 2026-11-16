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

export interface SyncRepositoriesResult {
  repositories: GitHubRepository[];
  totalCount: number;
  syncId?: string;
  userId?: string;
  githubAccountId?: string;
  scope?: string;
}

export interface SyncCommitsResult {
  repositoryId?: string;
  fullName: string;
  commits: GitHubCommit[];
  totalCount: number;
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
   * Synchronizes repositories for an authenticated user using GitHubRepositoriesApi.
   */
  async syncUserRepositories(
    payload: SyncUserRepositoriesPayload | RepositorySyncJobPayload,
    clientOptions: GitHubSyncProcessorOptions = {},
    customClient?: GitHubClient,
  ): Promise<SyncRepositoriesResult> {
    const client = customClient || this.createGitHubClient(clientOptions);

    this.logger.info(
      `Invoking GitHub API to fetch repositories for user "${payload.userId}" (scope: ${payload.scope || 'all'})`,
      {
        userId: payload.userId,
        githubAccountId: (payload as any).githubAccountId,
        syncId: (payload as any).syncId,
        scope: payload.scope,
      },
    );

    const repos = await client.repositories.listForAuthenticatedUser({
      visibility: 'all',
      sort: 'updated',
      direction: 'desc',
      per_page: 100,
    });

    this.logger.info(
      `Successfully retrieved ${repos.length} repositories from GitHub for user "${payload.userId}"`,
      {
        userId: payload.userId,
        count: repos.length,
      },
    );

    return {
      repositories: repos,
      totalCount: repos.length,
      syncId: (payload as any).syncId,
      userId: payload.userId,
      githubAccountId: (payload as any).githubAccountId,
      scope: payload.scope || 'all',
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
   * Synchronizes commits for a repository using GitHubCommitsApi.
   */
  async syncRepositoryCommits(
    payload: SyncRepositoryCommitsPayload,
    clientOptions: GitHubSyncProcessorOptions = {},
    customClient?: GitHubClient,
  ): Promise<SyncCommitsResult> {
    const client = customClient || this.createGitHubClient(clientOptions);
    const [owner, name] = payload.fullName.split('/');

    if (!owner || !name) {
      throw new Error(`Invalid repository full name format: "${payload.fullName}". Expected "owner/repo".`);
    }

    this.logger.info(`Invoking GitHub API to list commits for "${payload.fullName}"`, {
      repositoryId: payload.repositoryId,
      fullName: payload.fullName,
      since: payload.since,
      until: payload.until,
    });

    const commits = await client.commits.list(owner, name, {
      since: payload.since,
      until: payload.until,
      page: payload.page,
      per_page: 100,
    });

    this.logger.info(`Successfully fetched ${commits.length} commits for "${payload.fullName}"`, {
      repositoryId: payload.repositoryId,
      count: commits.length,
    });

    return {
      repositoryId: payload.repositoryId,
      fullName: payload.fullName,
      commits,
      totalCount: commits.length,
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

