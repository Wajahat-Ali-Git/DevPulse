import { BadRequestException } from '@nestjs/common';

export const SUPPORTED_GITHUB_EVENTS = [
  'ping',
  'push',
  'pull_request',
  'pull_request_review',
  'repository',
] as const;

export type SupportedGitHubEvent = (typeof SUPPORTED_GITHUB_EVENTS)[number];

export function isSupportedGitHubEvent(event: string): event is SupportedGitHubEvent {
  return (SUPPORTED_GITHUB_EVENTS as readonly string[]).includes(event);
}

export interface ValidatedRepositoryInfo {
  githubRepoId: bigint;
  name: string;
  fullName: string;
  ownerLogin: string;
  ownerId?: bigint;
}

export interface ValidatedActorInfo {
  githubUserId?: bigint;
  username: string;
}

export interface WebhookMetadata {
  deliveryId: string;
  eventType: string;
  repositoryGitHubId?: bigint;
  repositoryFullName?: string;
  senderGitHubId?: bigint;
  action?: string;
  receivedAt: Date;
}

export interface ValidatedWebhookEvent {
  event: SupportedGitHubEvent;
  deliveryId: string;
  isPing: boolean;
  action?: string;
  repository?: ValidatedRepositoryInfo;
  actor?: ValidatedActorInfo;
  metadata: WebhookMetadata;
  payload: Record<string, any>;
}

/**
 * Extracts and normalizes relevant webhook metadata.
 */
export function extractWebhookMetadata(options: {
  deliveryId: string;
  eventType: string;
  repository?: ValidatedRepositoryInfo;
  actor?: ValidatedActorInfo;
  action?: string;
  receivedAt?: Date;
}): WebhookMetadata {
  return {
    deliveryId: options.deliveryId,
    eventType: options.eventType,
    repositoryGitHubId: options.repository?.githubRepoId,
    repositoryFullName: options.repository?.fullName,
    senderGitHubId: options.actor?.githubUserId,
    action: options.action,
    receivedAt: options.receivedAt ?? new Date(),
  };
}

/**
 * Validates payload structure and required fields according to event type.
 */
export function validateEventPayload(
  event: string,
  rawPayload: any,
  deliveryId: string,
): ValidatedWebhookEvent {
  if (!rawPayload || typeof rawPayload !== 'object') {
    throw new BadRequestException('Webhook payload must be a valid JSON object');
  }

  // 1. Ping Event
  if (event === 'ping') {
    const repository = rawPayload.repository
      ? extractRepository(rawPayload.repository)
      : undefined;
    const actor = rawPayload.sender ? extractActor(rawPayload.sender) : undefined;
    const metadata = extractWebhookMetadata({
      deliveryId,
      eventType: 'ping',
      repository,
      actor,
      action: rawPayload.action,
    });

    return {
      event: 'ping',
      deliveryId,
      isPing: true,
      repository,
      actor,
      metadata,
      payload: rawPayload,
    };
  }

  // 2. Repository information is mandatory for push, pull_request, pull_request_review, repository
  if (!rawPayload.repository || typeof rawPayload.repository !== 'object') {
    throw new BadRequestException(`Missing required repository object for GitHub event: ${event}`);
  }

  const repository = extractRepository(rawPayload.repository);
  const actor = rawPayload.sender ? extractActor(rawPayload.sender) : undefined;
  const action = typeof rawPayload.action === 'string' ? rawPayload.action : undefined;

  const metadata = extractWebhookMetadata({
    deliveryId,
    eventType: event,
    repository,
    actor,
    action,
  });

  // 3. Event-specific validations
  switch (event) {
    case 'push': {
      if (!rawPayload.ref || typeof rawPayload.ref !== 'string') {
        throw new BadRequestException('Missing required field: "ref" in push event payload');
      }
      if (!rawPayload.commits || !Array.isArray(rawPayload.commits)) {
        throw new BadRequestException('Missing or invalid field: "commits" in push event payload');
      }
      break;
    }

    case 'pull_request': {
      if (!rawPayload.action || typeof rawPayload.action !== 'string') {
        throw new BadRequestException('Missing required field: "action" in pull_request event payload');
      }
      if (!rawPayload.pull_request || typeof rawPayload.pull_request !== 'object') {
        throw new BadRequestException('Missing required object: "pull_request" in pull_request event payload');
      }
      const pr = rawPayload.pull_request;
      if (pr.id === undefined || pr.number === undefined) {
        throw new BadRequestException('Missing required pull_request identifiers (id, number)');
      }
      break;
    }

    case 'pull_request_review': {
      if (!rawPayload.action || typeof rawPayload.action !== 'string') {
        throw new BadRequestException('Missing required field: "action" in pull_request_review event payload');
      }
      if (!rawPayload.pull_request || typeof rawPayload.pull_request !== 'object') {
        throw new BadRequestException('Missing required object: "pull_request" in pull_request_review event payload');
      }
      if (!rawPayload.review || typeof rawPayload.review !== 'object') {
        throw new BadRequestException('Missing required object: "review" in pull_request_review event payload');
      }
      const review = rawPayload.review;
      if (review.id === undefined || !review.state) {
        throw new BadRequestException('Missing required review identifiers or state');
      }
      break;
    }

    case 'repository': {
      if (!rawPayload.action || typeof rawPayload.action !== 'string') {
        throw new BadRequestException('Missing required field: "action" in repository event payload');
      }
      break;
    }

    default: {
      throw new BadRequestException(`Unsupported GitHub webhook event: ${event}`);
    }
  }

  return {
    event: event as SupportedGitHubEvent,
    deliveryId,
    isPing: false,
    action,
    repository,
    actor,
    metadata,
    payload: rawPayload,
  };
}

function extractRepository(repo: any): ValidatedRepositoryInfo {
  if (repo.id === undefined || repo.id === null) {
    throw new BadRequestException('Repository missing required field: id');
  }
  if (!repo.name || typeof repo.name !== 'string') {
    throw new BadRequestException('Repository missing required field: name');
  }
  if (!repo.full_name || typeof repo.full_name !== 'string') {
    throw new BadRequestException('Repository missing required field: full_name');
  }

  const ownerLogin = repo.owner?.login || repo.full_name.split('/')[0] || '';
  const ownerId = repo.owner?.id !== undefined ? BigInt(repo.owner.id) : undefined;

  return {
    githubRepoId: BigInt(repo.id),
    name: repo.name,
    fullName: repo.full_name,
    ownerLogin,
    ownerId,
  };
}

function extractActor(sender: any): ValidatedActorInfo {
  return {
    githubUserId: sender.id !== undefined ? BigInt(sender.id) : undefined,
    username: sender.login || 'unknown',
  };
}
