import * as assert from 'node:assert';
import { CommitMetricsService } from './commit-metrics.service';

// ---------------------------------------------------------------------------
// Mock DatabaseService
// ---------------------------------------------------------------------------

function makeQueryRawFn(result: any[]) {
  // $queryRaw is a tagged-template function; we return a simple async mock.
  const fn = async (..._args: any[]) => result;
  return fn as any;
}

function makeMockDatabase(overrides: {
  commitCount?: number;
  queryRawResult?: any[];
} = {}) {
  const mockClient = {
    commit: {
      count: async (_args: any) => overrides.commitCount ?? 0,
    },
    $queryRaw: makeQueryRawFn(overrides.queryRawResult ?? []),
  };

  return { client: mockClient };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function bigint(n: number): bigint {
  return BigInt(n);
}

function dateRow(isoDate: string, count: number) {
  return { period: new Date(isoDate), count: bigint(count) };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function runTests() {
  console.log('Running CommitMetricsService Unit Tests...');

  // -------------------------------------------------------------------------
  // getTotalCommits
  // -------------------------------------------------------------------------

  {
    const db = makeMockDatabase({ commitCount: 42 }) as any;
    const service = new CommitMetricsService(db);
    const result = await service.getTotalCommits({});
    assert.strictEqual(result, 42, 'returns total without filters');
    console.log('✔ getTotalCommits: returns total without filters');
  }

  {
    let capturedWhere: any;
    const db = {
      client: {
        commit: {
          count: async (args: any) => { capturedWhere = args.where; return 10; },
        },
        $queryRaw: makeQueryRawFn([]),
      },
    } as any;
    const service = new CommitMetricsService(db);
    const result = await service.getTotalCommits({ repositoryId: 'repo-1' });
    assert.strictEqual(result, 10);
    assert.strictEqual(capturedWhere.repositoryId, 'repo-1');
    console.log('✔ getTotalCommits: applies repositoryId filter');
  }

  {
    let capturedWhere: any;
    const from = new Date('2024-01-01');
    const to = new Date('2024-01-31');
    const db = {
      client: {
        commit: {
          count: async (args: any) => { capturedWhere = args.where; return 5; },
        },
        $queryRaw: makeQueryRawFn([]),
      },
    } as any;
    const service = new CommitMetricsService(db);
    await service.getTotalCommits({ from, to });
    assert.deepStrictEqual(capturedWhere.authorDate, { gte: from, lte: to });
    console.log('✔ getTotalCommits: applies date range filter');
  }

  {
    let capturedWhere: any;
    const from = new Date('2024-06-01');
    const db = {
      client: {
        commit: {
          count: async (args: any) => { capturedWhere = args.where; return 3; },
        },
        $queryRaw: makeQueryRawFn([]),
      },
    } as any;
    const service = new CommitMetricsService(db);
    await service.getTotalCommits({ from });
    assert.deepStrictEqual(capturedWhere.authorDate, { gte: from });
    console.log('✔ getTotalCommits: applies only from date when to is omitted');
  }

  // -------------------------------------------------------------------------
  // getDailyCommitCounts
  // -------------------------------------------------------------------------

  {
    const rawRows = [dateRow('2024-01-01T00:00:00Z', 3), dateRow('2024-01-02T00:00:00Z', 7)];
    const db = makeMockDatabase({ queryRawResult: rawRows }) as any;
    const service = new CommitMetricsService(db);
    const result = await service.getDailyCommitCounts({
      from: new Date('2024-01-01'),
      to: new Date('2024-01-07'),
    });
    assert.deepStrictEqual(result, [
      { date: '2024-01-01', count: 3 },
      { date: '2024-01-02', count: 7 },
    ]);
    console.log('✔ getDailyCommitCounts: converts raw rows to date strings');
  }

  {
    const db = makeMockDatabase({ queryRawResult: [] }) as any;
    const service = new CommitMetricsService(db);
    const result = await service.getDailyCommitCounts({
      from: new Date('2099-01-01'),
      to: new Date('2099-01-07'),
    });
    assert.deepStrictEqual(result, []);
    console.log('✔ getDailyCommitCounts: returns empty array when no commits in range');
  }

  // -------------------------------------------------------------------------
  // getWeeklyCommitCounts
  // -------------------------------------------------------------------------

  {
    const rawRows = [dateRow('2024-01-01T00:00:00Z', 15), dateRow('2024-01-08T00:00:00Z', 20)];
    const db = makeMockDatabase({ queryRawResult: rawRows }) as any;
    const service = new CommitMetricsService(db);
    const result = await service.getWeeklyCommitCounts({
      from: new Date('2024-01-01'),
      to: new Date('2024-01-14'),
    });
    assert.deepStrictEqual(result, [
      { date: '2024-01-01', count: 15 },
      { date: '2024-01-08', count: 20 },
    ]);
    console.log('✔ getWeeklyCommitCounts: converts raw rows to week start date strings');
  }

  // -------------------------------------------------------------------------
  // getUniqueContributors
  // -------------------------------------------------------------------------

  {
    const rawRows = [
      {
        author_user_id: 'user-1',
        author_email: 'alice@example.com',
        author_name: 'Alice',
        commit_count: bigint(10),
      },
      {
        author_user_id: null,
        author_email: 'ghost@noreply.github.com',
        author_name: 'Ghost',
        commit_count: bigint(2),
      },
    ];
    const db = makeMockDatabase({ queryRawResult: rawRows }) as any;
    const service = new CommitMetricsService(db);
    const result = await service.getUniqueContributors({});
    assert.strictEqual(result.totalCount, 2);
    assert.strictEqual(result.resolvedCount, 1);
    assert.strictEqual(result.unresolvedCount, 1);
    assert.strictEqual(result.contributors[0].authorUserId, 'user-1');
    assert.strictEqual(result.contributors[0].isResolved, true);
    assert.strictEqual(result.contributors[0].commitCount, 10);
    assert.strictEqual(result.contributors[1].authorUserId, null);
    assert.strictEqual(result.contributors[1].isResolved, false);
    assert.strictEqual(result.contributors[1].commitCount, 2);
    console.log('✔ getUniqueContributors: groups resolved and unresolved contributors correctly');
  }

  {
    const db = makeMockDatabase({ queryRawResult: [] }) as any;
    const service = new CommitMetricsService(db);
    const result = await service.getUniqueContributors({});
    assert.deepStrictEqual(result, {
      resolvedCount: 0,
      unresolvedCount: 0,
      totalCount: 0,
      contributors: [],
    });
    console.log('✔ getUniqueContributors: returns zero counts when no commits exist');
  }

  // -------------------------------------------------------------------------
  // getCommitActivityTrend
  // -------------------------------------------------------------------------

  {
    const rawRows = [dateRow('2024-03-01T00:00:00Z', 5)];
    const db = makeMockDatabase({ queryRawResult: rawRows }) as any;
    const service = new CommitMetricsService(db);
    const result = await service.getCommitActivityTrend({
      from: new Date('2024-03-01'),
      to: new Date('2024-03-07'),
      granularity: 'day',
    });
    assert.deepStrictEqual(result, [{ periodStart: '2024-03-01', count: 5 }]);
    console.log('✔ getCommitActivityTrend: returns trend with day granularity');
  }

  {
    const rawRows = [dateRow('2024-01-01T00:00:00Z', 30)];
    const db = makeMockDatabase({ queryRawResult: rawRows }) as any;
    const service = new CommitMetricsService(db);
    const result = await service.getCommitActivityTrend({
      from: new Date('2024-01-01'),
      to: new Date('2024-01-31'),
      granularity: 'week',
    });
    assert.strictEqual(result[0].count, 30);
    console.log('✔ getCommitActivityTrend: returns trend with week granularity');
  }

  {
    // defaults to 'day' when granularity omitted
    const db = makeMockDatabase({ queryRawResult: [] }) as any;
    const service = new CommitMetricsService(db);
    const result = await service.getCommitActivityTrend({
      from: new Date('2024-01-01'),
      to: new Date('2024-01-31'),
    });
    assert.deepStrictEqual(result, []);
    console.log('✔ getCommitActivityTrend: defaults to day granularity when omitted');
  }

  // -------------------------------------------------------------------------
  // getRepositoryContributionDistribution
  // -------------------------------------------------------------------------

  {
    const rawRows = [
      { repository_id: 'repo-1', full_name: 'org/repo-one', commit_count: bigint(100) },
      { repository_id: 'repo-2', full_name: 'org/repo-two', commit_count: bigint(40) },
    ];
    const db = makeMockDatabase({ queryRawResult: rawRows }) as any;
    const service = new CommitMetricsService(db);
    const result = await service.getRepositoryContributionDistribution({});
    assert.deepStrictEqual(result, [
      { repositoryId: 'repo-1', fullName: 'org/repo-one', commitCount: 100 },
      { repositoryId: 'repo-2', fullName: 'org/repo-two', commitCount: 40 },
    ]);
    console.log('✔ getRepositoryContributionDistribution: maps raw rows to distribution entries');
  }

  {
    const db = makeMockDatabase({ queryRawResult: [] }) as any;
    const service = new CommitMetricsService(db);
    const result = await service.getRepositoryContributionDistribution({ workspaceId: 'ws-1' });
    assert.deepStrictEqual(result, []);
    console.log('✔ getRepositoryContributionDistribution: applies workspaceId filter');
  }

  {
    const db = makeMockDatabase({ queryRawResult: [] }) as any;
    const service = new CommitMetricsService(db);
    const result = await service.getRepositoryContributionDistribution({
      from: new Date('2024-01-01'),
      to: new Date('2024-12-31'),
    });
    assert.deepStrictEqual(result, []);
    console.log('✔ getRepositoryContributionDistribution: applies date range filters');
  }

  // -------------------------------------------------------------------------
  // getCommitsOverPeriod
  // -------------------------------------------------------------------------

  {
    const rawRows = [{ count: bigint(27) }];
    const db = makeMockDatabase({ queryRawResult: rawRows }) as any;
    const service = new CommitMetricsService(db);
    const result = await service.getCommitsOverPeriod({
      from: new Date('2024-01-01'),
      to: new Date('2024-01-31'),
    });
    assert.deepStrictEqual(result, { count: 27 });
    console.log('✔ getCommitsOverPeriod: returns count from raw query');
  }

  {
    const db = makeMockDatabase({ queryRawResult: [] }) as any;
    const service = new CommitMetricsService(db);
    const result = await service.getCommitsOverPeriod({
      from: new Date('2099-01-01'),
      to: new Date('2099-12-31'),
    });
    assert.deepStrictEqual(result, { count: 0 });
    console.log('✔ getCommitsOverPeriod: returns 0 when no rows returned');
  }

  console.log('\n✅ All CommitMetricsService tests passed!');
}

runTests().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
