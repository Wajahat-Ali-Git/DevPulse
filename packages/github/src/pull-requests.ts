import {
  GitHubPullRequest,
  GitHubPullRequestState,
  GitHubCommit,
  GitHubPaginationParams,
} from './types';
import { GitHubClient } from './client';

export interface ListPullRequestsParams extends GitHubPaginationParams {
  state?: GitHubPullRequestState;
  head?: string;
  base?: string;
  sort?: 'created' | 'updated' | 'popularity' | 'long-running';
  direction?: 'asc' | 'desc';
}

export interface CreatePullRequestParams {
  title: string;
  head: string;
  base: string;
  body?: string;
  maintainer_can_modify?: boolean;
  draft?: boolean;
}

export interface UpdatePullRequestParams {
  title?: string;
  body?: string;
  state?: 'open' | 'closed';
  base?: string;
  maintainer_can_modify?: boolean;
}

export interface PullRequestFile {
  sha: string;
  filename: string;
  status: 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged';
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
}

export class GitHubPullRequestsApi {
  constructor(private readonly client: GitHubClient) {}

  /**
   * Lists pull requests for a repository.
   */
  async list(
    owner: string,
    repo: string,
    params?: ListPullRequestsParams
  ): Promise<GitHubPullRequest[]> {
    return this.client.get<GitHubPullRequest[]>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`,
      {
        params: params as Record<string, string | number | boolean | undefined>,
      }
    );
  }

  /**
   * Retrieves a single pull request by its PR number.
   */
  async get(
    owner: string,
    repo: string,
    pullNumber: number
  ): Promise<GitHubPullRequest> {
    return this.client.get<GitHubPullRequest>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pullNumber}`
    );
  }

  /**
   * Creates a new pull request.
   */
  async create(
    owner: string,
    repo: string,
    params: CreatePullRequestParams
  ): Promise<GitHubPullRequest> {
    return this.client.post<GitHubPullRequest>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`,
      params
    );
  }

  /**
   * Updates an existing pull request.
   */
  async update(
    owner: string,
    repo: string,
    pullNumber: number,
    params: UpdatePullRequestParams
  ): Promise<GitHubPullRequest> {
    return this.client.patch<GitHubPullRequest>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pullNumber}`,
      params
    );
  }

  /**
   * Lists commits included on a specific pull request.
   */
  async listCommits(
    owner: string,
    repo: string,
    pullNumber: number,
    params?: GitHubPaginationParams
  ): Promise<GitHubCommit[]> {
    return this.client.get<GitHubCommit[]>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pullNumber}/commits`,
      {
        params: params as Record<string, string | number | boolean | undefined>,
      }
    );
  }

  /**
   * Lists files changed on a pull request.
   */
  async listFiles(
    owner: string,
    repo: string,
    pullNumber: number,
    params?: GitHubPaginationParams
  ): Promise<PullRequestFile[]> {
    return this.client.get<PullRequestFile[]>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pullNumber}/files`,
      {
        params: params as Record<string, string | number | boolean | undefined>,
      }
    );
  }

  /**
   * Checks if a pull request has been merged.
   */
  async checkIfMerged(
    owner: string,
    repo: string,
    pullNumber: number
  ): Promise<boolean> {
    try {
      await this.client.get(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pullNumber}/merge`
      );
      return true;
    } catch {
      return false;
    }
  }
}
