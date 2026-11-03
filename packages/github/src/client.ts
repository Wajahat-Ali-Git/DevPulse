import {
  GitHubRateLimitInfo,
  GitHubPageLinks,
  GitHubPaginatedResponse,
  GitHubPaginationOptions,
} from './types';
import {
  GitHubError,
  GitHubRateLimitError,
  GitHubNotFoundError,
  GitHubAuthenticationError,
  GitHubForbiddenError,
  GitHubValidationError,
  GitHubTransientError,
  normalizeGitHubError,
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
  maxRateLimitWaitSeconds?: number;
  baseRetryDelayMs?: number;
  oauthConfig?: GitHubOAuthConfig;
  webhookSecret?: string;
}

export interface RequestOptions {
  params?: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export interface RawResponseResult<T> {
  data: T;
  headers: Headers;
  links: GitHubPageLinks;
  rateLimit?: GitHubRateLimitInfo;
}

export class GitHubClient {
  private token?: string;
  private baseUrl: string;
  private userAgent: string;
  private timeoutMs: number;
  private maxRetries: number;
  private retryOnRateLimit: boolean;
  private maxRateLimitWaitSeconds: number;
  private baseRetryDelayMs: number;

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
    this.maxRateLimitWaitSeconds = options.maxRateLimitWaitSeconds ?? 60;
    this.baseRetryDelayMs = options.baseRetryDelayMs ?? 500;

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
   * Parses standard RFC 5988 Link headers returned by GitHub for pagination.
   */
  public parseLinkHeader(linkHeader?: string | null): GitHubPageLinks {
    const links: GitHubPageLinks = {};
    if (!linkHeader) {
      return links;
    }

    const parts = linkHeader.split(',');
    for (const part of parts) {
      const section = part.split(';');
      if (section.length !== 2) {
        continue;
      }
      const rawUrl = section[0].trim();
      if (!rawUrl.startsWith('<') || !rawUrl.endsWith('>')) {
        continue;
      }
      const url = rawUrl.substring(1, rawUrl.length - 1);
      const relMatch = section[1].match(/rel="([^"]+)"/);
      if (relMatch && relMatch[1]) {
        const rel = relMatch[1].trim();
        if (rel === 'next' || rel === 'prev' || rel === 'first' || rel === 'last') {
          links[rel] = url;
        }
      }
    }
    return links;
  }

  /**
   * Low-level request with metadata (data, headers, links, and parsed rate limit).
   */
  async requestRaw<T>(
    endpoint: string,
    options: RequestInit & RequestOptions = {}
  ): Promise<RawResponseResult<T>> {
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

        const rateLimit = this.extractRateLimitHeaders(response.headers);

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

          const fallbackMessage = `GitHub API request failed with status ${response.status} ${response.statusText}`;

          const retryAfterHeader = response.headers.get('retry-after');
          const isExplicitRateLimit =
            response.status === 403 ||
            response.status === 429 ||
            Boolean(retryAfterHeader) ||
            (this.lastRateLimit?.remaining === 0);

              let retryAfterSeconds: number | undefined;
              if (retryAfterHeader) {
                const parsed = parseInt(retryAfterHeader, 10);
                if (!isNaN(parsed) && parsed > 0) {
                  retryAfterSeconds = parsed;
                }
              } else if (this.lastRateLimit && this.lastRateLimit.reset) {
                const nowSeconds = Math.floor(Date.now() / 1000);
                retryAfterSeconds = Math.max(1, this.lastRateLimit.reset - nowSeconds);
              }

              // Check if rate limited and retry configured
              if (isExplicitRateLimit) {
                if (
                  this.retryOnRateLimit &&
                  attempt <= this.maxRetries &&
              retryAfterSeconds &&
                    retryAfterSeconds <= this.maxRateLimitWaitSeconds
            ) {
                  await new Promise((resolve) => setTimeout(resolve, retryAfterSeconds! * 1000));
                  continue;
                }

              const effectiveRateLimit: GitHubRateLimitInfo = this.lastRateLimit || {
                limit: 0,
                remaining: 0,
                reset: Math.floor(Date.now() / 1000) + (retryAfterSeconds || 60),
                used: 0,
                retryAfterSeconds,
              };

                const status = response.status === 429 || (rateLimit?.limit === 0 && retryAfterSeconds) ? 429 : 403;
                throw new GitHubRateLimitError(fallbackMessage, effectiveRateLimit, errorBody, status);
              }

                // Transient server error retry: 500, 502, 503, 504
                const isTransientStatus = response.status >= 500 || response.status === 408;
                if (isTransientStatus && attempt <= this.maxRetries) {
                  const backoffMs = Math.pow(2, attempt) * this.baseRetryDelayMs;
                  await new Promise((resolve) => setTimeout(resolve, backoffMs));
                  continue;
                }

                // Normalize error to application-level subclass
                throw normalizeGitHubError(
                  response.status,
                  fallbackMessage,
                  errorBody,
                  this.lastRateLimit,
                  retryAfterSeconds
                );
              }

              const linkHeader = response.headers.get('link');
              const links = this.parseLinkHeader(linkHeader);

              if (response.status === 204) {
                return {
                  data: undefined as unknown as T,
                  headers: response.headers,
                  links,
                  rateLimit,
                };
              }

