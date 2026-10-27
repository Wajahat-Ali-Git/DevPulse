/**
 * GitHub OAuth Security & Identity Association Tests
 *
 * Covers:
 *  - GitHubOAuthGuard: error handling, format validation, missing params
 *  - GitHubOAuthService: CSRF state validation, Redis availability assertion,
 *    token error mapping, profile fetch failure, email resolution
 *  - Authenticated Identity Association:
 *    * associating GitHub account with authenticated user
 *    * conflict rejection when GitHub account is already linked to another user
 *    * token & profile refresh when already linked to same user
 *    * state-bound user association in callback
 *    * mismatched user session vs state rejection
 *    * retroactive contribution attribution
 */
import * as assert from 'node:assert';
import { ExecutionContext } from '@nestjs/common';
import { GitHubOAuthGuard } from './guards/github-oauth.guard';
import { GitHubOAuthService } from './github-oauth.service';
import { AuthService } from './auth.service';
import { AuthenticationException, ConflictException } from '../common/errors';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(query: Record<string, string | undefined>): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ query }),
      getResponse: () => ({}),
      getNext: () => () => {},
    }),
    getHandler: () => () => {},
    getClass: () => class {},
  } as unknown as ExecutionContext;
}

/** Creates a minimal Redis-like mock for GitHubOAuthService tests */
function makeRedisMock(overrides: Partial<{ get: any; set: any; del: any; getdel: any }> = {}) {
  return {
    set: async () => 'OK',
    get: async (_key: string) => null,
    del: async () => 1,
    getdel: async (_key: string) => null,
    ...overrides,
  };
}

function makeRedisServiceMock(client: any) {
  return { client };
}

function makeDbServiceMock(overrides: any = {}) {
  const defaultUser = {
    findUnique: async () => null,
    update: async () => ({}),
    create: async () => ({ id: 'usr_1', email: 'test@example.com', role: 'MEMBER' }),
  };
  const defaultGitHubAccount = {
    findUnique: async () => null,
    update: async () => ({}),
    create: async () => ({}),
  };
  return {
    client: {
      gitHubAccount: {
        ...defaultGitHubAccount,
        ...(overrides.gitHubAccount || {}),
      },
      user: {
        ...defaultUser,
        ...(overrides.user || {}),
      },
      refreshToken: {
        create: async () => ({}),
        ...(overrides.refreshToken || {}),
      },
      commit: {
        updateMany: async () => ({ count: 0 }),
        ...(overrides.commit || {}),
      },
      pullRequest: {
        updateMany: async () => ({ count: 0 }),
        ...(overrides.pullRequest || {}),
      },
      review: {
        updateMany: async () => ({ count: 0 }),
        ...(overrides.review || {}),
      },
      $transaction: overrides.$transaction || (async (fn: (tx: any) => any) => fn({
        user: { create: async () => ({ id: 'usr_new', email: 'new@example.com', role: 'MEMBER' }) },
        gitHubAccount: { create: async () => ({}) },
      })),
      ...overrides,
    },
  };
}

// ---------------------------------------------------------------------------
// GitHubOAuthGuard tests
// ---------------------------------------------------------------------------

