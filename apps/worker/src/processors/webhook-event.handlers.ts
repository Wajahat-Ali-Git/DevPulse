import {
  prisma,
  PullRequestState,
  ReviewState,
  ActivityEventType,
  RepositoryStatus,
} from '@devpulse/database';
import { Logger } from '@devpulse/logger';
import { WebhookEventPayload } from '@devpulse/types';

export interface WebhookEventHandlingResult {
  handled: boolean;
  event: string;
  action?: string;
  repositoryId?: string;
  entitiesAffected: {
    commits?: number;
    pullRequests?: number;
    reviews?: number;
    repositories?: number;
  };
  details?: Record<string, any>;
}

export class WebhookEventHandlers {
  private static readonly logger = new Logger({ service: 'worker', context: 'WebhookEventHandlers' });

  /**
   * Validates that the repository exists and is tracked in DevPulse.
   */
  static async validateRepositoryOwnership(repositoryId?: string, githubRepoId?: number): Promise<{ id: string; fullName: string; workspaceId: string } | null> {
    if (!prisma?.repository) {
      return null;
    }

    try {
      if (repositoryId) {
        const repo = await prisma.repository.findUnique({
          where: { id: repositoryId },
          select: { id: true, fullName: true, workspaceId: true },
        });
        if (repo) return repo;
      }

      if (githubRepoId) {
        const repo = await prisma.repository.findFirst({
          where: { githubId: BigInt(githubRepoId) },
          select: { id: true, fullName: true, workspaceId: true },
        });
        if (repo) return repo;
      }
    } catch (err) {
      this.logger.warn(`Error resolving repository ownership: ${(err as Error).message}`);
    }

    return null;
  }

