import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  Res,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { Response } from 'express';
import { AuthService } from './auth.service';
import { GitHubOAuthService } from './github-oauth.service';
import { DatabaseService } from '../database.service';
import { Public, CurrentUser } from './decorators';
import { GitHubOAuthGuard } from './guards';
import { AuthTokenPayload } from '@devpulse/types';
import { AuthenticationException } from '../common/errors';
import { config } from '@devpulse/config';

export class RefreshDto {
  refreshToken!: string;
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
   *
   * GET /api/v1/auth/github
   */
  @Public()
  @Get('github')
  async githubAuthorize(@Res() res: Response): Promise<void> {
    const authorizationUrl = await this.githubOAuthService.buildAuthorizationUrl();
    res.redirect(authorizationUrl);
  }

  // ---------------------------------------------------------------------------
  // GitHub OAuth — Callback
  // ---------------------------------------------------------------------------

  /**
   * Handles the GitHub OAuth callback.
   * Validates the CSRF state, exchanges the authorization code for an access
   * token, upserts the user record and linked GitHubAccount, then issues a
   * DevPulse JWT pair.
   *
   * On success, redirects to the web application with tokens as query params
   * so the frontend can store them (suitable for SPA flows). In a
   * production hardened setup, prefer HttpOnly cookie delivery.
   *
   * GET /api/v1/auth/github/callback
   */
  @Public()
  @UseGuards(GitHubOAuthGuard)
  @Get('github/callback')
  async githubCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Res() res: Response,
  ): Promise<void> {
    const { tokens, isNewUser } = await this.githubOAuthService.handleCallback(code, state);

    // Redirect to the web app carrying the token pair as query params.
    // The frontend is expected to store them in memory / secure storage and
    // strip them from the URL immediately.
    const webUrl = config.urls.web;
    const redirectUrl = new URL('/auth/callback', webUrl);
    redirectUrl.searchParams.set('access_token', tokens.accessToken);
    redirectUrl.searchParams.set('refresh_token', tokens.refreshToken);
    redirectUrl.searchParams.set('token_type', tokens.tokenType);
    redirectUrl.searchParams.set('expires_in', String(tokens.expiresIn));
    redirectUrl.searchParams.set('is_new_user', String(isNewUser));

    res.redirect(redirectUrl.toString());
  }

  // ---------------------------------------------------------------------------
  // Current User Profile
  // ---------------------------------------------------------------------------

  /**
   * Returns current authenticated user profile.
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
      },
    });

    if (!userRecord) {
      throw new AuthenticationException('User not found');
    }

    return userRecord;
  }

  // ---------------------------------------------------------------------------
  // Token Refresh
  // ---------------------------------------------------------------------------

  /**
   * Refreshes JWT access token using opaque refresh token with rotation.
   * Public route.
   */
  @Public()
  @Post('refresh')
  async refreshTokens(@Body() body: RefreshDto) {
    if (!body?.refreshToken) {
      throw new AuthenticationException('Refresh token is required');
    }

    const tokenHash = this.authService.hashToken(body.refreshToken);

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

    return {
      accessToken,
      refreshToken: newRefreshToken,
      tokenType: 'Bearer',
      expiresIn: 900,
    };
  }
}