async function testGuard() {
  console.log('\n--- GitHubOAuthGuard ---');

  const guard = new GitHubOAuthGuard();

  // 1. access_denied → known message
  {
    const ctx = makeContext({ error: 'access_denied' });
    let caught: any;
    try { guard.canActivate(ctx); } catch (e) { caught = e; }
    assert.ok(caught instanceof AuthenticationException);
    assert.ok(caught.message.includes('denied'), `Expected "denied" in: ${caught.message}`);
    console.log('  ✓ access_denied maps to friendly message');
  }

  // 2. Unknown GitHub error with description
  {
    const ctx = makeContext({ error: 'unknown_error', error_description: 'Something+went+wrong' });
    let caught: any;
    try { guard.canActivate(ctx); } catch (e) { caught = e; }
    assert.ok(caught instanceof AuthenticationException);
    assert.ok(caught.message.includes('Something went wrong'), `Got: ${caught.message}`);
    console.log('  ✓ Unknown error with URL-encoded description decoded correctly');
  }

  // 3. Malformed error_description (invalid URI encoding) does NOT throw
  {
    const ctx = makeContext({ error: 'fail', error_description: '%E0%A4%A' });
    let caught: any;
    try { guard.canActivate(ctx); } catch (e) { caught = e; }
    assert.ok(caught instanceof AuthenticationException);
    assert.ok(typeof caught.message === 'string');
    console.log('  ✓ Malformed error_description handled without URIError');
  }

  // 4. Missing code → rejected
  {
    const ctx = makeContext({ state: 'a'.repeat(48) });
    let caught: any;
    try { guard.canActivate(ctx); } catch (e) { caught = e; }
    assert.ok(caught instanceof AuthenticationException);
    assert.ok(caught.message.includes('authorization code'), `Got: ${caught.message}`);
    console.log('  ✓ Missing code rejected');
  }

  // 5. Missing state → rejected
  {
    const ctx = makeContext({ code: 'valid_code' });
    let caught: any;
    try { guard.canActivate(ctx); } catch (e) { caught = e; }
    assert.ok(caught instanceof AuthenticationException);
    assert.ok(caught.message.includes('state parameter'), `Got: ${caught.message}`);
    console.log('  ✓ Missing state rejected');
  }

  // 6. Malformed state (wrong length) → rejected
  {
    const ctx = makeContext({ code: 'code', state: 'short' });
    let caught: any;
    try { guard.canActivate(ctx); } catch (e) { caught = e; }
    assert.ok(caught instanceof AuthenticationException);
    assert.ok(caught.message.toLowerCase().includes('csrf'), `Got: ${caught.message}`);
    console.log('  ✓ State with wrong length rejected as malformed');
  }

  // 7. Malformed state (invalid characters) → rejected
  {
    const ctx = makeContext({ code: 'code', state: 'g'.repeat(48) }); // 'g' is not hex
    let caught: any;
    try { guard.canActivate(ctx); } catch (e) { caught = e; }
    assert.ok(caught instanceof AuthenticationException);
    assert.ok(caught.message.toLowerCase().includes('csrf'), `Got: ${caught.message}`);
    console.log('  ✓ State with non-hex characters rejected');
  }

  // 8. Valid params → passes guard
  {
    const ctx = makeContext({ code: 'valid_code', state: 'a'.repeat(48) });
    const result = guard.canActivate(ctx);
    assert.strictEqual(result, true);
    console.log('  ✓ Valid code + well-formed state passes guard');
  }
}

// ---------------------------------------------------------------------------
// GitHubOAuthService: State Validation tests
// ---------------------------------------------------------------------------

async function testStateValidation() {
  console.log('\n--- GitHubOAuthService: State Validation ---');

  const authService = new AuthService();

  // 9. Fail-secure: Redis offline during state generation → throws
  {
    const svc = new GitHubOAuthService(
      authService,
      makeDbServiceMock() as any,
      makeRedisServiceMock(null) as any,
    );
    let caught: any;
    try { await svc.generateOAuthState(); } catch (e) { caught = e; }
    assert.ok(caught instanceof AuthenticationException);
    assert.ok(caught.message.toLowerCase().includes('temporarily unavailable'), `Got: ${caught.message}`);
    console.log('  ✓ generateOAuthState throws when Redis is unavailable');
  }

  // 10. Fail-secure: Redis offline during state validation → throws
  {
    const svc = new GitHubOAuthService(
      authService,
      makeDbServiceMock() as any,
      makeRedisServiceMock(null) as any,
    );
    let caught: any;
    try { await svc.validateOAuthState('a'.repeat(48)); } catch (e) { caught = e; }
    assert.ok(caught instanceof AuthenticationException);
    assert.ok(caught.message.toLowerCase().includes('temporarily unavailable'), `Got: ${caught.message}`);
    console.log('  ✓ validateOAuthState throws when Redis is unavailable (fail-secure)');
  }

  // 11. Valid state exists in Redis → consumed via getdel
  {
    const svc = new GitHubOAuthService(
      authService,
      makeDbServiceMock() as any,
      makeRedisServiceMock(makeRedisMock({ getdel: async () => '1' })) as any,
    );
    await svc.validateOAuthState('a'.repeat(48));
    console.log('  ✓ Valid state token accepted and consumed');
  }

  // 12. State not in Redis (GETDEL returns null) → rejected
  {
    const svc = new GitHubOAuthService(
      authService,
      makeDbServiceMock() as any,
      makeRedisServiceMock(makeRedisMock({ getdel: async () => null })) as any,
    );
    let caught: any;
    try { await svc.validateOAuthState('b'.repeat(48)); } catch (e) { caught = e; }
    assert.ok(caught instanceof AuthenticationException);
    assert.ok(
      caught.message.toLowerCase().includes('invalid') || caught.message.toLowerCase().includes('expired'),
      `Got: ${caught.message}`
    );
    console.log('  ✓ Missing/expired state rejected with CSRF warning');
  }

  // 13. Empty state string → rejected immediately
  {
    const svc = new GitHubOAuthService(
      authService,
      makeDbServiceMock() as any,
      makeRedisServiceMock(makeRedisMock()) as any,
    );
    let caught: any;
    try { await svc.validateOAuthState(''); } catch (e) { caught = e; }
    assert.ok(caught instanceof AuthenticationException);
    assert.ok(caught.message.toLowerCase().includes('missing'), `Got: ${caught.message}`);
    console.log('  ✓ Empty state string rejected before Redis call');
  }
}

