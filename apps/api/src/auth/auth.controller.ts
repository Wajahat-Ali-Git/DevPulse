import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  Query,
  Req,
  Res,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { GitHubOAuthService } from './github-oauth.service';
import { DatabaseService } from '../database.service';
import { RedisService } from '../redis.service';
import { Public, CurrentUser } from './decorators';
import { GitHubOAuthGuard } from './guards';
import { AuthTokenPayload } from '@devpulse/types';
import { AuthenticationException } from '../common/errors';
import { config } from '@devpulse/config';

/** Cookie name for the short-lived JWT access token */
const ACCESS_TOKEN_COOKIE = 'devpulse_access_token';
/** Cookie name for the long-lived opaque refresh token */
const REFRESH_TOKEN_COOKIE = 'devpulse_refresh_token';

/** Sets access + refresh tokens as httpOnly, SameSite=lax cookies. */
function setTokenCookies(res: Response, accessToken: string, refreshToken: string): void {
  const isProduction = config.app.isProduction;
  res.cookie(ACCESS_TOKEN_COOKIE, accessToken, {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    path: '/',
    maxAge: 15 * 60 * 1000, // 15 minutes
  });
  res.cookie(REFRESH_TOKEN_COOKIE, refreshToken, {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    path: '/',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  });
}

