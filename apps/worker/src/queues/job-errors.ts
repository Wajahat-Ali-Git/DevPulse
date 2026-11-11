import { UnrecoverableError } from 'bullmq';
import {
  GitHubAuthenticationError,
  GitHubNotFoundError,
  GitHubValidationError,
  GitHubForbiddenError,
  GitHubRateLimitError,
  GitHubTransientError,
} from '@devpulse/github';

/**
 * Base class for permanent job errors that should never be retried by BullMQ.
 * Wrapping an error in or inheriting from PermanentJobError instructs the
 * base worker to fail the job immediately via UnrecoverableError.
 */
export class PermanentJobError extends Error {
  public readonly isPermanent = true;

  constructor(message: string, public readonly originalError?: unknown) {
    super(message);
    this.name = 'PermanentJobError';
    Object.setPrototypeOf(this, PermanentJobError.prototype);
  }
}

/**
 * Base class for retryable job errors that should be retried with backoff.
 */
export class RetryableJobError extends Error {
  public readonly isRetryable = true;

  constructor(
    message: string,
    public readonly retryAfterMs?: number,
    public readonly originalError?: unknown,
  ) {
    super(message);
    this.name = 'RetryableJobError';
    Object.setPrototypeOf(this, RetryableJobError.prototype);
  }
}

/**
 * Determines whether a given failure is retryable or permanent.
 *
 * Permanent Failures (should NOT retry):
 * - Already marked as UnrecoverableError (BullMQ native)
 * - PermanentJobError instances
 * - Validation errors (e.g. invalid payload schema, GitHub 422)
 * - Authentication/credential errors (GitHub 401 Bad Credentials / revoked token)
 * - Resource not found errors (GitHub 404)
 * - Forbidden / insufficient permissions (GitHub 403 when NOT rate-limited)
 *
 * Retryable Failures (SHOULD retry with backoff):
 * - RetryableJobError instances
 * - GitHub rate-limit errors (403/429 with reset time)
 * - Transient network, timeout, or server disruptions (GitHub 502/503/504/408)
 * - Database deadlock, connection loss, or transient Redis timeouts
 */
export function isRetryableError(error: unknown): boolean {
  if (!error) return false;

  // BullMQ native unrecoverable error is permanent
  if (error instanceof UnrecoverableError) {
    return false;
  }

  // Explicitly flagged permanent error
  if (error instanceof PermanentJobError || (error as any).isPermanent === true) {
    return false;
  }

  // Explicitly flagged retryable error
  if (error instanceof RetryableJobError || (error as any).isRetryable === true) {
    return true;
  }

  // GitHub Normalized Errors classification
  if (error instanceof GitHubAuthenticationError) {
    return false; // Invalid/revoked tokens cannot succeed on retry
  }

  if (error instanceof GitHubNotFoundError) {
    return false; // Missing resources will not appear on immediate retry
  }

  if (error instanceof GitHubValidationError) {
    return false; // Malformed parameters / validation failure is deterministic
  }

  if (error instanceof GitHubForbiddenError) {
    return false; // Insufficient repository permissions is deterministic
  }

  if (error instanceof GitHubRateLimitError) {
    return true; // Rate limits recover after resetDate / retry-after
  }

  if (error instanceof GitHubTransientError) {
    return true; // Transient 5xx / gateway / network errors are retryable
  }

  // Standard JavaScript SyntaxError or TypeError (bug in code / malformed payload)
  if (error instanceof TypeError || error instanceof SyntaxError || error instanceof RangeError) {
    return false;
  }

  // Check error message heuristics for network/transient failures
  const err = error as Error;
  const msg = err.message ? err.message.toLowerCase() : '';
  const code = (err as any).code ? String((err as any).code).toUpperCase() : '';

  if (
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'EHOSTUNREACH' ||
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN' ||
    msg.includes('connection lost') ||
    msg.includes('deadlock') ||
    msg.includes('timeout') ||
    msg.includes('rate limit') ||
    msg.includes('too many requests')
  ) {
    return true;
  }

  // Default: generic/unknown errors default to retryable for transient resilience
  return true;
}

/**
 * Normalizes any error into BullMQ's UnrecoverableError if it's determined to be permanent,
 * or returns the original error (allowing BullMQ to retry according to backoff).
 */
export function normalizeJobError(error: unknown): Error {
  if (error instanceof UnrecoverableError) {
    return error;
  }

  if (!isRetryableError(error)) {
    const message = error instanceof Error ? error.message : String(error);
    const unrecoverable = new UnrecoverableError(`Permanent Job Failure: ${message}`);
    if (error instanceof Error && error.stack) {
      unrecoverable.stack = error.stack;
    }
    return unrecoverable;
  }

  return error instanceof Error ? error : new Error(String(error));
}
