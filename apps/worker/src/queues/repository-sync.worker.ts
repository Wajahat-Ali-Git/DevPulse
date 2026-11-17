import { Injectable, OnModuleInit, Optional } from '@nestjs/common';
import { Job } from 'bullmq';
import {
  QueueName,
  JobName,
  SyncUserRepositoriesPayload,
  SyncSingleRepositoryPayload,
  SyncRepositoryCommitsPayload,
  SyncRepositoryPullRequestsPayload,
  RepositorySyncJobPayload as DedicatedSyncPayload,
} from '@devpulse/types';
import { CorrelationContext, redactCredentialString } from '@devpulse/logger';
import { prisma } from '@devpulse/database';
import { RedisService } from '../redis/redis.service';
import { BaseWorker } from './base.worker';
import { GitHubSyncProcessor } from '../processors/github-sync.processor';

export type RepositorySyncJobPayload =
  | SyncUserRepositoriesPayload
  | SyncSingleRepositoryPayload
  | SyncRepositoryCommitsPayload
  | SyncRepositoryPullRequestsPayload
  | DedicatedSyncPayload;

export interface RepositorySyncJobResult {
  success: boolean;
  jobName: string;
  processedAt: string;
  details?: Record<string, any>;
  data?: any;
}

@Injectable()
export class RepositorySyncWorker extends BaseWorker<RepositorySyncJobPayload, RepositorySyncJobResult> implements OnModuleInit {
  protected readonly queueName = QueueName.REPOSITORY_SYNC;

  constructor(
    redisService: RedisService,
    @Optional() private readonly gitHubSyncProcessor?: GitHubSyncProcessor,
  ) {
    super(redisService, RepositorySyncWorker.name, {
      concurrency: 5,
      limiter: {
        max: 30,
        duration: 60000, // 30 jobs per minute GitHub rate-limit safety
      },
    });
  }

  onModuleInit() {
    this.startWorker();
  }

