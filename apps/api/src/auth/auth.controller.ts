import {
  Controller,
  Get,
  Post,
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
import { Public, CurrentUser } from './decorators';
import { GitHubOAuthGuard } from './guards';
import { AuthTokenPayload } from '@devpulse/types';
import { AuthenticationException } from '../common/errors';
import { config } from '@devpulse/config';

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

    // Redirect to the web app carrying the token pair as query params.
    const webUrl = config.urls.web;
    const redirectUrl = new URL('/auth/callback', webUrl);
    redirectUrl.searchParams.set('access_token', tokens.accessToken);
    redirectUrl.searchParams.set('refresh_token', tokens.refreshToken);
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

    // Set secure httpOnly cookies
    const isProduction = config.app.isProduction;
    res.cookie('devpulse_access_token', accessToken, {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'lax',
      path: '/',
      maxAge: 15 * 60 * 1000, // 15 minutes
    });

    res.cookie('devpulse_refresh_token', newRefreshToken, {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'lax',
      path: '/',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    });

    // Never return access or refresh tokens in API response bodies
    return {
      success: true,
      tokenType: 'Bearer',
      expiresIn: 900,
    };
  }
}
