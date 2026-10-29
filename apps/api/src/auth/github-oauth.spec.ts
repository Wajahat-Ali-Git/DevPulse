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
import { GitHubOAuthService, GITHUB_OAUTH_SCOPES } from './github-oauth.service';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
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
    // Token is encrypted at rest using AES-256-GCM envelope
    assert.notStrictEqual(createdAccountData.accessToken, dummyTokenResponse.access_token);
    assert.ok(createdAccountData.accessToken.startsWith('v1:'));
    assert.strictEqual(authService.decryptToken(createdAccountData.accessToken), dummyTokenResponse.access_token);
    assert.strictEqual(authService.decryptToken(createdAccountData.refreshToken), dummyTokenResponse.refresh_token);
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
    // Token is encrypted at rest using AES-256-GCM envelope
    assert.notStrictEqual(updatedAccountData.accessToken, dummyTokenResponse.access_token);
    assert.ok(updatedAccountData.accessToken.startsWith('v1:'));
    assert.strictEqual(authService.decryptToken(updatedAccountData.accessToken), dummyTokenResponse.access_token);
    assert.strictEqual(authService.decryptToken(updatedAccountData.refreshToken), dummyTokenResponse.refresh_token);
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
  }
}

// ---------------------------------------------------------------------------
// Minimum Permissions & Callback Scenarios (Success, Denial, Invalid)
// ---------------------------------------------------------------------------

