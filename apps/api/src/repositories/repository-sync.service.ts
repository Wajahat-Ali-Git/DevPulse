import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Queue, ConnectionOptions } from 'bullmq';
import { DatabaseService } from '../database.service';
import { RedisService } from '../redis.service';
import { RepositorySyncQueueService } from './repository-sync-queue.service';
import { GitHubClient, GitHubNotFoundError, GitHubForbiddenError, GitHubRepository } from '@devpulse/github';
import { RepositoryStatus } from '@devpulse/database';
import { Logger } from '@devpulse/logger';
import { QueueName, JobName, SyncUserRepositoriesPayload } from '@devpulse/types';
import { ResourceNotFoundException, AuthorizationException } from '../common/errors';
import {
  SyncRepositoryResult,
  SyncRepositoryOptions,
  SyncExecutionRecord,
  ListRepositoriesFilter,
  PaginatedRepositoriesResponse,
  InitiateSyncRequestDto,
  InitiateSyncResponseDto,
  SyncJobStatusResponseDto,
  SyncHistoryFilter,
  SyncHistoryItemDto,
} from './types';

@Injectable()
export class RepositorySyncService implements OnModuleDestroy {
  private readonly logger = new Logger({ service: 'api', context: RepositorySyncService.name });

  // In-memory sync telemetry tracking last successful sync timestamp and error per repository
  private readonly syncStateMap = new Map<string, { lastSyncedAt?: Date; lastSyncError?: string | null }>();

  // In-memory sync history tracking recent repository synchronization jobs
  private readonly syncHistory: SyncHistoryItemDto[] = [];

