import { GitHubRateLimitInfo } from './types';

export interface GitHubNormalizedErrorDetails {
  resource?: string;
  field?: string;
  code?: string;
  message?: string;
}

/**
 * Normalizes raw GitHub error payload bodies into structured error properties.
 */
export function extractGitHubErrorMessage(errorBody: unknown, fallback: string): {
  message: string;
  errors?: GitHubNormalizedErrorDetails[];
  documentationUrl?: string;
} {
  if (typeof errorBody === 'object' && errorBody !== null) {
    const obj = errorBody as Record<string, any>;
    const message = typeof obj.message === 'string' && obj.message.trim().length > 0
      ? obj.message
      : typeof obj.error_description === 'string' && obj.error_description.trim().length > 0
        ? obj.error_description
        : typeof obj.error === 'string' && obj.error.trim().length > 0
          ? obj.error
          : fallback;

    const documentationUrl = typeof obj.documentation_url === 'string'
      ? obj.documentation_url
      : undefined;

    const errors: GitHubNormalizedErrorDetails[] | undefined = Array.isArray(obj.errors)
      ? obj.errors.map((e: any) => {
        if (typeof e === 'string') {
          return { message: e };
        }
        if (typeof e === 'object' && e !== null) {
          return {
            resource: typeof e.resource === 'string' ? e.resource : undefined,
            field: typeof e.field === 'string' ? e.field : undefined,
            code: typeof e.code === 'string' ? e.code : undefined,
            message: typeof e.message === 'string' ? e.message : undefined,
          };
        }
        return { message: String(e) };
      })
      : undefined;

    return { message, errors, documentationUrl };
  }

  if (typeof errorBody === 'string' && errorBody.trim().length > 0) {
    return { message: errorBody };
  }

  return { message: fallback };
}

/**
 * Base normalized application-level error for GitHub API interactions.
 */
export class GitHubError extends Error {
  public readonly status: number;
  public readonly responseBody?: unknown;
  public readonly rateLimit?: GitHubRateLimitInfo;
  public readonly isRateLimitExceeded: boolean;
  public readonly errors?: GitHubNormalizedErrorDetails[];
  public readonly documentationUrl?: string;

  constructor(
    message: string,
    status: number,
    responseBody?: unknown,
    rateLimit?: GitHubRateLimitInfo
  ) {
    const normalized = extractGitHubErrorMessage(responseBody, message);
    super(normalized.message);
    this.name = 'GitHubError';
    this.status = status;
    this.responseBody = responseBody;
    this.rateLimit = rateLimit;
    this.isRateLimitExceeded = status === 403 || status === 429;
    this.errors = normalized.errors;
    this.documentationUrl = normalized.documentationUrl;
    Object.setPrototypeOf(this, GitHubError.prototype);
  }
}

/**
 * Rate limit error with retry guidance and reset date.
 */
export class GitHubRateLimitError extends GitHubError {
  public readonly resetDate: Date;
  public readonly retryAfterSeconds: number;

  constructor(
    message: string,
    rateLimit: GitHubRateLimitInfo,
    responseBody?: unknown,
    status?: number
  ) {
    const resolvedStatus = status ?? (rateLimit.limit === 0 && rateLimit.retryAfterSeconds ? 429 : 403);
    super(message, resolvedStatus, responseBody, rateLimit);
    this.name = 'GitHubRateLimitError';
    this.resetDate = new Date(rateLimit.reset * 1000);
    const nowEpochSeconds = Math.floor(Date.now() / 1000);
    this.retryAfterSeconds = rateLimit.retryAfterSeconds !== undefined
      ? rateLimit.retryAfterSeconds
      : Math.max(0, rateLimit.reset - nowEpochSeconds);
    Object.setPrototypeOf(this, GitHubRateLimitError.prototype);
  }
}

/**
 * Resource not found (404).
 */
export class GitHubNotFoundError extends GitHubError {
  constructor(message = 'Resource not found on GitHub', responseBody?: unknown) {
    super(message, 404, responseBody);
    this.name = 'GitHubNotFoundError';
    Object.setPrototypeOf(this, GitHubNotFoundError.prototype);
  }
}

/**
 * Authentication error (401 Bad credentials or expired/revoked token).
 */
export class GitHubAuthenticationError extends GitHubError {
  constructor(message = 'Bad GitHub credentials or token expired', responseBody?: unknown) {
    super(message, 401, responseBody);
    this.name = 'GitHubAuthenticationError';
    Object.setPrototypeOf(this, GitHubAuthenticationError.prototype);
  }
}

/**
 * Forbidden / insufficient scope error (403).
 */
export class GitHubForbiddenError extends GitHubError {
  constructor(message = 'Forbidden access to GitHub resource', responseBody?: unknown) {
    super(message, 403, responseBody);
    this.name = 'GitHubForbiddenError';
    Object.setPrototypeOf(this, GitHubForbiddenError.prototype);
  }
}

/**
 * Validation error (422 Unprocessable Entity), with normalized field validation errors.
 */
export class GitHubValidationError extends GitHubError {
  constructor(message = 'Validation failed for GitHub resource', responseBody?: unknown) {
    super(message, 422, responseBody);
    this.name = 'GitHubValidationError';
    Object.setPrototypeOf(this, GitHubValidationError.prototype);
  }
}

/**
 * Transient network or timeout error (502, 503, 504, 408, or connection drop).
 */
export class GitHubTransientError extends GitHubError {
  public readonly isTransient = true;

  constructor(message = 'Transient GitHub network or service disruption', status = 503, responseBody?: unknown) {
    super(message, status, responseBody);
    this.name = 'GitHubTransientError';
    Object.setPrototypeOf(this, GitHubTransientError.prototype);
  }
}

/**
 * Helper to normalize any HTTP response status and body into the appropriate application error subclass.
 */
export function normalizeGitHubError(
  status: number,
  fallbackMessage: string,
  errorBody?: unknown,
  rateLimit?: GitHubRateLimitInfo,
  retryAfterSeconds?: number
): GitHubError {
  const { message } = extractGitHubErrorMessage(errorBody, fallbackMessage);

  if (status === 401) {
    return new GitHubAuthenticationError(message, errorBody);
  }

  if (status === 404) {
    return new GitHubNotFoundError(message, errorBody);
  }

  if (status === 422) {
    return new GitHubValidationError(message, errorBody);
  }

  if (status === 403) {
    if (rateLimit?.remaining === 0 || message.toLowerCase().includes('rate limit')) {
      const rl: GitHubRateLimitInfo = rateLimit || {
        limit: 0,
        remaining: 0,
        reset: Math.floor(Date.now() / 1000) + 60,
        used: 0,
        retryAfterSeconds,
      };
      return new GitHubRateLimitError(message, rl, errorBody, 403);
    }
    return new GitHubForbiddenError(message, errorBody);
  }

  if (status === 429) {
    const rl: GitHubRateLimitInfo = rateLimit || {
      limit: 0,
      remaining: 0,
      reset: Math.floor(Date.now() / 1000) + (retryAfterSeconds || 60),
      used: 0,
      retryAfterSeconds,
    };
    return new GitHubRateLimitError(message, rl, errorBody, 429);
  }

  if (status === 408 || status === 502 || status === 503 || status === 504) {
    return new GitHubTransientError(message, status, errorBody);
  }

  return new GitHubError(message, status, errorBody, rateLimit);
}
