import assert from 'assert';
import { RepositorySyncService } from './repository-sync.service';
import { GitHubClient, GitHubNotFoundError, GitHubForbiddenError, GitHubRepository } from '@devpulse/github';
import { RepositoryStatus } from '@devpulse/database';

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
  console.log('=== Running Repository Sync & Identifier Stability Unit Tests ===\n');

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
    assert.strictEqual(mockPrisma.repositories.length, 1);
    console.log('  ✔ Created repository record with stable BigInt githubId\n');
  }

  // Test 2: Handle renamed repositories: update name and full_name while keeping internal ID and relations intact
  {
    console.log('Test 2: Handle renamed repositories while preserving stable githubId & UUID');
    const mockPrisma = new MockPrismaClient();
    const service = new RepositorySyncService({ client: mockPrisma as any } as any);

    // Initial repo record
    const initialGhRepo = makeMockGitHubRepo({ id: 102, name: 'old-name', full_name: 'org/old-name' });
    const initial = await service.upsertFromGitHub('ws-123', initialGhRepo);
    const originalInternalId = initial.repositoryId;

    // Repo was renamed on GitHub: same githubId (102), but new slug 'org/new-name'
    const renamedGhRepo = makeMockGitHubRepo({ id: 102, name: 'new-name', full_name: 'org/new-name' });
    const result = await service.upsertFromGitHub('ws-123', renamedGhRepo);

    assert.strictEqual(result.action, 'UPDATED');
    assert.strictEqual(result.isRenamed, true);
    assert.strictEqual(result.previousFullName, 'org/old-name');
    assert.strictEqual(result.fullName, 'org/new-name');
    assert.strictEqual(result.repositoryId, originalInternalId, 'Internal UUID must be preserved across renames');
    assert.strictEqual(mockPrisma.repositories.length, 1, 'Should not create duplicate rows for renamed repo');
    console.log('  ✔ Successfully detected rename and updated record in-place preserving UUID\n');
  }

  // Test 3: Handle archived repositories: status updated to ARCHIVED
  {
    console.log('Test 3: Handle archived repositories');
    const mockPrisma = new MockPrismaClient();
    const service = new RepositorySyncService({ client: mockPrisma as any } as any);

    // Create active repo
    const activeRepo = makeMockGitHubRepo({ id: 103, archived: false });
    await service.upsertFromGitHub('ws-123', activeRepo);

    // Now repository is archived on GitHub
    const archivedRepo = makeMockGitHubRepo({ id: 103, archived: true });
    const result = await service.upsertFromGitHub('ws-123', archivedRepo);

    assert.strictEqual(result.action, 'UPDATED');
    assert.strictEqual(result.isArchived, true);
    assert.strictEqual(result.status, RepositoryStatus.ARCHIVED);

    const stored = mockPrisma.repositories.find((r) => r.githubId === BigInt(103));
    assert.strictEqual(stored.status, RepositoryStatus.ARCHIVED);
    console.log('  ✔ Repository status correctly transitioned to ARCHIVED\n');
  }

  // Test 4: Handle private/visibility status changes
  {
    console.log('Test 4: Handle repository visibility / privacy toggles');
    const mockPrisma = new MockPrismaClient();
    const service = new RepositorySyncService({ client: mockPrisma as any } as any);

    const publicRepo = makeMockGitHubRepo({ id: 104, private: false });
    await service.upsertFromGitHub('ws-123', publicRepo);

    // Repository was made private
    const privateRepo = makeMockGitHubRepo({ id: 104, private: true });
    const result = await service.upsertFromGitHub('ws-123', privateRepo);

    assert.strictEqual(result.action, 'UPDATED');
    assert.strictEqual(result.isPrivate, true);

    const stored = mockPrisma.repositories.find((r) => r.githubId === BigInt(104));
    assert.strictEqual(stored.isPrivate, true);
    console.log('  ✔ Privacy change detected and updated\n');
  }

  // Test 5: Handle deleted or inaccessible repositories (404 Not Found)
  {
    console.log('Test 5: Handle deleted or inaccessible repositories (404 Not Found)');
    const mockPrisma = new MockPrismaClient();
    const service = new RepositorySyncService({ client: mockPrisma as any } as any);

    // Pre-populate an existing repository in DB
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

    const stored = mockPrisma.repositories.find((r) => r.id === existing.id);
    assert.strictEqual(stored.status, RepositoryStatus.INACTIVE);
    console.log('  ✔ Deleted repository caught via 404 and deactivated gracefully\n');
  }

  // Test 6: Handle forbidden repositories (403 Forbidden - lost collaborator access or token revoked)
  {
    console.log('Test 6: Handle forbidden repositories (403 Forbidden)');
    const mockPrisma = new MockPrismaClient();
    const service = new RepositorySyncService({ client: mockPrisma as any } as any);

    // Pre-populate an existing repository in DB
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

    const stored = mockPrisma.repositories.find((r) => r.id === existing.id);
    assert.strictEqual(stored.status, RepositoryStatus.INACTIVE);
    console.log('  ✔ Forbidden repository caught via 403 and marked INACTIVE\n');
  }

  // Test 7: Batch sync processes multiple repositories correctly
  {
    console.log('Test 7: Batch repository synchronization');
    const mockPrisma = new MockPrismaClient();
    const service = new RepositorySyncService({ client: mockPrisma as any } as any);

    const repos = [
      makeMockGitHubRepo({ id: 201, name: 'repo-a', full_name: 'org/repo-a' }),
      makeMockGitHubRepo({ id: 202, name: 'repo-b', full_name: 'org/repo-b', archived: true }),
      makeMockGitHubRepo({ id: 203, name: 'repo-c', full_name: 'org/repo-c', private: true }),
    ];

    const results = await service.syncBatch('ws-123', repos);
    assert.strictEqual(results.length, 3);
    assert.strictEqual(results[0].status, RepositoryStatus.ACTIVE);
    assert.strictEqual(results[1].status, RepositoryStatus.ARCHIVED);
    assert.strictEqual(results[2].isPrivate, true);
    assert.strictEqual(mockPrisma.repositories.length, 3);
    console.log('  ✔ Batch synchronization succeeded across diverse repository states\n');
  }

  console.log('✅ ALL REPOSITORY SYNC & IDENTIFIER STABILITY TESTS PASSED!\n');
}

runTests().catch((err) => {
  console.error('Test failed with error:', err);
  process.exit(1);
});

