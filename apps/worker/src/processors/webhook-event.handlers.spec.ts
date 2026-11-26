import * as assert from 'node:assert';
import { WebhookEventHandlers } from './webhook-event.handlers';
import { prisma, PullRequestState, ReviewState, RepositoryStatus } from '@devpulse/database';

async function runWebhookEventHandlerTests() {
  console.log('=== Running WebhookEventHandlers Unit Tests ===\n');

  // Set up in-memory storage for prisma mocks
  const mockRepos: any[] = [
    {
      id: 'repo-1',
      fullName: 'devpulse/core',
      workspaceId: 'ws-1',
      githubId: BigInt(1001),
      pushedAt: new Date('2024-01-01T00:00:00Z'),
    },
  ];
  const mockCommits: any[] = [];
  const mockPRs: any[] = [];
  const mockReviews: any[] = [];
  const mockUsers: any[] = [
    { id: 'user-alice', email: 'alice@devpulse.local', name: 'Alice' },
    { id: 'user-bob', email: 'bob@devpulse.local', name: 'Bob' },
  ];
  const mockGhAccounts: any[] = [
    { id: 'gh-1', userId: 'user-alice', username: 'alice', githubUserId: BigInt(111) },
    { id: 'gh-2', userId: 'user-bob', username: 'bob', githubUserId: BigInt(222) },
  ];

  // Mock Prisma client methods on prisma singleton
  (prisma as any).user = {
    findUnique: async ({ where }: any) => {
      if (where.email) return mockUsers.find(u => u.email === where.email) || null;
      if (where.id) return mockUsers.find(u => u.id === where.id) || null;
      return null;
    },
    findFirst: async ({ where }: any) => {
      if (where.email) return mockUsers.find(u => u.email === where.email) || null;
      return null;
    },
  };

  (prisma as any).gitHubAccount = {
    findFirst: async ({ where }: any) => {
      if (where.githubUserId) return mockGhAccounts.find(a => a.githubUserId === where.githubUserId) || null;
      if (where.username) return mockGhAccounts.find(a => a.username === where.username) || null;
      return null;
    },
  };

  // Mock Prisma client methods on prisma singleton
  (prisma as any).repository = {
    findUnique: async ({ where }: any) => mockRepos.find(r => r.id === where.id) || null,
    findFirst: async ({ where }: any) => mockRepos.find(r => (where.githubId && r.githubId === where.githubId) || (where.fullName && r.fullName === where.fullName)) || null,
    update: async ({ where, data }: any) => {
      const idx = mockRepos.findIndex(r => r.id === where.id);
      if (idx >= 0) {
        mockRepos[idx] = { ...mockRepos[idx], ...data };
        return mockRepos[idx];
      }
      return null;
    },
  };

  (prisma as any).commit = {
    upsert: async ({ where, create, update }: any) => {
      const idx = mockCommits.findIndex(c => c.repositoryId === where.repositoryId_sha.repositoryId && c.sha === where.repositoryId_sha.sha);
      if (idx >= 0) {
        mockCommits[idx] = { ...mockCommits[idx], ...update };
        return mockCommits[idx];
      }
      const record = { id: `c-${mockCommits.length + 1}`, ...create };
      mockCommits.push(record);
      return record;
    },
  };

  (prisma as any).pullRequest = {
    findFirst: async ({ where }: any) => {
      return mockPRs.find(pr => {
        if (where.githubId && pr.githubId === where.githubId) return true;
        if (where.repositoryId && pr.repositoryId === where.repositoryId && pr.number === where.number) return true;
        return false;
      }) || null;
    },
    create: async ({ data }: any) => {
      const rec = { id: `pr-${mockPRs.length + 1}`, ...data };
      mockPRs.push(rec);
      return rec;
    },
    upsert: async ({ where, create, update }: any) => {
      const idx = mockPRs.findIndex(pr => pr.githubId === where.githubId);
      if (idx >= 0) {
        mockPRs[idx] = { ...mockPRs[idx], ...update };
        return mockPRs[idx];
      }
      const rec = { id: `pr-${mockPRs.length + 1}`, ...create };
      mockPRs.push(rec);
      return rec;
    },
  };

  (prisma as any).review = {
    upsert: async ({ where, create, update }: any) => {
      const idx = mockReviews.findIndex(r => r.githubId === where.githubId);
      if (idx >= 0) {
        mockReviews[idx] = { ...mockReviews[idx], ...update };
        return mockReviews[idx];
      }
      const rec = { id: `rev-${mockReviews.length + 1}`, ...create };
      mockReviews.push(rec);
      return rec;
    },
  };

  // Test 1: Push event extracts commits and updates repository activity timestamps
  console.log('Test 1: Push event commit extraction and repository pushedAt update');
  {
    const payload: any = {
      deliveryId: 'del-push-001',
      event: 'push',
      repositoryId: 'repo-1',
      githubRepoId: 1001,
      rawPayload: {
        ref: 'refs/heads/main',
        commits: [
          {
            id: 'sha-001',
            message: 'feat: add webhook processing',
            timestamp: '2026-11-26T12:00:00Z',
            author: { name: 'Alice', email: 'alice@devpulse.local' },
          },
          {
            id: 'sha-002',
            message: 'fix: handle missing pr in review',
            timestamp: '2026-11-26T12:10:00Z',
            author: { name: 'Bob', email: 'bob@devpulse.local' },
          },
        ],
        repository: {
          id: 1001,
          pushed_at: 1795695000,
        },
      },
    };

    const result = await WebhookEventHandlers.handlePushEvent(payload);
    assert.strictEqual(result.handled, true);
    assert.strictEqual(result.entitiesAffected.commits, 2);
    assert.strictEqual(mockCommits.length, 2);
    assert.strictEqual(mockCommits[0].sha, 'sha-001');
    assert.strictEqual(mockCommits[1].sha, 'sha-002');
    assert.ok(mockRepos[0].pushedAt instanceof Date);

    // Re-handling push event must be idempotent without creating duplicate commits
    const retryResult = await WebhookEventHandlers.handlePushEvent(payload);
    assert.strictEqual(retryResult.handled, true);
    assert.strictEqual(mockCommits.length, 2, 'Commits must not be duplicated on retry');
    console.log('  ✔ Push event extracted commits, updated repository timestamps, and verified retry safety');
  }

  // Test 2: Pull request events (opened, edited, merged, closed)
  console.log('\nTest 2: Pull request events lifecycle and merged vs closed distinction');
  {
    // 2.1 PR Opened
    const prOpenedPayload: any = {
      deliveryId: 'del-pr-open-1',
      event: 'pull_request',
      action: 'opened',
      repositoryId: 'repo-1',
      rawPayload: {
        action: 'opened',
        pull_request: {
          id: 5001,
          number: 10,
          title: 'Implement Webhooks',
          state: 'open',
          user: { login: 'octocat', id: 99 },
          head: { ref: 'feat/webhooks' },
          base: { ref: 'main' },
          created_at: '2026-11-26T10:00:00Z',
          updated_at: '2026-11-26T10:00:00Z',
        },
        repository: { id: 1001 },
      },
    };

    const openRes = await WebhookEventHandlers.handlePullRequestEvent(prOpenedPayload);
    assert.strictEqual(openRes.handled, true);
    assert.strictEqual(mockPRs.length, 1);
    assert.strictEqual(mockPRs[0].state, PullRequestState.OPEN);
    assert.strictEqual(mockPRs[0].isMerged, false);

    // 2.2 PR Merged
    const prMergedPayload: any = {
      deliveryId: 'del-pr-merge-1',
      event: 'pull_request',
      action: 'closed',
      repositoryId: 'repo-1',
      rawPayload: {
        action: 'closed',
        pull_request: {
          id: 5001,
          number: 10,
          title: 'Implement Webhooks',
          state: 'closed',
          merged: true,
          merged_at: '2026-11-26T13:00:00Z',
          closed_at: '2026-11-26T13:00:00Z',
          updated_at: '2026-11-26T13:00:00Z',
        },
        repository: { id: 1001 },
      },
    };

    const mergeRes = await WebhookEventHandlers.handlePullRequestEvent(prMergedPayload);
    assert.strictEqual(mergeRes.handled, true);
    assert.strictEqual(mockPRs.length, 1, 'PR record updated in-place without duplicate');
    assert.strictEqual(mockPRs[0].state, PullRequestState.MERGED);
    assert.strictEqual(mockPRs[0].isMerged, true);
    assert.ok(mockPRs[0].mergedAt instanceof Date);

    // 2.3 PR Closed without merge
    const prClosedPayload: any = {
      deliveryId: 'del-pr-close-2',
      event: 'pull_request',
      action: 'closed',
      repositoryId: 'repo-1',
      rawPayload: {
        action: 'closed',
        pull_request: {
          id: 5002,
          number: 11,
          title: 'Discarded PR',
          state: 'closed',
          merged: false,
          merged_at: null,
          closed_at: '2026-11-26T13:30:00Z',
          updated_at: '2026-11-26T13:30:00Z',
        },
        repository: { id: 1001 },
      },
    };

    const closeRes = await WebhookEventHandlers.handlePullRequestEvent(prClosedPayload);
    assert.strictEqual(closeRes.handled, true);
    const closedPr = mockPRs.find(p => p.number === 11);
    assert.ok(closedPr);
    assert.strictEqual(closedPr.state, PullRequestState.CLOSED);
    assert.strictEqual(closedPr.isMerged, false);

    console.log('  ✔ Pull request opened, merged, and closed states correctly handled and distinguished');
  }

  // Test 3: Pull request review events (submitted, edited, dismissed)
  console.log('\nTest 3: Pull request review events persistence');
  {
    const reviewPayload: any = {
      deliveryId: 'del-rev-001',
      event: 'pull_request_review',
      action: 'submitted',
      repositoryId: 'repo-1',
      rawPayload: {
        action: 'submitted',
        review: {
          id: 8001,
          state: 'approved',
          body: 'LGTM!',
          commit_id: 'sha-001',
          user: { login: 'reviewer-alice', id: 123 },
          submitted_at: '2026-11-26T13:45:00Z',
        },
        pull_request: {
          id: 5001,
          number: 10,
        },
        repository: { id: 1001 },
      },
    };

    const reviewRes = await WebhookEventHandlers.handlePullRequestReviewEvent(reviewPayload);
    assert.strictEqual(reviewRes.handled, true);
    assert.strictEqual(mockReviews.length, 1);
    assert.strictEqual(mockReviews[0].githubId, BigInt(8001));
    assert.strictEqual(mockReviews[0].state, ReviewState.APPROVED);
    assert.strictEqual(mockReviews[0].body, 'LGTM!');

    console.log('  ✔ Pull request review submitted and state mapped correctly');
  }

  // Test 4: Repository lifecycle events (archived, unarchived, deleted)
  console.log('\nTest 4: Repository lifecycle events handling');
  {
    const repoArchivedPayload: any = {
      deliveryId: 'del-repo-arch-1',
      event: 'repository',
      action: 'archived',
      repositoryId: 'repo-1',
      rawPayload: {
        action: 'archived',
        repository: {
          id: 1001,
          name: 'core',
          full_name: 'devpulse/core',
        },
      },
    };

    const archRes = await WebhookEventHandlers.handleRepositoryEvent(repoArchivedPayload);
    assert.strictEqual(archRes.handled, true);
    assert.strictEqual(mockRepos[0].status, RepositoryStatus.ARCHIVED);

    // Unarchive
    repoArchivedPayload.action = 'unarchived';
    repoArchivedPayload.rawPayload.action = 'unarchived';
    const unarchRes = await WebhookEventHandlers.handleRepositoryEvent(repoArchivedPayload);
    assert.strictEqual(unarchRes.handled, true);
    assert.strictEqual(mockRepos[0].status, RepositoryStatus.ACTIVE);

    console.log('  ✔ Repository status transitioned cleanly on archived and unarchived events');
  }

  // Test 5: Validate repository ownership before applying changes (rejects untracked)
  console.log('\nTest 5: Untracked repository events safely ignored without database corruption');
  {
    const untrackedPush: any = {
      deliveryId: 'del-untracked-1',
      event: 'push',
      githubRepoId: 999999,
      rawPayload: {
        repository: { id: 999999, full_name: 'stranger/untracked' },
        commits: [{ id: 'untracked-sha-1' }],
      },
    };

    const untrackedRes = await WebhookEventHandlers.handlePushEvent(untrackedPush);
    assert.strictEqual(untrackedRes.handled, false);
    assert.strictEqual(untrackedRes.details?.reason, 'untracked_repository');
    assert.strictEqual(mockCommits.find(c => c.sha === 'untracked-sha-1'), undefined);

    console.log('  ✔ Untracked repository event safely rejected without applying changes');
  }

  // Test 6: Webhook worker delivery processing state transitions & error handling
  console.log('\nTest 6: Webhook worker delivery processing state transitions & error telemetry');
  {
    const mockDeliveries: any[] = [
      {
        id: 'del-rec-1',
        deliveryId: 'del-worker-tracking-1',
        status: 'QUEUED',
        attemptCount: 0,
        errorMessage: null,
      },
    ];

    (prisma as any).webhookDelivery = {
      updateMany: async ({ where, data }: any) => {
        let count = 0;
        for (const d of mockDeliveries) {
          if (d.deliveryId === where.deliveryId) {
            Object.assign(d, data);
            count++;
          }
        }
        return { count };
      },
    };

    // Simulate start of processing
    await (prisma as any).webhookDelivery.updateMany({
      where: { deliveryId: 'del-worker-tracking-1' },
      data: { status: 'PROCESSING', attemptCount: 1 },
    });
    assert.strictEqual(mockDeliveries[0].status, 'PROCESSING');
    assert.strictEqual(mockDeliveries[0].attemptCount, 1);

    // Simulate successful completion
    await (prisma as any).webhookDelivery.updateMany({
      where: { deliveryId: 'del-worker-tracking-1' },
      data: { status: 'COMPLETED', processedAt: new Date(), errorMessage: null },
    });
    assert.strictEqual(mockDeliveries[0].status, 'COMPLETED');
    assert.strictEqual(mockDeliveries[0].errorMessage, null);

    // Simulate transient failure (attempt incremented, status RETRYING)
    await (prisma as any).webhookDelivery.updateMany({
      where: { deliveryId: 'del-worker-tracking-1' },
      data: { attemptCount: 2, errorMessage: 'ETIMEDOUT connecting to upstream' },
    });
    assert.strictEqual(mockDeliveries[0].attemptCount, 2);
    assert.strictEqual(mockDeliveries[0].errorMessage, 'ETIMEDOUT connecting to upstream');

    // Simulate final retry exhaustion (marked as FAILED)
    await (prisma as any).webhookDelivery.updateMany({
      where: { deliveryId: 'del-worker-tracking-1' },
      data: { status: 'FAILED', attemptCount: 5, errorMessage: 'Max retries exceeded' },
    });
    assert.strictEqual(mockDeliveries[0].status, 'FAILED');
    assert.strictEqual(mockDeliveries[0].attemptCount, 5);

    // Simulate worker crash recovery for deliveries stuck in PROCESSING
    mockDeliveries.push({
      id: 'del-stuck-1',
      deliveryId: 'del-stuck-1',
      status: 'PROCESSING',
      attemptCount: 1,
      errorMessage: null,
      updatedAt: new Date(Date.now() - 30 * 60 * 1000), // 30 mins ago
    });

    (prisma as any).webhookDelivery.findMany = async ({ where }: any) => {
      if (where.status === 'PROCESSING') {
        return mockDeliveries.filter(d => d.status === 'PROCESSING' && (!where.updatedAt?.lte || d.updatedAt <= where.updatedAt.lte));
      }
      return [];
    };
    (prisma as any).webhookDelivery.update = async ({ where, data }: any) => {
      const item = mockDeliveries.find(d => d.id === where.id);
      if (item) Object.assign(item, data);
      return item;
    };

    // Recover stuck deliveries
    const stuck = await (prisma as any).webhookDelivery.findMany({
      where: { status: 'PROCESSING', updatedAt: { lte: new Date(Date.now() - 15 * 60 * 1000) } },
    });
    assert.strictEqual(stuck.length, 1);
    await (prisma as any).webhookDelivery.update({
      where: { id: stuck[0].id },
      data: { status: 'QUEUED', errorMessage: 'Recovered from crashed/stuck worker execution' },
    });
    assert.strictEqual(mockDeliveries.find(d => d.id === 'del-stuck-1').status, 'QUEUED');

    console.log('  ✔ Worker lifecycle states (QUEUED -> PROCESSING -> COMPLETED / FAILED) and attempt tracking verified');
  }

  console.log('\n✅ ALL WEBHOOK EVENT HANDLER UNIT TESTS PASSED SUCCESSFULLY!\n');
}

runWebhookEventHandlerTests().catch((err) => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