async function testCallbackScenarios() {
  console.log('\n--- Minimum Permissions & End-to-End Callback Scenarios ---');

  const authService = new AuthService();

  // 23. Minimum required scopes requested
  {
    assert.deepStrictEqual([...GITHUB_OAUTH_SCOPES], ['read:user', 'user:email']);
    assert.ok(!GITHUB_OAUTH_SCOPES.includes('repo'), 'Should NOT request broad "repo" scope for basic authentication');
    assert.ok(!GITHUB_OAUTH_SCOPES.includes('admin'), 'Should NOT request admin scopes');
    assert.ok(!GITHUB_OAUTH_SCOPES.includes('write'), 'Should NOT request write scopes');

    const svc = new GitHubOAuthService(
      authService,
      makeDbServiceMock() as any,
      makeRedisServiceMock(makeRedisMock()) as any,
    );
    let capturedOptions: any = null;
    (svc as any).githubAuthApi = {
      getAuthorizationUrl: (options: any) => {
        capturedOptions = options;
        return `https://github.com/login/oauth/authorize?scope=${options.scopes.join('+')}&state=${options.state}`;
      },
    };

    const url = await svc.buildAuthorizationUrl();
    assert.deepStrictEqual(capturedOptions.scopes, ['read:user', 'user:email']);
    assert.ok(url.includes('scope=read%3Auser+user%3Aemail') || url.includes('read:user'));
    console.log('  ✓ Minimum required scopes requested strictly (read:user, user:email)');
  }

  // 24. Callback Success Scenario (New user signs in via OAuth)
  {
    const state = 'c'.repeat(48);
    const redis = makeRedisMock({ getdel: async () => '1' });
    let createdUser: any = null;
    let createdAccount: any = null;
    let createdRefreshToken: any = null;

    const dbMock = makeDbServiceMock({
      user: {
        findUnique: async () => null,
      },
      gitHubAccount: {
        findUnique: async () => null,
      },
      $transaction: async (fn: any) => {
        return fn({
          user: {
            create: async (args: any) => {
              createdUser = { id: 'usr_brand_new', ...args.data };
              return createdUser;
            },
          },
          gitHubAccount: {
            create: async (args: any) => {
              createdAccount = { id: 'gh_brand_new', ...args.data };
              return createdAccount;
            },
          },
        });
      },
      refreshToken: {
        create: async (args: any) => {
          createdRefreshToken = args.data;
          return { id: 'rt_1', ...args.data };
        },
      },
    });

    const svc = new GitHubOAuthService(
      authService,
      dbMock as any,
      makeRedisServiceMock(redis) as any,
    );

    (svc as any).githubAuthApi = {
      exchangeCodeForToken: async () => ({
        access_token: 'gho_fresh_tok',
        refresh_token: 'ghr_fresh_tok',
        expires_in: 3600,
        scope: 'read:user,user:email',
      }),
    };
    (svc as any).fetchGitHubProfile = async () => ({
      githubUser: {
        id: 998877,
        login: 'newcoder',
        name: 'New Coder',
        email: null,
        avatar_url: 'https://github.com/avatar.png',
        html_url: 'https://github.com/newcoder',
      },
      primaryEmail: 'verified.new@example.com',
    });

    const result = await svc.handleCallback('valid_auth_code', state);

    assert.strictEqual(result.isNewUser, true);
    assert.strictEqual(result.isLinked, false);
    assert.ok(result.tokens.accessToken, 'Access token should be issued');
    assert.ok(result.tokens.refreshToken, 'Refresh token should be issued');
    assert.strictEqual(createdUser.email, 'verified.new@example.com');
    assert.strictEqual(createdAccount.username, 'newcoder');
    assert.deepStrictEqual(createdAccount.scopes, ['read:user', 'user:email']);
    assert.strictEqual(createdRefreshToken.userId, 'usr_brand_new');
    console.log('  ✓ Callback success scenario: creates user, creates account with minimal scopes, issues tokens');
  }

  // 25. Callback Success Scenario with Controller Redirect
  {
    const state = 'd'.repeat(48);
    const redis = makeRedisMock({ getdel: async () => '1' });

    const dbMock = makeDbServiceMock({
      user: {
        findUnique: async () => ({ id: 'usr_existing', email: 'existing@devpulse.io', role: 'MEMBER' }),
      },
      gitHubAccount: {
        findUnique: async () => ({
          id: 'gh_existing',
          userId: 'usr_existing',
          user: { id: 'usr_existing', email: 'existing@devpulse.io', role: 'MEMBER' },
        }),
        update: async () => ({ id: 'gh_existing' }),
      },
    });

    const svc = new GitHubOAuthService(
      authService,
      dbMock as any,
      makeRedisServiceMock(redis) as any,
    );

    (svc as any).githubAuthApi = {
      exchangeCodeForToken: async () => ({
        access_token: 'gho_tok',
        scope: 'read:user,user:email',
      }),
    };
    (svc as any).fetchGitHubProfile = async () => ({
      githubUser: {
        id: 112233,
        login: 'existinguser',
        email: 'existing@devpulse.io',
      },
      primaryEmail: 'existing@devpulse.io',
    });

    const controller = new AuthController(authService, svc, dbMock as any);
    let redirectedUrl: string = '';
    const resMock = {
      redirect: (url: string) => {
        redirectedUrl = url;
      },
    };

    await controller.githubCallback('auth_code_123', state, undefined, resMock as any);

    assert.ok(redirectedUrl.includes('/auth/callback'), 'Should redirect to web /auth/callback');
    assert.ok(redirectedUrl.includes('access_token='), 'Redirect URL should include access_token');
    assert.ok(redirectedUrl.includes('refresh_token='), 'Redirect URL should include refresh_token');
    assert.ok(redirectedUrl.includes('is_new_user=false'), 'Existing user is_new_user should be false');
    console.log('  ✓ Controller callback success: redirects to web app with JWTs and query params');
  }

  // 26. Callback Denial Scenario: access_denied query from GitHub
  {
    const guard = new GitHubOAuthGuard();
    const ctx = makeContext({
      error: 'access_denied',
      error_description: 'The+user+has+denied+your+application+access.',
    });

    let guardError: any;
    try {
      guard.canActivate(ctx);
    } catch (err) {
      guardError = err;
    }

    assert.ok(guardError instanceof AuthenticationException);
    assert.ok(guardError.message.toLowerCase().includes('denied'), `Expected denied message, got: ${guardError.message}`);
    console.log('  ✓ Callback denial scenario: access_denied caught and reported cleanly before code exchange');
  }

  // 27. Callback Denial Scenario: application_suspended query from GitHub
  {
    const guard = new GitHubOAuthGuard();
    const ctx = makeContext({
      error: 'application_suspended',
      error_description: 'Application+is+suspended.',
    });

    let guardError: any;
    try {
      guard.canActivate(ctx);
    } catch (err) {
      guardError = err;
    }

    assert.ok(guardError instanceof AuthenticationException);
    assert.ok(guardError.message.toLowerCase().includes('suspended'), `Expected suspended message, got: ${guardError.message}`);
    console.log('  ✓ Callback denial scenario: application_suspended caught with helpful message');
  }

  // 28. Invalid Callback Scenario: Missing or Empty Code
  {
    const guard = new GitHubOAuthGuard();
    for (const invalidCode of [undefined, '', '   ']) {
      const ctx = makeContext({ code: invalidCode, state: 'e'.repeat(48) });
      let err: any;
      try { guard.canActivate(ctx); } catch (e) { err = e; }
      assert.ok(err instanceof AuthenticationException);
      assert.ok(err.message.includes('authorization code'));
    }
    console.log('  ✓ Invalid callback scenario: missing or whitespace code rejected');
  }

  // 29. Invalid Callback Scenario: Missing or Tampered State
  {
    const guard = new GitHubOAuthGuard();
    const tamperedStates = [
      undefined,
      '',
      'abc',
      '12345',
      'e'.repeat(47), // 47 chars (1 char too short)
      'e'.repeat(49), // 49 chars (1 char too long)
      'e'.repeat(47) + 'Z', // Invalid hex character
      '../etc/passwd',
      '<script>alert(1)</script>',
    ];

    for (const badState of tamperedStates) {
      const ctx = makeContext({ code: 'valid_code', state: badState });
      let err: any;
      try { guard.canActivate(ctx); } catch (e) { err = e; }
      assert.ok(err instanceof AuthenticationException, `Failed to reject state: ${badState}`);
    }
    console.log('  ✓ Invalid callback scenario: missing, malformed, non-hex, and injected states rejected by guard');
  }

  // 30. Invalid Callback Scenario: State replay or expiration (Redis returns null)
  {
    const redis = makeRedisMock({ getdel: async () => null });
    const svc = new GitHubOAuthService(
      authService,
      makeDbServiceMock() as any,
      makeRedisServiceMock(redis) as any,
    );

    let err: any;
    try {
      await svc.handleCallback('any_code', 'f'.repeat(48));
    } catch (e) {
      err = e;
    }

    assert.ok(err instanceof AuthenticationException);
    assert.ok(err.message.toLowerCase().includes('invalid') || err.message.toLowerCase().includes('expired'));
    console.log('  ✓ Invalid callback scenario: state replay or expiration rejected with CSRF error');
  }

  // 31. Invalid Callback Scenario: GitHub returns bad_verification_code
  {
    const redis = makeRedisMock({ getdel: async () => '1' });
    const svc = new GitHubOAuthService(
      authService,
      makeDbServiceMock() as any,
      makeRedisServiceMock(redis) as any,
    );

    (svc as any).githubAuthApi = {
      exchangeCodeForToken: async () => {
        throw new Error('GitHub OAuth error: bad_verification_code');
      },
    };

    let err: any;
    try {
      await svc.handleCallback('invalid_or_expired_code', 'a'.repeat(48));
    } catch (e) {
      err = e;
    }

    assert.ok(err instanceof AuthenticationException);
    assert.ok(err.message.includes('expired or has already been used'));
    console.log('  ✓ Invalid callback scenario: bad_verification_code mapped to friendly expired/used error');
  }

  // 32. Invalid Callback Scenario: GitHub user has no verified email
  {
    const redis = makeRedisMock({ getdel: async () => '1' });
    const svc = new GitHubOAuthService(
      authService,
      makeDbServiceMock() as any,
      makeRedisServiceMock(redis) as any,
    );

    (svc as any).githubAuthApi = {
      exchangeCodeForToken: async () => ({
        access_token: 'gho_tok',
      }),
    };
    (svc as any).fetchGitHubProfile = async () => {
      throw new AuthenticationException(
        'Your GitHub account has no verified primary email address. Please add and verify an email on GitHub, then try signing in again.',
      );
    };

    let err: any;
    try {
      await svc.handleCallback('code', 'a'.repeat(48));
    } catch (e) {
      err = e;
    }

    assert.ok(err instanceof AuthenticationException);
    assert.ok(err.message.includes('verified primary email'));
    console.log('  ✓ Invalid callback scenario: unverified email rejected with actionable message');
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
  await testCallbackScenarios();

  console.log('\n✅ ALL GITHUB OAUTH & IDENTITY ASSOCIATION TESTS PASSED!\n');
}

runAll().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
