import { Injectable } from '@nestjs/common';
import * as crypto from 'crypto';
import { config } from '@devpulse/config';
import { GitHubAuthApi, GitHubClient, GitHubUser } from '@devpulse/github';
import { DatabaseService } from '../database.service';
import { RedisService } from '../redis.service';
import { AuthService } from './auth.service';
import { AuthTokens, UserRole } from '@devpulse/types';
import { AuthenticationException } from '../common/errors';

/** Prefix and TTL for OAuth CSRF state stored in Redis */
const OAUTH_STATE_PREFIX = 'oauth:state:';
const OAUTH_STATE_TTL_SECONDS = 300; // 5 minutes

/** Prefix for encrypted GitHub access tokens in GitHubAccount */
const REFRESH_TOKEN_TTL_DAYS = 7;

export interface GitHubOAuthResult {
  tokens: AuthTokens;
  isNewUser: boolean;
}

@Injectable()
export class GitHubOAuthService {
  private readonly githubConfig = config.github;

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
   * Generates a cryptographically-random CSRF state token and persists it in
   * Redis with a short TTL so it can be validated on callback.
   */
  async generateOAuthState(): Promise<string> {
    const state = crypto.randomBytes(24).toString('hex');

    if (this.redisService.client) {
      await this.redisService.client.set(
        `${OAUTH_STATE_PREFIX}${state}`,
        '1',
        'EX',
        OAUTH_STATE_TTL_SECONDS,
      );
    }

    return state;
  }

  /**
   * Validates that the returned state token matches one we previously issued.
   * Deletes it from Redis after successful verification to prevent reuse.
   */
  async validateOAuthState(state: string): Promise<void> {
    if (!state) {
      throw new AuthenticationException('Missing OAuth state parameter');
    }

    if (this.redisService.client) {
      const key = `${OAUTH_STATE_PREFIX}${state}`;
      const exists = await this.redisService.client.get(key);

      if (!exists) {
        throw new AuthenticationException(
          'Invalid or expired OAuth state. Possible CSRF attack detected.',
        );
      }

      // One-time use — delete immediately after validation
      await this.redisService.client.del(key);
    }
  }

  // ---------------------------------------------------------------------------
  // Authorization URL
  // ---------------------------------------------------------------------------

  /**
   * Builds the GitHub OAuth authorization URL with a CSRF state token.
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
   * Handles the GitHub OAuth callback:
   *  1. Validates the CSRF state
   *  2. Exchanges the authorization code for a GitHub access token
   *  3. Fetches the authenticated GitHub user & their primary email
   *  4. Upserts the DevPulse User and linked GitHubAccount
   *  5. Issues a JWT access token + opaque refresh token pair
   */
  async handleCallback(
    code: string,
    state: string,
  ): Promise<GitHubOAuthResult> {
    // 1 — CSRF validation
    await this.validateOAuthState(state);

    // 2 — Code → GitHub access token
    const tokenResponse = await this.githubAuthApi.exchangeCodeForToken({ code, state });

    // 3 — Fetch GitHub user profile using the new token
    const authedClient = new GitHubClient({ token: tokenResponse.access_token });
    const authedApi = new GitHubAuthApi(authedClient, this.githubConfig);
    const githubUser: GitHubUser = await authedApi.getAuthenticatedUser();

    // Resolve primary verified email
    let primaryEmail: string | null = githubUser.email;
    if (!primaryEmail) {
      const emails = await authedApi.getAuthenticatedEmails();
      const primary = emails.find((e) => e.primary && e.verified);
      primaryEmail = primary?.email ?? null;
    }

    if (!primaryEmail) {
      throw new AuthenticationException(
        'GitHub account has no verified primary email. Please add and verify an email on GitHub.',
      );
    }

    // 4 — Upsert DevPulse User + GitHubAccount
    const { user, isNewUser } = await this.upsertUser(githubUser, primaryEmail, tokenResponse);

    // 5 — Issue token pair
    const { accessToken, refreshToken, refreshTokenHash, familyId, tokenType, expiresIn } =
      this.authService.issueTokenPair(user);

    // Persist refresh token in DB
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
  // User Upsert
  // ---------------------------------------------------------------------------

  private async upsertUser(
    githubUser: GitHubUser,
    email: string,
    tokenResponse: { access_token: string; refresh_token?: string; expires_in?: number },
  ): Promise<{ user: { id: string; email: string; role: UserRole }; isNewUser: boolean }> {
    const db = this.databaseService.client;

    // Determine token expiry for GitHubAccount
    const tokenExpiresAt = tokenResponse.expires_in
      ? new Date(Date.now() + tokenResponse.expires_in * 1000)
      : null;

    // Resolve display name
    const displayName = githubUser.name || githubUser.login;

    // Check whether a GitHubAccount already exists for this GitHub user ID
    const existingAccount = await db.gitHubAccount.findUnique({
      where: { githubUserId: BigInt(githubUser.id) },
      include: { user: true },
    });

    if (existingAccount) {
      // Update GitHubAccount tokens and profile
      await db.gitHubAccount.update({
        where: { id: existingAccount.id },
        data: {
          username: githubUser.login,
          displayName,
          email,
          avatarUrl: githubUser.avatar_url,
          profileUrl: githubUser.html_url,
          accessToken: tokenResponse.access_token,
          refreshToken: tokenResponse.refresh_token ?? null,
          tokenExpiresAt,
          scopes: ['read:user', 'user:email'],
        },
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

    // Check if a DevPulse User already exists with this email (linked different provider)
    const existingUser = await db.user.findUnique({ where: { email } });

    if (existingUser) {
      // Link this GitHub account to the existing user
      await db.gitHubAccount.create({
        data: {
          userId: existingUser.id,
          githubUserId: BigInt(githubUser.id),
          username: githubUser.login,
          displayName,
          email,
          avatarUrl: githubUser.avatar_url,
          profileUrl: githubUser.html_url,
          accessToken: tokenResponse.access_token,
          refreshToken: tokenResponse.refresh_token ?? null,
          tokenExpiresAt,
          scopes: ['read:user', 'user:email'],
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

    // New user — create User + GitHubAccount in a transaction
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
          username: githubUser.login,
          displayName,
          email,
          avatarUrl: githubUser.avatar_url,
          profileUrl: githubUser.html_url,
          accessToken: tokenResponse.access_token,
          refreshToken: tokenResponse.refresh_token ?? null,
          tokenExpiresAt,
          scopes: ['read:user', 'user:email'],
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
}
