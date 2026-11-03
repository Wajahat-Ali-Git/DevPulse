import assert from 'assert';
import {
  GitHubClient,
  GitHubWebhooks,
  GitHubError,
  GitHubRateLimitError,
  GitHubNotFoundError,
  GitHubAuthenticationError,
  GitHubForbiddenError,
  GitHubValidationError,
  GitHubTransientError,
  normalizeGitHubError,
} from './index';
import type {
  GitHubUser,
  GitHubRepository,
  GitHubCommit,
  GitHubPullRequest,
  GitHubReview,
  GitHubIssue,
} from './index';
import type { BranchInfo, ListRepositoriesParams } from './repositories';
import type { CommitComparison, ListCommitsParams } from './commits';
import type { PullRequestFile, ListPullRequestsParams } from './pull-requests';
import type { ReviewComment } from './reviews';

// ---------------------------------------------------------------------------
// Mock factory helpers
// ---------------------------------------------------------------------------

function makeMockUser(overrides: Partial<GitHubUser> = {}): GitHubUser {
  return {
    id: 1,
    login: 'octocat',
    name: 'The Octocat',
    email: 'octocat@github.com',
    avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4',
    html_url: 'https://github.com/octocat',
    type: 'User',
    site_admin: false,
    ...overrides,
  };
}

function makeMockRepo(overrides: Partial<GitHubRepository> = {}): GitHubRepository {
  return {
    id: 100,
    node_id: 'MDEwOlJlcG9zaXRvcnkxMDA=',
    name: 'Hello-World',
    full_name: 'octocat/Hello-World',
    private: false,
    owner: {
      id: 1,
      login: 'octocat',
      avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4',
      html_url: 'https://github.com/octocat',
      type: 'User',
    },
    html_url: 'https://github.com/octocat/Hello-World',
    description: 'My first repository',
    fork: false,
    url: 'https://api.github.com/repos/octocat/Hello-World',
    created_at: '2011-01-26T19:01:12Z',
    updated_at: '2024-01-01T00:00:00Z',
    pushed_at: '2024-01-01T00:00:00Z',
    git_url: 'git://github.com/octocat/Hello-World.git',
    ssh_url: 'git@github.com:octocat/Hello-World.git',
    clone_url: 'https://github.com/octocat/Hello-World.git',
    default_branch: 'main',
    open_issues_count: 5,
    stargazers_count: 100,
    watchers_count: 100,
    forks_count: 20,
    language: 'JavaScript',
    archived: false,
    disabled: false,
    visibility: 'public',
    ...overrides,
  };
}

function makeMockCommit(overrides: Partial<GitHubCommit> = {}): GitHubCommit {
  return {
    sha: 'abc123def456',
    node_id: 'C_abc123',
    commit: {
      author: { name: 'Monalisa Octocat', email: 'mona@github.com', date: '2024-01-01T00:00:00Z' },
      committer: { name: 'Monalisa Octocat', email: 'mona@github.com', date: '2024-01-01T00:00:00Z' },
      message: 'Initial commit',
      comment_count: 0,
      tree: { sha: 'def456', url: 'https://api.github.com/repos/octocat/Hello-World/git/trees/def456' },
    },
    url: 'https://api.github.com/repos/octocat/Hello-World/commits/abc123def456',
    html_url: 'https://github.com/octocat/Hello-World/commit/abc123def456',
    comments_url: 'https://api.github.com/repos/octocat/Hello-World/commits/abc123def456/comments',
    author: makeMockUser(),
    committer: makeMockUser(),
    parents: [],
    ...overrides,
  };
}

function makeMockPullRequest(overrides: Partial<GitHubPullRequest> = {}): GitHubPullRequest {
  const user = makeMockUser();
  const repo = makeMockRepo();
  return {
    id: 200,
    node_id: 'PR_200',
    number: 1,
    state: 'open',
    locked: false,
    title: 'Add new feature',
    user,
    body: 'This PR adds a new feature.',
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-02T00:00:00Z',
    closed_at: null,
    merged_at: null,
    merge_commit_sha: null,
    draft: false,
    html_url: 'https://github.com/octocat/Hello-World/pull/1',
    diff_url: 'https://github.com/octocat/Hello-World/pull/1.diff',
    patch_url: 'https://github.com/octocat/Hello-World/pull/1.patch',
    head: { label: 'octocat:feature', ref: 'feature', sha: 'aaa111', user, repo },
    base: { label: 'octocat:main', ref: 'main', sha: 'bbb222', user, repo },
    ...overrides,
  };
}

function makeMockReview(overrides: Partial<GitHubReview> = {}): GitHubReview {
  return {
    id: 300,
    node_id: 'RV_300',
    user: makeMockUser(),
    body: 'Looks good!',
    state: 'APPROVED',
    html_url: 'https://github.com/octocat/Hello-World/pull/1#pullrequestreview-300',
    pull_request_url: 'https://api.github.com/repos/octocat/Hello-World/pulls/1',
    commit_id: 'abc123',
    submitted_at: '2024-01-02T10:00:00Z',
    ...overrides,
  };
}

