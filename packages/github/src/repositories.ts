import { GitHubRepository, GitHubPaginationParams } from './types';
import { GitHubClient } from './client';

export interface ListRepositoriesParams extends GitHubPaginationParams {
  visibility?: 'all' | 'public' | 'private';
  affiliation?: 'owner' | 'collaborator' | 'organization_member';
  type?: 'all' | 'owner' | 'public' | 'private' | 'member';
  sort?: 'created' | 'updated' | 'pushed' | 'full_name';
  direction?: 'asc' | 'desc';
}

export interface ListOrgRepositoriesParams extends GitHubPaginationParams {
  type?: 'all' | 'public' | 'private' | 'forks' | 'sources' | 'member';
  sort?: 'created' | 'updated' | 'pushed' | 'full_name';
  direction?: 'asc' | 'desc';
}

export interface BranchInfo {
  name: string;
  commit: {
    sha: string;
    url: string;
  };
  protected: boolean;
}

export class GitHubRepositoriesApi {
  constructor(private readonly client: GitHubClient) {}

  /**
   * Retrieves a single repository by owner and name.
   */
  async get(owner: string, repo: string): Promise<GitHubRepository> {
    return this.client.get<GitHubRepository>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
    );
  }

  /**
   * Lists repositories for the authenticated user.
   */
  async listForAuthenticatedUser(params?: ListRepositoriesParams): Promise<GitHubRepository[]> {
    return this.client.get<GitHubRepository[]>('/user/repos', {
      params: params as Record<string, string | number | boolean | undefined>,
    });
  }

  /**
   * Lists public repositories for a specific user.
   */
  async listForUser(username: string, params?: ListRepositoriesParams): Promise<GitHubRepository[]> {
    return this.client.get<GitHubRepository[]>(
      `/users/${encodeURIComponent(username)}/repos`,
      {
        params: params as Record<string, string | number | boolean | undefined>,
      }
    );
  }

  /**
   * Lists repositories in an organization.
   */
  async listForOrg(org: string, params?: ListOrgRepositoriesParams): Promise<GitHubRepository[]> {
    return this.client.get<GitHubRepository[]>(
      `/orgs/${encodeURIComponent(org)}/repos`,
      {
        params: params as Record<string, string | number | boolean | undefined>,
      }
    );
  }

  /**
   * Lists branches for a repository.
   */
  async listBranches(
    owner: string,
    repo: string,
    params?: GitHubPaginationParams & { protected?: boolean }
  ): Promise<BranchInfo[]> {
    return this.client.get<BranchInfo[]>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches`,
      {
        params: params as Record<string, string | number | boolean | undefined>,
      }
    );
  }

  /**
   * Gets repository languages breakdown.
   */
  async getLanguages(owner: string, repo: string): Promise<Record<string, number>> {
    return this.client.get<Record<string, number>>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/languages`
    );
  }

  /**
   * Gets repository contributor activity or list.
   */
  async listContributors(
    owner: string,
    repo: string,
    params?: GitHubPaginationParams
  ): Promise<Array<{
    id: number;
    login: string;
    avatar_url: string;
    contributions: number;
    html_url: string;
  }>> {
    return this.client.get(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contributors`,
      {
        params: params as Record<string, string | number | boolean | undefined>,
      }
    );
  }
}
