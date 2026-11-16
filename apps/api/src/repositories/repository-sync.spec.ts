import assert from 'assert';
import { RepositorySyncService } from './repository-sync.service';
import { GitHubClient, GitHubNotFoundError, GitHubForbiddenError, GitHubRepository } from '@devpulse/github';
import { RepositoryStatus } from '@devpulse/database';
import { AuthorizationException } from '../common/errors';

function makeMockGitHubRepo(overrides: Partial<GitHubRepository> = {}): GitHubRepository {
  return {
    id: 12345678,
    node_id: 'MDEwOlJlcG9zaXRvcnkxMjM0NTY3OA==',
    name: 'devpulse',
    full_name: 'devpulse-org/devpulse',
    private: false,
    owner: {
      id: 999,
      login: 'devpulse-org',
      avatar_url: 'https://avatars.githubusercontent.com/u/999',
      html_url: 'https://github.com/devpulse-org',
      type: 'Organization',
    },
    html_url: 'https://github.com/devpulse-org/devpulse',
    description: 'Engineering analytics platform',
    fork: false,
    url: 'https://api.github.com/repos/devpulse-org/devpulse',
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-02T00:00:00Z',
    pushed_at: '2024-01-03T00:00:00Z',
    git_url: 'git://github.com/devpulse-org/devpulse.git',
    ssh_url: 'git@github.com:devpulse-org/devpulse.git',
    clone_url: 'https://github.com/devpulse-org/devpulse.git',
    default_branch: 'main',
    open_issues_count: 5,
    stargazers_count: 100,
    watchers_count: 100,
    forks_count: 10,
    language: 'TypeScript',
    archived: false,
    disabled: false,
    visibility: 'public',
    ...overrides,
  };
}

class MockPrismaClient {
  public repositories: any[] = [];
  public workspaceMembers: any[] = [];
  public gitHubAccounts: any[] = [];

  gitHubAccount = {
    findFirst: async ({ where }: { where: { id?: string; userId?: string } }) => {
      return (
        this.gitHubAccounts.find((a) => {
          if (where.id && a.id !== where.id) return false;
          if (where.userId && a.userId !== where.userId) return false;
          return true;
        }) || null
      );
    },
  };

  workspaceMember = {
    findUnique: async ({ where }: { where: { workspaceId_userId: { workspaceId: string; userId: string } } }) => {
      const { workspaceId, userId } = where.workspaceId_userId;
      return (
        this.workspaceMembers.find((m) => m.workspaceId === workspaceId && m.userId === userId) || null
      );
    },
    findMany: async ({ where }: { where: { userId?: string } }) => {
      if (where.userId) {
        return this.workspaceMembers.filter((m) => m.userId === where.userId);
      }
      return this.workspaceMembers;
    },
  };