  async processJob(job: Job<RepositorySyncJobPayload, RepositorySyncJobResult>): Promise<RepositorySyncJobResult> {
    const jobName = job.name;
    const processor = this.gitHubSyncProcessor || new GitHubSyncProcessor();
    const syncId = (job.data as any)?.syncId || String(job.id);
    const userId = (job.data as any)?.userId;

    return CorrelationContext.run({ service: 'worker', jobId: job.id }, async () => {
      this.logger.info(`Starting repository sync job "${jobName}" [${job.id}]`, {
        jobId: job.id,
        jobName,
        payload: job.data,
      });

      // Update SyncRun state to PROCESSING if record exists
      try {
        if (prisma && prisma.syncRun && typeof prisma.syncRun.updateMany === 'function') {
          await prisma.syncRun.updateMany({
            where: {
              OR: [{ id: syncId }, { jobId: String(job.id) }],
            },
            data: {
              status: 'PROCESSING',
              startedAt: new Date(),
              lastProcessedAt: new Date(),
            },
          });
        }
      } catch (err: any) {
        this.logger.debug(`Could not update SyncRun to PROCESSING: ${err?.message}`);
      }

      let syncData: any = undefined;

      try {
        switch (jobName) {
          case JobName.SYNC_USER_REPOSITORIES: {
            syncData = await processor.syncUserRepositories(
              job.data as SyncUserRepositoriesPayload,
              {},
              undefined,
              async (progressUpdate) => {
                if (typeof job.updateProgress === 'function') {
                  await job.updateProgress(progressUpdate.percentage ?? progressUpdate.totalProcessed);
                }
                // Update SyncRun with intermediate progress
                try {
                  if (prisma && prisma.syncRun && typeof prisma.syncRun.updateMany === 'function') {
                    await prisma.syncRun.updateMany({
                      where: {
                        OR: [{ id: syncId }, { jobId: String(job.id) }],
                      },
                      data: {
                        processedItems: progressUpdate.totalProcessed ?? 0,
                        lastProcessedAt: new Date(),
                      },
                    });
                  }
                } catch {
                  // progress tracking failure shouldn't abort job
                }
              },
            );
            break;
          }
          case JobName.SYNC_SINGLE_REPOSITORY: {
            syncData = await processor.syncSingleRepository(job.data as SyncSingleRepositoryPayload);
            if (typeof job.updateProgress === 'function') {
              await job.updateProgress(100);
            }
            break;
          }
          case JobName.SYNC_REPOSITORY_COMMITS: {
            const commitPayload = job.data as SyncRepositoryCommitsPayload;
            // Incremental retrieval checkpoint: if payload.since is not set, look up the latest commit date in DB
            let effectiveSince = commitPayload.since;
            if (!effectiveSince && prisma && prisma.commit && typeof prisma.commit.findFirst === 'function') {
              try {
                const latestCommit = await prisma.commit.findFirst({
                  where: { repositoryId: commitPayload.repositoryId },
                  orderBy: { authorDate: 'desc' },
                  select: { authorDate: true },
                });
                if (latestCommit?.authorDate) {
                  effectiveSince = latestCommit.authorDate.toISOString();
                  this.logger.info(
                    `Using incremental commit sync checkpoint since=${effectiveSince} for repo ${commitPayload.fullName}`,
                  );
                }
              } catch (err: any) {
                this.logger.debug(`Could not determine latest commit checkpoint: ${err?.message}`);
              }
            }

            syncData = await processor.syncRepositoryCommits(
              {
                ...commitPayload,
                since: effectiveSince,
              },
              {},
              undefined,
              async (progressUpdate) => {
                if (typeof job.updateProgress === 'function') {
                  await job.updateProgress(progressUpdate.percentage ?? progressUpdate.totalProcessed);
                }
                // Update SyncRun with intermediate progress
                try {
                  if (prisma && prisma.syncRun && typeof prisma.syncRun.updateMany === 'function') {
                    await prisma.syncRun.updateMany({
                      where: {
                        OR: [{ id: syncId }, { jobId: String(job.id) }],
                      },
                      data: {
                        processedItems: progressUpdate.totalProcessed ?? 0,
                        lastProcessedAt: new Date(),
                      },
                    });
                  }
                } catch {
                  // progress tracking failure shouldn't abort job
                }
              },
            );

            // Persist retrieved commits avoiding duplicate commits and linking authors
            if (syncData?.commits && prisma && prisma.commit && typeof prisma.commit.upsert === 'function') {
              let persistedCount = 0;
              for (const ghCommit of syncData.commits) {
                try {
                  const sha = ghCommit.sha;
                  const message = ghCommit.commit?.message || '';
                  const authorInfo = ghCommit.commit?.author;
                  const committerInfo = ghCommit.commit?.committer;
                  const authorName = authorInfo?.name || ghCommit.author?.login || 'Unknown Author';
                  const authorEmail = authorInfo?.email || 'unknown@example.com';
                  const authorDate = authorInfo?.date ? new Date(authorInfo.date) : new Date();
                  const committerName = committerInfo?.name || ghCommit.committer?.login || null;
                  const committerEmail = committerInfo?.email || null;
                  const committerDate = committerInfo?.date ? new Date(committerInfo.date) : null;
                  const url = ghCommit.html_url || ghCommit.url;
                  const parentShas = Array.isArray(ghCommit.parents)
                    ? ghCommit.parents.map((p: any) => p.sha).filter(Boolean)
                    : [];
                  const authorGithubId = ghCommit.author?.id ? BigInt(ghCommit.author.id) : null;

                  // Resolve authorUserId if an existing GitHubAccount is linked
                  let authorUserId: string | null = null;
                  if (authorGithubId && prisma.gitHubAccount && typeof prisma.gitHubAccount.findFirst === 'function') {
                    const linkedAccount = await prisma.gitHubAccount.findFirst({
                      where: { githubUserId: authorGithubId },
                      select: { userId: true },
                    });
                    if (linkedAccount) {
                      authorUserId = linkedAccount.userId;
                    }
                  }

                  // Fallback match by author email to User if no GitHubAccount link
                  if (!authorUserId && authorEmail && prisma.user && typeof prisma.user.findFirst === 'function') {
                    const matchedUser = await prisma.user.findFirst({
                      where: { email: authorEmail },
                      select: { id: true },
                    });
                    if (matchedUser) {
                      authorUserId = matchedUser.id;
                    }
                  }

                  await prisma.commit.upsert({
                    where: {
                      repositoryId_sha: {
                        repositoryId: commitPayload.repositoryId,
                        sha,
                      },
                    },
                    update: {
                      message,
                      authorName,
                      authorEmail,
                      authorDate,
                      committerName,
                      committerEmail,
                      committerDate,
                      authorUserId,
                      authorGithubId,
                      url,
                      parentShas,
                      rawPayload: ghCommit as any,
                      additions: ghCommit.stats?.additions ?? 0,
                      deletions: ghCommit.stats?.deletions ?? 0,
                      totalChanges: ghCommit.stats?.total ?? 0,
                    },
                    create: {
                      repositoryId: commitPayload.repositoryId,
                      sha,
                      message,
                      authorName,
                      authorEmail,
                      authorDate,
                      committerName,
                      committerEmail,
                      committerDate,
                      authorUserId,
                      authorGithubId,
                      url,
                      parentShas,
                      rawPayload: ghCommit as any,
                      additions: ghCommit.stats?.additions ?? 0,
                      deletions: ghCommit.stats?.deletions ?? 0,
                      totalChanges: ghCommit.stats?.total ?? 0,
                    },
                  });
                  persistedCount++;
                } catch (commitErr: any) {
                  this.logger.warn(
                    `Failed to upsert commit ${ghCommit.sha} for repo ${commitPayload.fullName}: ${commitErr?.message}`,
                  );
                }
              }
              this.logger.info(
                `Persisted/upserted ${persistedCount} commits for repository "${commitPayload.fullName}"`,
              );
            }

            if (typeof job.updateProgress === 'function') {
              await job.updateProgress(100);
            }
            break;
          }
          case JobName.SYNC_REPOSITORY_PULL_REQUESTS: {
            const prPayload = job.data as SyncRepositoryPullRequestsPayload;

            syncData = await processor.syncRepositoryPullRequests(
              prPayload,
              {},
              undefined,
              async (progressUpdate) => {
                if (typeof job.updateProgress === 'function') {
                  await job.updateProgress(progressUpdate.percentage ?? progressUpdate.totalProcessed);
                }
                // Update SyncRun with intermediate progress
                try {
                  if (prisma && prisma.syncRun && typeof prisma.syncRun.updateMany === 'function') {
                    await prisma.syncRun.updateMany({
                      where: {
                        OR: [{ id: syncId }, { jobId: String(job.id) }],
                      },
                      data: {
                        processedItems: progressUpdate.totalProcessed ?? 0,
                        lastProcessedAt: new Date(),
                      },
                    });
                  }
                } catch {
                  // progress tracking failure shouldn't abort job
                }
              },
            );

            // Persist retrieved pull requests avoiding duplicates and tracking lifecycle changes
            if (syncData?.pullRequests && prisma && prisma.pullRequest && typeof prisma.pullRequest.upsert === 'function') {
              let persistedPrCount = 0;
              for (const ghPr of syncData.pullRequests) {
                try {
                  const githubId = BigInt(ghPr.id);
                  const number = ghPr.number;
                  const title = ghPr.title;
                  const body = ghPr.body ?? null;
                  const isMerged = Boolean(ghPr.merged || ghPr.merged_at);
                  // Map state: MERGED if merged, otherwise OPEN or CLOSED
                  const state = isMerged
                    ? 'MERGED'
                    : ghPr.state?.toUpperCase() === 'CLOSED'
                    ? 'CLOSED'
                    : 'OPEN';
                  const authorUsername = ghPr.user?.login || 'unknown';
                  const authorGithubId = ghPr.user?.id ? BigInt(ghPr.user.id) : null;
                  const sourceBranch = ghPr.head?.ref || '';
                  const targetBranch = ghPr.base?.ref || '';
                  const isDraft = Boolean(ghPr.draft);
                  const url = ghPr.html_url || null;
                  const additions = ghPr.additions ?? 0;
                  const deletions = ghPr.deletions ?? 0;
                  const changedFiles = ghPr.changed_files ?? 0;
                  const mergedAt = ghPr.merged_at ? new Date(ghPr.merged_at) : null;
                  const closedAt = ghPr.closed_at ? new Date(ghPr.closed_at) : null;
                  const githubCreatedAt = ghPr.created_at ? new Date(ghPr.created_at) : new Date();
                  const githubUpdatedAt = ghPr.updated_at ? new Date(ghPr.updated_at) : new Date();

                  // Resolve authorUserId if linked GitHubAccount exists
                  let authorUserId: string | null = null;
                  if (authorGithubId && prisma.gitHubAccount && typeof prisma.gitHubAccount.findFirst === 'function') {
                    const linkedAccount = await prisma.gitHubAccount.findFirst({
                      where: { githubUserId: authorGithubId },
                      select: { userId: true },
                    });
                    if (linkedAccount) {
                      authorUserId = linkedAccount.userId;
                    }
                  }

                  await prisma.pullRequest.upsert({
                    where: { githubId },
                    update: {
                      number,
                      title,
                      body,
                      state: state as any,
                      authorUsername,
                      authorUserId,
                      authorGithubId,
                      sourceBranch,
                      targetBranch,
                      isDraft,
                      isMerged,
                      url,
                      rawPayload: ghPr as any,
                      additions,
                      deletions,
                      changedFiles,
                      mergedAt,
                      closedAt,
                      githubCreatedAt,
                      githubUpdatedAt,
                    },
                    create: {
                      repositoryId: prPayload.repositoryId,
                      githubId,
                      number,
                      title,
                      body,
                      state: state as any,
                      authorUsername,
                      authorUserId,
                      authorGithubId,
                      sourceBranch,
                      targetBranch,
                      isDraft,
                      isMerged,
                      url,
                      rawPayload: ghPr as any,
                      additions,
                      deletions,
                      changedFiles,
                      mergedAt,
                      closedAt,
                      githubCreatedAt,
                      githubUpdatedAt,
                    },
                  });
                  persistedPrCount++;
                } catch (prErr: any) {
                  this.logger.warn(
                    `Failed to upsert pull request #${ghPr.number} for repo ${prPayload.fullName}: ${prErr?.message}`,
                  );
                }
              }
              this.logger.info(
                `Persisted/upserted ${persistedPrCount} pull requests for repository "${prPayload.fullName}"`,
              );
            }

            if (typeof job.updateProgress === 'function') {
              await job.updateProgress(100);
            }
            break;
          }
          default: {
            this.logger.warn(`Unknown sync job name: "${jobName}", using default user repositories sync handler`);
            syncData = await processor.syncUserRepositories(
              job.data as SyncUserRepositoriesPayload,
              {},
              undefined,
              async (progressUpdate) => {
                if (typeof job.updateProgress === 'function') {
                  await job.updateProgress(progressUpdate.percentage ?? progressUpdate.totalProcessed);
                }
              },
            );
          }
        }

        // Mark SyncRun as COMPLETED
        try {
          if (prisma && prisma.syncRun && typeof prisma.syncRun.updateMany === 'function') {
            await prisma.syncRun.updateMany({
              where: {
                OR: [{ id: syncId }, { jobId: String(job.id) }],
              },
              data: {
                status: 'COMPLETED',
                completedAt: new Date(),
                lastProcessedAt: new Date(),
                totalItems: syncData?.totalCount ?? 0,
                processedItems: syncData?.totalCount ?? 0,
              },
            });
          }
        } catch (err: any) {
          this.logger.debug(`Could not update SyncRun to COMPLETED: ${err?.message}`);
        }

        return {
          success: true,
          jobName,
          processedAt: new Date().toISOString(),
          details: {
            jobId: job.id,
            syncId,
            userId,
            scope: (job.data as any)?.scope,
            totalCount: syncData?.totalCount,
          },
          data: syncData,
        };
      } catch (error: any) {
        // Mark SyncRun as FAILED on error with sanitized error message
        try {
          if (prisma && prisma.syncRun && typeof prisma.syncRun.updateMany === 'function') {
            const rawErrorMsg = error?.message || 'Sync execution failed';
            const safeErrorMessage = redactCredentialString(rawErrorMsg);
            await prisma.syncRun.updateMany({
              where: {
                OR: [{ id: syncId }, { jobId: String(job.id) }],
              },
              data: {
                status: 'FAILED',
                errorMessage: safeErrorMessage,
                lastProcessedAt: new Date(),
              },
            });
          }
        } catch {
          // ignore
        }
        throw error;
      }
    });
  }
}