function makeMockIssue(overrides: Partial<GitHubIssue> = {}): GitHubIssue {
  return {
    id: 400,
    node_id: 'I_400',
    url: 'https://api.github.com/repos/octocat/Hello-World/issues/1',
    repository_url: 'https://api.github.com/repos/octocat/Hello-World',
    html_url: 'https://github.com/octocat/Hello-World/issues/1',
    number: 1,
    state: 'open',
    title: 'Found a bug',
    body: 'Details here.',
    user: makeMockUser(),
    labels: [{ id: 10, name: 'bug', color: 'fc2929' }],
    assignee: null,
    assignees: [],
    locked: false,
    comments: 0,
    closed_at: null,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mock GitHubClient factory
//
// Replaces `client.request` with a stub that returns a pre-set response. The
// stub also records the last URL and method so tests can assert routing.
// ---------------------------------------------------------------------------

interface RequestRecord {
  url: string;
  method: string;
}

function createMockedClient(mockResponse: unknown): { client: GitHubClient; lastRequest: RequestRecord } {
  const record: RequestRecord = { url: '', method: '' };

  const client = new GitHubClient({
    token: 'ghp_test_token',
    oauthConfig: {
      clientId: 'test-client-id',
      clientSecret: 'test-client-secret',
      callbackUrl: 'http://localhost:3000/callback',
    },
  });

  // Monkey-patch `request` so no real HTTP calls are made
  (client as any).request = async (endpoint: string, options: RequestInit = {}): Promise<unknown> => {
    record.url = endpoint;
    record.method = (options.method as string) || 'GET';
    return mockResponse;
  };

  return { client, lastRequest: record };
}

// ---------------------------------------------------------------------------
// Test runner helpers
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`  ✔ ${name}`);
    passed++;
  } catch (err: any) {
    console.error(`  ✘ ${name}`);
    console.error(`    ${err?.message ?? err}`);
    failed++;
  }
}

async function suite(name: string, fn: () => Promise<void>): Promise<void> {
  console.log(`\n${name}`);
  await fn();
}

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

