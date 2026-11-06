import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database.service';
import { GitHubClient, GitHubNotFoundError, GitHubForbiddenError, GitHubRepository } from '@devpulse/github';
import { RepositoryStatus } from '@devpulse/database';
import { Logger } from '@devpulse/logger';
import { ResourceNotFoundException, AuthorizationException } from '../common/errors';
import {
  SyncRepositoryResult,
  SyncRepositoryOptions,
  SyncExecutionRecord,
  ListRepositoriesFilter,
  PaginatedRepositoriesResponse,
} from './types';

@Injectable()
export class RepositorySyncService {
  private readonly logger = new Logger({ service: 'api', context: RepositorySyncService.name });

  // In-memory sync telemetry tracking last successful sync timestamp and error per repository
  private readonly syncStateMap = new Map<string, { lastSyncedAt?: Date; lastSyncError?: string | null }>();

  constructor(private readonly databaseService: DatabaseService) {}

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
