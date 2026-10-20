import { GitHubRateLimitInfo } from './types';
import {
  GitHubError,
  GitHubRateLimitError,
  GitHubNotFoundError,
  GitHubAuthenticationError,
  GitHubForbiddenError,
} from './errors';
import { GitHubAuthApi, GitHubOAuthConfig } from './auth';
import { GitHubUsersApi } from './users';
import { GitHubRepositoriesApi } from './repositories';
import { GitHubCommitsApi } from './commits';
import { GitHubPullRequestsApi } from './pull-requests';
import { GitHubReviewsApi } from './reviews';
import { GitHubIssuesApi } from './issues';
import { GitHubWebhooks } from './webhooks';

export interface GitHubClientOptions {
  token?: string;
  baseUrl?: string;
  userAgent?: string;
  timeoutMs?: number;
  maxRetries?: number;
  retryOnRateLimit?: boolean;
  oauthConfig?: GitHubOAuthConfig;
  webhookSecret?: string;
}

export interface RequestOptions {
  params?: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export class GitHubClient {
  private token?: string;
  private baseUrl: string;
  private userAgent: string;
  private timeoutMs: number;
  private maxRetries: number;
  private retryOnRateLimit: boolean;

  private lastRateLimit?: GitHubRateLimitInfo;

  public readonly auth: GitHubAuthApi;
  public readonly users: GitHubUsersApi;
  public readonly repositories: GitHubRepositoriesApi;
  public readonly commits: GitHubCommitsApi;
  public readonly pullRequests: GitHubPullRequestsApi;
  public readonly reviews: GitHubReviewsApi;
  public readonly issues: GitHubIssuesApi;
  public readonly webhooks: GitHubWebhooks;

  constructor(options: GitHubClientOptions = {}) {
    this.token = options.token;
    this.baseUrl = (options.baseUrl || 'https://api.github.com').replace(/\/+$/, '');
    this.userAgent = options.userAgent || 'DevPulse-GitHub-Client/1.0';
    this.timeoutMs = options.timeoutMs ?? 15000;
    this.maxRetries = options.maxRetries ?? 2;
    this.retryOnRateLimit = options.retryOnRateLimit ?? false;

    this.auth = new GitHubAuthApi(this, options.oauthConfig);
    this.users = new GitHubUsersApi(this);
    this.repositories = new GitHubRepositoriesApi(this);
    this.commits = new GitHubCommitsApi(this);
    this.pullRequests = new GitHubPullRequestsApi(this);
    this.reviews = new GitHubReviewsApi(this);
    this.issues = new GitHubIssuesApi(this);
    this.webhooks = new GitHubWebhooks(options.webhookSecret);
  }

  /**
   * Set or switch token dynamically (e.g. per-user OAuth access token).
   */
  setToken(token: string): void {
    this.token = token;
  }

  /**
   * Returns current rate limit information observed from headers.
   */
  getRateLimitInfo(): GitHubRateLimitInfo | undefined {
    return this.lastRateLimit;
  }

  /**
   * Directly fetch live rate limit information from the GitHub API.
   */
  async fetchRateLimit(): Promise<{
    resources: {
      core: GitHubRateLimitInfo;
      search: GitHubRateLimitInfo;
      graphql?: GitHubRateLimitInfo;
    };
    rate: GitHubRateLimitInfo;
  }> {
    const response = await this.get<{
      resources: {
        core: GitHubRateLimitInfo;
        search: GitHubRateLimitInfo;
        graphql?: GitHubRateLimitInfo;
      };
      rate: GitHubRateLimitInfo;
    }>('/rate_limit');
    return response;
  }

  /**
   * Generic request method supporting query params, timeouts, retries, and rate limit parsing.
   */
  async request<T>(
    endpoint: string,
    options: RequestInit & RequestOptions = {}
  ): Promise<T> {
    const { params, headers: customHeaders, signal, ...fetchInit } = options;

    let url = endpoint.startsWith('http://') || endpoint.startsWith('https://')
      ? endpoint
      : `${this.baseUrl}${endpoint.startsWith('/') ? '' : '/'}${endpoint}`;

    if (params) {
      const searchParams = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null) {
          searchParams.append(key, String(value));
        }
      }
      const queryString = searchParams.toString();
      if (queryString) {
        url += (url.includes('?') ? '&' : '?') + queryString;
      }
    }

    const headers: Record<string, string> = {
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': this.userAgent,
    };

    if (customHeaders) {
      if (customHeaders instanceof Headers) {
        customHeaders.forEach((value, key) => {
          headers[key] = value;
        });
      } else if (Array.isArray(customHeaders)) {
        for (const [key, value] of customHeaders) {
          headers[key] = value;
        }
      } else if (typeof customHeaders === 'object') {
        Object.assign(headers, customHeaders);
      }
    }

