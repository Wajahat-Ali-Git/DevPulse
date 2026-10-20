import { GitHubReview, GitHubReviewState, GitHubPaginationParams } from './types';
import { GitHubClient } from './client';

export interface SubmitReviewParams {
  body?: string;
  event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
  comments?: Array<{
    path: string;
    position?: number;
    body: string;
    line?: number;
    side?: 'LEFT' | 'RIGHT';
    start_line?: number;
    start_side?: 'LEFT' | 'RIGHT';
  }>;
}

export interface ReviewComment {
  id: number;
  node_id: string;
  url: string;
  body: string;
  path: string;
  position: number | null;
  line: number | null;
  commit_id: string;
  user: {
    id: number;
    login: string;
    avatar_url: string;
  };
  created_at: string;
  updated_at: string;
  html_url: string;
}

export class GitHubReviewsApi {
  constructor(private readonly client: GitHubClient) {}

  /**
   * Lists reviews for a pull request.
   */
  async list(
    owner: string,
    repo: string,
    pullNumber: number,
    params?: GitHubPaginationParams
  ): Promise<GitHubReview[]> {
    return this.client.get<GitHubReview[]>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pullNumber}/reviews`,
      {
        params: params as Record<string, string | number | boolean | undefined>,
      }
    );
  }

  /**
   * Retrieves a single review by review ID.
   */
  async get(
    owner: string,
    repo: string,
    pullNumber: number,
    reviewId: number
  ): Promise<GitHubReview> {
    return this.client.get<GitHubReview>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pullNumber}/reviews/${reviewId}`
    );
  }

  /**
   * Creates/submits a review on a pull request.
   */
  async create(
    owner: string,
    repo: string,
    pullNumber: number,
    params: SubmitReviewParams
  ): Promise<GitHubReview> {
    return this.client.post<GitHubReview>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pullNumber}/reviews`,
      params
    );
  }

  /**
   * Lists comments for a specific review on a pull request.
   */
  async listComments(
    owner: string,
    repo: string,
    pullNumber: number,
    reviewId: number,
    params?: GitHubPaginationParams
  ): Promise<ReviewComment[]> {
    return this.client.get<ReviewComment[]>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pullNumber}/reviews/${reviewId}/comments`,
      {
        params: params as Record<string, string | number | boolean | undefined>,
      }
    );
  }
}