  /**
   * Helper to resolve local User ID from GitHub username or GitHub user ID.
   */
  static async resolveUserId(githubUserId?: bigint | number, username?: string, email?: string): Promise<string | null> {
    if (!prisma) return null;

    try {
      if (githubUserId && prisma.gitHubAccount) {
        const account = await prisma.gitHubAccount.findFirst({
          where: { githubUserId: BigInt(githubUserId) },
          select: { userId: true },
        });
        if (account?.userId) return account.userId;
      }

      if (username && prisma.gitHubAccount) {
        const account = await prisma.gitHubAccount.findFirst({
          where: { username },
          select: { userId: true },
        });
        if (account?.userId) return account.userId;
      }

      if (email && prisma.user) {
        const user = await prisma.user.findUnique({
          where: { email },
          select: { id: true },
        });
        if (user?.id) return user.id;
      }
    } catch (err) {
      this.logger.warn(`Error resolving user ID: ${(err as Error).message}`);
    }

    return null;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 1. Push Events Handler
  // ─────────────────────────────────────────────────────────────────────────────
  static async handlePushEvent(payload: WebhookEventPayload): Promise<WebhookEventHandlingResult> {
    const raw = payload.rawPayload || {};
    const repoInfo = await this.validateRepositoryOwnership(payload.repositoryId, payload.githubRepoId || raw.repository?.id);

    if (!repoInfo) {
      this.logger.info(`Ignoring push event for untracked repository: ${payload.repositoryId || payload.githubRepoId || 'unknown'}`);
      return {
        handled: false,
        event: 'push',
        entitiesAffected: {},
        details: { reason: 'untracked_repository' },
      };
    }

    const commits = Array.isArray(raw.commits) ? raw.commits : [];
    let commitsUpserted = 0;
    const pushedDate = raw.repository?.pushed_at ? new Date(raw.repository.pushed_at * 1000 || raw.repository.pushed_at) : new Date();

    if (prisma?.commit && commits.length > 0) {
      for (const c of commits) {
        const sha = c.id || c.sha;
        if (!sha) continue;

        const authorName = c.author?.name || 'unknown';
        const authorEmail = c.author?.email || 'unknown@devpulse.local';
        const authorDate = c.timestamp ? new Date(c.timestamp) : new Date();

        const authorUserId = await this.resolveUserId(c.author?.id, c.author?.username, authorEmail);

        try {
          await prisma.commit.upsert({
            where: {
              repositoryId_sha: {
                repositoryId: repoInfo.id,
                sha,
              },
            },
            update: {
              message: c.message || '',
              authorName,
              authorEmail,
              authorDate,
              authorUserId: authorUserId || undefined,
              authorGithubId: c.author?.id ? BigInt(c.author.id) : undefined,
              url: c.url || null,
              rawPayload: c,
              updatedAt: new Date(),
            },
            create: {
              repositoryId: repoInfo.id,
              sha,
              message: c.message || '',
              authorName,
              authorEmail,
              authorDate,
              authorUserId: authorUserId || null,
              authorGithubId: c.author?.id ? BigInt(c.author.id) : null,
              url: c.url || null,
              parentShas: Array.isArray(c.parents) ? c.parents.map((p: any) => p.id || p.sha || p) : [],
              rawPayload: c,
            },
          });
          commitsUpserted++;
        } catch (err) {
          this.logger.warn(`Failed to upsert commit [${sha}]: ${(err as Error).message}`);
        }
      }
    }

    // Update repository activity timestamps
    if (prisma?.repository) {
      try {
        await prisma.repository.update({
          where: { id: repoInfo.id },
          data: {
            pushedAt: pushedDate,
            lastSyncedAt: new Date(),
            lastCommitSyncAt: new Date(),
            updatedAt: new Date(),
          },
        });
      } catch (err) {
        this.logger.warn(`Failed to update repository pushedAt: ${(err as Error).message}`);
      }
    }

    this.logger.info(`Processed push event for repo ${repoInfo.fullName}: ${commitsUpserted} commits upserted`, {
      repositoryId: repoInfo.id,
      commitsCount: commits.length,
      commitsUpserted,
    });

    return {
      handled: true,
      event: 'push',
      repositoryId: repoInfo.id,
      entitiesAffected: { commits: commitsUpserted },
      details: { ref: raw.ref, commitCount: commits.length },
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 2. Pull Request Events Handler
  // ─────────────────────────────────────────────────────────────────────────────
  static async handlePullRequestEvent(payload: WebhookEventPayload): Promise<WebhookEventHandlingResult> {
    const raw = payload.rawPayload || {};
    const action = payload.action || raw.action;
    const prData = raw.pull_request;

    if (!prData) {
      return { handled: false, event: 'pull_request', action, entitiesAffected: {} };
    }

    const repoInfo = await this.validateRepositoryOwnership(payload.repositoryId, payload.githubRepoId || raw.repository?.id);
    if (!repoInfo) {
      this.logger.info(`Ignoring pull_request event for untracked repository: ${payload.repositoryId || payload.githubRepoId || 'unknown'}`);
      return {
        handled: false,
        event: 'pull_request',
        action,
        entitiesAffected: {},
        details: { reason: 'untracked_repository' },
      };
    }

    const githubId = BigInt(prData.id);
    const prNumber = prData.number;
    const isMerged = Boolean(prData.merged_at || prData.merged);
    const state: PullRequestState = isMerged
      ? PullRequestState.MERGED
      : prData.state === 'closed'
      ? PullRequestState.CLOSED
      : PullRequestState.OPEN;

    const authorUsername = prData.user?.login || 'unknown';
    const authorUserId = await this.resolveUserId(prData.user?.id, authorUsername);

    let prUpserted = false;
    if (prisma?.pullRequest) {
      try {
        await prisma.pullRequest.upsert({
          where: {
            githubId,
          },
          update: {
            number: prNumber,
            title: prData.title || '',
            body: prData.body || null,
            state,
            isMerged,
            isDraft: Boolean(prData.draft),
            sourceBranch: prData.head?.ref || 'unknown',
            targetBranch: prData.base?.ref || 'main',
            url: prData.html_url || null,
            additions: prData.additions ?? 0,
            deletions: prData.deletions ?? 0,
            changedFiles: prData.changed_files ?? 0,
            mergedAt: prData.merged_at ? new Date(prData.merged_at) : null,
            closedAt: prData.closed_at ? new Date(prData.closed_at) : null,
            githubUpdatedAt: prData.updated_at ? new Date(prData.updated_at) : new Date(),
            rawPayload: prData,
            authorUserId: authorUserId || undefined,
            updatedAt: new Date(),
          },
          create: {
            repositoryId: repoInfo.id,
            githubId,
            number: prNumber,
            title: prData.title || '',
            body: prData.body || null,
            state,
            isMerged,
            isDraft: Boolean(prData.draft),
            sourceBranch: prData.head?.ref || 'unknown',
            targetBranch: prData.base?.ref || 'main',
            authorUsername,
            authorUserId: authorUserId || null,
            authorGithubId: prData.user?.id ? BigInt(prData.user.id) : null,
            url: prData.html_url || null,
            additions: prData.additions ?? 0,
            deletions: prData.deletions ?? 0,
            changedFiles: prData.changed_files ?? 0,
            mergedAt: prData.merged_at ? new Date(prData.merged_at) : null,
            closedAt: prData.closed_at ? new Date(prData.closed_at) : null,
            githubCreatedAt: prData.created_at ? new Date(prData.created_at) : new Date(),
            githubUpdatedAt: prData.updated_at ? new Date(prData.updated_at) : new Date(),
            rawPayload: prData,
          },
        });
        prUpserted = true;
      } catch (err) {
        this.logger.warn(`Failed to upsert pull request #${prNumber}: ${(err as Error).message}`);
      }
    }

    // Update repository lastPrSyncAt
    if (prisma?.repository) {
      try {
        await prisma.repository.update({
          where: { id: repoInfo.id },
          data: {
            lastSyncedAt: new Date(),
            lastPrSyncAt: new Date(),
          },
        });
      } catch (err) {
        this.logger.warn(`Failed to update repo lastPrSyncAt: ${(err as Error).message}`);
      }
    }

    this.logger.info(`Processed pull_request event [${action}] for #${prNumber} on ${repoInfo.fullName} (state: ${state}, merged: ${isMerged})`);

    return {
      handled: true,
      event: 'pull_request',
      action,
      repositoryId: repoInfo.id,
      entitiesAffected: { pullRequests: prUpserted ? 1 : 0 },
      details: { prNumber, state, isMerged },
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 3. Pull Request Review Events Handler
  // ─────────────────────────────────────────────────────────────────────────────
  static async handlePullRequestReviewEvent(payload: WebhookEventPayload): Promise<WebhookEventHandlingResult> {
    const raw = payload.rawPayload || {};
    const action = payload.action || raw.action;
    const reviewData = raw.review;
    const prData = raw.pull_request;

    if (!reviewData || !prData) {
      return { handled: false, event: 'pull_request_review', action, entitiesAffected: {} };
    }

    const repoInfo = await this.validateRepositoryOwnership(payload.repositoryId, payload.githubRepoId || raw.repository?.id);
    if (!repoInfo) {
      return {
        handled: false,
        event: 'pull_request_review',
        action,
        entitiesAffected: {},
        details: { reason: 'untracked_repository' },
      };
    }

    // First ensure the parent PullRequest record exists in database
    let localPullRequestId: string | undefined;
    if (prisma?.pullRequest) {
      const existingPr = await prisma.pullRequest.findFirst({
        where: {
          OR: [
            { githubId: BigInt(prData.id) },
            { repositoryId: repoInfo.id, number: prData.number },
          ],
        },
        select: { id: true },
      });

      if (existingPr) {
        localPullRequestId = existingPr.id;
      } else {
        // Upsert pull request stub
        try {
          const createdPr = await prisma.pullRequest.create({
            data: {
              repositoryId: repoInfo.id,
              githubId: BigInt(prData.id),
              number: prData.number,
              title: prData.title || `PR #${prData.number}`,
              sourceBranch: prData.head?.ref || 'unknown',
              targetBranch: prData.base?.ref || 'main',
              authorUsername: prData.user?.login || 'unknown',
              githubCreatedAt: prData.created_at ? new Date(prData.created_at) : new Date(),
              githubUpdatedAt: prData.updated_at ? new Date(prData.updated_at) : new Date(),
            },
            select: { id: true },
          });
          localPullRequestId = createdPr.id;
        } catch (err) {
          this.logger.warn(`Failed to create PR stub for review: ${(err as Error).message}`);
        }
      }
    }

    if (!localPullRequestId) {
      this.logger.warn(`Cannot persist review: local PullRequest not found or failed to create`);
      return { handled: false, event: 'pull_request_review', action, entitiesAffected: {} };
    }

    // Map GitHub review state to ReviewState enum
    let reviewState: ReviewState = ReviewState.COMMENTED;
    const stateStr = (reviewData.state || '').toUpperCase();
    if (stateStr === 'APPROVED') reviewState = ReviewState.APPROVED;
    else if (stateStr === 'CHANGES_REQUESTED') reviewState = ReviewState.CHANGES_REQUESTED;
    else if (stateStr === 'DISMISSED') reviewState = ReviewState.DISMISSED;
    else if (stateStr === 'PENDING') reviewState = ReviewState.PENDING;

    const authorUsername = reviewData.user?.login || 'unknown';
    const authorUserId = await this.resolveUserId(reviewData.user?.id, authorUsername);

    let reviewUpserted = false;
    if (prisma?.review) {
      try {
        await prisma.review.upsert({
          where: {
            githubId: BigInt(reviewData.id),
          },
          update: {
            state: reviewState,
            body: reviewData.body || null,
            commitSha: reviewData.commit_id || null,
            url: reviewData.html_url || null,
            submittedAt: reviewData.submitted_at ? new Date(reviewData.submitted_at) : new Date(),
            authorUserId: authorUserId || undefined,
            updatedAt: new Date(),
          },
          create: {
            pullRequestId: localPullRequestId,
            githubId: BigInt(reviewData.id),
            authorUsername,
            authorUserId: authorUserId || null,
            state: reviewState,
            body: reviewData.body || null,
            commitSha: reviewData.commit_id || null,
            url: reviewData.html_url || null,
            submittedAt: reviewData.submitted_at ? new Date(reviewData.submitted_at) : new Date(),
          },
        });
        reviewUpserted = true;
      } catch (err) {
        this.logger.warn(`Failed to upsert review [${reviewData.id}]: ${(err as Error).message}`);
      }
    }

    this.logger.info(`Processed pull_request_review event [${action}] for review ${reviewData.id} (state: ${reviewState})`);

    return {
      handled: true,
      event: 'pull_request_review',
      action,
      repositoryId: repoInfo.id,
      entitiesAffected: { reviews: reviewUpserted ? 1 : 0 },
      details: { reviewId: reviewData.id, reviewState },
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 4. Repository Lifecycle Events Handler
  // ─────────────────────────────────────────────────────────────────────────────
  static async handleRepositoryEvent(payload: WebhookEventPayload): Promise<WebhookEventHandlingResult> {
    const raw = payload.rawPayload || {};
    const action = payload.action || raw.action;
    const repoData = raw.repository;

    if (!repoData) {
      return { handled: false, event: 'repository', action, entitiesAffected: {} };
    }

    const repoInfo = await this.validateRepositoryOwnership(payload.repositoryId, payload.githubRepoId || repoData.id);
    if (!repoInfo) {
      this.logger.info(`Repository event for untracked repository: ${repoData.full_name}`);
      return {
        handled: false,
        event: 'repository',
        action,
        entitiesAffected: {},
        details: { reason: 'untracked_repository' },
      };
    }

    // Determine status based on action
    let newStatus: RepositoryStatus | undefined;
    if (action === 'archived') {
      newStatus = RepositoryStatus.ARCHIVED;
    } else if (action === 'unarchived') {
      newStatus = RepositoryStatus.ACTIVE;
    } else if (action === 'deleted') {
      newStatus = RepositoryStatus.INACTIVE;
    }

    let repoUpdated = false;
    if (prisma?.repository) {
      try {
        await prisma.repository.update({
          where: { id: repoInfo.id },
          data: {
            name: repoData.name || undefined,
            fullName: repoData.full_name || undefined,
            description: repoData.description !== undefined ? repoData.description : undefined,
            defaultBranch: repoData.default_branch || undefined,
            isPrivate: repoData.private !== undefined ? Boolean(repoData.private) : undefined,
            status: newStatus || undefined,
            updatedAt: new Date(),
          },
        });
        repoUpdated = true;
      } catch (err) {
        this.logger.warn(`Failed to update repository metadata on repository event: ${(err as Error).message}`);
      }
    }

    this.logger.info(`Processed repository event [${action}] for ${repoInfo.fullName} (status: ${newStatus || 'unchanged'})`);

    return {
      handled: true,
      event: 'repository',
      action,
      repositoryId: repoInfo.id,
      entitiesAffected: { repositories: repoUpdated ? 1 : 0 },
      details: { action, newStatus },
    };
  }
}