/** Clears access and refresh token cookies. */
function clearTokenCookies(res: Response): void {
  const isProduction = config.app.isProduction;
  res.cookie(ACCESS_TOKEN_COOKIE, '', {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
  res.cookie(REFRESH_TOKEN_COOKIE, '', {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
}


export class RefreshDto {
  refreshToken?: string;
}

export class AssociateGitHubDto {
  code!: string;
  state!: string;
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly githubOAuthService: GitHubOAuthService,
    private readonly databaseService: DatabaseService,
    private readonly redisService?: RedisService,
  ) {}

  // ---------------------------------------------------------------------------
  // GitHub OAuth — Authorization
  // ---------------------------------------------------------------------------

  /**
   * Initiates the GitHub OAuth flow.
   * Generates a CSRF state token and redirects the browser to GitHub's
   * authorization page.
   * If an authenticated user token is present, associates state with user.sub.
   *
   * GET /api/v1/auth/github
   */
  @Public()
  @Get('github')
  async githubAuthorize(
    @CurrentUser() currentUser: AuthTokenPayload | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const authorizationUrl = await this.githubOAuthService.buildAuthorizationUrl(
      currentUser?.sub,
    );
    res.redirect(authorizationUrl);
  }

  /**
   * Initiates the GitHub OAuth flow specifically for linking the GitHub identity
   * to the currently authenticated DevPulse user.
   * Protected route.
   *
   * GET /api/v1/auth/github/connect
   */
  @Get('github/connect')
  async githubConnect(
    @CurrentUser() user: AuthTokenPayload,
    @Res() res: Response,
  ): Promise<void> {
    const authorizationUrl = await this.githubOAuthService.buildAuthorizationUrl(user.sub);
    res.redirect(authorizationUrl);
  }

  /**
   * Directly associates a GitHub authorization code and state with the
   * currently authenticated DevPulse user.
   * Protected route.
   *
   * POST /api/v1/auth/github/associate
   */
  @Post('github/associate')
  @HttpCode(HttpStatus.OK)
  async associateGitHub(
    @CurrentUser() user: AuthTokenPayload,
    @Body() body: AssociateGitHubDto,
  ) {
    if (!body?.code || !body?.state) {
      throw new AuthenticationException(
        'Code and state parameters are required to associate GitHub identity',
      );
    }

    const result = await this.githubOAuthService.associateGitHubIdentity(
      user.sub,
      body.code,
      body.state,
    );

    return {
      message: 'GitHub identity successfully associated with user',
      user: result.user,
      githubAccount: {
        id: result.gitHubAccount.id,
        githubUserId: result.gitHubAccount.githubUserId.toString(),
        username: result.gitHubAccount.username,
        displayName: result.gitHubAccount.displayName,
        email: result.gitHubAccount.email,
        avatarUrl: result.gitHubAccount.avatarUrl,
        profileUrl: result.gitHubAccount.profileUrl,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // GitHub OAuth — Callback
  // ---------------------------------------------------------------------------

  /**
   * Handles the GitHub OAuth callback.
   * Validates the CSRF state, exchanges the authorization code for an access
   * token, associates or upserts the user record and linked GitHubAccount,
   * then issues a DevPulse JWT pair.
   *
   * On success, redirects to the web application with tokens as query params.
   *
   * GET /api/v1/auth/github/callback
   */
  @Public()
  @UseGuards(GitHubOAuthGuard)
  @Get('github/callback')
  async githubCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @CurrentUser() currentUser: AuthTokenPayload | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const { tokens, isNewUser, isLinked } = await this.githubOAuthService.handleCallback(
      code,
      state,
      currentUser?.sub,
    );

    // Deliver tokens via httpOnly, SameSite=lax cookies — never in URL params,
    // response bodies, or redirect query strings where they could leak into
    // browser history, server logs, or Referer headers.
    setTokenCookies(res, tokens.accessToken, tokens.refreshToken);

    // Redirect to the web app with only non-sensitive session metadata.
    const webUrl = config.urls.web;
    const redirectUrl = new URL('/auth/callback', webUrl);
    redirectUrl.searchParams.set('token_type', tokens.tokenType);
    redirectUrl.searchParams.set('expires_in', String(tokens.expiresIn));
    redirectUrl.searchParams.set('is_new_user', String(isNewUser));
    if (isLinked) {
      redirectUrl.searchParams.set('is_linked', 'true');
    }

    res.redirect(redirectUrl.toString());
  }

  // ---------------------------------------------------------------------------
  // Current User Profile
  // ---------------------------------------------------------------------------

  /**
   * Returns current authenticated user profile, including linked GitHub accounts.
   * Protected route.
   */
  @Get('me')
  async getProfile(@CurrentUser() user: AuthTokenPayload) {
    const userRecord = await this.databaseService.client.user.findUnique({
      where: { id: user.sub },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        avatarUrl: true,
        createdAt: true,
        updatedAt: true,
        githubAccounts: {
          select: {
            id: true,
            githubUserId: true,
            username: true,
            displayName: true,
            email: true,
            avatarUrl: true,
            profileUrl: true,
            createdAt: true,
            updatedAt: true,
          },
        },
      },
    });

    if (!userRecord) {
      throw new AuthenticationException('User not found');
    }

    return {
      ...userRecord,
      githubAccounts: userRecord.githubAccounts.map((gh) => ({
        ...gh,
        githubUserId: gh.githubUserId.toString(),
      })),
    };
  }

  // ---------------------------------------------------------------------------
  // Token Refresh
  // ---------------------------------------------------------------------------

  /**
   * Refreshes JWT access token using opaque refresh token with rotation.
   * Access and refresh tokens are securely stored/rotated via httpOnly cookies
   * and never leaked in the JSON response body.
   * Public route.
   */
  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refreshTokens(
    @Body() body: RefreshDto,
    @Res({ passthrough: true }) res: Response,
    @Req() req?: Request,
  ) {
    // 1. Resolve refresh token from body or httpOnly cookie
    let rawRefreshToken = body?.refreshToken;
    if (!rawRefreshToken && req?.headers?.cookie) {
      const match = req.headers.cookie.match(/(?:^|;\s*)devpulse_refresh_token=([^;]+)/);
      if (match) {
        rawRefreshToken = decodeURIComponent(match[1]);
      }
    }

    if (!rawRefreshToken) {
      throw new AuthenticationException('Refresh token is required');
    }

    const tokenHash = this.authService.hashToken(rawRefreshToken);

    const existingToken = await this.databaseService.client.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });

    if (!existingToken) {
      throw new AuthenticationException('Invalid refresh token');
    }

    // Replay attack detection: if token is already revoked, revoke all tokens in family
    if (existingToken.isRevoked) {
      await this.databaseService.client.refreshToken.updateMany({
        where: { familyId: existingToken.familyId },
        data: { isRevoked: true, revokedAt: new Date() },
      });
      throw new AuthenticationException('Refresh token reuse detected. Session terminated.');
    }

    // Check expiration
    if (new Date() > existingToken.expiresAt) {
      throw new AuthenticationException('Refresh token expired');
    }

    // Mark current token as revoked
    await this.databaseService.client.refreshToken.update({
      where: { id: existingToken.id },
      data: { isRevoked: true, revokedAt: new Date() },
    });

    // Issue new token pair under same family
    const accessToken = this.authService.generateAccessToken({
      sub: existingToken.user.id,
      email: existingToken.user.email,
      role: existingToken.user.role as any,
    });

    const { token: newRefreshToken, hash: newRefreshTokenHash } = this.authService.generateRefreshToken();

    // 7 days expiration for refresh token
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    await this.databaseService.client.refreshToken.create({
      data: {
        userId: existingToken.userId,
        tokenHash: newRefreshTokenHash,
        familyId: existingToken.familyId,
        expiresAt,
      },
    });

    // Deliver new tokens via httpOnly, SameSite=lax cookies — never in the response body.
    setTokenCookies(res, accessToken, newRefreshToken);

    // Never return access or refresh tokens in API response bodies
    return {
      success: true,
      tokenType: 'Bearer',
      expiresIn: 900,
    };
  }

  // ---------------------------------------------------------------------------
  // GitHub Account Disconnection & Token Cleanup
  // ---------------------------------------------------------------------------

  /**
   * Disconnects a linked GitHub account, revokes OAuth grant remotely,
   * and cleans up all credentials and tokens.
   * Protected route.
   *
   * POST /api/v1/auth/github/disconnect
   * DELETE /api/v1/auth/github/disconnect
   */
  @Post('github/disconnect')
  @HttpCode(HttpStatus.OK)
  async disconnectGitHub(
    @CurrentUser() user: AuthTokenPayload,
    @Body() body?: { accountId?: string; purge?: boolean },
    @Query('accountId') queryAccountId?: string,
  ) {
    const accountId = body?.accountId || queryAccountId;
    const purgeAccount = body?.purge !== false;
    return this.githubOAuthService.disconnectGitHubAccount(user.sub, accountId, { purgeAccount });
  }

  @Delete('github/disconnect')
  @HttpCode(HttpStatus.OK)
  async disconnectGitHubDelete(
    @CurrentUser() user: AuthTokenPayload,
    @Body() body?: { accountId?: string; purge?: boolean },
    @Query('accountId') queryAccountId?: string,
  ) {
    const accountId = body?.accountId || queryAccountId;
    const purgeAccount = body?.purge !== false;
    return this.githubOAuthService.disconnectGitHubAccount(user.sub, accountId, { purgeAccount });
  }

  /**
   * Deletes and disconnects a specific GitHub account by ID.
   * Protected route.
   *
   * DELETE /api/v1/auth/github/accounts/:accountId
   */
  @Delete('github/accounts/:accountId')
  @HttpCode(HttpStatus.OK)
  async deleteGitHubAccount(
    @CurrentUser() user: AuthTokenPayload,
    @Param('accountId') accountId: string,
    @Query('purge') purgeQuery?: string,
  ) {
    const purgeAccount = purgeQuery !== 'false';
    return this.githubOAuthService.disconnectGitHubAccount(user.sub, accountId, { purgeAccount });
  }

  // ---------------------------------------------------------------------------
  // Logout & Session Revocation
  // ---------------------------------------------------------------------------

  /**
   * Single session logout: marks current session as revoked, revokes current refresh token,
   * blacklists session in Redis, and clears httpOnly auth cookies.
   * Protected route.
   *
   * POST /api/v1/auth/logout
   */
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(
    @CurrentUser() user: AuthTokenPayload,
    @Res({ passthrough: true }) res: Response,
    @Req() req?: Request,
  ) {
    // 1. Resolve refresh token from body or cookie
    let rawRefreshToken;
    if (req?.headers?.cookie) {
      const match = req.headers.cookie.match(/(?:^|;\s*)devpulse_refresh_token=([^;]+)/);
      if (match) {
        rawRefreshToken = decodeURIComponent(match[1]);
      }
    }

    if (rawRefreshToken) {
      const tokenHash = this.authService.hashToken(rawRefreshToken);
      const existingToken = await this.databaseService.client.refreshToken.findUnique({
        where: { tokenHash },
      });
      if (existingToken) {
        await this.databaseService.client.refreshToken.updateMany({
          where: { familyId: existingToken.familyId },
          data: { isRevoked: true, revokedAt: new Date() },
        });
      }
    }

    // 2. Revoke session if user has sessionId in token
    if (user?.sessionId) {
      await this.databaseService.client.session.updateMany({
        where: { id: user.sessionId, userId: user.sub },
        data: { revokedAt: new Date() },
      });

      if (this.redisService?.client) {
        try {
          await this.redisService.client.set(
            `session:revoked:${user.sessionId}`,
            '1',
            'EX',
            7 * 24 * 60 * 60,
          );
        } catch {
          // ignore redis failure
        }
      }
    }

    // 3. Clear auth cookies
    clearTokenCookies(res);

    return {
      success: true,
      message: 'Successfully logged out',
    };
  }

  /**
   * Global logout (all devices): revokes all sessions and all refresh tokens
   * for the user, blacklists sessions in Redis, and clears cookies.
   * Protected route.
   *
   * POST /api/v1/auth/logout-all
   */
  @Post('logout-all')
  @HttpCode(HttpStatus.OK)
  async logoutAll(
    @CurrentUser() user: AuthTokenPayload,
    @Res({ passthrough: true }) res: Response,
  ) {
    // 1. Revoke all refresh tokens
    await this.databaseService.client.refreshToken.updateMany({
      where: { userId: user.sub },
      data: { isRevoked: true, revokedAt: new Date() },
    });

    // 2. Revoke all sessions in DB & Redis
    const sessions = await this.databaseService.client.session.findMany({
      where: { userId: user.sub, revokedAt: null },
      select: { id: true },
    });

    await this.databaseService.client.session.updateMany({
      where: { userId: user.sub },
      data: { revokedAt: new Date() },
    });

    if (this.redisService?.client && sessions && sessions.length > 0) {
      try {
        for (const s of sessions) {
          await this.redisService.client.set(
            `session:revoked:${s.id}`,
            '1',
            'EX',
            7 * 24 * 60 * 60,
          );
        }
      } catch {
        // ignore redis failure
      }
    }

    // 3. Clear auth cookies
    clearTokenCookies(res);

    return {
      success: true,
      message: 'Successfully logged out from all devices',
    };
  }

}
