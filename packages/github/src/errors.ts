import { GitHubRateLimitInfo } from './types';

export class GitHubError extends Error {
  public readonly status: number;
  public readonly responseBody?: unknown;
  public readonly rateLimit?: GitHubRateLimitInfo;
  public readonly isRateLimitExceeded: boolean;

  constructor(
    message: string,
    status: number,
    responseBody?: unknown,
    rateLimit?: GitHubRateLimitInfo
  ) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
    this.responseBody = responseBody;
    this.rateLimit = rateLimit;
    this.isRateLimitExceeded = status === 403 || status === 429;
    Object.setPrototypeOf(this, GitHubError.prototype);
  }
}

export class GitHubRateLimitError extends GitHubError {
  public readonly resetDate: Date;
  public readonly retryAfterSeconds: number;

  constructor(
    message: string,
    rateLimit: GitHubRateLimitInfo,
    responseBody?: unknown
  ) {
    super(message, 403, responseBody, rateLimit);
    this.name = 'GitHubRateLimitError';
    this.resetDate = new Date(rateLimit.reset * 1000);
    const nowEpochSeconds = Math.floor(Date.now() / 1000);
    this.retryAfterSeconds = Math.max(0, rateLimit.reset - nowEpochSeconds);
    Object.setPrototypeOf(this, GitHubRateLimitError.prototype);
  }
}

export class GitHubNotFoundError extends GitHubError {
  constructor(message = 'Resource not found on GitHub', responseBody?: unknown) {
    super(message, 404, responseBody);
    this.name = 'GitHubNotFoundError';
    Object.setPrototypeOf(this, GitHubNotFoundError.prototype);
  }
}

export class GitHubAuthenticationError extends GitHubError {
  constructor(message = 'Bad GitHub credentials or token expired', responseBody?: unknown) {
    super(message, 401, responseBody);
    this.name = 'GitHubAuthenticationError';
    Object.setPrototypeOf(this, GitHubAuthenticationError.prototype);
  }
}

export class GitHubForbiddenError extends GitHubError {
  constructor(message = 'Forbidden access to GitHub resource', responseBody?: unknown) {
    super(message, 403, responseBody);
    this.name = 'GitHubForbiddenError';
    Object.setPrototypeOf(this, GitHubForbiddenError.prototype);
  }
}
