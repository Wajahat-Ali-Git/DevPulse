import * as assert from 'node:assert';
import { PrMetricsService } from './pr-metrics.service';

// ---------------------------------------------------------------------------
// Mock DatabaseService
// ---------------------------------------------------------------------------

function makeQueryRawFn(resultsQueue: any[][]) {
  let callIndex = 0;
  const fn = async (..._args: any[]) => {
    const result = resultsQueue[callIndex] ?? [];
    callIndex++;
    return result;
  };
  return fn as any;
}

function makeMockDatabase(resultsQueue: any[][] = []) {
  const mockClient = {
    $queryRaw: makeQueryRawFn(resultsQueue),
  };
  return { client: mockClient };
}

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
  console.log('Running PrMetricsService Unit Tests...');

  // -------------------------------------------------------------------------
  // getCountSummary
  // -------------------------------------------------------------------------

  {
    // Scenario 1: Mixed PR states (OPEN, CLOSED, MERGED)
    // Merge rate = merged / (closed + merged) * 100
    // 15 merged, 5 closed unmerged, 10 open -> 15 / (5 + 15) * 100 = 75.0%
    const mockRows = [
      { state: 'OPEN', count: bigint(10) },
      { state: 'CLOSED', count: bigint(5) },
      { state: 'MERGED', count: bigint(15) },
    ];
    const db = makeMockDatabase([mockRows]) as any;
    const service = new PrMetricsService(db);

    const summary = await service.getCountSummary({ repositoryId: 'repo-1' });

    assert.strictEqual(summary.open, 10, 'open count match');
    assert.strictEqual(summary.closed, 5, 'closed count match');
    assert.strictEqual(summary.merged, 15, 'merged count match');
    assert.strictEqual(summary.total, 30, 'total count match');
    assert.strictEqual(summary.mergeRatePercent, 75.0, 'merge rate calculation');
    console.log('✔ getCountSummary: correctly calculates counts and merge rate');
  }

  {
    // Scenario 2: Zero closed or merged (only open PRs) -> merge rate should be null
    const mockRows = [{ state: 'OPEN', count: bigint(4) }];
    const db = makeMockDatabase([mockRows]) as any;
    const service = new PrMetricsService(db);

    const summary = await service.getCountSummary({});

    assert.strictEqual(summary.open, 4);
    assert.strictEqual(summary.closed, 0);
    assert.strictEqual(summary.merged, 0);
    assert.strictEqual(summary.total, 4);
    assert.strictEqual(summary.mergeRatePercent, null, 'merge rate null when eligibleClosed is 0');
    console.log('✔ getCountSummary: returns null merge rate when no closed or merged PRs');
  }

  {
    // Scenario 3: Empty results (no PRs at all)
    const db = makeMockDatabase([[]]) as any;
    const service = new PrMetricsService(db);

    const summary = await service.getCountSummary({
      from: new Date('2024-01-01'),
      to: new Date('2024-01-31'),
      workspaceId: 'ws-123',
    });

    assert.deepStrictEqual(summary, {
      total: 0,
      open: 0,
      closed: 0,
      merged: 0,
      mergeRatePercent: null,
    });
    console.log('✔ getCountSummary: returns all zeroes and null rate for empty repository/workspace');
  }

  // -------------------------------------------------------------------------
  // getDurationMetrics
  // -------------------------------------------------------------------------

  {
    // Returns average time to merge and average time to close in seconds
    // First query is merge duration, second query is close duration
    const mergeResult = [{ avg_seconds: '7200.45' }]; // 2 hours
    const closeResult = [{ avg_seconds: '10800.12' }]; // 3 hours
    const db = makeMockDatabase([mergeResult, closeResult]) as any;
    const service = new PrMetricsService(db);

    const durations = await service.getDurationMetrics({ repositoryId: 'repo-1' });

    assert.strictEqual(durations.avgSecondsToMerge, 7200);
    assert.strictEqual(durations.avgSecondsToClose, 10800);
    console.log('✔ getDurationMetrics: rounds valid average duration seconds correctly');
  }

  {
    // Scenario: No merged PRs and no closed PRs (null avg_seconds returned by Postgres AVG())
    const mergeResult = [{ avg_seconds: null }];
    const closeResult = [{ avg_seconds: null }];
    const db = makeMockDatabase([mergeResult, closeResult]) as any;
    const service = new PrMetricsService(db);

    const durations = await service.getDurationMetrics({});

    assert.strictEqual(durations.avgSecondsToMerge, null);
    assert.strictEqual(durations.avgSecondsToClose, null);
    console.log('✔ getDurationMetrics: returns null when no matching duration rows found');
  }

  {
    // Scenario: Empty rows array returned by driver
    const db = makeMockDatabase([[], []]) as any;
    const service = new PrMetricsService(db);

    const durations = await service.getDurationMetrics({ workspaceId: 'ws-1' });

    assert.strictEqual(durations.avgSecondsToMerge, null);
    assert.strictEqual(durations.avgSecondsToClose, null);
    console.log('✔ getDurationMetrics: handles empty database response array safely');
  }

  // -------------------------------------------------------------------------
  // getPrsCreatedOverTime
  // -------------------------------------------------------------------------

  {
    const rawRows = [
      dateRow('2024-02-01T00:00:00Z', 5),
      dateRow('2024-02-02T00:00:00Z', 8),
    ];
    const db = makeMockDatabase([rawRows]) as any;
    const service = new PrMetricsService(db);

    const result = await service.getPrsCreatedOverTime({
      from: new Date('2024-02-01'),
      to: new Date('2024-02-07'),
      granularity: 'day',
    });

    assert.deepStrictEqual(result, [
      { date: '2024-02-01', count: 5 },
      { date: '2024-02-02', count: 8 },
    ]);
    console.log('✔ getPrsCreatedOverTime: maps daily creation counts properly');
  }

  {
    const rawRows = [dateRow('2024-02-05T00:00:00Z', 22)];
    const db = makeMockDatabase([rawRows]) as any;
    const service = new PrMetricsService(db);

    const result = await service.getPrsCreatedOverTime({
      repositoryId: 'repo-1',
      workspaceId: 'ws-1',
      from: new Date('2024-02-01'),
      to: new Date('2024-02-28'),
      granularity: 'week',
    });

    assert.deepStrictEqual(result, [{ date: '2024-02-05', count: 22 }]);
    console.log('✔ getPrsCreatedOverTime: maps weekly creation counts with repository and workspace filters');
  }

  // -------------------------------------------------------------------------
  // getPrsMergedOverTime
  // -------------------------------------------------------------------------

  {
    const rawRows = [
      dateRow('2024-02-01T00:00:00Z', 3),
      dateRow('2024-02-03T00:00:00Z', 6),
    ];
    const db = makeMockDatabase([rawRows]) as any;
    const service = new PrMetricsService(db);

    const result = await service.getPrsMergedOverTime({
      from: new Date('2024-02-01'),
      to: new Date('2024-02-07'),
    });

    assert.deepStrictEqual(result, [
      { date: '2024-02-01', count: 3 },
      { date: '2024-02-03', count: 6 },
    ]);
    console.log('✔ getPrsMergedOverTime: maps daily merged counts properly');
  }

  {
    const db = makeMockDatabase([[]]) as any;
    const service = new PrMetricsService(db);

    const result = await service.getPrsMergedOverTime({
      repositoryId: 'repo-999',
      from: new Date('2099-01-01'),
      to: new Date('2099-01-07'),
    });

    assert.deepStrictEqual(result, []);
    console.log('✔ getPrsMergedOverTime: returns empty array when no PRs merged in period');
  }

  console.log('\n✅ All PrMetricsService tests passed!');
}

runTests().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