  // Lazily initialized BullMQ queue for repository synchronization
  private syncQueue?: Queue;

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly redisService?: RedisService,
    private readonly syncQueueService?: RepositorySyncQueueService,
  ) {}

  /**
   * Returns or lazily creates the BullMQ queue for repository synchronization.
   */
  private getSyncQueue(): Queue {
    if (this.syncQueueService) {
      return this.syncQueueService.getQueue();
    }
    if (!this.syncQueue) {
      const connection = this.redisService?.client as any;
      this.syncQueue = new Queue(QueueName.REPOSITORY_SYNC, {
        connection,
      });
    }
    return this.syncQueue;
  }

  /**
   * Enqueues an asynchronous repository synchronization job.
   * Validates that the requested GitHub account exists and belongs to the authenticated user.
   * Also verifies user workspace membership.
   */
  async enqueueRepositorySync(
    userId: string,
    dto: InitiateSyncRequestDto,
  ): Promise<InitiateSyncResponseDto> {
    const prisma = this.databaseService.client;

    // 1. Enforce user-level data isolation on workspace
    await this.verifyUserWorkspaceAccess(userId, dto.workspaceId);

    // 2. Validate that the requested GitHub account belongs to the authenticated user
    let gitHubAccount;
    if (dto.githubAccountId) {
      gitHubAccount = await prisma.gitHubAccount.findFirst({
        where: {
          id: dto.githubAccountId,
        },
      });

      if (!gitHubAccount) {
        throw new ResourceNotFoundException('Requested GitHub account was not found');
      }

      if (gitHubAccount.userId !== userId) {
        this.logger.warn(
          `User ${userId} attempted to initiate sync with foreign GitHub account ${dto.githubAccountId} owned by ${gitHubAccount.userId}`,
        );
        throw new AuthorizationException(
          'The requested GitHub account does not belong to the authenticated user',
        );
      }
    } else {
      // Find the user's primary linked GitHub account
      gitHubAccount = await prisma.gitHubAccount.findFirst({
        where: {
          userId,
        },
      });

      if (!gitHubAccount) {
        throw new ResourceNotFoundException(
          'No linked GitHub account found for the authenticated user. Please connect a GitHub account first.',
        );
      }
    }

    // 3. Construct job payload and correlation tracking
    const correlationId = `sync_${userId}_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const syncId = correlationId;
    const scope = dto.scope || 'all';
    const payload: SyncUserRepositoriesPayload & { correlationId: string } = {
      userId,
      workspaceId: dto.workspaceId,
      githubAccountId: gitHubAccount.id,
      syncId,
      scope,
      forced: dto.forced ?? false,
      correlationId,
    };

    // 4. Enqueue via dedicated RepositorySyncQueueService or fallback queue
    let job: any;
    if (this.syncQueueService) {
      job = await this.syncQueueService.addSyncUserRepositoriesJob(payload, {
        jobId: syncId,
        correlationId,
      });
    } else {
      const queue = this.getSyncQueue();
      job = await queue.add(JobName.SYNC_USER_REPOSITORIES, payload, {
        jobId: syncId,
      });
    }

    const initiatedAt = new Date().toISOString();
    const jobIdStr = String(job.id);

    // Persist SyncRun record in database for persistent tracking
    try {
      if (prisma && prisma.syncRun && typeof prisma.syncRun.create === 'function') {
        await prisma.syncRun.create({
          data: {
            id: syncId,
            userId,
            githubAccountId: gitHubAccount.id,
            jobId: jobIdStr,
            type: 'USER_REPOSITORIES',
            status: 'QUEUED',
            workspaceId: dto.workspaceId,
            correlationId,
            scope: typeof scope === 'string' ? scope : 'all',
            totalItems: 0,
            processedItems: 0,
          },
        });
      }
    } catch (err: any) {
      this.logger.warn(`Failed to persist SyncRun record for sync ${syncId}: ${err?.message}`);
    }

    this.logger.info(
      `Enqueued repository sync job [${jobIdStr}] for user ${userId} (account: ${gitHubAccount.username}, workspace: ${dto.workspaceId}, corr: ${correlationId})`,
      {
        jobId: jobIdStr,
        userId,
        workspaceId: dto.workspaceId,
        githubAccountId: gitHubAccount.id,
        username: gitHubAccount.username,
        correlationId,
      },
    );

    // Record into sync history
    this.recordSyncHistory({
      syncId: jobIdStr,
      jobId: jobIdStr,
      jobName: JobName.SYNC_USER_REPOSITORIES,
      queueName: QueueName.REPOSITORY_SYNC,
      status: 'enqueued',
      workspaceId: dto.workspaceId,
      userId,
      enqueuedAt: initiatedAt,
    });

    return {
      syncId: jobIdStr,
      jobId: jobIdStr,
      queueName: QueueName.REPOSITORY_SYNC,
      jobName: JobName.SYNC_USER_REPOSITORIES,
      status: 'enqueued',
      initiatedAt,
      githubAccountId: gitHubAccount.id,
      workspaceId: dto.workspaceId,
      userId,
      scope,
      tracking: {
        checkStatusUrl: `/api/v1/sync/${jobIdStr}`,
        correlationId,
        pollingIntervalMs: 2000,
        estimatedTimeoutMs: 120000,
      },
    };
  }

  /**
   * Retrieves tracking and status information for an enqueued synchronization job.
   */
  async getSyncJobStatus(syncOrJobId: string): Promise<SyncJobStatusResponseDto> {
    const prisma = this.databaseService?.client;
    const queue = this.getSyncQueue();
    let job = await queue.getJob(syncOrJobId);

    // If job not found in BullMQ, check Prisma SyncRun table
    let syncRunRecord: any = null;
    if (prisma && prisma.syncRun && typeof prisma.syncRun.findFirst === 'function') {
      try {
        syncRunRecord = await prisma.syncRun.findFirst({
          where: {
            OR: [{ id: syncOrJobId }, { jobId: syncOrJobId }],
          },
        });
      } catch (err: any) {
        this.logger.debug(`Could not query syncRun: ${err?.message}`);
      }
    }

    if (!job && !syncRunRecord) {
      throw new ResourceNotFoundException(`Synchronization job with ID ${syncOrJobId} not found`);
    }

    let state = 'unknown';
    let attemptsMade = 0;
    let progress: number | undefined = undefined;
    let jobIdStr = syncOrJobId;
    let userId: string | undefined = syncRunRecord?.userId;
    let workspaceId: string | undefined = syncRunRecord?.workspaceId;
    let jobReturnValue: any = undefined;
    let failedReason: string | null = syncRunRecord?.errorMessage ?? null;
    let createdAt: string | undefined = syncRunRecord?.createdAt ? new Date(syncRunRecord.createdAt).toISOString() : undefined;
    let processedAt: string | undefined = syncRunRecord?.startedAt ? new Date(syncRunRecord.startedAt).toISOString() : undefined;
    let finishedAt: string | undefined = syncRunRecord?.completedAt ? new Date(syncRunRecord.completedAt).toISOString() : undefined;

    if (job) {
      state = await job.getState();
      attemptsMade = job.attemptsMade ?? 0;
      progress = typeof job.progress === 'number' ? job.progress : undefined;
      jobIdStr = String(job.id);
      userId = job.data?.userId ?? userId;
      workspaceId = job.data?.workspaceId ?? workspaceId;
      jobReturnValue = job.returnvalue;
      failedReason = job.failedReason ?? failedReason;
      createdAt = job.timestamp ? new Date(job.timestamp).toISOString() : createdAt;
      processedAt = job.processedOn ? new Date(job.processedOn).toISOString() : processedAt;
      finishedAt = job.finishedOn ? new Date(job.finishedOn).toISOString() : finishedAt;
    } else if (syncRunRecord) {
      state = syncRunRecord.status.toLowerCase();
      jobIdStr = syncRunRecord.jobId || syncRunRecord.id;
    }

    // Update history entry if present
    const existing = this.syncHistory.find((h) => h.syncId === jobIdStr || h.jobId === jobIdStr);
    if (existing) {
      existing.status = state;
      existing.processedAt = processedAt;
      existing.finishedAt = finishedAt;
      if (job?.finishedOn && job?.processedOn) {
        existing.durationMs = job.finishedOn - job.processedOn;
      }
      existing.error = failedReason ?? null;
      existing.result = jobReturnValue;
    }

    return {
      syncId: jobIdStr,
      jobId: jobIdStr,
      queueName: QueueName.REPOSITORY_SYNC,
      jobName: job?.name || JobName.SYNC_USER_REPOSITORIES,
      status: state as any,
      progress,
      result: jobReturnValue,
      error: failedReason ?? null,
      attemptsMade,
      userId,
      workspaceId,
      createdAt,
      processedAt,
      finishedAt,
    };
  }

  /**
   * Records or updates a sync item in the in-memory sync history.
   */
  recordSyncHistory(item: SyncHistoryItemDto): void {
    const index = this.syncHistory.findIndex((h) => h.syncId === item.syncId || h.jobId === item.jobId);
    if (index >= 0) {
      this.syncHistory[index] = { ...this.syncHistory[index], ...item };
    } else {
      // Keep most recent items at the front, cap history buffer at 500
      this.syncHistory.unshift(item);
      if (this.syncHistory.length > 500) {
        this.syncHistory.pop();
      }
    }
  }

  /**
   * Retrieves synchronization history filtered by authorized workspaces and options.
   */
  async getSyncHistory(
    userId: string,
    filter: SyncHistoryFilter = {},
  ): Promise<SyncHistoryItemDto[]> {
    const prisma = this.databaseService.client;

    let allowedWorkspaceIds: string[];
    if (filter.workspaceId) {
      await this.verifyUserWorkspaceAccess(userId, filter.workspaceId);
      allowedWorkspaceIds = [filter.workspaceId];
    } else {
      const memberships = await prisma.workspaceMember.findMany({
        where: { userId },
        select: { workspaceId: true },
      });
      allowedWorkspaceIds = memberships.map((m: { workspaceId: string }) => m.workspaceId);
    }

    const limit = Math.min(Math.max(filter.limit ?? 20, 1), 100);

    // Try fetching from database SyncRun table first
    if (prisma && prisma.syncRun && typeof prisma.syncRun.findMany === 'function') {
      try {
        const whereClause: any = {
          workspaceId: { in: allowedWorkspaceIds },
        };
        if (filter.status) {
          whereClause.status = filter.status.toUpperCase();
        }

        const dbRuns = await prisma.syncRun.findMany({
          where: whereClause,
          orderBy: { createdAt: 'desc' },
          take: limit,
        });

        if (dbRuns && dbRuns.length > 0) {
          return dbRuns.map((run: any) => ({
            syncId: run.id,
            jobId: run.jobId || run.id,
            jobName: JobName.SYNC_USER_REPOSITORIES,
            queueName: QueueName.REPOSITORY_SYNC,
            status: run.status.toLowerCase(),
            workspaceId: run.workspaceId,
            userId: run.userId,
            enqueuedAt: run.createdAt ? new Date(run.createdAt).toISOString() : new Date().toISOString(),
            processedAt: run.startedAt ? new Date(run.startedAt).toISOString() : undefined,
            finishedAt: run.completedAt ? new Date(run.completedAt).toISOString() : undefined,
            error: run.errorMessage ?? null,
            result: run.processedItems ? { totalCount: run.processedItems } : undefined,
          }));
        }
      } catch (err: any) {
        this.logger.debug(`Could not query syncRun history from database: ${err?.message}`);
      }
    }

    return this.syncHistory
      .filter((item) => {
        if (!allowedWorkspaceIds.includes(item.workspaceId)) {
          return false;
        }
        if (filter.status && item.status.toLowerCase() !== filter.status.toLowerCase()) {
          return false;
        }
        return true;
      })
      .slice(0, limit);
  }

  async onModuleDestroy() {
    if (this.syncQueue) {
      await this.syncQueue.close();
    }
  }


  /**
   * Enforces user-level data isolation.
   * Verifies that the specified user has membership in the workspace.
   * Throws AuthorizationException if the user is not a member.
   */
  async verifyUserWorkspaceAccess(userId: string, workspaceId: string): Promise<boolean> {
    const prisma = this.databaseService.client;
    const membership = await prisma.workspaceMember.findUnique({
      where: {
        workspaceId_userId: {
          workspaceId,
          userId,
        },
      },
    });

    if (!membership) {
      this.logger.warn(`User ${userId} attempted unauthorized access to workspace ${workspaceId}`);
      throw new AuthorizationException('You do not have access to this workspace or its repositories');
    }

    return true;
  }

  /**
   * Retrieves repositories accessible to a user within their authorized workspaces,
   * with pagination and tenant isolation.
   */
  async listUserRepositories(
    userId: string,
    filter: ListRepositoriesFilter = {}
  ): Promise<PaginatedRepositoriesResponse<any>> {
    const prisma = this.databaseService.client;
    const page = Math.max(1, filter.page ?? 1);
    const perPage = Math.min(100, Math.max(1, filter.perPage ?? 20));

    // Determine target workspaces authorized for this user
    let workspaceIds: string[] = [];
    if (filter.workspaceId) {
      await this.verifyUserWorkspaceAccess(userId, filter.workspaceId);
      workspaceIds = [filter.workspaceId];
    } else {
      const memberships = await prisma.workspaceMember.findMany({
        where: { userId },
        select: { workspaceId: true },
      });
      workspaceIds = memberships.map((m) => m.workspaceId);
    }

    if (workspaceIds.length === 0) {
      return {
        data: [],
        pagination: {
          page,
          perPage,
          total: 0,
          totalPages: 0,
          hasNextPage: false,
          hasPrevPage: false,
        },
      };
    }

    const whereClause: any = {
      workspaceId: { in: workspaceIds },
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.search
        ? {
            OR: [
              { name: { contains: filter.search, mode: 'insensitive' } },
              { fullName: { contains: filter.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [items, total] = await Promise.all([
      prisma.repository.findMany({
        where: whereClause,
        skip: (page - 1) * perPage,
        take: perPage,
        orderBy: { updatedAt: 'desc' },
      }),
      prisma.repository.count({ where: whereClause }),
    ]);

    // Augment with last sync telemetry
    const enriched = items.map((repo) => {
      const telemetry = this.syncStateMap.get(repo.id);
      return {
        ...repo,
        lastSyncedAt: telemetry?.lastSyncedAt ?? null,
        lastSyncError: telemetry?.lastSyncError ?? null,
      };
    });

    const totalPages = Math.ceil(total / perPage);

    return {
      data: enriched,
      pagination: {
        page,
        perPage,
        total,
        totalPages,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
      },
    };
  }

  /**
   * Upsert a repository using stable GitHub ID (githubId).
   */
  async upsertFromGitHub(
    workspaceId: string,
    githubRepo: GitHubRepository
  ): Promise<SyncRepositoryResult> {
    const prisma = this.databaseService.client;
    const githubId = BigInt(githubRepo.id);
    const fullName = githubRepo.full_name;
    const name = githubRepo.name;
    const isPrivate = githubRepo.private;
    const isArchived = Boolean(githubRepo.archived);
    const targetStatus = isArchived ? RepositoryStatus.ARCHIVED : RepositoryStatus.ACTIVE;

    // Check existing repository by stable githubId
    const existing = await prisma.repository.findUnique({
      where: { githubId },
    });

    if (!existing) {
      const created = await prisma.repository.create({
        data: {
          workspaceId,
          githubId,
          name,
          fullName,
          description: githubRepo.description ?? null,
          url: githubRepo.html_url,
          defaultBranch: githubRepo.default_branch || 'main',
          isPrivate,
          isFork: githubRepo.fork,
          status: targetStatus,
          pushedAt: githubRepo.pushed_at ? new Date(githubRepo.pushed_at) : null,
        },
      });

      const now = new Date();
      this.recordSyncSuccess(created.id, now);
      this.logger.log(`Created repository record for ${fullName} (githubId: ${githubId})`);

      return {
        repositoryId: created.id,
        githubId,
        name: created.name,
        fullName: created.fullName,
        status: created.status,
        isRenamed: false,
        isArchived,
        isPrivate: created.isPrivate,
        action: 'CREATED',
        lastSyncedAt: now,
        lastSyncError: null,
      };
    }

    // Detect changes
    const isRenamed = existing.fullName !== fullName || existing.name !== name;
    const previousFullName = isRenamed ? existing.fullName : undefined;
    const isStatusChanged = existing.status !== targetStatus;
    const isPrivacyChanged = existing.isPrivate !== isPrivate;
    const isBranchChanged = existing.defaultBranch !== (githubRepo.default_branch || 'main');
    const isDescriptionChanged = existing.description !== (githubRepo.description ?? null);
    const isPushedAtChanged = githubRepo.pushed_at
      ? !existing.pushedAt || existing.pushedAt.toISOString() !== new Date(githubRepo.pushed_at).toISOString()
      : false;

    const now = new Date();

    if (isRenamed || isStatusChanged || isPrivacyChanged || isBranchChanged || isDescriptionChanged || isPushedAtChanged) {
      const updated = await prisma.repository.update({
        where: { id: existing.id },
        data: {
          name,
          fullName,
          description: githubRepo.description ?? null,
          url: githubRepo.html_url,
          defaultBranch: githubRepo.default_branch || 'main',
          isPrivate,
          isFork: githubRepo.fork,
          status: targetStatus,
          pushedAt: githubRepo.pushed_at ? new Date(githubRepo.pushed_at) : existing.pushedAt,
        },
      });

      this.recordSyncSuccess(updated.id, now);

      if (isRenamed) {
        this.logger.log(
          `Repository renamed from ${previousFullName} to ${fullName} (githubId: ${githubId}, id: ${existing.id})`
        );
      }

      return {
        repositoryId: updated.id,
        githubId,
        name: updated.name,
        fullName: updated.fullName,
        status: updated.status,
        isRenamed,
        previousFullName,
        isArchived,
        isPrivate: updated.isPrivate,
        action: 'UPDATED',
        lastSyncedAt: now,
        lastSyncError: null,
      };
    }

    this.recordSyncSuccess(existing.id, now);

    return {
      repositoryId: existing.id,
      githubId,
      name: existing.name,
      fullName: existing.fullName,
      status: existing.status,
      isRenamed: false,
      isArchived,
      isPrivate: existing.isPrivate,
      action: 'UNCHANGED',
      lastSyncedAt: now,
      lastSyncError: null,
    };
  }

  /**
   * Synchronizes a single repository, tracking completion timestamp and errors.
   */
  async syncRepository(
    gitHubClient: GitHubClient,
    owner: string,
    repo: string,
    options: SyncRepositoryOptions
  ): Promise<SyncRepositoryResult> {
    const prisma = this.databaseService.client;
    const lookupFullName = `${owner}/${repo}`;

    // Enforce tenant user-level access if userId provided
    if (options.userId) {
      await this.verifyUserWorkspaceAccess(options.userId, options.workspaceId);
    }

    try {
      const githubRepo = await gitHubClient.repositories.get(owner, repo);
      return await this.upsertFromGitHub(options.workspaceId, githubRepo);
    } catch (error: any) {
      const errorMsg = error?.message || 'Unknown GitHub API error';

      if (error instanceof GitHubNotFoundError) {
        this.logger.warn(`Repository ${lookupFullName} not found on GitHub (deleted or inaccessible)`);

        const existing = await prisma.repository.findFirst({
          where: {
            workspaceId: options.workspaceId,
            fullName: { equals: lookupFullName, mode: 'insensitive' },
          },
        });

        if (existing) {
          const updated = await prisma.repository.update({
            where: { id: existing.id },
            data: { status: RepositoryStatus.INACTIVE },
          });

          this.recordSyncError(existing.id, errorMsg);
          this.logger.log(`Marked deleted/inaccessible repository ${lookupFullName} as INACTIVE`);

          return {
            repositoryId: updated.id,
            githubId: updated.githubId,
            name: updated.name,
            fullName: updated.fullName,
            status: updated.status,
            isRenamed: false,
            isArchived: updated.status === RepositoryStatus.ARCHIVED,
            isPrivate: updated.isPrivate,
            action: 'DEACTIVATED',
            lastSyncError: errorMsg,
          };
        }

        throw new ResourceNotFoundException(`Repository ${lookupFullName} not found on GitHub`);
      }

      if (error instanceof GitHubForbiddenError) {
        this.logger.warn(`Access forbidden for repository ${lookupFullName}`);

        const existing = await prisma.repository.findFirst({
          where: {
            workspaceId: options.workspaceId,
            fullName: { equals: lookupFullName, mode: 'insensitive' },
          },
        });

        if (existing) {
          const updated = await prisma.repository.update({
            where: { id: existing.id },
            data: { status: RepositoryStatus.INACTIVE },
          });

          this.recordSyncError(existing.id, errorMsg);
          this.logger.log(`Marked inaccessible repository ${lookupFullName} as INACTIVE due to 403 Forbidden`);

          return {
            repositoryId: updated.id,
            githubId: updated.githubId,
            name: updated.name,
            fullName: updated.fullName,
            status: updated.status,
            isRenamed: false,
            isArchived: updated.status === RepositoryStatus.ARCHIVED,
            isPrivate: updated.isPrivate,
            action: 'DEACTIVATED',
            lastSyncError: errorMsg,
          };
        }

        throw new AuthorizationException(`Access to repository ${lookupFullName} is forbidden or token lacks permission`);
      }

      // Record sync error on existing repository if identifiable
      const existing = await prisma.repository.findFirst({
        where: {
          workspaceId: options.workspaceId,
          fullName: { equals: lookupFullName, mode: 'insensitive' },
        },
      });
      if (existing) {
        this.recordSyncError(existing.id, errorMsg);
      }

      throw error;
    }
  }

  /**
   * Synchronizes multiple repositories in batch.
   */
  async syncBatch(
    workspaceId: string,
    githubRepos: GitHubRepository[],
    userId?: string
  ): Promise<SyncRepositoryResult[]> {
    if (userId) {
      await this.verifyUserWorkspaceAccess(userId, workspaceId);
    }

    const results: SyncRepositoryResult[] = [];
    for (const repo of githubRepos) {
      const res = await this.upsertFromGitHub(workspaceId, repo);
      results.push(res);
    }
    return results;
  }

  /**
   * Returns sync telemetry (last success and last error) for a repository.
   */
  getSyncTelemetry(repositoryId: string): { lastSyncedAt?: Date; lastSyncError?: string | null } | undefined {
    return this.syncStateMap.get(repositoryId);
  }

  private recordSyncSuccess(repositoryId: string, at: Date): void {
    const existing = this.syncStateMap.get(repositoryId);
    this.syncStateMap.set(repositoryId, {
      ...existing,
      lastSyncedAt: at,
      lastSyncError: null,
    });
  }

  private recordSyncError(repositoryId: string, error: string): void {
    const existing = this.syncStateMap.get(repositoryId);
    this.syncStateMap.set(repositoryId, {
      ...existing,
      lastSyncError: error,
    });
  }
}