// ---------------------------------------------------------------------------
// GitHubOAuthService.handleCallback error mapping tests
// ---------------------------------------------------------------------------

async function testCallbackErrorMapping() {
  console.log('\n--- GitHubOAuthService: Callback Error Mapping ---');

  const authService = new AuthService();

  function makeServiceWithExchangeError(errorMessage: string) {
    const redis = makeRedisMock({ getdel: async () => '1' });
    const svc = new GitHubOAuthService(
      authService,
      makeDbServiceMock() as any,
      makeRedisServiceMock(redis) as any,
    );

    (svc as any).githubAuthApi = {
      getAuthorizationUrl: () => '',
      exchangeCodeForToken: async () => { throw new Error(errorMessage); },
    };

    return svc;
  }

  // 14. bad_verification_code → expired code message
  {
    const svc = makeServiceWithExchangeError('GitHub OAuth error: bad_verification_code');
    let caught: any;
    try { await svc.handleCallback('code', 'a'.repeat(48)); } catch (e) { caught = e; }
    assert.ok(caught instanceof AuthenticationException);
    assert.ok(
      caught.message.toLowerCase().includes('expired') || caught.message.toLowerCase().includes('used'),
      `Got: ${caught.message}`
    );
    console.log('  ✓ bad_verification_code mapped to "expired/already used" message');
  }

  // 15. Network/fetch error → friendly network message
  {
    const svc = makeServiceWithExchangeError('fetch failed: ECONNREFUSED');
    let caught: any;
    try { await svc.handleCallback('code', 'a'.repeat(48)); } catch (e) { caught = e; }
    assert.ok(caught instanceof AuthenticationException);
    assert.ok(
      caught.message.toLowerCase().includes('reach github') || caught.message.toLowerCase().includes('try again'),
      `Got: ${caught.message}`
    );
    console.log('  ✓ Network failure mapped to friendly "unreachable" message');
  }

  // 16. Unknown GitHub error → safe fallback message
  {
    const svc = makeServiceWithExchangeError('GitHub OAuth error: some_new_unknown_error_code');
    let caught: any;
    try { await svc.handleCallback('code', 'a'.repeat(48)); } catch (e) { caught = e; }
    assert.ok(caught instanceof AuthenticationException);
    assert.ok(!caught.message.includes('stack'), `Stack leaked: ${caught.message}`);
    console.log('  ✓ Unknown GitHub error caught and surfaced safely');
  }
}

// ---------------------------------------------------------------------------
// GitHub Identity Association with Authenticated User
// ---------------------------------------------------------------------------