              const data = (await response.json()) as T;
              return {
                data,
                headers: response.headers,
                links,
                rateLimit,
              };
            } catch (err: any) {
              if (err.name === 'AbortError') {
                // Timeout is a transient failure
                if (attempt <= this.maxRetries) {
                  const backoffMs = Math.pow(2, attempt) * this.baseRetryDelayMs;
                  await new Promise((resolve) => setTimeout(resolve, backoffMs));
                  continue;
                }
                throw new GitHubTransientError(`GitHub API request timed out after ${this.timeoutMs}ms`, 408);
              }

              if (err instanceof GitHubError) {
                throw err;
              }

                const isNetworkTransient =
                  err.code === 'ECONNRESET' ||
                  err.code === 'ETIMEDOUT' ||
                  err.code === 'EAI_AGAIN' ||
                  err.code === 'UND_ERR_CONNECT_TIMEOUT' ||
                  err.message?.includes('fetch failed') ||
                  err.message?.includes('network');

                if (attempt <= this.maxRetries && isNetworkTransient) {
                  const backoffMs = Math.pow(2, attempt) * this.baseRetryDelayMs;
                  await new Promise((resolve) => setTimeout(resolve, backoffMs));
                  continue;
                }

                if (isNetworkTransient) {
                  throw new GitHubTransientError(err.message || 'Transient network disruption', 503, err);
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

  /**
   * Generic request method supporting query params, timeouts, retries, and rate limit parsing.
   */
  async request<T>(
            endpoint: string,
            options: RequestInit & RequestOptions = {}
          ): Promise < T > {
            const raw = await this.requestRaw<T>(endpoint, options);
            return raw.data;
          }

  /**
   * Fetches a paginated endpoint, returning both data and Link-based navigation links.
   */
  async getPaginated<T>(
            endpoint: string,
            options: RequestOptions = {}
          ): Promise < GitHubPaginatedResponse < T >> {
            const raw = await this.requestRaw<T>(endpoint, { method: 'GET', ...options });
            return {
              data: raw.data,
              links: raw.links,
              rateLimit: raw.rateLimit,
            };
          }

          /**
           * Async iterator that yields each page of a paginated list resource.
           */
          async * paginatePages<T>(
            endpoint: string,
            options: RequestOptions & GitHubPaginationOptions = {}
          ): AsyncGenerator < T[], void, unknown > {
            const { maxPages, maxItems, ...requestOptions } = options;
            let nextUrl: string | undefined = endpoint;
            let pageCount = 0;
            let totalItems = 0;

            while(nextUrl) {
              if (maxPages && pageCount >= maxPages) {
                break;
              }
              if (maxItems && totalItems >= maxItems) {
                break;
              }

              // First request can take params; subsequent requests follow Link URL directly
              const pageResult: GitHubPaginatedResponse<T[]> = await this.getPaginated<T[]>(
                nextUrl,
                pageCount === 0 ? requestOptions : { signal: requestOptions.signal, headers: requestOptions.headers }
              );

              let items = Array.isArray(pageResult.data) ? pageResult.data : [];
              pageCount++;

              if (maxItems && totalItems + items.length > maxItems) {
                items = items.slice(0, maxItems - totalItems);
              }

              totalItems += items.length;
              yield items;

              if (!pageResult.links.next || (maxItems && totalItems >= maxItems)) {
                break;
              }
              nextUrl = pageResult.links.next;
            }
          }

  /**
   * Helper that collects all items across pages up to optional limits.
   */
  async paginateAll<T>(
            endpoint: string,
            options: RequestOptions & GitHubPaginationOptions = {}
          ): Promise < T[] > {
            const all: T[] = [];
            for await (const page of this.paginatePages<T>(endpoint, options)) {
            all.push(...page);
          }
          return all;
        }

  async get<T>(endpoint: string, options: RequestOptions = {}): Promise < T > {
          return this.request<T>(endpoint, { method: 'GET', ...options });
        }

  async post<T>(endpoint: string, body ?: unknown, options: RequestOptions = {}): Promise < T > {
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

  async patch<T>(endpoint: string, body ?: unknown, options: RequestOptions = {}): Promise < T > {
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

  async put<T>(endpoint: string, body ?: unknown, options: RequestOptions = {}): Promise < T > {
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

  async delete <T>(endpoint: string, options: RequestOptions = {}): Promise < T > {
          return this.request<T>(endpoint, { method: 'DELETE', ...options });
        }

  private extractRateLimitHeaders(headers: Headers): GitHubRateLimitInfo | undefined {
    const limit = headers.get('x-ratelimit-limit');
    const remaining = headers.get('x-ratelimit-remaining');
    const reset = headers.get('x-ratelimit-reset');
    const used = headers.get('x-ratelimit-used');
    const resource = headers.get('x-ratelimit-resource');
    const retryAfter = headers.get('retry-after');

    if (limit && remaining && reset) {
      const parsedRetryAfter = retryAfter ? parseInt(retryAfter, 10) : undefined;
      const rateLimit: GitHubRateLimitInfo = {
        limit: parseInt(limit, 10),
        remaining: parseInt(remaining, 10),
        reset: parseInt(reset, 10),
        used: used ? parseInt(used, 10) : 0,
        resource: resource || undefined,
        retryAfterSeconds: !isNaN(Number(parsedRetryAfter)) ? parsedRetryAfter : undefined,
      };
      this.lastRateLimit = rateLimit;
      return rateLimit;
    }

    if (retryAfter) {
      const parsedRetryAfter = parseInt(retryAfter, 10);
      const rateLimit: GitHubRateLimitInfo = {
        limit: 0,
        remaining: 0,
        reset: Math.floor(Date.now() / 1000) + (isNaN(parsedRetryAfter) ? 60 : parsedRetryAfter),
        used: 0,
        retryAfterSeconds: !isNaN(parsedRetryAfter) ? parsedRetryAfter : undefined,
      };
      this.lastRateLimit = rateLimit;
      return rateLimit;
    }

    return undefined;
  }
}
