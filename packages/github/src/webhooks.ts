import * as crypto from 'crypto';
import {
  GitHubPushEventPayload,
  GitHubPullRequestEventPayload,
  GitHubPullRequestReviewEventPayload,
  GitHubIssuesEventPayload,
  GitHubWebhookPayload,
} from './types';

export interface VerifyWebhookSignatureOptions {
  payload: string | Buffer;
  signature: string;
  secret: string;
}

export type GitHubWebhookEventType =
  | 'push'
  | 'pull_request'
  | 'pull_request_review'
  | 'issues'
  | 'issue_comment'
  | 'ping'
  | 'repository'
  | 'star'
  | 'watch'
  | string;

export class GitHubWebhooks {
  constructor(private readonly defaultSecret?: string) {}

  /**
   * Computes HMAC SHA-256 hex digest for a payload.
   */
  static sign(payload: string | Buffer, secret: string): string {
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(payload);
    return `sha256=${hmac.digest('hex')}`;
  }

  /**
   * Verifies the GitHub HMAC SHA-256 signature using timing-safe comparison.
   */
  static verifySignature(options: VerifyWebhookSignatureOptions): boolean {
    const { payload, signature, secret } = options;
    if (!signature || !secret) {
      return false;
    }

    const expectedSignature = GitHubWebhooks.sign(payload, secret);

    const sigBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expectedSignature);

    if (sigBuffer.length !== expectedBuffer.length) {
      return false;
    }

    return crypto.timingSafeEqual(sigBuffer, expectedBuffer);
  }

  /**
   * Instance method to verify signature using configured defaultSecret if not provided.
   */
  verify(payload: string | Buffer, signature: string, secret?: string): boolean {
    const webhookSecret = secret || this.defaultSecret;
    if (!webhookSecret) {
      throw new Error('Webhook secret is required to verify webhook signature');
    }

    return GitHubWebhooks.verifySignature({
      payload,
      signature,
      secret: webhookSecret,
    });
  }

  /**
   * Parses and validates raw webhook event payload and headers.
   */
  parseEvent(
    rawPayload: string | Buffer,
    signature?: string,
    secret?: string
  ): GitHubWebhookPayload {
    if (signature) {
      const isValid = this.verify(rawPayload, signature, secret);
      if (!isValid) {
        throw new Error('Invalid GitHub webhook signature');
      }
    }

    const jsonString = typeof rawPayload === 'string' ? rawPayload : rawPayload.toString('utf8');
    return JSON.parse(jsonString) as GitHubWebhookPayload;
  }

  /**
   * Type guard for push events.
   */
  static isPushEvent(event: string, _payload: any): _payload is GitHubPushEventPayload {
    return event === 'push';
  }

  /**
   * Type guard for pull_request events.
   */
  static isPullRequestEvent(
    event: string,
    _payload: any
  ): _payload is GitHubPullRequestEventPayload {
    return event === 'pull_request';
  }

  /**
   * Type guard for pull_request_review events.
   */
  static isPullRequestReviewEvent(
    event: string,
    _payload: any
  ): _payload is GitHubPullRequestReviewEventPayload {
    return event === 'pull_request_review';
  }

  /**
   * Type guard for issues events.
   */
  static isIssuesEvent(
    event: string,
    _payload: any
  ): _payload is GitHubIssuesEventPayload {
    return event === 'issues';
  }
}
