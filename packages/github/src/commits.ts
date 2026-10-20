import { GitHubCommit, GitHubPaginationParams } from './types';
import { GitHubClient } from './client';

export interface ListCommitsParams extends GitHubPaginationParams {
  sha?: string;
  path?: string;
  author?: string;
  committer?: string;
  since?: string; // ISO 8601 date string
  until?: string; // ISO 8601 date string
}

export interface CommitComparison {
  url: string;
  html_url: string;
  status: 'ahead' | 'behind' | 'diverged' | 'identical';
  ahead_by: number;
  behind_by: number;
  total_commits: number;
  commits: GitHubCommit[];
}

export class GitHubCommitsApi {
  constructor(private readonly client: GitHubClient) {}

  /**
   * Lists commits in a repository.
   */
  async list(
    owner: string,
    repo: string,
    params?: ListCommitsParams
  ): Promise<GitHubCommit[]> {
    return this.client.get<GitHubCommit[]>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits`,
      {
        params: params as Record<string, string | number | boolean | undefined>,
      }
    );
  }

  /**
   * Retrieves a single commit by commit SHA or ref.
   */
  async get(owner: string, repo: string, ref: string): Promise<GitHubCommit> {
    return this.client.get<GitHubCommit>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(ref)}`
    );
  }

  /**
   * Compares two commits or references (base...head).
   */
  async compare(
    owner: string,
    repo: string,
    base: string,
    head: string
  ): Promise<CommitComparison> {
    return this.client.get<CommitComparison>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`
    );
  }
}