    if (this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    }

    let attempt = 0;
    while (true) {
      attempt++;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

      // Link external signal if provided
      const abortListener = () => controller.abort();
      if (signal) {
        signal.addEventListener('abort', abortListener);
      }

      try {
        const response = await fetch(url, {
          ...fetchInit,
          headers,
          signal: controller.signal,
        });

        this.extractRateLimitHeaders(response.headers);

        if (!response.ok) {
          let errorBody: unknown;
          try {
            errorBody = await response.json();
          } catch {
            try {
              errorBody = await response.text();
            } catch {
              errorBody = undefined;
            }
          }

          const message =
            typeof errorBody === 'object' && errorBody !== null && 'message' in errorBody
              ? String((errorBody as { message: unknown }).message)
              : `GitHub API request failed with status ${response.status} ${response.statusText}`;

          if (response.status === 401) {
            throw new GitHubAuthenticationError(message, errorBody);
          }

          if (response.status === 404) {
            throw new GitHubNotFoundError(message, errorBody);
          }

          const isRateLimit =
            (response.status === 403 || response.status === 429) &&
            (this.lastRateLimit?.remaining === 0 ||
              message.toLowerCase().includes('rate limit'));

          if (isRateLimit && this.lastRateLimit) {
            if (this.retryOnRateLimit && attempt <= this.maxRetries) {
              const nowSeconds = Math.floor(Date.now() / 1000);
              const waitSeconds = Math.min(
                Math.max(1, this.lastRateLimit.reset - nowSeconds),
                60
              );
              await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));
              continue;
            }
            throw new GitHubRateLimitError(message, this.lastRateLimit, errorBody);
          }

          if (response.status === 403) {
            throw new GitHubForbiddenError(message, errorBody);
          }

          if (response.status >= 500 && attempt <= this.maxRetries) {
            const backoffMs = Math.pow(2, attempt) * 500;
            await new Promise((resolve) => setTimeout(resolve, backoffMs));
            continue;
          }

          throw new GitHubError(message, response.status, errorBody, this.lastRateLimit);
        }

        if (response.status === 204) {
          return undefined as unknown as T;
        }

        const data = (await response.json()) as T;
        return data;
      } catch (err: any) {
        if (err.name === 'AbortError') {
          throw new GitHubError(`GitHub API request timed out after ${this.timeoutMs}ms`, 408);
        }
        if (err instanceof GitHubError) {
          throw err;
        }
        if (attempt <= this.maxRetries && err.code !== 'ENOTFOUND') {
          const backoffMs = Math.pow(2, attempt) * 500;
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
          continue;
        }
        throw new GitHubError(err.message || 'Unknown network error', 500, err);
      } finally {
        clearTimeout(timeoutId);
        if (signal) {
          signal.removeEventListener('abort', abortListener);
        }
      }
    }
  }

  async get<T>(endpoint: string, options: RequestOptions = {}): Promise<T> {
    return this.request<T>(endpoint, { method: 'GET', ...options });
  }

  async post<T>(endpoint: string, body?: unknown, options: RequestOptions = {}): Promise<T> {
    return this.request<T>(endpoint, {
      method: 'POST',
      body: body !== undefined ? JSON.stringify(body) : undefined,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
      ...options,
    });
  }

  async patch<T>(endpoint: string, body?: unknown, options: RequestOptions = {}): Promise<T> {
    return this.request<T>(endpoint, {
      method: 'PATCH',
      body: body !== undefined ? JSON.stringify(body) : undefined,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
      ...options,
    });
  }

  async put<T>(endpoint: string, body?: unknown, options: RequestOptions = {}): Promise<T> {
    return this.request<T>(endpoint, {
      method: 'PUT',
      body: body !== undefined ? JSON.stringify(body) : undefined,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
      ...options,
    });
  }

  async delete<T>(endpoint: string, options: RequestOptions = {}): Promise<T> {
    return this.request<T>(endpoint, { method: 'DELETE', ...options });
  }

  private extractRateLimitHeaders(headers: Headers): void {
    const limit = headers.get('x-ratelimit-limit');
    const remaining = headers.get('x-ratelimit-remaining');
    const reset = headers.get('x-ratelimit-reset');
    const used = headers.get('x-ratelimit-used');
    const resource = headers.get('x-ratelimit-resource');

    if (limit && remaining && reset) {
      this.lastRateLimit = {
        limit: parseInt(limit, 10),
        remaining: parseInt(remaining, 10),
        reset: parseInt(reset, 10),
        used: used ? parseInt(used, 10) : 0,
        resource: resource || undefined,
      };
    }
  }
}
