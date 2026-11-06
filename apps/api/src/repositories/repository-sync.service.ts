import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database.service';
import { GitHubClient, GitHubNotFoundError, GitHubForbiddenError, GitHubRepository } from '@devpulse/github';
import { RepositoryStatus } from '@devpulse/database';
import { Logger } from '@devpulse/logger';
import { ResourceNotFoundException, AuthorizationException } from '../common/errors';
import { SyncRepositoryResult, SyncRepositoryOptions } from './types';

@Injectable()
export class RepositorySyncService {
  private readonly logger = new Logger({ service: 'api', context: RepositorySyncService.name });

  constructor(private readonly databaseService: DatabaseService) {}

  /**
   * Upsert a repository using stable GitHub ID (githubId).
   * Automatically handles:
   * 1. Creation if newly tracked.
   * 2. Renaming: updates name and full_name while keeping internal UUID and associations intact.
   * 3. Archival: sets status = ARCHIVED if archived on GitHub.
   * 4. Privacy: updates is_private flag.
   * 5. Active: restores status = ACTIVE if active on GitHub.
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
      // Create new repository
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
      };
    }

    // Detect if renamed
    const isRenamed = existing.fullName !== fullName || existing.name !== name;
    const previousFullName = isRenamed ? existing.fullName : undefined;

    // Detect changes
    const isStatusChanged = existing.status !== targetStatus;
    const isPrivacyChanged = existing.isPrivate !== isPrivate;
    const isBranchChanged = existing.defaultBranch !== (githubRepo.default_branch || 'main');
    const isDescriptionChanged = existing.description !== (githubRepo.description ?? null);
    const isPushedAtChanged = githubRepo.pushed_at
      ? !existing.pushedAt || existing.pushedAt.toISOString() !== new Date(githubRepo.pushed_at).toISOString()
      : false;

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

      if (isRenamed) {
        this.logger.log(
          `Repository renamed from ${previousFullName} to ${fullName} (githubId: ${githubId}, id: ${existing.id})`
        );
      }

      if (isStatusChanged) {
        this.logger.log(
          `Repository ${fullName} status changed from ${existing.status} to ${targetStatus}`
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
      };
    }

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
    };
  }

  /**
   * Synchronizes a single repository by fetching from GitHub and updating the database.
   * Gracefully handles:
   * - 404 Not Found: Repository was deleted or transferred. Deactivates repository record if requested.
   * - 403 Forbidden: Repository became private or access token lost permission. Marks as INACTIVE.
   * - Renamed repositories: GitHub redirects old slug to new slug, and stable githubId updates DB record.
   * - Archived repositories: Marks status as ARCHIVED.
   */
  async syncRepository(
    gitHubClient: GitHubClient,
    owner: string,
    repo: string,
    options: SyncRepositoryOptions
  ): Promise<SyncRepositoryResult> {
    const prisma = this.databaseService.client;
    const lookupFullName = `${owner}/${repo}`;

    try {
      const githubRepo = await gitHubClient.repositories.get(owner, repo);
      return await this.upsertFromGitHub(options.workspaceId, githubRepo);
    } catch (error) {
      // Handle deleted or transferred repository (404)
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
          };
        }

        throw new ResourceNotFoundException(`Repository ${lookupFullName} not found on GitHub`);
      }

      // Handle forbidden or lost access (403)
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
          };
        }

        throw new AuthorizationException(`Access to repository ${lookupFullName} is forbidden or token lacks permission`);
      }

      throw error;
    }
  }

  /**
   * Synchronizes multiple repositories for a user or workspace,
   * handling new, renamed, archived, and deleted/inaccessible repositories.
   */
  async syncBatch(
    workspaceId: string,
    githubRepos: GitHubRepository[]
  ): Promise<SyncRepositoryResult[]> {
    const results: SyncRepositoryResult[] = [];
    for (const repo of githubRepos) {
      const res = await this.upsertFromGitHub(workspaceId, repo);
      results.push(res);
    }
    return results;
  }
}
