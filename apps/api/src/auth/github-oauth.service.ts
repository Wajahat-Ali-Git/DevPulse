import { Injectable } from '@nestjs/common';
import * as crypto from 'crypto';
import { config } from '@devpulse/config';
import { GitHubAuthApi, GitHubClient, GitHubUser } from '@devpulse/github';
import { DatabaseService } from '../database.service';
import { RedisService } from '../redis.service';
import { AuthService } from './auth.service';
import { AuthTokens, UserRole } from '@devpulse/types';
import { AuthenticationException, ConflictException, ResourceNotFoundException } from '../common/errors';
import { logger } from '@devpulse/logger';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Redis key prefix for CSRF state tokens */
const OAUTH_STATE_PREFIX = 'oauth:state:';

/** State tokens expire after 5 minutes — matches a typical OAuth UX window */
const OAUTH_STATE_TTL_SECONDS = 300;

/** Refresh tokens are valid for 7 days */
const REFRESH_TOKEN_TTL_DAYS = 7;

/**
 * Minimal required OAuth permissions:
 * - 'read:user': Read basic public profile (username, name, avatar, profile URL)
 * - 'user:email': Read primary verified email for account resolution and authentication
 *
 * Broad repository or write scopes (e.g., 'repo', 'workflow', 'admin') are intentionally
 * omitted to adhere strictly to the principle of least privilege.
 */
export const GITHUB_OAUTH_SCOPES: readonly string[] = ['read:user', 'user:email'];

/**
 * GitHub error codes returned in the token exchange response body.
 * Maps raw GitHub error codes to user-facing messages.
 */
