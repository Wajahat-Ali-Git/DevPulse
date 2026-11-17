import * as assert from 'node:assert';
import { GitHubSyncProcessor } from './github-sync.processor';

async function runTests() {
  console.log('=== Running GitHubSyncProcessor Unit Tests ===\n');

  const processor = new GitHubSyncProcessor();

  // Test 1: Verify GitHubClient creation options
  {
    console.log('Test 1: createGitHubClient initializes client with custom options');
    const client = processor.createGitHubClient({
      token: 'ghp_test123',
      baseUrl: 'https://api.github.test',
      timeoutMs: 5000,
      maxRetries: 3,
    });
    assert.ok(client, 'GitHubClient should be instantiated');
    assert.ok(client.repositories, 'repositories API namespace should exist');
    assert.ok(client.commits, 'commits API namespace should exist');
    assert.ok(client.pullRequests, 'pullRequests API namespace should exist');
    console.log('  ✔ GitHubClient instantiation and API namespaces verified\n');
  }

  // Test 2: syncUserRepositories invokes client.repositories.listForAuthenticatedUser
  {
    console.log('Test 2: syncUserRepositories calls client.repositories.listForAuthenticatedUser');
    const mockRepos: any[] = [
      {
        id: 101,
        node_id: 'n_101',
        name: 'repo-one',
        full_name: 'test-user/repo-one',
        private: false,
        owner: { id: 1, login: 'test-user', avatar_url: '', html_url: '', type: 'User' },
        html_url: 'https://github.com/test-user/repo-one',
        description: 'First test repo',
        fork: false,
        url: '',
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-02T00:00:00Z',
        pushed_at: '2024-01-02T00:00:00Z',
        git_url: '',
        ssh_url: '',
        clone_url: '',
        default_branch: 'main',
        open_issues_count: 0,
        stargazers_count: 5,
        watchers_count: 5,
        forks_count: 0,
        language: 'TypeScript',
        archived: false,
        disabled: false,
        visibility: 'public',
      },
    ];

    let listCalled = false;
    let listParams: any = null;

    const mockClient = {
      repositories: {
        listForAuthenticatedUser: async (params: any) => {
          listCalled = true;
          listParams = params;
          return mockRepos;
        },
      },
    } as any;

    const payload = {
      userId: 'user-42',
      workspaceId: 'ws-42',
      githubAccountId: 'gh-acc-42',
      syncId: 'sync-42',
      scope: 'repositories',
      forced: true,
    };

    const result = await processor.syncUserRepositories(payload, {}, mockClient);

    assert.strictEqual(listCalled, true, 'listForAuthenticatedUser should have been invoked');
    assert.strictEqual(result.totalCount, 1);
    assert.strictEqual(result.userId, 'user-42');
    assert.strictEqual(result.githubAccountId, 'gh-acc-42');
    assert.strictEqual(result.syncId, 'sync-42');
    assert.strictEqual(result.scope, 'repositories');
    assert.strictEqual(result.repositories[0].name, 'repo-one');
    assert.strictEqual(listParams?.visibility, 'all');
    console.log('  ✔ syncUserRepositories fetches repositories via GitHub package successfully\n');
  }

  // Test 3: syncSingleRepository invokes client.repositories.get
  {
    console.log('Test 3: syncSingleRepository calls client.repositories.get with owner and repo');
    let getCalledWith: { owner: string; repo: string } | null = null;

    const mockRepo: any = {
      id: 202,
      node_id: 'n_202',
      name: 'core',
      full_name: 'devpulse/core',
      private: true,
      owner: { id: 2, login: 'devpulse', avatar_url: '', html_url: '', type: 'Organization' },
      html_url: 'https://github.com/devpulse/core',
      description: 'DevPulse Core',
      fork: false,
      url: '',
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-02T00:00:00Z',
      pushed_at: '2024-01-02T00:00:00Z',
      git_url: '',
      ssh_url: '',
      clone_url: '',
      default_branch: 'main',
      open_issues_count: 2,
      stargazers_count: 50,
      watchers_count: 50,
      forks_count: 3,
      language: 'TypeScript',
      archived: false,
      disabled: false,
      visibility: 'private',
    };

    const mockClient = {
      repositories: {
        get: async (owner: string, repo: string) => {
          getCalledWith = { owner, repo };
          return mockRepo;
        },
      },
    } as any;

    const result = await processor.syncSingleRepository(
      {
        repositoryId: 'r-1',
        workspaceId: 'w-1',
        githubRepoId: 202,
        fullName: 'devpulse/core',
      },
      {},
      mockClient,
    );

    assert.ok(getCalledWith !== null);
    const called: { owner: string; repo: string } = getCalledWith;
    assert.strictEqual(called.owner, 'devpulse');
    assert.strictEqual(called.repo, 'core');
    assert.strictEqual(result.id, 202);
    assert.strictEqual(result.full_name, 'devpulse/core');
    console.log('  ✔ syncSingleRepository retrieves single repository successfully\n');
  }

  // Test 4: syncRepositoryCommits invokes client.commits.list
  {
    console.log('Test 4: syncRepositoryCommits calls client.commits.list');
    let listCommitsCalledWith: { owner: string; repo: string; params: any } | null = null;

    const mockCommits: any[] = [
      {
        sha: 'abc1234',
        node_id: 'c_1',
        commit: {
          author: { name: 'Alice', email: 'alice@example.com', date: '2024-01-01T00:00:00Z' },
          committer: { name: 'Alice', email: 'alice@example.com', date: '2024-01-01T00:00:00Z' },
          message: 'feat: initial commit',
          tree: { sha: 't_1', url: '' },
          comment_count: 0,
        },
        url: '',
        html_url: '',
        comments_url: '',
        parents: [],
      },
    ];

    const mockClient = {
      commits: {
        list: async (owner: string, repo: string, params: any) => {
          listCommitsCalledWith = { owner, repo, params };
          return mockCommits;
        },
      },
    } as any;

    const result = await processor.syncRepositoryCommits(
      {
        repositoryId: 'r-1',
        workspaceId: 'w-1',
        fullName: 'devpulse/core',
        since: '2024-01-01T00:00:00Z',
      },
      {},
      mockClient,
    );

    assert.ok(listCommitsCalledWith !== null);
    const called: { owner: string; repo: string; params: any } = listCommitsCalledWith;
    assert.strictEqual(called.owner, 'devpulse');
    assert.strictEqual(called.repo, 'core');
    assert.strictEqual(called.params.since, '2024-01-01T00:00:00Z');
    assert.strictEqual(result.totalCount, 1);
    assert.strictEqual(result.commits[0].sha, 'abc1234');
    console.log('  ✔ syncRepositoryCommits retrieves commits successfully\n');
  }

  // Test 5: syncRepositoryPullRequests invokes client.pullRequests.list
  {
    console.log('Test 5: syncRepositoryPullRequests calls client.pullRequests.list');
    let listPrsCalledWith: { owner: string; repo: string; params: any } | null = null;

    const mockPrs: any[] = [
      {
        id: 501,
        node_id: 'pr_501',
        number: 1,
        state: 'open',
        locked: false,
        title: 'Add background workers',
        body: 'Implements BullMQ worker',
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-02T00:00:00Z',
        closed_at: null,
        merged_at: null,
        user: { id: 1, login: 'alice', avatar_url: '', html_url: '', type: 'User' },
        draft: false,
        head: { ref: 'feature', sha: '111', repo: null as any },
        base: { ref: 'main', sha: '000', repo: null as any },
        html_url: 'https://github.com/devpulse/core/pull/1',
        diff_url: '',
        patch_url: '',
        url: '',
      },
    ];

    const mockClient = {
      pullRequests: {
        list: async (owner: string, repo: string, params: any) => {
          listPrsCalledWith = { owner, repo, params };
          return mockPrs;
        },
      },
    } as any;

    const result = await processor.syncRepositoryPullRequests(
      {
        repositoryId: 'r-1',
        workspaceId: 'w-1',
        fullName: 'devpulse/core',
        state: 'open',
      },
      {},
      mockClient,
    );

    assert.ok(listPrsCalledWith !== null);
    const called: { owner: string; repo: string; params: any } = listPrsCalledWith;
    assert.strictEqual(called.owner, 'devpulse');
    assert.strictEqual(called.repo, 'core');
    assert.strictEqual(called.params.state, 'open');
    assert.strictEqual(result.totalCount, 1);
    assert.strictEqual(result.pullRequests[0].number, 1);
    console.log('  ✔ syncRepositoryPullRequests retrieves pull requests successfully\n');
  }

  // Test 6: Invalid full name validation
  {
    console.log('Test 6: Validates malformed repository names');
    let errorCaught = false;
    try {
      await processor.syncSingleRepository({
        repositoryId: 'r-1',
        workspaceId: 'w-1',
        githubRepoId: 1,
        fullName: 'invalid-name-without-slash',
      });
    } catch (err: any) {
      errorCaught = true;
      assert.ok(err.message.includes('Expected "owner/repo"'));
    }
    assert.strictEqual(errorCaught, true);
    console.log('  ✔ Malformed fullName formats rejected cleanly\n');
  }

  // Test 7: Multi-page repository synchronization with pagination and progress reporting
  {
    console.log('Test 7: Multi-page repository synchronization with pagination and progress reporting');
    const page1Repos: any[] = Array.from({ length: 100 }, (_, i) => ({
      id: 1000 + i,
      name: `repo-p1-${i}`,
      full_name: `org/repo-p1-${i}`,
      private: false,
    }));
    const page2Repos: any[] = Array.from({ length: 35 }, (_, i) => ({
      id: 2000 + i,
      name: `repo-p2-${i}`,
      full_name: `org/repo-p2-${i}`,
      private: false,
    }));

    const requestedPages: number[] = [];
    const mockPaginatedClient = {
      repositories: {
        listForAuthenticatedUser: async (params: any) => {
          requestedPages.push(params.page);
          if (params.page === 1) return page1Repos;
          if (params.page === 2) return page2Repos;
          return [];
        },
      },
    } as any;

    const reportedProgress: any[] = [];
    const payload = {
      userId: 'user-paged',
      workspaceId: 'ws-paged',
      githubAccountId: 'gh-acc-paged',
      syncId: 'sync-paged-1',
      scope: 'all',
    };

    const paginatedResult = await processor.syncUserRepositories(
      payload,
      {},
      mockPaginatedClient,
      async (prog) => {
        reportedProgress.push({ ...prog });
      },
    );

    assert.deepStrictEqual(requestedPages, [1, 2], 'Should request page 1 and page 2 sequentially');
    assert.strictEqual(paginatedResult.totalCount, 135, 'Total repositories should sum both pages');
    assert.strictEqual(paginatedResult.pagesProcessed, 2, 'Should process 2 pages');
    assert.strictEqual(reportedProgress.length, 2, 'Should report progress for both pages');
    assert.strictEqual(reportedProgress[0].page, 1);
    assert.strictEqual(reportedProgress[0].totalProcessed, 100);
    assert.strictEqual(reportedProgress[0].hasMore, true);
    assert.strictEqual(reportedProgress[1].page, 2);
    assert.strictEqual(reportedProgress[1].totalProcessed, 135);
    assert.strictEqual(reportedProgress[1].hasMore, false);
    assert.strictEqual(reportedProgress[1].percentage, 100);
    console.log('  ✔ Pagination processes all pages and streams progress events accurately\n');
  }

  // Test 8: syncRepositoryCommits paginated retrieval and progress reporting
  {
    console.log('Test 8: syncRepositoryCommits paginated retrieval across multiple pages');
    const page1Commits = Array.from({ length: 100 }, (_, i) => ({
      sha: `sha_p1_${i + 1}`,
      commit: {
        author: { name: `Author ${i + 1}`, email: `author${i + 1}@example.com`, date: '2024-01-01T00:00:00Z' },
        message: `Commit ${i + 1}`,
      },
      author: { id: 1000 + i, login: `user${i + 1}` },
      parents: i > 0 ? [{ sha: `sha_p1_${i}` }] : [],
    }));

    const page2Commits = Array.from({ length: 42 }, (_, i) => ({
      sha: `sha_p2_${i + 1}`,
      commit: {
        author: { name: `Author ${100 + i + 1}`, email: `author${100 + i + 1}@example.com`, date: '2024-01-02T00:00:00Z' },
        message: `Commit ${100 + i + 1}`,
      },
      author: null, // Test author without linked GitHub account
      parents: [{ sha: `sha_p1_100` }],
    }));

    const requestedPages: number[] = [];
    const mockCommitClient = {
      commits: {
        list: async (owner: string, repo: string, params: any) => {
          requestedPages.push(params.page);
          if (params.page === 1) return page1Commits;
          if (params.page === 2) return page2Commits;
          return [];
        },
      },
    } as any;

    const reportedProgress: any[] = [];
    const result = await processor.syncRepositoryCommits(
      {
        repositoryId: 'repo-commits-1',
        workspaceId: 'ws-commits-1',
        fullName: 'org/repo-commits',
        since: '2024-01-01T00:00:00Z',
      },
      {},
      mockCommitClient,
      async (prog) => {
        reportedProgress.push({ ...prog });
      },
    );

    assert.deepStrictEqual(requestedPages, [1, 2]);
    assert.strictEqual(result.totalCount, 142);
    assert.strictEqual(result.pagesProcessed, 2);
    assert.strictEqual(reportedProgress.length, 2);
    assert.strictEqual(reportedProgress[0].totalProcessed, 100);
    assert.strictEqual(reportedProgress[1].totalProcessed, 142);
    assert.strictEqual(result.commits[100].author, null, 'Commits authored without linked GitHub accounts handled');
    console.log('  ✔ Paginated commit retrieval and incremental checkpoints verified\n');
  }

  console.log('✅ ALL GITHUB SYNC PROCESSOR TESTS PASSED!\n');
}

runTests().catch((err) => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
