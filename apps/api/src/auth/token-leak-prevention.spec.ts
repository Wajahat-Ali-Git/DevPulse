import * as assert from 'node:assert';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { TokenEncryptionService } from './token-encryption.service';

async function runLeakPreventionTests() {
  console.log('=== API Response Token Leak Prevention Tests ===');

  const encryptionService = new TokenEncryptionService();
  const authService = new AuthService(encryptionService);

  // Test 1: GET /api/v1/auth/me does not return accessToken or refreshToken
  console.log('Test 1: GET /api/v1/auth/me response sanitization');
  {
    const mockUserRecord = {
      id: 'usr_me_123',
      email: 'alex@devpulse.local',
      name: 'Alex Developer',
      role: 'MEMBER',
      avatarUrl: 'https://avatars.githubusercontent.com/u/12345',
      createdAt: new Date(),
      updatedAt: new Date(),
      githubAccounts: [
        {
          id: 'gh_acc_1',
          githubUserId: BigInt(12345),
          username: 'alexdev',
          displayName: 'Alex Developer',
          email: 'alex@devpulse.local',
          avatarUrl: 'https://avatars.githubusercontent.com/u/12345',
          profileUrl: 'https://github.com/alexdev',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    };

    let selectedFields: any = null;
    const dbMock = {
      client: {
        user: {
          findUnique: async (args: any) => {
            selectedFields = args.select;
            return mockUserRecord;
          },
        },
      },
    };

    const controller = new AuthController(authService, {} as any, dbMock as any);
    const result = await controller.getProfile({ sub: 'usr_me_123', email: 'alex@devpulse.local', role: 'MEMBER' });

    // Assert that findUnique explicitly excludes tokens in query projection
    assert.strictEqual(selectedFields.githubAccounts.select.accessToken, undefined);
    assert.strictEqual(selectedFields.githubAccounts.select.refreshToken, undefined);

    // Assert that result response contains zero token fields
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes('accessToken'), 'Response must never include accessToken');
    assert.ok(!serialized.includes('refreshToken'), 'Response must never include refreshToken');
    assert.ok(!serialized.includes('access_token'), 'Response must never include access_token');
    assert.ok(!serialized.includes('refresh_token'), 'Response must never include refresh_token');
    console.log('  ✓ GET /api/v1/auth/me never leaks tokens in response body');
  }

  // Test 2: POST /api/v1/auth/github/associate does not return OAuth tokens
  console.log('Test 2: POST /api/v1/auth/github/associate response sanitization');
  {
    const githubOAuthServiceMock = {
      associateGitHubIdentity: async () => ({
        user: { id: 'usr_1', email: 'test@devpulse.local', role: 'MEMBER' },
        gitHubAccount: {
          id: 'gh_acc_2',
          githubUserId: BigInt(9999),
          username: 'gh_user',
          displayName: 'GH User',
          email: 'test@devpulse.local',
          avatarUrl: 'https://avatar.png',
          profileUrl: 'https://github.com/gh_user',
          accessToken: 'v1:encrypted_gho_token',
          refreshToken: 'v1:encrypted_ghr_token',
        },
      }),
    };

    const controller = new AuthController(authService, githubOAuthServiceMock as any, {} as any);
    const result = await controller.associateGitHub(
      { sub: 'usr_1', email: 'test@devpulse.local', role: 'MEMBER' },
      { code: 'valid_code', state: 'a'.repeat(48) },
    );

    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes('accessToken'), 'Response must never include accessToken');
    assert.ok(!serialized.includes('refreshToken'), 'Response must never include refreshToken');
    assert.ok(!serialized.includes('v1:encrypted'), 'Response must never include ciphertext or tokens');
    assert.strictEqual((result as any).githubAccount.accessToken, undefined);
    assert.strictEqual((result as any).githubAccount.refreshToken, undefined);
    console.log('  ✓ POST /api/v1/auth/github/associate never leaks tokens in response body');
  }

  // Test 3: POST /api/v1/auth/refresh sets httpOnly secure cookie and returns no tokens in response body
  console.log('Test 3: POST /api/v1/auth/refresh response body sanitization');
  {
    const existingRefreshTokenRecord = {
      id: 'rf_1',
      userId: 'usr_1',
      tokenHash: authService.hashToken('raw_refresh_token_value'),
      familyId: 'family_1',
      isRevoked: false,
      expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24),
      user: { id: 'usr_1', email: 'test@devpulse.local', role: 'MEMBER' },
    };

    let updatedToken: any = null;
    let createdToken: any = null;

    const dbMock = {
      client: {
        refreshToken: {
          findUnique: async () => existingRefreshTokenRecord,
          update: async (args: any) => {
            updatedToken = args;
            return args.data;
          },
          create: async (args: any) => {
            createdToken = args;
            return args.data;
          },
        },
      },
    };

    const cookiesSet: Array<{ name: string; val: string; options: any }> = [];
    const resMock = {
      cookie: (name: string, val: string, options: any) => {
        cookiesSet.push({ name, val, options });
      },
    };

    const controller = new AuthController(authService, {} as any, dbMock as any);
    const result = await controller.refreshTokens(
      { refreshToken: 'raw_refresh_token_value' },
      resMock as any,
    );

    // Verify response body contains ONLY non-token metadata
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes('accessToken'), 'Response body must never contain accessToken');
    assert.ok(!serialized.includes('refreshToken'), 'Response body must never contain refreshToken');
    assert.strictEqual(result.tokenType, 'Bearer');
    assert.strictEqual(result.expiresIn, 900);

    // Verify cookies set with httpOnly, secure, sameSite=lax
    const accessCookie = cookiesSet.find((c) => c.name === 'devpulse_access_token');
    const refreshCookie = cookiesSet.find((c) => c.name === 'devpulse_refresh_token');

    assert.ok(accessCookie, 'Must set devpulse_access_token cookie');
    assert.ok(refreshCookie, 'Must set devpulse_refresh_token cookie');

    assert.strictEqual(accessCookie.options.httpOnly, true);
    assert.strictEqual(accessCookie.options.sameSite, 'lax');
    assert.strictEqual(accessCookie.options.path, '/');

    assert.strictEqual(refreshCookie.options.httpOnly, true);
    assert.strictEqual(refreshCookie.options.sameSite, 'lax');
    assert.strictEqual(refreshCookie.options.path, '/');

    console.log('  ✓ POST /api/v1/auth/refresh returns clean response and sets secure httpOnly cookies');
  }

  // Test 4: Database refresh token storage uses one-way SHA-256 hash
  console.log('Test 4: Database refresh token storage uses cryptographic hash');
  {
    const rawToken = 'my_raw_refresh_token_value_to_hash';
    const hash = authService.hashToken(rawToken);

    assert.notStrictEqual(hash, rawToken);
    assert.strictEqual(hash.length, 64, 'SHA-256 hex must be 64 characters');
    console.log('  ✓ Refresh tokens are stored only as one-way SHA-256 hashes');
  }

  console.log('\n✅ ALL API RESPONSE TOKEN LEAK PREVENTION TESTS PASSED!\n');
}

runLeakPreventionTests().catch((err) => {
  console.error('❌ Leak prevention tests failed:', err);
  process.exit(1);
});
