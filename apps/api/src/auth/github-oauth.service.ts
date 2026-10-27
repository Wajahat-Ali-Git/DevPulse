import { Injectable } from '@nestjs/common';
import * as crypto from 'crypto';
import { config } from '@devpulse/config';
import { GitHubAuthApi, GitHubClient, GitHubUser } from '@devpulse/github';
import { DatabaseService } from '../database.service';
import { RedisService } from '../redis.service';
import { AuthService } from './auth.service';
import { AuthTokens, UserRole } from '@devpulse/types';
import { AuthenticationException } from '../common/errors';

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

export interface GitHubOAuthResult {
  tokens: AuthTokens;
  isNewUser: boolean;
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
   * @throws {AuthenticationException} If Redis is unavailable — we must not
   *   issue a state token we cannot later verify.
   */
  async generateOAuthState(): Promise<string> {
    this.assertRedisAvailable();

    const state = crypto.randomBytes(24).toString('hex'); // 48 hex chars

    await this.redisService.client.set(
      `${OAUTH_STATE_PREFIX}${state}`,
      '1',
      'EX',
      OAUTH_STATE_TTL_SECONDS,
    );

    return state;
  }

  /**
   * Validates the CSRF state token returned by GitHub.
   *
   * Uses `GETDEL` (Redis ≥ 6.2) to atomically read and delete the key in a
   * single round-trip, eliminating the TOCTOU race between GET and DEL.
   *
   * Failure cases:
   *  - State is empty or missing               → 401
   *  - Redis is unavailable                    → 401 (fail-secure)
   *  - Key does not exist (expired or not ours) → 401 with CSRF warning
   *  - Key was already consumed (GETDEL = null) → 401 with CSRF warning
   *
   * @throws {AuthenticationException} on any validation failure.
   */
  async validateOAuthState(state: string): Promise<void> {
    if (!state) {
      throw new AuthenticationException('Missing OAuth state parameter');
    }

    this.assertRedisAvailable();

    const key = `${OAUTH_STATE_PREFIX}${state}`;

    // Atomic read-and-delete — if the key existed we get '1', otherwise null
    const value = await this.redisService.client.getdel(key);

    if (value === null) {
      throw new AuthenticationException(
        'Invalid or expired OAuth state. The link may have already been used or has timed out. Please sign in again.',
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Authorization URL
  // ---------------------------------------------------------------------------

  /**
   * Builds the GitHub OAuth authorization URL, embedding a fresh CSRF state.
   */
  async buildAuthorizationUrl(): Promise<string> {
    const state = await this.generateOAuthState();

    return this.githubAuthApi.getAuthorizationUrl({
      scopes: ['read:user', 'user:email'],
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
   *  4. Upsert DevPulse User and linked GitHubAccount
   *  5. Issue a JWT access token + opaque refresh token pair
   *
   * All network and API errors are caught and re-mapped to typed
   * AuthenticationExceptions with user-facing messages.
   */
  async handleCallback(code: string, state: string): Promise<GitHubOAuthResult> {
    // Step 1 — CSRF validation (atomic, fail-secure)
    await this.validateOAuthState(state);

    // Step 2 — Exchange authorization code for GitHub access token
    const tokenResponse = await this.exchangeCode(code, state);

    // Step 3 — Fetch user profile using the newly issued token
    const { githubUser, primaryEmail } = await this.fetchGitHubProfile(
      tokenResponse.access_token,
    );

    // Step 4 — Upsert DevPulse User + GitHubAccount
    const { user, isNewUser } = await this.upsertUser(githubUser, primaryEmail, tokenResponse);

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
    };
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
   *
   * The upstream library surfaces GitHub's `error` field as an Error whose
   * message starts with `"GitHub OAuth error: <code> — <description>"`.
   * We parse the code out to look it up in GITHUB_TOKEN_ERRORS.
   */
  private mapGitHubTokenError(err: unknown): AuthenticationException {
    if (err instanceof Error) {
      const raw = err.message;

      // Try to extract the GitHub error code from the message produced by the library
      // Pattern: "GitHub OAuth error: <error_code>" or "GitHub OAuth error: <description>"
      const match = raw.match(/^GitHub OAuth error:\s*(.+)$/i);
      if (match) {
        const segment = match[1].trim().toLowerCase().replace(/\s+/g, '_');

        // Check if the segment contains a known error code
        for (const [code, friendlyMessage] of Object.entries(GITHUB_TOKEN_ERRORS)) {
          if (segment.startsWith(code) || segment.includes(code)) {
            return new AuthenticationException(friendlyMessage);
          }
        }

        // Unknown GitHub error — surface the description but keep it concise
        return new AuthenticationException(
          `GitHub authorization failed: ${match[1].trim().slice(0, 200)}`,
        );
      }

      // Network / fetch failure (e.g. DNS, timeout)
      if (raw.includes('fetch') || raw.includes('ECONNREFUSED') || raw.includes('ETIMEDOUT')) {
        return new AuthenticationException(
          'Unable to reach GitHub to complete sign-in. Please try again in a moment.',
        );
      }
    }

    // Unknown error type — do not leak internals
    return new AuthenticationException(
      'An unexpected error occurred during GitHub sign-in. Please try again.',
    );
  }

  // ---------------------------------------------------------------------------
  // Private — Profile Fetching
  // ---------------------------------------------------------------------------

  /**
   * Fetches the authenticated GitHub user's profile and resolves their primary
   * verified email address.
   *
   * @throws {AuthenticationException} if the GitHub API call fails or the
   *   account has no verified primary email.
   */
  private async fetchGitHubProfile(
    accessToken: string,
  ): Promise<{ githubUser: GitHubUser; primaryEmail: string }> {
    const authedClient = new GitHubClient({ token: accessToken });
    const authedApi = new GitHubAuthApi(authedClient, this.githubConfig);

    let githubUser: GitHubUser;
    try {
      githubUser = await authedApi.getAuthenticatedUser();
    } catch (err: unknown) {
      throw new AuthenticationException(
        'Failed to retrieve your GitHub profile. Please try again.',
      );
    }

    // GitHub's /user endpoint may or may not include the email directly
    let primaryEmail: string | null = githubUser.email;

    if (!primaryEmail) {
      try {
        const emails = await authedApi.getAuthenticatedEmails();
        const primary = emails.find((e) => e.primary && e.verified);
        primaryEmail = primary?.email ?? null;
      } catch {
        // Email fetch failure — treat as no verified email found
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
  // Private — User Upsert
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

    const accountData = {
      username: githubUser.login,
      displayName,
      email,
      avatarUrl: githubUser.avatar_url,
      profileUrl: githubUser.html_url,
      accessToken: tokenResponse.access_token,
      refreshToken: tokenResponse.refresh_token ?? null,
      tokenExpiresAt,
      scopes: ['read:user', 'user:email'],
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
    const newUser = await db.$transaction(async (tx) => {
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

    return {
      user: {
        id: newUser.id,
        email: newUser.email,
        role: newUser.role as UserRole,
      },
      isNewUser: true,
    };
  }

  // ---------------------------------------------------------------------------
  // Private — Guards
  // ---------------------------------------------------------------------------

  /**
   * Asserts that the Redis client is connected and usable.
   *
   * We fail-secure: if Redis is unavailable we must reject the request rather
   * than silently skipping CSRF validation.
   */
  private assertRedisAvailable(): void {
    if (!this.redisService.client) {
      throw new AuthenticationException(
        'Authentication service is temporarily unavailable. Please try again in a moment.',
      );
    }
  }
}