async function runTests() {
  console.log('Running @devpulse/github tests...\n');

  // ── Suite 1: Client instantiation ────────────────────────────────────────
  await suite('GitHubClient — instantiation', async () => {
    await test('all sub-modules are instantiated on the client', () => {
      const client = new GitHubClient({
        token: 'ghp_test_token_12345',
        baseUrl: 'https://api.github.com',
        oauthConfig: {
          clientId: 'test-client-id',
          clientSecret: 'test-client-secret',
          callbackUrl: 'http://localhost:3000/callback',
        },
        webhookSecret: 'test-webhook-secret',
      });

      assert.ok(client.auth, 'client.auth should be defined');
      assert.ok(client.users, 'client.users should be defined');
      assert.ok(client.repositories, 'client.repositories should be defined');
      assert.ok(client.commits, 'client.commits should be defined');
      assert.ok(client.pullRequests, 'client.pullRequests should be defined');
      assert.ok(client.reviews, 'client.reviews should be defined');
      assert.ok(client.issues, 'client.issues should be defined');
      assert.ok(client.webhooks, 'client.webhooks should be defined');
    });

    await test('setToken and getRateLimitInfo methods exist', () => {
      const client = new GitHubClient();
      assert.strictEqual(typeof client.setToken, 'function');
      assert.strictEqual(typeof client.getRateLimitInfo, 'function');
      assert.strictEqual(client.getRateLimitInfo(), undefined);
    });
  });

  // ── Suite 2: OAuth URL generation ────────────────────────────────────────
  await suite('GitHubAuthApi — OAuth URL generation', async () => {
    await test('authUrl contains client_id, state, and scopes', () => {
      const client = new GitHubClient({
        token: 'ghp_test_token_12345',
        baseUrl: 'https://api.github.com',
        oauthConfig: {
          clientId: 'test-client-id',
          clientSecret: 'test-client-secret',
          callbackUrl: 'http://localhost:3000/callback',
        },
        webhookSecret: 'test-webhook-secret',
      });

      const authUrl = client.auth.getAuthorizationUrl({
        scopes: ['read:user', 'repo'],
        state: 'state123',
      });
      assert.ok(authUrl.includes('client_id=test-client-id'), 'authUrl contains client_id');
      assert.ok(authUrl.includes('state=state123'), 'authUrl contains state');
      assert.ok(
        authUrl.includes('scope=read%3Auser+repo') || authUrl.includes('scope=read%3Auser%20repo'),
        'authUrl contains scopes'
      );
    });
  });

  // ── Suite 3: Webhooks ─────────────────────────────────────────────────────
  await suite('GitHubWebhooks — signature and parsing', async () => {
    const payload = JSON.stringify({ action: 'opened', pull_request: { id: 101, number: 1 } });
    const secret = 'super-secret-key';
    let signature: string;

    await test('sign() returns sha256= prefixed signature', () => {
      signature = GitHubWebhooks.sign(payload, secret);
      assert.ok(signature.startsWith('sha256='), 'Signature starts with sha256=');
    });

    await test('verifySignature() returns true for valid signature', () => {
      signature = GitHubWebhooks.sign(payload, secret);
      assert.strictEqual(GitHubWebhooks.verifySignature({ payload, signature, secret }), true);
    });

    await test('verifySignature() returns false for tampered signature', () => {
      signature = GitHubWebhooks.sign(payload, secret);
      const tampered = signature.slice(0, -2) + 'aa';
      assert.strictEqual(GitHubWebhooks.verifySignature({ payload, signature: tampered, secret }), false);
    });

    await test('verifySignature() returns false for wrong secret', () => {
      signature = GitHubWebhooks.sign(payload, secret);
      assert.strictEqual(GitHubWebhooks.verifySignature({ payload, signature, secret: 'wrong-secret' }), false);
    });

    await test('parseEvent() and event type guards work correctly', () => {
      const client = new GitHubClient({ webhookSecret: secret });
      signature = GitHubWebhooks.sign(payload, secret);
      const parsed = client.webhooks.parseEvent(payload, signature, secret);
      assert.strictEqual(parsed.action, 'opened');
      assert.strictEqual(GitHubWebhooks.isPullRequestEvent('pull_request', parsed), true);
      assert.strictEqual(GitHubWebhooks.isPushEvent('pull_request', parsed), false);
    });
  });

  // ── Suite 4: Error hierarchy ──────────────────────────────────────────────
  await suite('Error hierarchy', async () => {
    await test('GitHubRateLimitError has correct status and fields', () => {
      const rateLimitInfo = {
        limit: 5000,
        remaining: 0,
        reset: Math.floor(Date.now() / 1000) + 120,
        used: 5000,
      };
      const err = new GitHubRateLimitError('API rate limit exceeded', rateLimitInfo);
      assert.ok(err instanceof GitHubError, 'is instance of GitHubError');
      assert.strictEqual(err.status, 403);
      assert.strictEqual(err.isRateLimitExceeded, true);
      assert.strictEqual(err.rateLimit?.remaining, 0);
      assert.ok(err.retryAfterSeconds > 0, 'retryAfterSeconds should be positive');
    });

    await test('GitHubNotFoundError has status 404', () => {
      const err = new GitHubNotFoundError('Repository not found');
      assert.strictEqual(err.status, 404);
      assert.ok(err instanceof GitHubError);
    });

    await test('GitHubAuthenticationError has status 401', () => {
      const err = new GitHubAuthenticationError('Bad credentials');
      assert.strictEqual(err.status, 401);
      assert.ok(err instanceof GitHubError);
    });

    await test('GitHubForbiddenError has status 403', () => {
      const err = new GitHubForbiddenError('Must have push access');
      assert.strictEqual(err.status, 403);
      assert.ok(err instanceof GitHubError);
    });
  });

  // ── Suite 5: GitHubUsersApi ───────────────────────────────────────────────
  await suite('GitHubUsersApi', async () => {
    await test('getMe() calls GET /user and returns GitHubUser', async () => {
      const mockUser = makeMockUser();
      const { client, lastRequest } = createMockedClient(mockUser);
      const result = await client.users.getMe();
      assert.strictEqual(lastRequest.url, '/user');
      assert.strictEqual(lastRequest.method, 'GET');
      assert.strictEqual(result.login, 'octocat');
      assert.strictEqual(result.id, 1);
    });

    await test('getByUsername() calls GET /users/:username', async () => {
      const mockUser = makeMockUser({ login: 'torvalds' });
      const { client, lastRequest } = createMockedClient(mockUser);
      const result = await client.users.getByUsername('torvalds');
      assert.ok(lastRequest.url.includes('/users/torvalds'));
      assert.strictEqual(result.login, 'torvalds');
    });

    await test('getByUsername() URL-encodes the username', async () => {
      const { client, lastRequest } = createMockedClient(makeMockUser());
      await client.users.getByUsername('user name');
      assert.ok(lastRequest.url.includes('user%20name'), 'username should be URL-encoded');
    });

    await test('getEmails() calls GET /user/emails', async () => {
      const mockEmails = [{ email: 'mona@github.com', primary: true, verified: true, visibility: 'public' }];
      const { client, lastRequest } = createMockedClient(mockEmails);
      const result = await client.users.getEmails();
      assert.strictEqual(lastRequest.url, '/user/emails');
      assert.strictEqual(result[0].email, 'mona@github.com');
      assert.strictEqual(result[0].primary, true);
    });

    await test('getOrganizations() calls GET /user/orgs', async () => {
      const mockOrgs = [{ login: 'github', id: 9919, url: 'https://api.github.com/orgs/github', avatar_url: 'https://avatars.githubusercontent.com/u/9919?v=4', description: 'The home of GitHub' }];
      const { client, lastRequest } = createMockedClient(mockOrgs);
      const result = await client.users.getOrganizations();
      assert.strictEqual(lastRequest.url, '/user/orgs');
      assert.strictEqual(result[0].login, 'github');
    });

    await test('getOrganizations() passes pagination params', async () => {
      const { client, lastRequest } = createMockedClient([]);
      await client.users.getOrganizations({ per_page: 50, page: 2 });
      assert.strictEqual(lastRequest.url, '/user/orgs');
    });
  });

  // ── Suite 6: GitHubRepositoriesApi ───────────────────────────────────────
  await suite('GitHubRepositoriesApi', async () => {
    await test('get() calls GET /repos/:owner/:repo', async () => {
      const mockRepo = makeMockRepo();
      const { client, lastRequest } = createMockedClient(mockRepo);
      const result = await client.repositories.get('octocat', 'Hello-World');
      assert.ok(lastRequest.url.includes('/repos/octocat/Hello-World'));
      assert.strictEqual(result.name, 'Hello-World');
      assert.strictEqual(result.full_name, 'octocat/Hello-World');
    });

    await test('get() URL-encodes owner and repo', async () => {
      const { client, lastRequest } = createMockedClient(makeMockRepo());
      await client.repositories.get('my org', 'my repo');
      assert.ok(lastRequest.url.includes('my%20org'));
      assert.ok(lastRequest.url.includes('my%20repo'));
    });

    await test('listForAuthenticatedUser() calls GET /user/repos', async () => {
      const mockRepos = [makeMockRepo()];
      const { client, lastRequest } = createMockedClient(mockRepos);
      const result = await client.repositories.listForAuthenticatedUser();
      assert.strictEqual(lastRequest.url, '/user/repos');
      assert.strictEqual(result.length, 1);
    });

    await test('listForAuthenticatedUser() accepts params', async () => {
      const params: ListRepositoriesParams = { visibility: 'private', sort: 'updated', per_page: 10 };
      const { client, lastRequest } = createMockedClient([]);
      await client.repositories.listForAuthenticatedUser(params);
      assert.strictEqual(lastRequest.url, '/user/repos');
    });

    await test('listForUser() calls GET /users/:username/repos', async () => {
      const { client, lastRequest } = createMockedClient([makeMockRepo()]);
      await client.repositories.listForUser('octocat');
      assert.ok(lastRequest.url.includes('/users/octocat/repos'));
    });

    await test('listForOrg() calls GET /orgs/:org/repos', async () => {
      const { client, lastRequest } = createMockedClient([makeMockRepo()]);
      await client.repositories.listForOrg('github');
      assert.ok(lastRequest.url.includes('/orgs/github/repos'));
    });

    await test('listBranches() calls GET /repos/:owner/:repo/branches', async () => {
      const mockBranches: BranchInfo[] = [
        { name: 'main', commit: { sha: 'abc', url: 'https://...' }, protected: true },
      ];
      const { client, lastRequest } = createMockedClient(mockBranches);
      const result = await client.repositories.listBranches('octocat', 'Hello-World');
      assert.ok(lastRequest.url.includes('/repos/octocat/Hello-World/branches'));
      assert.strictEqual(result[0].name, 'main');
      assert.strictEqual(result[0].protected, true);
    });

    await test('getLanguages() calls GET /repos/:owner/:repo/languages', async () => {
      const mockLangs = { JavaScript: 12345, TypeScript: 67890 };
      const { client, lastRequest } = createMockedClient(mockLangs);
      const result = await client.repositories.getLanguages('octocat', 'Hello-World');
      assert.ok(lastRequest.url.includes('/repos/octocat/Hello-World/languages'));
      assert.strictEqual(result['TypeScript'], 67890);
    });

    await test('listContributors() calls GET /repos/:owner/:repo/contributors', async () => {
      const mockContributors = [
        { id: 1, login: 'octocat', avatar_url: 'https://...', contributions: 42, html_url: 'https://github.com/octocat' },
      ];
      const { client, lastRequest } = createMockedClient(mockContributors);
      const result = await client.repositories.listContributors('octocat', 'Hello-World');
      assert.ok(lastRequest.url.includes('/repos/octocat/Hello-World/contributors'));
      assert.strictEqual(result[0].contributions, 42);
    });
  });

  // ── Suite 7: GitHubCommitsApi ─────────────────────────────────────────────
  await suite('GitHubCommitsApi', async () => {
    await test('list() calls GET /repos/:owner/:repo/commits', async () => {
      const mockCommits = [makeMockCommit()];
      const { client, lastRequest } = createMockedClient(mockCommits);
      const result = await client.commits.list('octocat', 'Hello-World');
      assert.ok(lastRequest.url.includes('/repos/octocat/Hello-World/commits'));
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].sha, 'abc123def456');
    });

    await test('list() accepts filtering params', async () => {
      const params: ListCommitsParams = {
        sha: 'main',
        author: 'octocat',
        since: '2024-01-01T00:00:00Z',
        until: '2024-12-31T23:59:59Z',
        per_page: 25,
        page: 1,
      };
      const { client, lastRequest } = createMockedClient([]);
      await client.commits.list('octocat', 'Hello-World', params);
      assert.ok(lastRequest.url.includes('/repos/octocat/Hello-World/commits'));
    });

    await test('get() calls GET /repos/:owner/:repo/commits/:ref', async () => {
      const mockCommit = makeMockCommit({ stats: { total: 10, additions: 8, deletions: 2 } });
      const { client, lastRequest } = createMockedClient(mockCommit);
      const result = await client.commits.get('octocat', 'Hello-World', 'abc123def456');
      assert.ok(lastRequest.url.includes('/repos/octocat/Hello-World/commits/abc123def456'));
      assert.strictEqual(result.stats?.total, 10);
    });

    await test('get() URL-encodes the ref', async () => {
      const { client, lastRequest } = createMockedClient(makeMockCommit());
      await client.commits.get('octocat', 'Hello-World', 'refs/heads/main');
      assert.ok(lastRequest.url.includes('refs%2Fheads%2Fmain'));
    });

    await test('compare() calls GET /repos/:owner/:repo/compare/:base...:head', async () => {
      const mockComparison: CommitComparison = {
        url: 'https://api.github.com/repos/octocat/Hello-World/compare/main...feature',
        html_url: 'https://github.com/octocat/Hello-World/compare/main...feature',
        status: 'ahead',
        ahead_by: 3,
        behind_by: 0,
        total_commits: 3,
        commits: [makeMockCommit()],
      };
      const { client, lastRequest } = createMockedClient(mockComparison);
      const result = await client.commits.compare('octocat', 'Hello-World', 'main', 'feature');
      assert.ok(lastRequest.url.includes('/repos/octocat/Hello-World/compare/'));
      assert.ok(lastRequest.url.includes('main'));
      assert.ok(lastRequest.url.includes('feature'));
      assert.strictEqual(result.status, 'ahead');
      assert.strictEqual(result.ahead_by, 3);
    });
  });

  // ── Suite 8: GitHubPullRequestsApi ───────────────────────────────────────
  await suite('GitHubPullRequestsApi', async () => {
    await test('list() calls GET /repos/:owner/:repo/pulls', async () => {
      const mockPRs = [makeMockPullRequest()];
      const { client, lastRequest } = createMockedClient(mockPRs);
      const result = await client.pullRequests.list('octocat', 'Hello-World');
      assert.ok(lastRequest.url.includes('/repos/octocat/Hello-World/pulls'));
      assert.strictEqual(result[0].number, 1);
      assert.strictEqual(result[0].state, 'open');
    });

    await test('list() accepts filter params', async () => {
      const params: ListPullRequestsParams = { state: 'closed', sort: 'updated', direction: 'desc', per_page: 30 };
      const { client, lastRequest } = createMockedClient([]);
      await client.pullRequests.list('octocat', 'Hello-World', params);
      assert.ok(lastRequest.url.includes('/repos/octocat/Hello-World/pulls'));
    });

    await test('get() calls GET /repos/:owner/:repo/pulls/:number', async () => {
      const mockPR = makeMockPullRequest({ title: 'Fix critical bug', number: 42 });
      const { client, lastRequest } = createMockedClient(mockPR);
      const result = await client.pullRequests.get('octocat', 'Hello-World', 42);
      assert.ok(lastRequest.url.includes('/repos/octocat/Hello-World/pulls/42'));
      assert.strictEqual(result.title, 'Fix critical bug');
      assert.strictEqual(result.number, 42);
    });

    await test('create() calls POST /repos/:owner/:repo/pulls', async () => {
      const mockPR = makeMockPullRequest();
      const { client, lastRequest } = createMockedClient(mockPR);
      await client.pullRequests.create('octocat', 'Hello-World', {
        title: 'Add feature',
        head: 'feature-branch',
        base: 'main',
      });
      assert.ok(lastRequest.url.includes('/repos/octocat/Hello-World/pulls'));
      assert.strictEqual(lastRequest.method, 'POST');
    });

    await test('update() calls PATCH /repos/:owner/:repo/pulls/:number', async () => {
      const mockPR = makeMockPullRequest({ title: 'Updated title' });
      const { client, lastRequest } = createMockedClient(mockPR);
      const result = await client.pullRequests.update('octocat', 'Hello-World', 1, { title: 'Updated title' });
      assert.ok(lastRequest.url.includes('/repos/octocat/Hello-World/pulls/1'));
      assert.strictEqual(lastRequest.method, 'PATCH');
      assert.strictEqual(result.title, 'Updated title');
    });

    await test('listCommits() calls GET /repos/:owner/:repo/pulls/:number/commits', async () => {
      const mockCommits = [makeMockCommit()];
      const { client, lastRequest } = createMockedClient(mockCommits);
      const result = await client.pullRequests.listCommits('octocat', 'Hello-World', 1);
      assert.ok(lastRequest.url.includes('/repos/octocat/Hello-World/pulls/1/commits'));
      assert.strictEqual(result.length, 1);
    });

    await test('listFiles() calls GET /repos/:owner/:repo/pulls/:number/files', async () => {
      const mockFiles: PullRequestFile[] = [
        { sha: 'abc', filename: 'src/index.ts', status: 'modified', additions: 5, deletions: 2, changes: 7 },
      ];
      const { client, lastRequest } = createMockedClient(mockFiles);
      const result = await client.pullRequests.listFiles('octocat', 'Hello-World', 1);
      assert.ok(lastRequest.url.includes('/repos/octocat/Hello-World/pulls/1/files'));
      assert.strictEqual(result[0].filename, 'src/index.ts');
      assert.strictEqual(result[0].additions, 5);
    });

    await test('checkIfMerged() returns true when endpoint succeeds', async () => {
      const { client } = createMockedClient(undefined);
      const result = await client.pullRequests.checkIfMerged('octocat', 'Hello-World', 1);
      assert.strictEqual(result, true);
    });

    await test('checkIfMerged() returns false when endpoint throws', async () => {
      const client = new GitHubClient({ token: 'ghp_test' });
      // Stub `get` to throw a GitHubNotFoundError to simulate unmerged PR
      (client as any).request = async (): Promise<never> => {
        throw new GitHubNotFoundError('Not merged');
      };
      const result = await client.pullRequests.checkIfMerged('octocat', 'Hello-World', 1);
      assert.strictEqual(result, false);
    });
  });

  // ── Suite 9: GitHubReviewsApi ─────────────────────────────────────────────
  await suite('GitHubReviewsApi', async () => {
    await test('list() calls GET /repos/:owner/:repo/pulls/:number/reviews', async () => {
      const mockReviews = [makeMockReview()];
      const { client, lastRequest } = createMockedClient(mockReviews);
      const result = await client.reviews.list('octocat', 'Hello-World', 1);
      assert.ok(lastRequest.url.includes('/repos/octocat/Hello-World/pulls/1/reviews'));
      assert.strictEqual(result[0].state, 'APPROVED');
    });

    await test('get() calls GET /repos/:owner/:repo/pulls/:number/reviews/:reviewId', async () => {
      const mockReview = makeMockReview({ id: 999, state: 'CHANGES_REQUESTED' });
      const { client, lastRequest } = createMockedClient(mockReview);
      const result = await client.reviews.get('octocat', 'Hello-World', 1, 999);
      assert.ok(lastRequest.url.includes('/repos/octocat/Hello-World/pulls/1/reviews/999'));
      assert.strictEqual(result.state, 'CHANGES_REQUESTED');
    });

    await test('create() calls POST /repos/:owner/:repo/pulls/:number/reviews', async () => {
      const mockReview = makeMockReview();
      const { client, lastRequest } = createMockedClient(mockReview);
      await client.reviews.create('octocat', 'Hello-World', 1, {
        event: 'APPROVE',
        body: 'LGTM!',
      });
      assert.ok(lastRequest.url.includes('/repos/octocat/Hello-World/pulls/1/reviews'));
      assert.strictEqual(lastRequest.method, 'POST');
    });

    await test('listComments() calls GET /repos/:owner/:repo/pulls/:number/reviews/:reviewId/comments', async () => {
      const mockComments: ReviewComment[] = [
        {
          id: 1,
          node_id: 'RC_1',
          url: 'https://...',
          body: 'Nice work',
          path: 'src/index.ts',
          position: 1,
          line: 10,
          commit_id: 'abc123',
          user: { id: 1, login: 'octocat', avatar_url: 'https://...' },
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
          html_url: 'https://github.com/...',
        },
      ];
      const { client, lastRequest } = createMockedClient(mockComments);
      const result = await client.reviews.listComments('octocat', 'Hello-World', 1, 300);
      assert.ok(lastRequest.url.includes('/repos/octocat/Hello-World/pulls/1/reviews/300/comments'));
      assert.strictEqual(result[0].body, 'Nice work');
    });
  });

  // ── Suite 10: GitHubIssuesApi ─────────────────────────────────────────────
  await suite('GitHubIssuesApi', async () => {
    await test('list() calls GET /repos/:owner/:repo/issues', async () => {
      const mockIssues = [makeMockIssue()];
      const { client, lastRequest } = createMockedClient(mockIssues);
      const result = await client.issues.list('octocat', 'Hello-World');
      assert.ok(lastRequest.url.includes('/repos/octocat/Hello-World/issues'));
      assert.strictEqual(result[0].state, 'open');
      assert.strictEqual(result[0].title, 'Found a bug');
    });

    await test('get() calls GET /repos/:owner/:repo/issues/:number', async () => {
      const mockIssue = makeMockIssue({ number: 42, title: 'Critical crash' });
      const { client, lastRequest } = createMockedClient(mockIssue);
      const result = await client.issues.get('octocat', 'Hello-World', 42);
      assert.ok(lastRequest.url.includes('/repos/octocat/Hello-World/issues/42'));
      assert.strictEqual(result.title, 'Critical crash');
    });

    await test('create() calls POST /repos/:owner/:repo/issues', async () => {
      const mockIssue = makeMockIssue({ title: 'New bug report' });
      const { client, lastRequest } = createMockedClient(mockIssue);
      await client.issues.create('octocat', 'Hello-World', { title: 'New bug report', body: 'Details...' });
      assert.ok(lastRequest.url.includes('/repos/octocat/Hello-World/issues'));
      assert.strictEqual(lastRequest.method, 'POST');
    });

    await test('update() calls PATCH /repos/:owner/:repo/issues/:number', async () => {
      const mockIssue = makeMockIssue({ state: 'closed' });
      const { client, lastRequest } = createMockedClient(mockIssue);
      const result = await client.issues.update('octocat', 'Hello-World', 1, { state: 'closed' });
      assert.ok(lastRequest.url.includes('/repos/octocat/Hello-World/issues/1'));
      assert.strictEqual(lastRequest.method, 'PATCH');
      assert.strictEqual(result.state, 'closed');
    });

    await test('listComments() calls GET /repos/:owner/:repo/issues/:number/comments', async () => {
      const mockComments = [
        {
          id: 1,
          node_id: 'IC_1',
          url: 'https://...',
          html_url: 'https://...',
          body: 'This is a known issue.',
          user: { id: 1, login: 'octocat', avatar_url: 'https://...' },
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
        },
      ];
      const { client, lastRequest } = createMockedClient(mockComments);
      const result = await client.issues.listComments('octocat', 'Hello-World', 1);
      assert.ok(lastRequest.url.includes('/repos/octocat/Hello-World/issues/1/comments'));
      assert.strictEqual(result[0].body, 'This is a known issue.');
    });
  });

  // ── Suite 11: URL encoding and edge cases ─────────────────────────────────
  await suite('URL encoding and edge cases', async () => {
    await test('org with special chars is URL-encoded in listForOrg()', async () => {
      const { client, lastRequest } = createMockedClient([]);
      await client.repositories.listForOrg('my org');
      assert.ok(lastRequest.url.includes('my%20org'));
    });

    await test('listBranches() accepts protected filter param', async () => {
      const { client, lastRequest } = createMockedClient([]);
      await client.repositories.listBranches('octocat', 'Hello-World', { protected: true, per_page: 10 });
      assert.ok(lastRequest.url.includes('/repos/octocat/Hello-World/branches'));
    });

    await test('commits compare() encodes base and head refs', async () => {
      const mockComparison: CommitComparison = {
        url: '', html_url: '', status: 'identical', ahead_by: 0, behind_by: 0, total_commits: 0, commits: [],
      };
      const { client, lastRequest } = createMockedClient(mockComparison);
      await client.commits.compare('octocat', 'Hello-World', 'refs/heads/main', 'refs/heads/feature');
      assert.ok(lastRequest.url.includes('refs%2Fheads%2Fmain'));
      assert.ok(lastRequest.url.includes('refs%2Fheads%2Ffeature'));
    });
  });


  // ── Suite 12: Pagination & Rate Limit Guidance ────────────────────────────
  await suite('Pagination & Rate Limit Guidance', async () => {
    await test('parseLinkHeader() accurately extracts next, prev, first, and last', () => {
      const client = new GitHubClient();
      const linkHeader = '<https://api.github.com/user/repos?page=3&per_page=100>; rel="next", <https://api.github.com/user/repos?page=1&per_page=100>; rel="prev", <https://api.github.com/user/repos?page=5&per_page=100>; rel="last", <https://api.github.com/user/repos?page=1&per_page=100>; rel="first"';
      const links = client.parseLinkHeader(linkHeader);
      assert.strictEqual(links.next, 'https://api.github.com/user/repos?page=3&per_page=100');
      assert.strictEqual(links.prev, 'https://api.github.com/user/repos?page=1&per_page=100');
      assert.strictEqual(links.first, 'https://api.github.com/user/repos?page=1&per_page=100');
      assert.strictEqual(links.last, 'https://api.github.com/user/repos?page=5&per_page=100');
    });

    await test('parseLinkHeader() handles empty or null gracefully', () => {
      const client = new GitHubClient();
      assert.deepStrictEqual(client.parseLinkHeader(null), {});
      assert.deepStrictEqual(client.parseLinkHeader(''), {});
    });

    await test('getPaginated() returns data and links object', async () => {
      const client = new GitHubClient({ token: 'test' });
      (client as any).requestRaw = async () => ({
        data: [{ id: 1 }],
        headers: new Headers({
          'link': '<https://api.github.com/repos?page=2>; rel="next"'
        }),
        links: { next: 'https://api.github.com/repos?page=2' }
      });

      const response = await client.getPaginated<Array<{ id: number }>>('/repos');
      assert.strictEqual(response.data.length, 1);
      assert.strictEqual(response.links.next, 'https://api.github.com/repos?page=2');
    });

    await test('paginatePages() yields pages sequentially until no next link', async () => {
      const client = new GitHubClient({ token: 'test' });
      const pages = [
        {
          data: [{ id: 1 }, { id: 2 }],
          links: { next: 'https://api.github.com/repos?page=2' }
        },
        {
          data: [{ id: 3 }, { id: 4 }],
          links: {}
        }
      ];
      let callCount = 0;
      (client as any).getPaginated = async () => {
        return pages[callCount++];
      };

      const collectedPages: any[][] = [];
      for await (const page of client.paginatePages('/repos')) {
        collectedPages.push(page);
      }

      assert.strictEqual(collectedPages.length, 2);
      assert.strictEqual(collectedPages[0].length, 2);
      assert.strictEqual(collectedPages[1].length, 2);
      assert.strictEqual(callCount, 2);
    });

    await test('paginateAll() aggregates all items across pages respecting maxItems', async () => {
      const client = new GitHubClient({ token: 'test' });
      const pages = [
        {
          data: [{ id: 1 }, { id: 2 }, { id: 3 }],
          links: { next: 'https://api.github.com/repos?page=2' }
        },
        {
          data: [{ id: 4 }, { id: 5 }],
          links: {}
        }
      ];
      let callCount = 0;
      (client as any).getPaginated = async () => {
        return pages[callCount++];
      };

      const all = await client.paginateAll<{ id: number }>('/repos', { maxItems: 4 });
      assert.strictEqual(all.length, 4);
      assert.deepStrictEqual(all.map((x) => x.id), [1, 2, 3, 4]);
    });

    await test('extracts Retry-After header and respects retry guidance on rate limits', () => {
      const client = new GitHubClient();
      const headers = new Headers({
        'retry-after': '30',
        'x-ratelimit-limit': '60',
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 120),
      });

      const extracted = (client as any).extractRateLimitHeaders(headers);
      assert.ok(extracted, 'Rate limit info should be extracted');
      assert.strictEqual(extracted.retryAfterSeconds, 30);
      assert.strictEqual(client.getRateLimitInfo()?.retryAfterSeconds, 30);

      const err = new GitHubRateLimitError('Rate limit exceeded', extracted);
      assert.strictEqual(err.retryAfterSeconds, 30);
      assert.strictEqual(err.status, 403);
    });

    await test('detects secondary rate limit with 429 and Retry-After header', () => {
      const client = new GitHubClient();
      const headers = new Headers({
        'retry-after': '60',
      });

      const extracted = (client as any).extractRateLimitHeaders(headers);
      assert.ok(extracted);
      assert.strictEqual(extracted.retryAfterSeconds, 60);

      const err = new GitHubRateLimitError('You have exceeded a secondary rate limit', extracted);
      assert.strictEqual(err.status, 429);
      assert.strictEqual(err.retryAfterSeconds, 60);
    });
  });


  // ── Suite 13: Bounded Retries & Error Normalization ───────────────────────
  await suite('Bounded Retries & Error Normalization', async () => {
    await test('retries transient 5xx server errors up to maxRetries with backoff', async () => {
      let attempts = 0;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () => {
        attempts++;
        if (attempts < 3) {
          return new Response(JSON.stringify({ message: 'Internal Server Error' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ id: 123, login: 'recovered' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };

      try {
        const client = new GitHubClient({
          token: 'test',
          maxRetries: 3,
          baseRetryDelayMs: 10,
        });
        const result = await client.request<{ id: number; login: string }>('/user');
        assert.strictEqual(attempts, 3, 'Should retry until successful attempt 3');
        assert.strictEqual(result.login, 'recovered');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    await test('fails with normalized error when maxRetries exceeded on 5xx', async () => {
      let attempts = 0;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () => {
        attempts++;
        return new Response(JSON.stringify({ message: 'Service Unavailable' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        });
      };

      try {
        const client = new GitHubClient({
          token: 'test',
          maxRetries: 2,
          baseRetryDelayMs: 5,
        });
        let thrownError: any;
        try {
          await client.request('/user');
        } catch (err) {
          thrownError = err;
        }

        assert.ok(thrownError, 'Should throw an error');
        assert.strictEqual(attempts, 3, 'Initial attempt + 2 retries = 3 attempts');
        assert.ok(thrownError instanceof GitHubTransientError);
        assert.strictEqual(thrownError.status, 503);
        assert.strictEqual(thrownError.message, 'Service Unavailable');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    await test('retries transient network drops (ECONNRESET) up to maxRetries', async () => {
      let attempts = 0;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () => {
        attempts++;
        if (attempts < 2) {
          const err: any = new Error('read ECONNRESET');
          err.code = 'ECONNRESET';
          throw err;
        }
        return new Response(JSON.stringify({ status: 'ok' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };

      try {
        const client = new GitHubClient({
          token: 'test',
          maxRetries: 2,
          baseRetryDelayMs: 5,
        });
        const res = await client.request<{ status: string }>('/status');
        assert.strictEqual(attempts, 2);
        assert.strictEqual(res.status, 'ok');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    await test('normalizes 422 Unprocessable Entity into GitHubValidationError with field details', () => {
      const errorBody = {
        message: 'Validation Failed',
        errors: [
          { resource: 'Issue', field: 'title', code: 'missing_field' },
          { resource: 'Issue', field: 'body', code: 'custom', message: 'body is too short' },
        ],
        documentation_url: 'https://docs.github.com/rest/issues/issues#create-an-issue',
      };

      const normalized = normalizeGitHubError(422, 'Default message', errorBody);
      assert.ok(normalized instanceof GitHubValidationError);
      assert.strictEqual(normalized.status, 422);
      assert.strictEqual(normalized.message, 'Validation Failed');
      assert.strictEqual(normalized.documentationUrl, 'https://docs.github.com/rest/issues/issues#create-an-issue');
      assert.strictEqual(normalized.errors?.length, 2);
      assert.strictEqual(normalized.errors?.[0].field, 'title');
      assert.strictEqual(normalized.errors?.[1].message, 'body is too short');
    });

    await test('normalizes 401 Unauthorized with OAuth error_description', () => {
      const errorBody = {
        error: 'bad_verification_code',
        error_description: 'The code passed is incorrect or expired.',
      };

      const normalized = normalizeGitHubError(401, 'Auth failed', errorBody);
      assert.ok(normalized instanceof GitHubAuthenticationError);
      assert.strictEqual(normalized.status, 401);
      assert.strictEqual(normalized.message, 'The code passed is incorrect or expired.');
    });

    await test('normalizes 404 Not Found correctly', () => {
      const errorBody = { message: 'Not Found' };
      const normalized = normalizeGitHubError(404, 'Not found', errorBody);
      assert.ok(normalized instanceof GitHubNotFoundError);
      assert.strictEqual(normalized.status, 404);
      assert.strictEqual(normalized.message, 'Not Found');
    });
  });

  // ── Final summary ─────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(55)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error(`\n${failed} test(s) failed.`);
    process.exit(1);
  } else {
    console.log('\nAll @devpulse/github tests passed successfully! 🎉');
  }
}

runTests().catch((err) => {
  console.error('Unexpected test runner error:', err);
  process.exit(1);
});
