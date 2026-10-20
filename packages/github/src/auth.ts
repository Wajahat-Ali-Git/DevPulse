import {
  GitHubUser,
  GitHubOAuthTokenResponse,
} from './types';
import { GitHubClient } from './client';

export interface GitHubOAuthConfig {
  clientId: string;
  clientSecret: string;
  callbackUrl?: string;
}

export interface GitHubAuthorizeUrlOptions {
  scopes?: string[];
  state?: string;
  allowSignup?: boolean;
}

export interface ExchangeCodeOptions {
  code: string;
  state?: string;
  redirectUri?: string;
}

export interface RefreshTokenOptions {
  refreshToken: string;
}

export class GitHubAuthApi {
  constructor(
    private readonly client: GitHubClient,
    private readonly config?: GitHubOAuthConfig
  ) {}

  /**
   * Generates the GitHub OAuth authorization URL.
   */
  getAuthorizationUrl(options: GitHubAuthorizeUrlOptions = {}): string {
    const clientId = this.config?.clientId;
    if (!clientId) {
      throw new Error('GitHub clientId is required to construct authorization URL');
    }

    const params = new URLSearchParams({
      client_id: clientId,
      scope: (options.scopes ?? ['read:user', 'user:email', 'repo']).join(' '),
    });

    const redirectUri = options.state || this.config?.callbackUrl;
    if (this.config?.callbackUrl) {
      params.append('redirect_uri', this.config.callbackUrl);
    }
    if (options.state) {
      params.append('state', options.state);
    }
    if (options.allowSignup !== undefined) {
      params.append('allow_signup', String(options.allowSignup));
    }

    return `https://github.com/login/oauth/authorize?${params.toString()}`;
  }

  /**
   * Exchanges authorization code for an OAuth access token.
   */
  async exchangeCodeForToken(
    options: ExchangeCodeOptions,
    customConfig?: GitHubOAuthConfig
  ): Promise<GitHubOAuthTokenResponse> {
    const clientId = customConfig?.clientId || this.config?.clientId;
    const clientSecret = customConfig?.clientSecret || this.config?.clientSecret;
    const redirectUri = options.redirectUri || customConfig?.callbackUrl || this.config?.callbackUrl;

    if (!clientId || !clientSecret) {
      throw new Error('Both clientId and clientSecret are required to exchange code for token');
    }

    const body: Record<string, string> = {
      client_id: clientId,
      client_secret: clientSecret,
      code: options.code,
    };

    if (redirectUri) {
      body.redirect_uri = redirectUri;
    }
    if (options.state) {
      body.state = options.state;
    }

    const response = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const data = (await response.json()) as GitHubOAuthTokenResponse;
    if (data.error) {
      throw new Error(`GitHub OAuth error: ${data.error_description || data.error}`);
    }

    return data;
  }

  /**
   * Refreshes an expiring user access token using a refresh token.
   */
  async refreshToken(
    options: RefreshTokenOptions,
    customConfig?: GitHubOAuthConfig
  ): Promise<GitHubOAuthTokenResponse> {
    const clientId = customConfig?.clientId || this.config?.clientId;
    const clientSecret = customConfig?.clientSecret || this.config?.clientSecret;

    if (!clientId || !clientSecret) {
      throw new Error('Both clientId and clientSecret are required to refresh OAuth token');
    }

    const response = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'refresh_token',
        refresh_token: options.refreshToken,
      }),
    });

    const data = (await response.json()) as GitHubOAuthTokenResponse;
    if (data.error) {
      throw new Error(`GitHub token refresh error: ${data.error_description || data.error}`);
    }

    return data;
  }

  /**
   * Returns authenticated user profile using current client token.
   */
  async getAuthenticatedUser(): Promise<GitHubUser> {
    return this.client.get<GitHubUser>('/user');
  }

  /**
   * Returns verified and primary email addresses for authenticated user.
   */
  async getAuthenticatedEmails(): Promise<Array<{
    email: string;
    primary: boolean;
    verified: boolean;
    visibility: string | null;
  }>> {
    return this.client.get('/user/emails');
  }
}
