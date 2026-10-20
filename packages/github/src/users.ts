import { GitHubUser, GitHubPaginationParams } from './types';
import { GitHubClient } from './client';

export interface UserRepositoriesParams extends GitHubPaginationParams {
  type?: 'all' | 'owner' | 'public' | 'private' | 'member';
  sort?: 'created' | 'updated' | 'pushed' | 'full_name';
  direction?: 'asc' | 'desc';
}

export class GitHubUsersApi {
  constructor(private readonly client: GitHubClient) {}

  /**
   * Retrieves profile details for the currently authenticated user.
   */
  async getMe(): Promise<GitHubUser> {
    return this.client.get<GitHubUser>('/user');
  }

  /**
   * Retrieves profile details for any GitHub user by username.
   */
  async getByUsername(username: string): Promise<GitHubUser> {
    return this.client.get<GitHubUser>(`/users/${encodeURIComponent(username)}`);
  }

  /**
   * Retrieves public and private email addresses for the currently authenticated user.
   */
  async getEmails(): Promise<Array<{
    email: string;
    primary: boolean;
    verified: boolean;
    visibility: string | null;
  }>> {
    return this.client.get('/user/emails');
  }

  /**
   * Retrieves organizations that the authenticated user belongs to.
   */
  async getOrganizations(params?: GitHubPaginationParams): Promise<Array<{
    login: string;
    id: number;
    url: string;
    avatar_url: string;
    description: string | null;
  }>> {
    return this.client.get('/user/orgs', {
      params: params as Record<string, string | number | boolean | undefined>,
    });
  }
}
