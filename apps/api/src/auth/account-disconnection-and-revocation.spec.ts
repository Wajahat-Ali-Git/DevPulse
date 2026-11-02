import * as assert from 'node:assert';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { GitHubOAuthService } from './github-oauth.service';
import { TokenEncryptionService } from './token-encryption.service';
import { AuthenticationException, ResourceNotFoundException } from '../common/errors';

async function runDisconnectionAndRevocationTests() {
  console.log('=== GitHub Account Disconnection, Expired & Revoked Authorizations Tests ===\n');

  const encryptionService = new TokenEncryptionService();
  const authService = new AuthService(encryptionService);

  // ---------------------------------------------------------------------------
  // Suite 1: GitHub Account Disconnection & Token Cleanup
  // ---------------------------------------------------------------------------
  console.log('--- Suite 1: GitHub Account Disconnection & Token Cleanup ---');

  // Test 1.1: Disconnection with purge=true revokes remote grant and deletes DB row
  console.log('Test 1.1: Disconnection with purge=true revokes grant and purges account');
  {
    let revokedToken: string | null = null;
    let deletedAccountId: string | null = null;
    const redisDeletes: string[] = [];

    const rawToken = 'gho_secret_access_token_to_disconnect_123';
    const encryptedToken = authService.encryptToken(rawToken)!;

    const mockAccount = {
      id: 'gh_acc_101',
      userId: 'usr_owner_1',
      githubUserId: BigInt(88888),
      username: 'octocat',
      accessToken: encryptedToken,
      refreshToken: authService.encryptToken('ghr_refresh_123'),
      tokenExpiresAt: new Date(Date.now() + 3600000),
    };

    const dbMock = {
      client: {
        gitHubAccount: {
          findFirst: async (args: any) => {
            if (args.where.userId === 'usr_owner_1') return mockAccount;
            return null;
          },
          delete: async (args: any) => {
            deletedAccountId = args.where.id;
            return mockAccount;
          },
        },
      },
    };

    const redisMock = {
      client: {
        del: async (key: string) => {
          redisDeletes.push(key);
          return 1;
        },
      },
    };

    const oauthService = new GitHubOAuthService(authService, dbMock as any, redisMock as any);

    // Mock remote revokeGrant on the private githubAuthApi instance
    (oauthService as any).githubAuthApi = {
      revokeGrant: async (opts: { accessToken: string }) => {
        revokedToken = opts.accessToken;
        return true;
      },
    };

    const result = await oauthService.disconnectGitHubAccount('usr_owner_1', 'gh_acc_101', {
      purgeAccount: true,
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.disconnectedAccount.username, 'octocat');
    assert.strictEqual(revokedToken, rawToken, 'Decrypted token must be passed to revokeGrant');
    assert.strictEqual(deletedAccountId, 'gh_acc_101', 'GitHubAccount record must be deleted');
    assert.ok(redisDeletes.includes('github:account:gh_acc_101'), 'Redis account cache must be cleared');
    assert.ok(redisDeletes.includes('github:user:usr_owner_1'), 'Redis user cache must be cleared');
    console.log('  ✓ Account purged and remote grant revoked successfully');
  }

  // Test 1.2: Disconnection with purge=false zeroes out tokens and marks disconnected
  console.log('Test 1.2: Disconnection with purge=false zeroes out all token credentials');
  {
    let updatedData: any = null;
    const rawToken = 'gho_secret_access_token_456';
    const encryptedToken = authService.encryptToken(rawToken)!;

    const mockAccount = {
      id: 'gh_acc_102',
      userId: 'usr_owner_2',
      githubUserId: BigInt(99999),
      username: 'monalisa',
      accessToken: encryptedToken,
      refreshToken: authService.encryptToken('ghr_refresh_456'),
      tokenExpiresAt: new Date(Date.now() + 3600000),
      scopes: ['read:user'],
    };

    const dbMock = {
      client: {
        gitHubAccount: {
          findFirst: async () => mockAccount,
          update: async (args: any) => {
            updatedData = args.data;
            return { ...mockAccount, ...args.data };
          },
        },
      },
    };

    const oauthService = new GitHubOAuthService(authService, dbMock as any, { client: null } as any);
    (oauthService as any).githubAuthApi = {
      revokeGrant: async () => true,
    };

    const result = await oauthService.disconnectGitHubAccount('usr_owner_2', 'gh_acc_102', {
      purgeAccount: false,
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(updatedData.accessToken, null, 'accessToken must be nulled');
    assert.strictEqual(updatedData.refreshToken, null, 'refreshToken must be nulled');
    assert.strictEqual(updatedData.tokenExpiresAt, null, 'tokenExpiresAt must be nulled');
    assert.deepStrictEqual(updatedData.scopes, [], 'scopes must be emptied');
    console.log('  ✓ Tokens zeroed out and cleaned up safely without deleting account row');
  }

  // Test 1.3: Remote token revocation failure (e.g. 404 or network outage) is fail-safe
  console.log('Test 1.3: Remote revocation failure does not prevent local token cleanup');
  {
    let deleteCalled = false;
    const mockAccount = {
      id: 'gh_acc_103',
      userId: 'usr_owner_3',
      githubUserId: BigInt(77777),
      username: 'dev_resilient',
      accessToken: authService.encryptToken('gho_stale_token'),
    };

    const dbMock = {
      client: {
        gitHubAccount: {
          findFirst: async () => mockAccount,
          delete: async () => {
            deleteCalled = true;
            return mockAccount;
          },
        },
      },
    };

    const oauthService = new GitHubOAuthService(authService, dbMock as any, { client: null } as any);
    (oauthService as any).githubAuthApi = {
      revokeGrant: async () => {
        throw new Error('GitHub API unreachable (503 Service Unavailable)');
      },
    };

    const result = await oauthService.disconnectGitHubAccount('usr_owner_3', 'gh_acc_103');
    assert.strictEqual(result.success, true);
    assert.strictEqual(deleteCalled, true, 'Local deletion must proceed even if remote revocation fails');
    console.log('  ✓ Fail-safe local cleanup completed despite remote revocation error');
  }

  // Test 1.4: Disconnecting non-existent account or account belonging to other user throws ResourceNotFoundException
  console.log('Test 1.4: Unauthorized or nonexistent account disconnection throws 404');
  {
    const dbMock = {
      client: {
        gitHubAccount: {
          findFirst: async () => null, // Not found or wrong user
        },
      },
    };

    const oauthService = new GitHubOAuthService(authService, dbMock as any, { client: null } as any);

    let caughtError: any;
    try {
      await oauthService.disconnectGitHubAccount('usr_attacker', 'gh_acc_victim');
    } catch (err) {
      caughtError = err;
    }

    assert.ok(caughtError instanceof ResourceNotFoundException);
    assert.strictEqual(caughtError.message, 'Linked GitHub account not found for this user.');
    console.log('  ✓ Non-existent or mismatched account properly rejected');
  }

  // ---------------------------------------------------------------------------
  // Suite 2: Expired, Revoked, and Disconnected Authorizations
  // ---------------------------------------------------------------------------
  console.log('\n--- Suite 2: Expired, Revoked, and Disconnected Authorizations ---');

  // Test 2.1: ensureValidGitHubToken returns decrypted token when active
  console.log('Test 2.1: ensureValidGitHubToken returns active valid token');
  {
    const rawToken = 'gho_active_and_valid_token_123';
    const mockAccount = {
      id: 'gh_acc_201',
      userId: 'usr_active',
      accessToken: authService.encryptToken(rawToken),
      tokenExpiresAt: new Date(Date.now() + 3600000), // Valid for 1h
    };

    const dbMock = {
      client: {
        gitHubAccount: {
          findFirst: async () => mockAccount,
        },
      },
    };

    const oauthService = new GitHubOAuthService(authService, dbMock as any, { client: null } as any);
    const token = await oauthService.ensureValidGitHubToken('usr_active', 'gh_acc_201');
    assert.strictEqual(token, rawToken);
    console.log('  ✓ Active unexpired token returned successfully');
  }

  // Test 2.2: ensureValidGitHubToken automatically refreshes expired token
  console.log('Test 2.2: ensureValidGitHubToken refreshes expired token using refreshToken');
  {
    const oldExpiredRaw = 'gho_expired_access_token';
    const rawRefresh = 'ghr_valid_refresh_token';
    const freshNewRaw = 'gho_brand_new_access_token';
    const freshNewRefresh = 'ghr_brand_new_refresh_token';

    let updatedAccount: any = null;

    const mockAccount = {
      id: 'gh_acc_202',
      userId: 'usr_refresh_needed',
      accessToken: authService.encryptToken(oldExpiredRaw),
      refreshToken: authService.encryptToken(rawRefresh),
      tokenExpiresAt: new Date(Date.now() - 600000), // Expired 10 min ago
    };

    const dbMock = {
      client: {
        gitHubAccount: {
          findFirst: async () => mockAccount,
          update: async (args: any) => {
            updatedAccount = args.data;
            return { ...mockAccount, ...args.data };
          },
        },
      },
    };

    const oauthService = new GitHubOAuthService(authService, dbMock as any, { client: null } as any);
    (oauthService as any).githubAuthApi = {
      refreshToken: async (opts: { refreshToken: string }) => {
        assert.strictEqual(opts.refreshToken, rawRefresh, 'Decrypted refresh token must be sent to GitHub');
        return {
          access_token: freshNewRaw,
          refresh_token: freshNewRefresh,
          expires_in: 3600,
          scope: 'read:user,user:email',
          token_type: 'bearer',
        };
      },
    };

    const token = await oauthService.ensureValidGitHubToken('usr_refresh_needed', 'gh_acc_202');
    assert.strictEqual(token, freshNewRaw);
    assert.strictEqual(authService.decryptToken(updatedAccount.accessToken), freshNewRaw);
    assert.strictEqual(authService.decryptToken(updatedAccount.refreshToken), freshNewRefresh);
    assert.ok(updatedAccount.tokenExpiresAt.getTime() > Date.now(), 'tokenExpiresAt updated');
    console.log('  ✓ Expired token automatically refreshed and updated in DB');
  }

  // Test 2.3: ensureValidGitHubToken cleans up tokens if expired with no refresh token
  console.log('Test 2.3: Expired token without refresh token cleans up credentials and throws 401');
  {
    let tokenCleanedUp = false;

    const mockAccount = {
      id: 'gh_acc_203',
      userId: 'usr_no_refresh',
      accessToken: authService.encryptToken('gho_expired_alone'),
      refreshToken: null,
      tokenExpiresAt: new Date(Date.now() - 60000), // Expired
    };

    const dbMock = {
      client: {
        gitHubAccount: {
          findFirst: async () => mockAccount,
          update: async (args: any) => {
            if (args.data.accessToken === null) {
              tokenCleanedUp = true;
            }
            return { ...mockAccount, ...args.data };
          },
        },
      },
    };

    const oauthService = new GitHubOAuthService(authService, dbMock as any, { client: null } as any);

    let caughtError: any;
    try {
      await oauthService.ensureValidGitHubToken('usr_no_refresh', 'gh_acc_203');
    } catch (err) {
      caughtError = err;
    }

    assert.ok(caughtError instanceof AuthenticationException);
    assert.strictEqual(tokenCleanedUp, true, 'Tokens must be zeroed when unrefreshable');
    console.log('  ✓ Token zeroed out and AuthenticationException thrown');
  }

  // Test 2.4: ensureValidGitHubToken cleans up tokens when refresh fails (revoked on GitHub)
  console.log('Test 2.4: Revoked authorization during refresh triggers token cleanup');
  {
    let tokenCleanedUp = false;

    const mockAccount = {
      id: 'gh_acc_204',
      userId: 'usr_revoked_at_gh',
      accessToken: authService.encryptToken('gho_old'),
      refreshToken: authService.encryptToken('ghr_revoked_by_user_on_gh'),
      tokenExpiresAt: new Date(Date.now() - 60000),
    };

    const dbMock = {
      client: {
        gitHubAccount: {
          findFirst: async () => mockAccount,
          update: async (args: any) => {
            if (args.data.accessToken === null) {
              tokenCleanedUp = true;
            }
            return { ...mockAccount, ...args.data };
          },
        },
      },
    };

    const oauthService = new GitHubOAuthService(authService, dbMock as any, { client: null } as any);
    (oauthService as any).githubAuthApi = {
      refreshToken: async () => {
        throw new Error('GitHub token refresh error: bad_refresh_token');
      },
    };

    let caughtError: any;
    try {
      await oauthService.ensureValidGitHubToken('usr_revoked_at_gh', 'gh_acc_204');
    } catch (err) {
      caughtError = err;
    }

    assert.ok(caughtError instanceof AuthenticationException);
    assert.strictEqual(tokenCleanedUp, true, 'Revoked credentials cleaned up from DB');
    console.log('  ✓ Revoked authorization caught, cleaned up, and flagged');
  }

  // Test 2.5: ensureValidGitHubToken rejects disconnected account (accessToken == null)
  console.log('Test 2.5: Disconnected authorization immediately rejected');
  {
    const mockAccount = {
      id: 'gh_acc_205',
      userId: 'usr_disconnected',
      accessToken: null,
      refreshToken: null,
      tokenExpiresAt: null,
    };

    const dbMock = {
      client: {
        gitHubAccount: {
          findFirst: async () => mockAccount,
        },
      },
    };

    const oauthService = new GitHubOAuthService(authService, dbMock as any, { client: null } as any);

    let caughtError: any;
    try {
      await oauthService.ensureValidGitHubToken('usr_disconnected', 'gh_acc_205');
    } catch (err) {
      caughtError = err;
    }

    assert.ok(caughtError instanceof AuthenticationException);
    assert.ok(caughtError.message.includes('disconnected'));
    console.log('  ✓ Disconnected account rejected with actionable error message');
  }

  // Test 2.6: getAccountAuthorizationStatus categorization
  console.log('Test 2.6: getAccountAuthorizationStatus categorizes CONNECTED, EXPIRED, DISCONNECTED');
  {
    const oauthService = new GitHubOAuthService(authService, {} as any, { client: null } as any);

    const connected = oauthService.getAccountAuthorizationStatus({
      accessToken: 'v1:encrypted',
      tokenExpiresAt: new Date(Date.now() + 600000),
    });
    assert.strictEqual(connected.status, 'CONNECTED');
    assert.strictEqual(connected.isConnected, true);
    assert.strictEqual(connected.isExpired, false);

    const expired = oauthService.getAccountAuthorizationStatus({
      accessToken: 'v1:encrypted',
      tokenExpiresAt: new Date(Date.now() - 600000),
    });
    assert.strictEqual(expired.status, 'EXPIRED');
    assert.strictEqual(expired.isConnected, true);
    assert.strictEqual(expired.isExpired, true);

    const disconnected = oauthService.getAccountAuthorizationStatus({
      accessToken: null,
      tokenExpiresAt: null,
    });
    assert.strictEqual(disconnected.status, 'DISCONNECTED');
    assert.strictEqual(disconnected.isConnected, false);
    console.log('  ✓ Status correctly evaluated across all states');
  }

  // ---------------------------------------------------------------------------
  // Suite 3: Session & Refresh Token Revocation & Pruning
  // ---------------------------------------------------------------------------
  console.log('\n--- Suite 3: Session & Refresh Token Revocation & Pruning ---');

  // Test 3.1: POST /api/v1/auth/logout revokes session, refresh token family, and clears cookies
  console.log('Test 3.1: POST /api/v1/auth/logout single session revocation');
  {
    let revokedSessionId: string | null = null;
    let revokedFamilyId: string | null = null;
    const cookiesSet: Array<{ name: string; val: string; options: any }> = [];

    const rawRefresh = 'my_refresh_cookie_value_789';
    const hash = authService.hashToken(rawRefresh);

    const dbMock = {
      client: {
        refreshToken: {
          findUnique: async (args: any) => {
            if (args.where.tokenHash === hash) {
              return { id: 'rf_test', familyId: 'family_xyz', userId: 'usr_me' };
            }
            return null;
          },
          updateMany: async (args: any) => {
            revokedFamilyId = args.where.familyId;
            return { count: 1 };
          },
        },
        session: {
          updateMany: async (args: any) => {
            revokedSessionId = args.where.id;
            return { count: 1 };
          },
        },
      },
    };

    const redisKeys: Record<string, string> = {};
    const redisMock = {
      client: {
        set: async (key: string, val: string) => {
          redisKeys[key] = val;
          return 'OK';
        },
      },
    };

    const resMock = {
      cookie: (name: string, val: string, options: any) => {
        cookiesSet.push({ name, val, options });
      },
    };

    const reqMock = {
      headers: {
        cookie: `devpulse_refresh_token=${rawRefresh}`,
      },
    };

    const controller = new AuthController(authService, {} as any, dbMock as any, redisMock as any);
    const result = await controller.logout(
      { sub: 'usr_me', email: 'me@devpulse.local', role: 'MEMBER', sessionId: 'sess_123' },
      resMock as any,
      reqMock as any,
    );

    assert.strictEqual(result.success, true);
    assert.strictEqual(revokedFamilyId, 'family_xyz', 'Refresh token family must be revoked');
    assert.strictEqual(revokedSessionId, 'sess_123', 'Session record must be marked revoked in DB');
    assert.strictEqual(redisKeys['session:revoked:sess_123'], '1', 'Session blacklisted in Redis');

    const accessCookie = cookiesSet.find((c) => c.name === 'devpulse_access_token');
    const refreshCookie = cookiesSet.find((c) => c.name === 'devpulse_refresh_token');
    assert.strictEqual(accessCookie?.options.maxAge, 0, 'Access cookie cleared');
    assert.strictEqual(refreshCookie?.options.maxAge, 0, 'Refresh cookie cleared');
    console.log('  ✓ Single session logout cleanly revoked credentials and cleared cookies');
  }

  // Test 3.2: POST /api/v1/auth/logout-all revokes all user sessions and refresh tokens
  console.log('Test 3.2: POST /api/v1/auth/logout-all multi-device revocation');
  {
    let revokedUserTokensId: string | null = null;
    let revokedUserSessionsId: string | null = null;
    const redisBlacklist: string[] = [];

    const dbMock = {
      client: {
        refreshToken: {
          updateMany: async (args: any) => {
            revokedUserTokensId = args.where.userId;
            return { count: 3 };
          },
        },
        session: {
          findMany: async () => [{ id: 'sess_dev_1' }, { id: 'sess_dev_2' }],
          updateMany: async (args: any) => {
            revokedUserSessionsId = args.where.userId;
            return { count: 2 };
          },
        },
      },
    };

    const redisMock = {
      client: {
        set: async (key: string) => {
          redisBlacklist.push(key);
          return 'OK';
        },
      },
    };

    const resMock = {
      cookie: () => { },
    };

    const controller = new AuthController(authService, {} as any, dbMock as any, redisMock as any);
    const result = await controller.logoutAll(
      { sub: 'usr_multi_device', email: 'multi@devpulse.local', role: 'MEMBER' },
      resMock as any,
    );

    assert.strictEqual(result.success, true);
    assert.strictEqual(revokedUserTokensId, 'usr_multi_device');
    assert.strictEqual(revokedUserSessionsId, 'usr_multi_device');
    assert.ok(redisBlacklist.includes('session:revoked:sess_dev_1'));
    assert.ok(redisBlacklist.includes('session:revoked:sess_dev_2'));
    console.log('  ✓ Global logout revoked all active sessions and refresh tokens');
  }

  // Test 3.3: AuthService.cleanupExpiredTokens prunes expired records
  console.log('Test 3.3: AuthService.cleanupExpiredTokens prunes expired DB entries');
  {
    let refreshDeleteCriteria: any = null;
    let sessionDeleteCriteria: any = null;

    const dbMock = {
      client: {
        refreshToken: {
          deleteMany: async (args: any) => {
            refreshDeleteCriteria = args;
            return { count: 12 };
          },
        },
        session: {
          deleteMany: async (args: any) => {
            sessionDeleteCriteria = args;
            return { count: 5 };
          },
        },
      },
    };

    const result = await authService.cleanupExpiredTokens(dbMock as any);
    assert.strictEqual(result.expiredRefreshTokensDeleted, 12);
    assert.strictEqual(result.expiredSessionsDeleted, 5);
    assert.ok(refreshDeleteCriteria.where.OR);
    assert.ok(sessionDeleteCriteria.where.OR);
    console.log('  ✓ Token and session cleanup prune logic verified');
  }

  console.log('\n✅ ALL DISCONNECTION, REVOCATION, AND TOKEN CLEANUP TESTS PASSED!\n');
}

runDisconnectionAndRevocationTests().catch((err) => {
  console.error('❌ Tests failed:', err);
  process.exit(1);
});
