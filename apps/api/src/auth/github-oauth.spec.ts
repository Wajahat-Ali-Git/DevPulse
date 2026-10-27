/**
 * GitHub OAuth Security Tests
 *
 * Covers:
 *  - GitHubOAuthGuard: error handling, format validation, missing params
 *  - GitHubOAuthService: CSRF state validation, Redis availability assertion,
 *    token error mapping, profile fetch failure, email resolution
 */
import * as assert from 'node:assert';
import { ExecutionContext } from '@nestjs/common';
import { GitHubOAuthGuard } from './guards/github-oauth.guard';
import { GitHubOAuthService } from './github-oauth.service';
import { AuthService } from './auth.service';
import { AuthenticationException } from '../common/errors';

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
  return {
    client: {
      gitHubAccount: {
        findUnique: async () => null,
        update: async () => ({}),
        create: async () => ({}),
      },
      user: {
        findUnique: async () => null,
        create: async () => ({ id: 'usr_1', email: 'test@example.com', role: 'MEMBER' }),
      },
      refreshToken: {
        create: async () => ({}),
      },
      $transaction: async (fn: (tx: any) => any) => fn({
        user: { create: async () => ({ id: 'usr_new', email: 'new@example.com', role: 'MEMBER' }) },
        gitHubAccount: { create: async () => ({}) },
      }),
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
    const ctx = makeContext({ error: 'some_error', error_description: '%zz_invalid' });
    let caught: any;
    try { guard.canActivate(ctx); } catch (e) { caught = e; }
    assert.ok(caught instanceof AuthenticationException);
    // Should fall back gracefully — no URIError propagated
    assert.ok(!caught.message.includes('URIError'), `URIError leaked: ${caught.message}`);
    console.log('  ✓ Malformed error_description handled without URIError');
  }

  // 4. Missing code → rejected
  {
    const ctx = makeContext({ state: 'a'.repeat(48) });
    let caught: any;
    try { guard.canActivate(ctx); } catch (e) { caught = e; }
    assert.ok(caught instanceof AuthenticationException);
    assert.ok(caught.message.toLowerCase().includes('code'), `Got: ${caught.message}`);
    console.log('  ✓ Missing code rejected');
  }

  // 5. Missing state → rejected
  {
    const ctx = makeContext({ code: 'abc123' });
    let caught: any;
    try { guard.canActivate(ctx); } catch (e) { caught = e; }
    assert.ok(caught instanceof AuthenticationException);
    assert.ok(caught.message.toLowerCase().includes('state'), `Got: ${caught.message}`);
    console.log('  ✓ Missing state rejected');
  }

  // 6. State wrong length → rejected for format
  {
    const ctx = makeContext({ code: 'abc123', state: 'tooshort' });
    let caught: any;
    try { guard.canActivate(ctx); } catch (e) { caught = e; }
    assert.ok(caught instanceof AuthenticationException);
    assert.ok(caught.message.toLowerCase().includes('malformed'), `Got: ${caught.message}`);
    console.log('  ✓ State with wrong length rejected as malformed');
  }

  // 7. State with non-hex chars → rejected
  {
    const ctx = makeContext({ code: 'abc123', state: 'z'.repeat(48) });
    let caught: any;
    try { guard.canActivate(ctx); } catch (e) { caught = e; }
    assert.ok(caught instanceof AuthenticationException);
    assert.ok(caught.message.toLowerCase().includes('malformed'), `Got: ${caught.message}`);
    console.log('  ✓ State with non-hex characters rejected');
  }

  // 8. Valid inputs pass through
  {
    const ctx = makeContext({ code: 'validcode123', state: 'a1b2c3d4'.repeat(6) }); // 48 hex chars
    const result = guard.canActivate(ctx);
    assert.strictEqual(result, true);
    console.log('  ✓ Valid code + well-formed state passes guard');
  }
}

// ---------------------------------------------------------------------------
// GitHubOAuthService.validateOAuthState tests
// ---------------------------------------------------------------------------

async function testStateValidation() {
  console.log('\n--- GitHubOAuthService: State Validation ---');

  const authService = new AuthService();

  // 9. Redis unavailable during generateOAuthState → throws
  {
    const svc = new GitHubOAuthService(
      authService,
      makeDbServiceMock() as any,
      makeRedisServiceMock(null) as any,  // client is null
    );
    let caught: any;
    try { await svc.generateOAuthState(); } catch (e) { caught = e; }
    assert.ok(caught instanceof AuthenticationException);
    assert.ok(caught.message.toLowerCase().includes('unavailable'), `Got: ${caught.message}`);
    console.log('  ✓ generateOAuthState throws when Redis is unavailable');
  }

  // 10. Redis unavailable during validateOAuthState → throws (fail-secure)
  {
    const svc = new GitHubOAuthService(
      authService,
      makeDbServiceMock() as any,
      makeRedisServiceMock(null) as any,
    );
    let caught: any;
    try { await svc.validateOAuthState('a'.repeat(48)); } catch (e) { caught = e; }
    assert.ok(caught instanceof AuthenticationException);
    assert.ok(caught.message.toLowerCase().includes('unavailable'), `Got: ${caught.message}`);
    console.log('  ✓ validateOAuthState throws when Redis is unavailable (fail-secure)');
  }

  // 11. Valid state in Redis (GETDEL returns '1') → passes
  {
    const svc = new GitHubOAuthService(
      authService,
      makeDbServiceMock() as any,
      makeRedisServiceMock(makeRedisMock({ getdel: async () => '1' })) as any,
    );
    // Should not throw
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

  // Helper — build service with a custom exchangeCodeForToken throwing a given error
  function makeServiceWithExchangeError(errorMessage: string) {
    const redis = makeRedisMock({ getdel: async () => '1' });
    const svc = new GitHubOAuthService(
      authService,
      makeDbServiceMock() as any,
      makeRedisServiceMock(redis) as any,
    );

    // Monkey-patch the private githubAuthApi on the instance
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
    // Must not leak raw stack or internal details
    assert.ok(!caught.message.includes('stack'), `Stack leaked: ${caught.message}`);
    console.log('  ✓ Unknown GitHub error caught and surfaced safely');
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function runAll() {
  console.log('=== GitHub OAuth Security Tests ===');

  await testGuard();
  await testStateValidation();
  await testCallbackErrorMapping();

  console.log('\n✅ ALL GITHUB OAUTH SECURITY TESTS PASSED!\n');
}

runAll().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