  repository = {
    findUnique: async ({ where }: { where: { githubId?: bigint; id?: string } }) => {
      if (where.githubId !== undefined) {
        return this.repositories.find((r) => r.githubId === where.githubId) || null;
      }
      if (where.id !== undefined) {
        return this.repositories.find((r) => r.id === where.id) || null;
      }
      return null;
    },

    findFirst: async ({ where }: { where: { workspaceId?: string; fullName?: any } }) => {
      return (
        this.repositories.find((r) => {
          const matchWs = !where.workspaceId || r.workspaceId === where.workspaceId;
          const matchName =
            !where.fullName ||
            r.fullName.toLowerCase() ===
              (typeof where.fullName === 'string'
                ? where.fullName.toLowerCase()
                : where.fullName.equals?.toLowerCase());
          return matchWs && matchName;
        }) || null
      );
    },

    findMany: async (args: any = {}) => {
      let filtered = [...this.repositories];
      if (args.where?.workspaceId?.in) {
        filtered = filtered.filter((r) => args.where.workspaceId.in.includes(r.workspaceId));
      }
      if (args.where?.status) {
        filtered = filtered.filter((r) => r.status === args.where.status);
      }
      const skip = args.skip ?? 0;
      const take = args.take ?? filtered.length;
      return filtered.slice(skip, skip + take);
    },

    count: async (args: any = {}) => {
      let filtered = [...this.repositories];
      if (args.where?.workspaceId?.in) {
        filtered = filtered.filter((r) => args.where.workspaceId.in.includes(r.workspaceId));
      }
      if (args.where?.status) {
        filtered = filtered.filter((r) => r.status === args.where.status);
      }
      return filtered.length;
    },

    create: async ({ data }: { data: any }) => {
      const record = {
        id: `repo_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        ...data,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      this.repositories.push(record);
      return record;
    },

    update: async ({ where, data }: { where: { id: string }; data: any }) => {
      const index = this.repositories.findIndex((r) => r.id === where.id);
      if (index === -1) {
        throw new Error(`Repository not found: ${where.id}`);
      }
      const existing = this.repositories[index];
      const updated = {
        ...existing,
        ...data,
        updatedAt: new Date(),
      };
      this.repositories[index] = updated;
      return updated;
    },
  };
}

async function runTests() {
  console.log('=== Running Repository Sync, Isolation & Telemetry Unit Tests ===\n');

  // Test 1: Upsert newly discovered repository creates record using stable githubId
  {
    console.log('Test 1: Upsert newly discovered repository using stable githubId');
    const mockPrisma = new MockPrismaClient();
    const service = new RepositorySyncService({ client: mockPrisma as any } as any);

    const ghRepo = makeMockGitHubRepo({ id: 101, name: 'repo-one', full_name: 'org/repo-one' });
    const result = await service.upsertFromGitHub('ws-123', ghRepo);

    assert.strictEqual(result.action, 'CREATED');
    assert.strictEqual(result.githubId, BigInt(101));
    assert.strictEqual(result.name, 'repo-one');
    assert.strictEqual(result.fullName, 'org/repo-one');
    assert.strictEqual(result.status, RepositoryStatus.ACTIVE);
    assert.strictEqual(result.isRenamed, false);
    assert.ok(result.lastSyncedAt instanceof Date, 'Should record lastSyncedAt timestamp');
    assert.strictEqual(result.lastSyncError, null);
    assert.strictEqual(mockPrisma.repositories.length, 1);
    console.log('  ✔ Created repository record with stable BigInt githubId and recorded sync time\n');
  }

  // Test 2: Handle renamed repositories: update name and full_name while keeping internal ID
  {
    console.log('Test 2: Handle renamed repositories while preserving stable githubId & UUID');
    const mockPrisma = new MockPrismaClient();
    const service = new RepositorySyncService({ client: mockPrisma as any } as any);

    const initialGhRepo = makeMockGitHubRepo({ id: 102, name: 'old-name', full_name: 'org/old-name' });
    const initial = await service.upsertFromGitHub('ws-123', initialGhRepo);
    const originalInternalId = initial.repositoryId;

    const renamedGhRepo = makeMockGitHubRepo({ id: 102, name: 'new-name', full_name: 'org/new-name' });
    const result = await service.upsertFromGitHub('ws-123', renamedGhRepo);

    assert.strictEqual(result.action, 'UPDATED');
    assert.strictEqual(result.isRenamed, true);
    assert.strictEqual(result.previousFullName, 'org/old-name');
    assert.strictEqual(result.fullName, 'org/new-name');
    assert.strictEqual(result.repositoryId, originalInternalId);
    assert.strictEqual(mockPrisma.repositories.length, 1);
    console.log('  ✔ Successfully detected rename and updated record in-place preserving UUID\n');
  }

  // Test 3: Handle archived repositories
  {
    console.log('Test 3: Handle archived repositories');
    const mockPrisma = new MockPrismaClient();
    const service = new RepositorySyncService({ client: mockPrisma as any } as any);

    const activeRepo = makeMockGitHubRepo({ id: 103, archived: false });
    await service.upsertFromGitHub('ws-123', activeRepo);

    const archivedRepo = makeMockGitHubRepo({ id: 103, archived: true });
    const result = await service.upsertFromGitHub('ws-123', archivedRepo);

    assert.strictEqual(result.action, 'UPDATED');
    assert.strictEqual(result.isArchived, true);
    assert.strictEqual(result.status, RepositoryStatus.ARCHIVED);
    console.log('  ✔ Repository status correctly transitioned to ARCHIVED\n');
  }

  // Test 4: Handle private/visibility status changes
  {
    console.log('Test 4: Handle repository visibility / privacy toggles');
    const mockPrisma = new MockPrismaClient();
    const service = new RepositorySyncService({ client: mockPrisma as any } as any);

    const publicRepo = makeMockGitHubRepo({ id: 104, private: false });
    await service.upsertFromGitHub('ws-123', publicRepo);

    const privateRepo = makeMockGitHubRepo({ id: 104, private: true });
    const result = await service.upsertFromGitHub('ws-123', privateRepo);

    assert.strictEqual(result.action, 'UPDATED');
    assert.strictEqual(result.isPrivate, true);
    console.log('  ✔ Privacy change detected and updated\n');
  }

  // Test 5: Handle deleted or inaccessible repositories (404 Not Found) & track error telemetry
  {
    console.log('Test 5: Handle deleted repositories (404 Not Found) & track error telemetry');
    const mockPrisma = new MockPrismaClient();
    const service = new RepositorySyncService({ client: mockPrisma as any } as any);

    const existing = await mockPrisma.repository.create({
      data: {
        workspaceId: 'ws-123',
        githubId: BigInt(105),
        name: 'deleted-repo',
        fullName: 'org/deleted-repo',
        url: 'https://github.com/org/deleted-repo',
        status: RepositoryStatus.ACTIVE,
        isPrivate: false,
        isFork: false,
      },
    });

    const mockGitHubClient = {
      repositories: {
        get: async () => {
          throw new GitHubNotFoundError('Repository not found on GitHub');
        },
      },
    } as unknown as GitHubClient;

    const result = await service.syncRepository(mockGitHubClient, 'org', 'deleted-repo', {
      workspaceId: 'ws-123',
    });

    assert.strictEqual(result.action, 'DEACTIVATED');
    assert.strictEqual(result.status, RepositoryStatus.INACTIVE);
    assert.ok(result.lastSyncError?.includes('Repository not found'));

    const telemetry = service.getSyncTelemetry(existing.id);
    assert.ok(telemetry?.lastSyncError?.includes('Repository not found'));
    console.log('  ✔ Deleted repository caught via 404, deactivated, and error telemetry tracked\n');
  }

  // Test 6: Handle forbidden repositories (403 Forbidden)
  {
    console.log('Test 6: Handle forbidden repositories (403 Forbidden)');
    const mockPrisma = new MockPrismaClient();
    const service = new RepositorySyncService({ client: mockPrisma as any } as any);

    const existing = await mockPrisma.repository.create({
      data: {
        workspaceId: 'ws-123',
        githubId: BigInt(106),
        name: 'forbidden-repo',
        fullName: 'org/forbidden-repo',
        url: 'https://github.com/org/forbidden-repo',
        status: RepositoryStatus.ACTIVE,
        isPrivate: true,
        isFork: false,
      },
    });

    const mockGitHubClient = {
      repositories: {
        get: async () => {
          throw new GitHubForbiddenError('Resource forbidden');
        },
      },
    } as unknown as GitHubClient;

    const result = await service.syncRepository(mockGitHubClient, 'org', 'forbidden-repo', {
      workspaceId: 'ws-123',
    });

    assert.strictEqual(result.action, 'DEACTIVATED');
    assert.strictEqual(result.status, RepositoryStatus.INACTIVE);
    assert.ok(result.lastSyncError?.includes('Resource forbidden'));
    console.log('  ✔ Forbidden repository caught via 403 and marked INACTIVE with error tracked\n');
  }

  // Test 7: User-level data isolation — reject unauthorized workspace access
  {
    console.log('Test 7: User-level data isolation — reject unauthorized workspace access');
    const mockPrisma = new MockPrismaClient();
    mockPrisma.workspaceMembers.push({
      workspaceId: 'ws-authorized',
      userId: 'user-alice',
    });

    const service = new RepositorySyncService({ client: mockPrisma as any } as any);

    // Alice has access to ws-authorized
    const hasAccess = await service.verifyUserWorkspaceAccess('user-alice', 'ws-authorized');
    assert.strictEqual(hasAccess, true);

    // Bob attempts to access ws-authorized -> should throw AuthorizationException
    let caughtError: any;
    try {
      await service.verifyUserWorkspaceAccess('user-bob', 'ws-authorized');
    } catch (err) {
      caughtError = err;
    }
    assert.ok(caughtError instanceof AuthorizationException);
    assert.strictEqual(caughtError.getStatus(), 403);
    console.log('  ✔ User-level workspace access control enforced strictly\n');
  }

  // Test 8: User-level data isolation — list repositories returns only user-authorized repositories
  {
    console.log('Test 8: User-level data isolation — listUserRepositories filters across authorized tenants');
    const mockPrisma = new MockPrismaClient();
    // Alice belongs to ws-A, Bob belongs to ws-B
    mockPrisma.workspaceMembers.push(
      { workspaceId: 'ws-A', userId: 'user-alice' },
      { workspaceId: 'ws-B', userId: 'user-bob' }
    );

    await mockPrisma.repository.create({
      data: {
        workspaceId: 'ws-A',
        githubId: BigInt(301),
        name: 'alice-repo',
        fullName: 'alice/alice-repo',
        url: 'https://...',
        status: RepositoryStatus.ACTIVE,
        isPrivate: false,
        isFork: false,
      },
    });

    await mockPrisma.repository.create({
      data: {
        workspaceId: 'ws-B',
        githubId: BigInt(302),
        name: 'bob-repo',
        fullName: 'bob/bob-repo',
        url: 'https://...',
        status: RepositoryStatus.ACTIVE,
        isPrivate: false,
        isFork: false,
      },
    });

    const service = new RepositorySyncService({ client: mockPrisma as any } as any);

    // Alice queries repositories -> only sees alice-repo
    const aliceRepos = await service.listUserRepositories('user-alice');
    assert.strictEqual(aliceRepos.data.length, 1);
    assert.strictEqual(aliceRepos.data[0].name, 'alice-repo');

    // Bob queries repositories -> only sees bob-repo
    const bobRepos = await service.listUserRepositories('user-bob');
    assert.strictEqual(bobRepos.data.length, 1);
    assert.strictEqual(bobRepos.data[0].name, 'bob-repo');

    // User without workspace memberships receives empty list
    const eveRepos = await service.listUserRepositories('user-eve');
    assert.strictEqual(eveRepos.data.length, 0);
    console.log('  ✔ Multi-tenant user data isolation verified\n');
  }

  // Test 9: Pagination and last-synced telemetry attached to listed repositories
  {
    console.log('Test 9: Paginated user repository fetch with sync telemetry');
    const mockPrisma = new MockPrismaClient();
    mockPrisma.workspaceMembers.push({ workspaceId: 'ws-A', userId: 'user-alice' });

    for (let i = 1; i <= 5; i++) {
      await mockPrisma.repository.create({
        data: {
          workspaceId: 'ws-A',
          githubId: BigInt(400 + i),
          name: `repo-${i}`,
          fullName: `alice/repo-${i}`,
          url: 'https://...',
          status: RepositoryStatus.ACTIVE,
          isPrivate: false,
          isFork: false,
        },
      });
    }

    const service = new RepositorySyncService({ client: mockPrisma as any } as any);

    // Fetch page 1 (perPage 2)
    const page1 = await service.listUserRepositories('user-alice', { page: 1, perPage: 2 });
    assert.strictEqual(page1.data.length, 2);
    assert.strictEqual(page1.pagination.total, 5);
    assert.strictEqual(page1.pagination.totalPages, 3);
    assert.strictEqual(page1.pagination.hasNextPage, true);
    assert.strictEqual(page1.pagination.hasPrevPage, false);

    // Fetch page 3 (last page, 1 item)
    const page3 = await service.listUserRepositories('user-alice', { page: 3, perPage: 2 });
    assert.strictEqual(page3.data.length, 1);
    assert.strictEqual(page3.pagination.hasNextPage, false);
    assert.strictEqual(page3.pagination.hasPrevPage, true);

    console.log('  ✔ Pagination and pagination metadata verified\n');
  }


  // Test 10: Repeated syncs with identical data (idempotency)
  {
    console.log('Test 10: Repeated syncs with unchanged data produces UNCHANGED action without redundant writes');
    const mockPrisma = new MockPrismaClient();
    const service = new RepositorySyncService({ client: mockPrisma as any } as any);

    const ghRepo = makeMockGitHubRepo({
      id: 501,
      name: 'stable-repo',
      full_name: 'org/stable-repo',
      description: 'Original description',
      default_branch: 'main',
      pushed_at: '2024-01-01T12:00:00Z',
    });

    // First sync -> CREATED
    const firstSync = await service.upsertFromGitHub('ws-123', ghRepo);
    assert.strictEqual(firstSync.action, 'CREATED');
    const initialUpdatedAt = mockPrisma.repositories[0].updatedAt;

    // Second sync with exact same data -> UNCHANGED
    const secondSync = await service.upsertFromGitHub('ws-123', ghRepo);
    assert.strictEqual(secondSync.action, 'UNCHANGED');
    assert.strictEqual(secondSync.repositoryId, firstSync.repositoryId);
    assert.strictEqual(secondSync.isRenamed, false);
    assert.strictEqual(mockPrisma.repositories.length, 1);
    assert.strictEqual(mockPrisma.repositories[0].updatedAt.getTime(), initialUpdatedAt.getTime(), 'No DB update when data unchanged');

    // Third sync with exact same data -> UNCHANGED
    const thirdSync = await service.upsertFromGitHub('ws-123', ghRepo);
    assert.strictEqual(thirdSync.action, 'UNCHANGED');
    console.log('  ✔ Repeated syncs are strictly idempotent and return UNCHANGED\n');
  }

  // Test 11: Repeated sync with changed description, default branch, and pushed_at
  {
    console.log('Test 11: Repeated sync detecting changed repository metadata (description, default_branch, pushed_at)');
    const mockPrisma = new MockPrismaClient();
    const service = new RepositorySyncService({ client: mockPrisma as any } as any);

    const initialGhRepo = makeMockGitHubRepo({
      id: 502,
      name: 'evolving-repo',
      full_name: 'org/evolving-repo',
      description: 'Initial description',
      default_branch: 'master',
      pushed_at: '2024-01-01T00:00:00Z',
    });

    const firstSync = await service.upsertFromGitHub('ws-123', initialGhRepo);
    assert.strictEqual(firstSync.action, 'CREATED');

    // Modified data: updated description, default branch changed to main, and new commit pushed
    const updatedGhRepo = makeMockGitHubRepo({
      id: 502,
      name: 'evolving-repo',
      full_name: 'org/evolving-repo',
      description: 'Updated modern documentation and features',
      default_branch: 'main',
      pushed_at: '2024-01-05T15:30:00Z',
    });

    const secondSync = await service.upsertFromGitHub('ws-123', updatedGhRepo);
    assert.strictEqual(secondSync.action, 'UPDATED');
    assert.strictEqual(secondSync.repositoryId, firstSync.repositoryId, 'Internal UUID preserved');
    assert.strictEqual(secondSync.isRenamed, false);

    const stored = mockPrisma.repositories.find((r) => r.githubId === BigInt(502));
    assert.strictEqual(stored.description, 'Updated modern documentation and features');
    assert.strictEqual(stored.defaultBranch, 'main');
    assert.strictEqual(stored.pushedAt.toISOString(), new Date('2024-01-05T15:30:00Z').toISOString());
    console.log('  ✔ Changed repository metadata detected and updated correctly\n');
  }

  // Test 12: Recovery transition from INACTIVE back to ACTIVE on subsequent sync
  {
    console.log('Test 12: Recovery from INACTIVE back to ACTIVE on subsequent sync');
    const mockPrisma = new MockPrismaClient();
    const service = new RepositorySyncService({ client: mockPrisma as any } as any);

    // Repository was previously deactivated (e.g. temporary network / permission loss)
    const existing = await mockPrisma.repository.create({
      data: {
        workspaceId: 'ws-123',
        githubId: BigInt(503),
        name: 'recovering-repo',
        fullName: 'org/recovering-repo',
        url: 'https://github.com/org/recovering-repo',
        status: RepositoryStatus.INACTIVE,
        isPrivate: false,
        isFork: false,
      },
    });

    // Subsequent sync succeeds and repository is active on GitHub
    const activeGhRepo = makeMockGitHubRepo({
      id: 503,
      name: 'recovering-repo',
      full_name: 'org/recovering-repo',
      archived: false,
    });

    const result = await service.upsertFromGitHub('ws-123', activeGhRepo);
    assert.strictEqual(result.action, 'UPDATED');
    assert.strictEqual(result.status, RepositoryStatus.ACTIVE);

    const stored = mockPrisma.repositories.find((r) => r.id === existing.id);
    assert.strictEqual(stored.status, RepositoryStatus.ACTIVE);
    console.log('  ✔ Inactive repository cleanly restored to ACTIVE status on repeated sync\n');
  }

  // Test 13: Unarchive transition from ARCHIVED back to ACTIVE on subsequent sync
  {
    console.log('Test 13: Unarchive transition from ARCHIVED back to ACTIVE');
    const mockPrisma = new MockPrismaClient();
    const service = new RepositorySyncService({ client: mockPrisma as any } as any);

    // Repository initially archived
    const archivedGhRepo = makeMockGitHubRepo({
      id: 504,
      name: 'unarchiving-repo',
      full_name: 'org/unarchiving-repo',
      archived: true,
    });
    const firstSync = await service.upsertFromGitHub('ws-123', archivedGhRepo);
    assert.strictEqual(firstSync.status, RepositoryStatus.ARCHIVED);

    // Unarchived on GitHub
    const unarchivedGhRepo = makeMockGitHubRepo({
      id: 504,
      name: 'unarchiving-repo',
      full_name: 'org/unarchiving-repo',
      archived: false,
    });
    const secondSync = await service.upsertFromGitHub('ws-123', unarchivedGhRepo);
    assert.strictEqual(secondSync.action, 'UPDATED');
    assert.strictEqual(secondSync.status, RepositoryStatus.ACTIVE);
    assert.strictEqual(secondSync.isArchived, false);
    console.log('  ✔ Repository unarchival recognized and status restored to ACTIVE\n');
  }

  // Test 14: Authenticated endpoint initiates repository synchronization and enqueues BullMQ job
  {
    console.log('Test 14: Authenticated endpoint initiates repository synchronization and enqueues BullMQ job');
    const mockPrisma = new MockPrismaClient();
    mockPrisma.workspaceMembers.push({ workspaceId: 'ws-test', userId: 'user-alice' });
    mockPrisma.gitHubAccounts.push({
      id: 'gh-acc-1',
      userId: 'user-alice',
      username: 'alice-gh',
    });

    let enqueuedJobName = '';
    let enqueuedPayload: any = null;
    const mockQueue: any = {
      add: async (name: string, payload: any) => {
        enqueuedJobName = name;
        enqueuedPayload = payload;
        return { id: 'bullmq-job-101' };
      },
    };

    const service = new RepositorySyncService({ client: mockPrisma as any } as any);
    (service as any).syncQueue = mockQueue;

    const controller = new (require('./repositories.controller').RepositoriesController)(service);

    const user = { sub: 'user-alice', email: 'alice@example.com', role: 'MEMBER' };
    const response = await controller.initiateSync(user as any, {
      workspaceId: 'ws-test',
      githubAccountId: 'gh-acc-1',
      forced: true,
    });

    assert.strictEqual(response.status, 'enqueued');
    assert.strictEqual(response.jobId, 'bullmq-job-101');
    assert.strictEqual(response.queueName, 'repository-sync');
    assert.strictEqual(response.jobName, 'sync-user-repositories');
    assert.strictEqual(response.githubAccountId, 'gh-acc-1');
    assert.strictEqual(response.workspaceId, 'ws-test');
    assert.strictEqual(response.userId, 'user-alice');
    assert.ok(response.tracking);
    assert.strictEqual(response.tracking.checkStatusUrl, '/api/v1/sync/bullmq-job-101');
    assert.ok(response.tracking.correlationId);
    assert.strictEqual(response.tracking.pollingIntervalMs, 2000);
    assert.strictEqual(enqueuedJobName, 'sync-user-repositories');
    assert.strictEqual(enqueuedPayload.userId, 'user-alice');
    assert.strictEqual(enqueuedPayload.workspaceId, 'ws-test');
    assert.strictEqual(enqueuedPayload.forced, true);
    assert.strictEqual(enqueuedPayload.githubAccountId, 'gh-acc-1');
    assert.ok(enqueuedPayload.syncId);
    assert.strictEqual(enqueuedPayload.scope, 'all');
    console.log('  ✔ Successfully initiated sync, enqueued BullMQ job, and returned tracking metadata\n');
  }

  // Test 15: Validate that requested GitHub account belongs to authenticated user (rejects foreign account)
  {
    console.log('Test 15: Validate requested GitHub account belongs to authenticated user (rejects foreign account)');
    const mockPrisma = new MockPrismaClient();
    mockPrisma.workspaceMembers.push({ workspaceId: 'ws-test', userId: 'user-alice' });
    mockPrisma.gitHubAccounts.push({
      id: 'gh-acc-bob',
      userId: 'user-bob', // Belongs to Bob, NOT Alice
      username: 'bob-gh',
    });

    const mockQueue: any = { add: async () => ({ id: '1' }) };
    const service = new RepositorySyncService({ client: mockPrisma as any } as any);
    (service as any).syncQueue = mockQueue;

    const controller = new (require('./repositories.controller').RepositoriesController)(service);
    const aliceUser = { sub: 'user-alice', email: 'alice@example.com', role: 'MEMBER' };

    let caughtError: any = null;
    try {
      await controller.initiateSync(aliceUser as any, {
        workspaceId: 'ws-test',
        githubAccountId: 'gh-acc-bob',
      });
    } catch (err) {
      caughtError = err;
    }

    assert.ok(caughtError !== null, 'Should have thrown AuthorizationException');
    assert.strictEqual(caughtError.getStatus(), 403);
    assert.ok(caughtError.message.includes('does not belong to the authenticated user'));
    console.log('  ✔ Foreign GitHub account access rejected with 403 Forbidden\n');
  }

  // Test 16: Reject sync when requested GitHub account does not exist (404 Not Found)
  {
    console.log('Test 16: Reject sync when requested GitHub account does not exist (404 Not Found)');
    const mockPrisma = new MockPrismaClient();
    mockPrisma.workspaceMembers.push({ workspaceId: 'ws-test', userId: 'user-alice' });

    const service = new RepositorySyncService({ client: mockPrisma as any } as any);
    const controller = new (require('./repositories.controller').RepositoriesController)(service);
    const aliceUser = { sub: 'user-alice', email: 'alice@example.com', role: 'MEMBER' };

    let caughtError: any = null;
    try {
      await controller.initiateSync(aliceUser as any, {
        workspaceId: 'ws-test',
        githubAccountId: 'gh-acc-non-existent',
      });
    } catch (err) {
      caughtError = err;
    }

    assert.ok(caughtError !== null, 'Should have thrown ResourceNotFoundException');
    assert.strictEqual(caughtError.getStatus(), 404);
    assert.ok(caughtError.message.includes('not found'));
    console.log('  ✔ Non-existent GitHub account rejected with 404 Not Found\n');
  }

  // Test 17: Default to user primary GitHub account when githubAccountId is omitted
  {
    console.log('Test 17: Default to user primary GitHub account when githubAccountId is omitted');
    const mockPrisma = new MockPrismaClient();
    mockPrisma.workspaceMembers.push({ workspaceId: 'ws-test', userId: 'user-alice' });
    mockPrisma.gitHubAccounts.push({
      id: 'gh-acc-primary',
      userId: 'user-alice',
      username: 'alice-primary',
    });

    const mockQueue: any = { add: async () => ({ id: 'bullmq-job-default' }) };
    const service = new RepositorySyncService({ client: mockPrisma as any } as any);
    (service as any).syncQueue = mockQueue;

    const controller = new (require('./repositories.controller').RepositoriesController)(service);
    const aliceUser = { sub: 'user-alice', email: 'alice@example.com', role: 'MEMBER' };

    const response = await controller.initiateSync(aliceUser as any, {
      workspaceId: 'ws-test',
    });

    assert.strictEqual(response.status, 'enqueued');
    assert.strictEqual(response.githubAccountId, 'gh-acc-primary');
    console.log('  ✔ Successfully defaulted to authenticated user primary linked account\n');
  }

  // Test 18: Reject sync when user has no access to workspace
  {
    console.log('Test 18: Reject sync when user has no access to workspace (403 Forbidden)');
    const mockPrisma = new MockPrismaClient();
    mockPrisma.gitHubAccounts.push({
      id: 'gh-acc-alice',
      userId: 'user-alice',
      username: 'alice-gh',
    });
    // Alice is NOT in workspace 'ws-unauthorized'

    const service = new RepositorySyncService({ client: mockPrisma as any } as any);
    const controller = new (require('./repositories.controller').RepositoriesController)(service);
    const aliceUser = { sub: 'user-alice', email: 'alice@example.com', role: 'MEMBER' };

    let caughtError: any = null;
    try {
      await controller.initiateSync(aliceUser as any, {
        workspaceId: 'ws-unauthorized',
      });
    } catch (err) {
      caughtError = err;
    }

    assert.ok(caughtError !== null, 'Should have thrown AuthorizationException');
    assert.strictEqual(caughtError.getStatus(), 403);
    assert.ok(caughtError.message.includes('access to this workspace'));
    console.log('  ✔ Unauthorized workspace access rejected with 403 Forbidden\n');
  }

  // Test 19: Get synchronization job status and tracking telemetry
  {
    console.log('Test 19: Get synchronization job status and tracking telemetry');
    const mockPrisma = new MockPrismaClient();
    const service = new RepositorySyncService({ client: mockPrisma as any } as any);

    const mockJob = {
      id: 'job-123',
      name: 'sync-user-repositories',
      attemptsMade: 1,
      progress: 50,
      returnvalue: { syncedCount: 10 },
      failedReason: null,
      timestamp: Date.now() - 5000,
      processedOn: Date.now() - 3000,
      finishedOn: Date.now() - 1000,
      getState: async () => 'completed',
    };

    (service as any).syncQueue = {
      getJob: async (id: string) => {
        if (id === 'job-123') return mockJob;
        return null;
      },
    };

    const controller = new (require('./repositories.controller').RepositoriesController)(service);
    const user = { sub: 'user-alice', email: 'alice@example.com', role: 'MEMBER' };

    const statusRes = await controller.getSyncStatus(user as any, 'job-123');
    assert.strictEqual(statusRes.syncId, 'job-123');
    assert.strictEqual(statusRes.jobId, 'job-123');
    assert.strictEqual(statusRes.status, 'completed');
    assert.strictEqual(statusRes.progress, 50);
    assert.strictEqual(statusRes.result.syncedCount, 10);
    assert.strictEqual(statusRes.attemptsMade, 1);
    assert.ok(statusRes.createdAt);
    assert.ok(statusRes.processedAt);
    assert.ok(statusRes.finishedAt);

    // Test non-existent job ID returns 404
    let notFoundErr: any = null;
    try {
      await controller.getSyncStatus(user as any, 'job-unknown');
    } catch (err) {
      notFoundErr = err;
    }
    assert.ok(notFoundErr !== null);
    assert.strictEqual(notFoundErr.getStatus(), 404);
    console.log('  ✔ Sync job status tracking returns complete state and handles 404\n');
  }

  // Test 20: SyncController endpoints: POST /api/v1/sync/repositories, GET /api/v1/sync/:syncId, GET /api/v1/sync/history
  {
    console.log('Test 20: SyncController endpoints (POST /sync/repositories, GET /sync/:syncId, GET /sync/history)');
    const mockPrisma = new MockPrismaClient();
    mockPrisma.workspaceMembers.push(
      { workspaceId: 'ws-1', userId: 'user-alice', role: 'MEMBER' },
      { workspaceId: 'ws-2', userId: 'user-alice', role: 'MEMBER' },
      { workspaceId: 'ws-3', userId: 'user-bob', role: 'MEMBER' },
    );
    mockPrisma.gitHubAccounts.push({
      id: 'gh-alice',
      userId: 'user-alice',
      username: 'alice',
      accessToken: 'token-alice',
    });

    const service = new RepositorySyncService({ client: mockPrisma as any } as any);

    let enqueuedPayload: any = null;
    const mockJobsMap = new Map<string, any>();

    (service as any).syncQueue = {
      add: async (name: string, payload: any, opts: any) => {
        enqueuedPayload = payload;
        const jobId = opts.jobId || 'job-sync-test';
        const jobRecord = {
          id: jobId,
          name,
          data: payload,
          attemptsMade: 1,
          progress: 100,
          returnvalue: { syncedCount: 5 },
          failedReason: null,
          timestamp: Date.now() - 2000,
          processedOn: Date.now() - 1000,
          finishedOn: Date.now(),
          getState: async () => 'completed',
        };
        mockJobsMap.set(jobId, jobRecord);
        return jobRecord;
      },
      getJob: async (id: string) => mockJobsMap.get(id) || null,
    };

    const { SyncController } = require('./sync.controller');
    const syncController = new SyncController(service);
    const alice = { sub: 'user-alice', email: 'alice@example.com', role: 'MEMBER' };
    const bob = { sub: 'user-bob', email: 'bob@example.com', role: 'MEMBER' };

    // 1. POST /api/v1/sync/repositories
    const initRes = await syncController.initiateRepositoriesSync(alice as any, {
      workspaceId: 'ws-1',
      githubAccountId: 'gh-alice',
    });
    assert.strictEqual(initRes.status, 'enqueued');
    assert.strictEqual(initRes.workspaceId, 'ws-1');
    assert.strictEqual(initRes.userId, 'user-alice');
    assert.ok(initRes.syncId);
    assert.strictEqual(initRes.syncId, initRes.jobId);
    assert.strictEqual(initRes.tracking.checkStatusUrl, `/api/v1/sync/${initRes.jobId}`);

    // 2. GET /api/v1/sync/:syncId
    const statusRes = await syncController.getSyncStatus(alice as any, initRes.syncId);
    assert.strictEqual(statusRes.syncId, initRes.syncId);
    assert.strictEqual(statusRes.jobId, initRes.jobId);
    assert.strictEqual(statusRes.status, 'completed');
    assert.strictEqual(statusRes.progress, 100);
    assert.strictEqual(statusRes.result.syncedCount, 5);

    // 3. GET /api/v1/sync/history (Alice sees her workspaces ws-1 and ws-2, but not Bob's ws-3)
    const historyAlice = await syncController.getSyncHistory(alice as any);
    assert.ok(Array.isArray(historyAlice));
    assert.ok(historyAlice.length >= 1);
    assert.strictEqual(historyAlice[0].syncId, initRes.syncId);
    assert.strictEqual(historyAlice[0].workspaceId, 'ws-1');
    assert.strictEqual(historyAlice[0].status, 'completed');

    // Bob cannot see Alice's workspace ws-1 sync history
    const historyBob = await syncController.getSyncHistory(bob as any);
    assert.strictEqual(historyBob.length, 0);

    // Specific workspace history filter
    const historyWs1 = await syncController.getSyncHistory(alice as any, 'ws-1');
    assert.strictEqual(historyWs1.length, 1);
    assert.strictEqual(historyWs1[0].workspaceId, 'ws-1');

    // Alice attempting to query sync history of ws-3 (Bob's workspace) throws 403
    let forbiddenErr: any = null;
    try {
      await syncController.getSyncHistory(alice as any, 'ws-3');
    } catch (err) {
      forbiddenErr = err;
    }
    assert.ok(forbiddenErr !== null);
    assert.strictEqual(forbiddenErr.getStatus(), 403);

    console.log('  ✔ POST /sync/repositories, GET /sync/:syncId, and GET /sync/history work with multi-tenant isolation\n');
  }

  console.log('✅ ALL REPOSITORY SYNC, ISOLATION & TELEMETRY TESTS PASSED!\n');
}

runTests().catch((err) => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
