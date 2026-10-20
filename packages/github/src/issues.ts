import { GitHubIssue, GitHubPaginationParams } from './types';
import { GitHubClient } from './client';

export interface ListIssuesParams extends GitHubPaginationParams {
  filter?: 'assigned' | 'created' | 'mentioned' | 'subscribed' | 'repos' | 'all';
  state?: 'open' | 'closed' | 'all';
  labels?: string; // Comma separated list of label names
  sort?: 'created' | 'updated' | 'comments';
  direction?: 'asc' | 'desc';
  since?: string; // ISO 8601 date string
  creator?: string;
  mentioned?: string;
  assignee?: string;
}

export interface CreateIssueParams {
  title: string;
  body?: string;
  assignees?: string[];
  milestone?: number;
  labels?: string[];
}

export interface UpdateIssueParams {
  title?: string;
  body?: string;
  assignees?: string[];
  state?: 'open' | 'closed';
  state_reason?: 'completed' | 'not_planned' | 'reopened' | null;
  labels?: string[];
}

export interface IssueComment {
  id: number;
  node_id: string;
  url: string;
  html_url: string;
  body: string;
  user: {
    id: number;
    login: string;
    avatar_url: string;
  };
  created_at: string;
  updated_at: string;
}

export class GitHubIssuesApi {
  constructor(private readonly client: GitHubClient) {}

  /**
   * Lists issues for a repository. Note: GitHub's issues endpoint also returns pull requests unless filtered.
   */
  async list(
    owner: string,
    repo: string,
    params?: ListIssuesParams
  ): Promise<GitHubIssue[]> {
    return this.client.get<GitHubIssue[]>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`,
      {
        params: params as Record<string, string | number | boolean | undefined>,
      }
    );
  }

  /**
   * Retrieves a single issue by number.
   */
  async get(
    owner: string,
    repo: string,
    issueNumber: number
  ): Promise<GitHubIssue> {
    return this.client.get<GitHubIssue>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}`
    );
  }

  /**
   * Creates a new issue.
   */
  async create(
    owner: string,
    repo: string,
    params: CreateIssueParams
  ): Promise<GitHubIssue> {
    return this.client.post<GitHubIssue>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`,
      params
    );
  }

  /**
   * Updates an existing issue.
   */
  async update(
    owner: string,
    repo: string,
    issueNumber: number,
    params: UpdateIssueParams
  ): Promise<GitHubIssue> {
    return this.client.patch<GitHubIssue>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}`,
      params
    );
  }

  /**
   * Lists comments on an issue.
   */
  async listComments(
    owner: string,
    repo: string,
    issueNumber: number,
    params?: GitHubPaginationParams
  ): Promise<IssueComment[]> {
    return this.client.get<IssueComment[]>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}/comments`,
      {
        params: params as Record<string, string | number | boolean | undefined>,
      }
    );
  }
}