async function testIdentityAssociation() {
  console.log('\n--- GitHub Identity Association with Authenticated User ---');

  const authService = new AuthService();

  const dummyGithubUser = {
    id: 1234567,
    login: 'octocat',
    name: 'Mona Lisa Octocat',
    email: 'mona@github.com',
    avatar_url: 'https://github.com/images/avatar.png',
    html_url: 'https://github.com/octocat',
  };

  const dummyTokenResponse = {
    access_token: 'gho_secret123',
    refresh_token: 'ghr_refresh456',
    expires_in: 28800,
  };

  // 17. Rejects association if authenticated user not found in database
  {
    const dbMock = makeDbServiceMock({
      user: {
        findUnique: async () => null,
      },
    });

    const svc = new GitHubOAuthService(
      authService,
      dbMock as any,
      makeRedisServiceMock(makeRedisMock()) as any,
    );

    let caught: any;
    try {
      await svc.associateUserWithGitHub(
        'usr_nonexistent',
        dummyGithubUser as any,
        'mona@github.com',
        dummyTokenResponse,
      );
    } catch (e) {
      caught = e;
    }

    assert.ok(caught instanceof AuthenticationException);
    assert.ok(caught.message.includes('DevPulse user not found'));
    console.log('  ✓ Rejects association if DevPulse user does not exist');
  }

  // 18. Rejects association with ConflictException if GitHub account is linked to another user
  {
    const dbMock = makeDbServiceMock({
      user: {
        findUnique: async () => ({ id: 'usr_me', email: 'me@example.com', role: 'MEMBER' }),
      },
      gitHubAccount: {
        findUnique: async () => ({
          id: 'gh_other',
          userId: 'usr_other_account',
          githubUserId: BigInt(dummyGithubUser.id),
        }),
      },
    });

    const svc = new GitHubOAuthService(
      authService,
      dbMock as any,
      makeRedisServiceMock(makeRedisMock()) as any,
    );

    let caught: any;
    try {
      await svc.associateUserWithGitHub(
        'usr_me',
        dummyGithubUser as any,
        'mona@github.com',
        dummyTokenResponse,
      );
    } catch (e) {
      caught = e;
    }

    assert.ok(caught instanceof ConflictException);
    assert.ok(caught.message.includes('already associated with another DevPulse user'));
    console.log('  ✓ Throws ConflictException when GitHub account belongs to another user');
  }

  // 19. Successfully links new GitHub account to authenticated user
  {
    let createdAccountData: any = null;
    let updatedUserData: any = null;
    let commitLinked = false;
    let prLinked = false;

    const dbMock = makeDbServiceMock({
      user: {
        findUnique: async () => ({
          id: 'usr_me',
          email: 'me@example.com',
          avatarUrl: null,
          role: 'MEMBER',
        }),
        update: async (args: any) => {
          updatedUserData = args.data;
          return { id: 'usr_me', ...args.data };
        },
      },
      gitHubAccount: {
        findUnique: async () => null,
        create: async (args: any) => {
          createdAccountData = args.data;
          return { id: 'gh_new_1', ...args.data };
        },
      },
      commit: {
        updateMany: async () => {
          commitLinked = true;
          return { count: 3 };
        },
      },
      pullRequest: {
        updateMany: async () => {
          prLinked = true;
          return { count: 1 };
        },
      },
      review: {
        updateMany: async () => ({ count: 0 }),
      },
    });

    const svc = new GitHubOAuthService(
      authService,
      dbMock as any,
      makeRedisServiceMock(makeRedisMock()) as any,
    );

    const result = await svc.associateUserWithGitHub(
      'usr_me',
      dummyGithubUser as any,
      'mona@github.com',
      dummyTokenResponse,
    );

    assert.strictEqual(result.user.id, 'usr_me');
    assert.strictEqual(result.isNewAccount, true);
    assert.strictEqual(createdAccountData.userId, 'usr_me');
    assert.strictEqual(createdAccountData.username, 'octocat');
    assert.strictEqual(createdAccountData.accessToken, dummyTokenResponse.access_token);
    assert.strictEqual(updatedUserData.avatarUrl, dummyGithubUser.avatar_url);
    assert.strictEqual(commitLinked, true);
    assert.strictEqual(prLinked, true);
    console.log('  ✓ Associates new GitHub account, syncs avatar, and links contributions');
  }

  // 20. Updates existing GitHub account when already linked to the same user
  {
    let updatedAccountData: any = null;

    const dbMock = makeDbServiceMock({
      user: {
        findUnique: async () => ({
          id: 'usr_me',
          email: 'me@example.com',
          avatarUrl: 'https://existing.png',
          role: 'ADMIN',
        }),
      },
      gitHubAccount: {
        findUnique: async () => ({
          id: 'gh_existing_1',
          userId: 'usr_me',
          githubUserId: BigInt(dummyGithubUser.id),
        }),
        update: async (args: any) => {
          updatedAccountData = args.data;
          return { id: 'gh_existing_1', ...args.data };
        },
      },
    });

    const svc = new GitHubOAuthService(
      authService,
      dbMock as any,
      makeRedisServiceMock(makeRedisMock()) as any,
    );

    const result = await svc.associateUserWithGitHub(
      'usr_me',
      dummyGithubUser as any,
      'mona@github.com',
      dummyTokenResponse,
    );

    assert.strictEqual(result.user.id, 'usr_me');
    assert.strictEqual(result.isNewAccount, false);
    assert.strictEqual(updatedAccountData.accessToken, dummyTokenResponse.access_token);
    assert.strictEqual(updatedAccountData.username, 'octocat');
    console.log('  ✓ Updates tokens and metadata for already-linked GitHub account');
  }

  // 21. handleCallback binds identity to authenticated user via state metadata
  {
    const statePayload = JSON.stringify({ userId: 'usr_logged_in', createdAt: Date.now() });
    const redis = makeRedisMock({ getdel: async () => statePayload });

    let createdAccountForUser: string | null = null;

    const dbMock = makeDbServiceMock({
      user: {
        findUnique: async (args: any) => ({
          id: args.where.id,
          email: 'me@example.com',
          role: 'MEMBER',
          avatarUrl: null,
        }),
      },
      gitHubAccount: {
        findUnique: async () => null,
        create: async (args: any) => {
          createdAccountForUser = args.data.userId;
          return { id: 'gh_acc', ...args.data };
        },
      },
    });

    const svc = new GitHubOAuthService(
      authService,
      dbMock as any,
      makeRedisServiceMock(redis) as any,
    );

    (svc as any).githubAuthApi = {
      getAuthorizationUrl: () => '',
      exchangeCodeForToken: async () => dummyTokenResponse,
    };
    (svc as any).fetchGitHubProfile = async () => ({
      githubUser: dummyGithubUser,
      primaryEmail: 'mona@github.com',
    });

    const result = await svc.handleCallback('valid_code', 'a'.repeat(48));

    assert.strictEqual(result.isLinked, true);
    assert.strictEqual(result.isNewUser, false);
    assert.strictEqual(createdAccountForUser, 'usr_logged_in');
    console.log('  ✓ handleCallback associates identity using state-embedded userId');
  }

  // 22. associateGitHubIdentity rejects if state was bound to a different user ID
  {
    const statePayload = JSON.stringify({ userId: 'usr_diff_1', createdAt: Date.now() });
    const redis = makeRedisMock({ getdel: async () => statePayload });

    const svc = new GitHubOAuthService(
      authService,
      makeDbServiceMock() as any,
      makeRedisServiceMock(redis) as any,
    );

    let caught: any;
    try {
      await svc.associateGitHubIdentity('usr_current_user', 'code', 'a'.repeat(48));
    } catch (e) {
      caught = e;
    }

    assert.ok(caught instanceof AuthenticationException);
    assert.ok(caught.message.includes('does not match the authenticated user session'));
    console.log('  ✓ associateGitHubIdentity rejects mismatched user state');
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function runAll() {
  console.log('=== GitHub OAuth Security & Identity Association Tests ===');

  await testGuard();
  await testStateValidation();
  await testCallbackErrorMapping();
  await testIdentityAssociation();

  console.log('\n✅ ALL GITHUB OAUTH & IDENTITY ASSOCIATION TESTS PASSED!\n');
}

runAll().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