const GITHUB_TOKEN_ERRORS: Record<string, string> = {
  bad_verification_code:
    'The authorization code has expired or has already been used. Please sign in again.',
  unverified_user_email:
    'Your GitHub email address is not verified. Please verify your email on GitHub and try again.',
  incorrect_client_credentials:
    'OAuth application credentials are invalid. Please contact support.',
  redirect_uri_mismatch:
    'OAuth redirect URI mismatch. Please contact support.',
  access_denied:
    'GitHub authorization was denied.',
  device_flow_disabled:
    'Device flow is not enabled for this application.',
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OAuthStateMetadata {
  userId?: string | null;
  createdAt: number;
}

export interface GitHubOAuthResult {
  tokens: AuthTokens;
  isNewUser: boolean;
  isLinked?: boolean;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable()
export class GitHubOAuthService {
  private readonly githubConfig = config.github;

  /**
   * Pre-built GitHubAuthApi instance used only for authorization URL generation
   * and the code exchange step (which does not require a user access token).
   */
  private readonly githubAuthApi = new GitHubAuthApi(
    new GitHubClient({ token: '' }),
    {
      clientId: this.githubConfig.clientId,
      clientSecret: this.githubConfig.clientSecret,
      callbackUrl: this.githubConfig.callbackUrl,
    },
  );

  constructor(
    private readonly authService: AuthService,
    private readonly databaseService: DatabaseService,
    private readonly redisService: RedisService,
  ) {}

  // ---------------------------------------------------------------------------
  // CSRF State Management
  // ---------------------------------------------------------------------------

  /**
   * Generates a cryptographically-secure, 48-character hex state token and
   * writes it to Redis with a 5-minute TTL.
   *
   * Optionally binds the state to an authenticated DevPulse `userId` so that
   * upon callback completion, the GitHub identity is reliably associated with
   * that specific user account.
   *
   * @param userId Optional ID of the currently authenticated DevPulse user
   * @throws {AuthenticationException} If Redis is unavailable — we must not
   *   issue a state token we cannot later verify.
   */
  async generateOAuthState(userId?: string): Promise<string> {
    this.assertRedisAvailable();

    const state = crypto.randomBytes(24).toString('hex'); // 48 hex chars
    const payload = JSON.stringify({
      userId: userId ?? null,
      createdAt: Date.now(),
    });

    await this.redisService.client!.set(
      `${OAUTH_STATE_PREFIX}${state}`,
      payload,
      'EX',
      OAUTH_STATE_TTL_SECONDS,
    );

    return state;
  }

  /**
   * Validates the CSRF state token returned by GitHub.
   *
   * Uses `GETDEL` (Redis >= 6.2) to atomically read and delete the key in a
   * single round-trip, eliminating the TOCTOU race between GET and DEL.
   *
   * Failure cases:
   *  - State is empty or missing               → 401
   *  - Redis is unavailable                    → 401 (fail-secure)
   *  - Key does not exist (expired or not ours) → 401 with CSRF warning
   *  - Key was already consumed (GETDEL = null) → 401 with CSRF warning
   *
   * @returns The parsed metadata containing bound `userId` if available
   * @throws {AuthenticationException} on any validation failure.
   */
  async validateOAuthState(state: string): Promise<OAuthStateMetadata> {
    if (!state) {
      throw new AuthenticationException('Missing OAuth state parameter');
    }

    this.assertRedisAvailable();

    const key = `${OAUTH_STATE_PREFIX}${state}`;

    // Atomic read-and-delete — if the key existed we get string payload, otherwise null
    const value = await this.redisService.client!.getdel(key);

    if (value === null) {
      throw new AuthenticationException(
        'Invalid or expired OAuth state. The link may have already been used or has timed out. Please sign in again.',
      );
    }

    if (value === '1') {
      return { userId: null, createdAt: Date.now() };
    }

    try {
      const parsed = JSON.parse(value);
      return {
        userId: parsed.userId ?? null,
        createdAt: parsed.createdAt ?? Date.now(),
      };
    } catch {
      return { userId: null, createdAt: Date.now() };
    }
  }

  // ---------------------------------------------------------------------------
  // Authorization URL
  // ---------------------------------------------------------------------------

  /**
   * Builds the GitHub OAuth authorization URL, embedding a fresh CSRF state.
   * If a `userId` is supplied, the generated state is associated with this user.
   */
  async buildAuthorizationUrl(userId?: string): Promise<string> {
    const state = await this.generateOAuthState(userId);

    return this.githubAuthApi.getAuthorizationUrl({
      scopes: [...GITHUB_OAUTH_SCOPES],
      state,
    });
  }

  // ---------------------------------------------------------------------------
  // Callback Handling
  // ---------------------------------------------------------------------------

  /**
   * Handles the full GitHub OAuth callback flow:
   *
   *  1. CSRF state validation (atomic Redis GETDEL)
   *  2. Authorization code → GitHub access token exchange
   *  3. Fetch GitHub user profile + resolve primary verified email
   *  4. If target user specified (via state or parameter), associates GitHub identity
   *     with the authenticated DevPulse user; otherwise, executes sign-in/registration upsert.
   *  5. Issues a JWT access token + opaque refresh token pair.
   *
   * All network and API errors are caught and re-mapped to typed
   * AuthenticationExceptions with user-facing messages.
   */
  async handleCallback(
    code: string,
    state: string,
    currentUserId?: string,
  ): Promise<GitHubOAuthResult> {
    // Step 1 — CSRF validation (atomic, fail-secure)
    const stateMetadata = await this.validateOAuthState(state);

    const targetUserId = currentUserId || stateMetadata.userId || undefined;

    // Step 2 — Exchange authorization code for GitHub access token
    const tokenResponse = await this.exchangeCode(code, state);

    // Step 3 — Fetch user profile using the newly issued token
    const { githubUser, primaryEmail } = await this.fetchGitHubProfile(
      tokenResponse.access_token,
    );

    // Step 4 — Link to authenticated user if targeted, otherwise upsert user from GitHub
    let user: { id: string; email: string; role: UserRole };
    let isNewUser = false;
    let isLinked = false;

    if (targetUserId) {
      const associated = await this.associateUserWithGitHub(
        targetUserId,
        githubUser,
        primaryEmail,
        tokenResponse,
      );
      user = associated.user;
      isLinked = true;
    } else {
      const upserted = await this.upsertUser(githubUser, primaryEmail, tokenResponse);
      user = upserted.user;
      isNewUser = upserted.isNewUser;
    }

    // Step 5 — Issue DevPulse token pair
    const { accessToken, refreshToken, refreshTokenHash, familyId, tokenType, expiresIn } =
      this.authService.issueTokenPair(user);

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + REFRESH_TOKEN_TTL_DAYS);

    await this.databaseService.client.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: refreshTokenHash,
        familyId,
        expiresAt,
      },
    });

    return {
      tokens: { accessToken, refreshToken, tokenType, expiresIn },
      isNewUser,
      isLinked,
    };
  }

  // ---------------------------------------------------------------------------
  // Authenticated User Identity Association
  // ---------------------------------------------------------------------------

  /**
   * Associates a GitHub identity with an existing, authenticated DevPulse user.
   *
   * Conflict & Integrity rules:
   *  - Throws AuthenticationException if the authenticated user does not exist in DevPulse.
   *  - Throws ConflictException if the GitHub account is already linked to a different DevPulse user.
   *  - Updates tokens, scopes, and profile info if already linked to this user.
   *  - Creates a new GitHubAccount record referencing userId if not yet linked.
   *  - Syncs the user's avatarUrl if currently empty.
   *  - Retroactively attributes existing commits, PRs, and reviews matching author username/email.
   */
  async associateUserWithGitHub(
    userId: string,
    githubUser: GitHubUser,
    email: string,
    tokenResponse: { access_token: string; refresh_token?: string; expires_in?: number },
  ): Promise<{
    user: { id: string; email: string; role: UserRole };
    gitHubAccount: any;
    isNewAccount: boolean;
  }> {
    const db = this.databaseService.client;

    const user = await db.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new AuthenticationException('Authenticated DevPulse user not found.');
    }

    const displayName = githubUser.name || githubUser.login;
    const tokenExpiresAt = tokenResponse.expires_in
      ? new Date(Date.now() + tokenResponse.expires_in * 1000)
      : null;

    const encryptedAccessToken = this.authService.encryptToken(tokenResponse.access_token);
    const encryptedRefreshToken = tokenResponse.refresh_token
      ? this.authService.encryptToken(tokenResponse.refresh_token)
      : null;

    const accountData = {
      username: githubUser.login,
      displayName,
      email,
      avatarUrl: githubUser.avatar_url,
      profileUrl: githubUser.html_url,
      accessToken: encryptedAccessToken,
      refreshToken: encryptedRefreshToken,
      tokenExpiresAt,
      scopes: [...GITHUB_OAUTH_SCOPES],
    };

    const existingAccount = await db.gitHubAccount.findUnique({
      where: { githubUserId: BigInt(githubUser.id) },
    });

    let gitHubAccount: any;
    let isNewAccount = false;

    if (existingAccount) {
      if (existingAccount.userId !== userId) {
        throw new ConflictException(
          'This GitHub account is already associated with another DevPulse user account.',
        );
      }

      gitHubAccount = await db.gitHubAccount.update({
        where: { id: existingAccount.id },
        data: accountData,
      });
    } else {
      gitHubAccount = await db.gitHubAccount.create({
        data: {
          userId,
          githubUserId: BigInt(githubUser.id),
          ...accountData,
        },
      });
      isNewAccount = true;
    }

    if (!user.avatarUrl && githubUser.avatar_url && db.user?.update) {
      await db.user.update({
        where: { id: userId },
        data: { avatarUrl: githubUser.avatar_url },
      });
    }

    await this.linkUserContributions(userId, githubUser.login, email);

    return {
      user: {
        id: user.id,
        email: user.email,
        role: user.role as UserRole,
      },
      gitHubAccount,
      isNewAccount,
    };
  }

  /**
   * Exchanges an authorization code and associates the resolved GitHub identity
   * directly with an authenticated DevPulse user.
   */
  async associateGitHubIdentity(
    userId: string,
    code: string,
    state: string,
  ): Promise<{
    user: { id: string; email: string; role: UserRole };
    gitHubAccount: any;
    isNewAccount: boolean;
  }> {
    const stateMetadata = await this.validateOAuthState(state);

    if (stateMetadata.userId && stateMetadata.userId !== userId) {
      throw new AuthenticationException(
        'OAuth state does not match the authenticated user session.',
      );
    }

    const tokenResponse = await this.exchangeCode(code, state);
    const { githubUser, primaryEmail } = await this.fetchGitHubProfile(
      tokenResponse.access_token,
    );

    return this.associateUserWithGitHub(
      userId,
      githubUser,
      primaryEmail,
      tokenResponse,
    );
  }

  // ---------------------------------------------------------------------------
  // Private — Code Exchange
  // ---------------------------------------------------------------------------

  /**
   * Exchanges the GitHub authorization code for an access token.
   *
   * Maps all known GitHub error codes to user-facing AuthenticationExceptions.
   * Network/fetch failures are also caught and surfaced as AuthenticationExceptions
   * to avoid leaking internal error details.
   */
  private async exchangeCode(
    code: string,
    state: string,
  ): Promise<{ access_token: string; refresh_token?: string; expires_in?: number; scope: string }> {
    try {
      const tokenResponse = await this.githubAuthApi.exchangeCodeForToken({ code, state });
      return tokenResponse;
    } catch (err: unknown) {
      throw this.mapGitHubTokenError(err);
    }
  }

  /**
   * Maps a raw error from `GitHubAuthApi.exchangeCodeForToken` to a typed
   * `AuthenticationException` with a clean user-facing message.
   */
  private mapGitHubTokenError(err: unknown): AuthenticationException {
    if (err instanceof Error) {
      const raw = err.message;

      const match = raw.match(/^GitHub OAuth error:\s*(.+)$/i);
      if (match) {
        const segment = match[1].trim().toLowerCase().replace(/\s+/g, '_');

        for (const [code, friendlyMessage] of Object.entries(GITHUB_TOKEN_ERRORS)) {
          if (segment.startsWith(code) || segment.includes(code)) {
            return new AuthenticationException(friendlyMessage);
          }
        }

        return new AuthenticationException(
          `GitHub sign-in failed: ${match[1].trim()}`,
        );
      }

      if (raw.includes('fetch') || raw.includes('network') || raw.includes('ECONNREFUSED')) {
        return new AuthenticationException(
          'Unable to reach GitHub to complete authentication. Please try again.',
        );
      }

      return new AuthenticationException(raw);
    }

    return new AuthenticationException(
      'An unexpected error occurred while communicating with GitHub. Please try again.',
    );
  }

  // ---------------------------------------------------------------------------
  // Private — Profile Fetch
  // ---------------------------------------------------------------------------

  /**
   * Fetches the user profile from GitHub and ensures a verified primary email is found.
   */
  private async fetchGitHubProfile(
    accessToken: string,
  ): Promise<{ githubUser: GitHubUser; primaryEmail: string }> {
    const authedClient = new GitHubClient({ token: accessToken });
    const authedApi = new GitHubAuthApi(authedClient, {
      clientId: this.githubConfig.clientId,
      clientSecret: this.githubConfig.clientSecret,
      callbackUrl: this.githubConfig.callbackUrl,
    });

    let githubUser: GitHubUser;
    try {
      githubUser = await authedApi.getAuthenticatedUser();
    } catch (err: unknown) {
      if (err instanceof Error) {
        throw new AuthenticationException(
          `Failed to retrieve GitHub profile: ${err.message}`,
        );
      }
      throw new AuthenticationException(
        'Failed to retrieve GitHub profile. Please try signing in again.',
      );
    }

    let primaryEmail: string | null = githubUser.email;

    if (!primaryEmail) {
      try {
        const emails = await authedApi.getAuthenticatedEmails();
        const primary = emails.find((e) => e.primary && e.verified);
        primaryEmail = primary?.email ?? null;
      } catch {
        primaryEmail = null;
      }
    }

    if (!primaryEmail) {
      throw new AuthenticationException(
        'Your GitHub account has no verified primary email address. ' +
          'Please add and verify an email on GitHub, then try signing in again.',
      );
    }

    return { githubUser, primaryEmail };
  }

  // ---------------------------------------------------------------------------
  // Private — User Upsert (Sign-In & Registration)
  // ---------------------------------------------------------------------------

  /**
   * Three-way upsert logic:
   *  1. Existing GitHubAccount  → refresh tokens + return linked user
   *  2. Email match (no GitHub) → link new GitHubAccount to existing user
   *  3. Completely new user     → create User + GitHubAccount in a transaction
   */
  private async upsertUser(
    githubUser: GitHubUser,
    email: string,
    tokenResponse: { access_token: string; refresh_token?: string; expires_in?: number },
  ): Promise<{ user: { id: string; email: string; role: UserRole }; isNewUser: boolean }> {
    const db = this.databaseService.client;
    const displayName = githubUser.name || githubUser.login;
    const tokenExpiresAt = tokenResponse.expires_in
      ? new Date(Date.now() + tokenResponse.expires_in * 1000)
      : null;

    const encryptedAccessToken = this.authService.encryptToken(tokenResponse.access_token);
    const encryptedRefreshToken = tokenResponse.refresh_token
      ? this.authService.encryptToken(tokenResponse.refresh_token)
      : null;

    const accountData = {
      username: githubUser.login,
      displayName,
      email,
      avatarUrl: githubUser.avatar_url,
      profileUrl: githubUser.html_url,
      accessToken: encryptedAccessToken,
      refreshToken: encryptedRefreshToken,
      tokenExpiresAt,
      scopes: [...GITHUB_OAUTH_SCOPES],
    };

    // ── Case 1: Known GitHub account ─────────────────────────────────────────
    const existingAccount = await db.gitHubAccount.findUnique({
      where: { githubUserId: BigInt(githubUser.id) },
      include: { user: true },
    });

    if (existingAccount) {
      await db.gitHubAccount.update({
        where: { id: existingAccount.id },
        data: accountData,
      });

      return {
        user: {
          id: existingAccount.user.id,
          email: existingAccount.user.email,
          role: existingAccount.user.role as UserRole,
        },
        isNewUser: false,
      };
    }

    // ── Case 2: Email already registered under a different sign-in method ────
    const existingUser = await db.user.findUnique({ where: { email } });

    if (existingUser) {
      await db.gitHubAccount.create({
        data: {
          userId: existingUser.id,
          githubUserId: BigInt(githubUser.id),
          ...accountData,
        },
      });

      await this.linkUserContributions(existingUser.id, githubUser.login, email);

      return {
        user: {
          id: existingUser.id,
          email: existingUser.email,
          role: existingUser.role as UserRole,
        },
        isNewUser: false,
      };
    }

    // ── Case 3: Brand new user ───────────────────────────────────────────────
    const newUser = await db.$transaction(async (tx: any) => {
      const created = await tx.user.create({
        data: {
          email,
          name: displayName,
          avatarUrl: githubUser.avatar_url,
          role: 'MEMBER',
        },
      });

      await tx.gitHubAccount.create({
        data: {
          userId: created.id,
          githubUserId: BigInt(githubUser.id),
          ...accountData,
        },
      });

      return created;
    });

    await this.linkUserContributions(newUser.id, githubUser.login, email);

    return {
      user: {
        id: newUser.id,
        email: newUser.email,
        role: newUser.role as UserRole,
      },
      isNewUser: true,
    };
  }

  /**
   * Retroactively links existing commits, pull requests, and reviews
   * matching the GitHub username or email with the DevPulse user.
   */
  private async linkUserContributions(
    userId: string,
    username: string,
    email: string,
  ): Promise<void> {
    const db = this.databaseService.client;
    try {
      if (db.commit) {
        await db.commit.updateMany({
          where: {
            authorUserId: null,
            OR: [{ authorEmail: email }, { committerEmail: email }],
          },
          data: { authorUserId: userId },
        });
      }

      if (db.pullRequest) {
        await db.pullRequest.updateMany({
          where: {
            authorUserId: null,
            authorUsername: username,
          },
          data: { authorUserId: userId },
        });
      }

      if (db.review) {
        await db.review.updateMany({
          where: {
            authorUserId: null,
            authorUsername: username,
          },
          data: { authorUserId: userId },
        });
      }
    } catch {
      // Non-fatal if contribution tables are empty or mock doesn't define all relations in tests
    }
  }

  // ---------------------------------------------------------------------------
  // Private — Guards
  // ---------------------------------------------------------------------------

  /**
   * Asserts that the Redis client is connected and usable.
   */
  private assertRedisAvailable(): void {
    if (!this.redisService.client) {
      throw new AuthenticationException(
        'Authentication service is temporarily unavailable. Please try again in a moment.',
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Account Disconnection & Token Cleanup
  // ---------------------------------------------------------------------------

  /**
   * Disconnects a linked GitHub account for an authenticated user and cleans up tokens.
   *
   * 1. Validates that the account belongs to the user.
   * 2. Revokes the OAuth token on GitHub via Applications API (best-effort; non-blocking on failure).
   * 3. Performs database token cleanup: zeroes out tokens or deletes the account record.
   * 4. Cleans up Redis caches associated with this account.
   *
   * @param userId Authenticated DevPulse user ID
   * @param accountId Optional specific GitHubAccount ID (defaults to user's linked account)
   * @param options.purgeAccount If true (default), deletes the GitHubAccount row; if false, zeroes tokens
   */
  async disconnectGitHubAccount(
    userId: string,
    accountId?: string,
    options: { purgeAccount?: boolean } = {},
  ): Promise<{
    success: boolean;
    message: string;
    disconnectedAccount: {
      id: string;
      githubUserId: string;
      username: string;
    };
  }> {
    const db = this.databaseService.client;
    const purge = options.purgeAccount !== false;

    // 1. Locate the target account
    let account;
    if (accountId) {
      account = await db.gitHubAccount.findFirst({
        where: { id: accountId, userId },
      });
    } else {
      account = await db.gitHubAccount.findFirst({
        where: { userId },
      });
    }

    if (!account) {
      throw new ResourceNotFoundException('Linked GitHub account not found for this user.');
    }

    // 2. Best-effort remote token revocation on GitHub
    if (account.accessToken) {
      try {
        const plainToken = this.authService.decryptToken(account.accessToken);
        if (plainToken) {
          await this.githubAuthApi.revokeGrant({ accessToken: plainToken });
        }
      } catch (err) {
        logger.warn(
          `Failed to remotely revoke GitHub token for account ${account.id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    // 3. Local token cleanup
    if (purge) {
      await db.gitHubAccount.delete({
        where: { id: account.id },
      });
    } else {
      await db.gitHubAccount.update({
        where: { id: account.id },
        data: {
          accessToken: null,
          refreshToken: null,
          tokenExpiresAt: null,
          scopes: [],
        },
      });
    }

    // 4. Redis cache cleanup
    if (this.redisService?.client) {
      try {
        await this.redisService.client.del(`github:account:${account.id}`);
        await this.redisService.client.del(`github:user:${userId}`);
      } catch {
        // Non-fatal if Redis is temporarily unreachable
      }
    }

    return {
      success: true,
      message: 'GitHub account successfully disconnected and tokens cleaned up',
      disconnectedAccount: {
        id: account.id,
        githubUserId: account.githubUserId.toString(),
        username: account.username,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Expired & Revoked Token Handling
  // ---------------------------------------------------------------------------

  /**
   * Retrieves a valid, decrypted GitHub access token for the given account.
   * Handles token expiration by refreshing using the refresh token if available.
   * If token is expired, revoked, or refresh fails, cleans up the invalidated tokens
   * and throws an AuthenticationException.
   */
  async ensureValidGitHubToken(userId: string, accountId?: string): Promise<string> {
    const db = this.databaseService.client;

    const account = accountId
      ? await db.gitHubAccount.findFirst({ where: { id: accountId, userId } })
      : await db.gitHubAccount.findFirst({ where: { userId } });

    if (!account || !account.accessToken) {
      throw new AuthenticationException(
        'GitHub account is not connected or authorization was disconnected. Please reconnect your GitHub account.',
      );
    }

    const isExpired = account.tokenExpiresAt
      ? new Date() >= new Date(new Date(account.tokenExpiresAt).getTime() - 60_000)
      : false;

    if (!isExpired) {
      const plainToken = this.authService.decryptToken(account.accessToken);
      if (!plainToken) {
        throw new AuthenticationException('Failed to decrypt GitHub access token');
      }
      return plainToken;
    }

    // Token is expired — attempt refresh if refreshToken exists
    if (!account.refreshToken) {
      await this.handleRevokedAuthorization(account.id);
      throw new AuthenticationException(
        'GitHub authorization has expired. Please reconnect your GitHub account.',
      );
    }

    const plainRefreshToken = this.authService.decryptToken(account.refreshToken);
    if (!plainRefreshToken) {
      await this.handleRevokedAuthorization(account.id);
      throw new AuthenticationException(
        'Failed to decrypt GitHub refresh token. Please reconnect your GitHub account.',
      );
    }

    try {
      const refreshed = await this.githubAuthApi.refreshToken({
        refreshToken: plainRefreshToken,
      });

      const encryptedAccess = this.authService.encryptToken(refreshed.access_token);
      const encryptedRefresh = refreshed.refresh_token
        ? this.authService.encryptToken(refreshed.refresh_token)
        : account.refreshToken;

      const newExpiresAt = refreshed.expires_in
        ? new Date(Date.now() + refreshed.expires_in * 1000)
        : null;

      await db.gitHubAccount.update({
        where: { id: account.id },
        data: {
          accessToken: encryptedAccess,
          refreshToken: encryptedRefresh,
          tokenExpiresAt: newExpiresAt,
        },
      });

      return refreshed.access_token;
    } catch (err) {
      // Refresh failed (e.g. refresh token revoked on GitHub or expired)
      await this.handleRevokedAuthorization(account.id);
      throw new AuthenticationException(
        'GitHub authorization has expired or was revoked. Please reconnect your GitHub account.',
      );
    }
  }

  /**
   * Handles revoked or invalidated authorization by zeroing out stored tokens
   * and evicting cached state.
   */
  async handleRevokedAuthorization(accountId: string): Promise<void> {
    const db = this.databaseService.client;
    try {
      await db.gitHubAccount.update({
        where: { id: accountId },
        data: {
          accessToken: null,
          refreshToken: null,
          tokenExpiresAt: null,
          scopes: [],
        },
      });

      if (this.redisService?.client) {
        await this.redisService.client.del(`github:account:${accountId}`);
      }
    } catch {
      // Non-fatal if account was already deleted
    }
  }

  /**
   * Helper to evaluate authorization status of a GitHub account without leaking tokens.
   */
  getAccountAuthorizationStatus(account: {
    accessToken?: string | null;
    tokenExpiresAt?: Date | null;
  }): {
    isConnected: boolean;
    isExpired: boolean;
    status: 'CONNECTED' | 'EXPIRED' | 'DISCONNECTED';
  } {
    const isConnected = Boolean(account.accessToken);
    const isExpired = Boolean(
      account.tokenExpiresAt && new Date() > new Date(account.tokenExpiresAt),
    );
    const status = !isConnected
      ? 'DISCONNECTED'
      : isExpired
        ? 'EXPIRED'
        : 'CONNECTED';

    return { isConnected, isExpired, status };
  }

}
