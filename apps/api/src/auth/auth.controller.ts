import {
  Controller,
  Get,
  Post,
  Body,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { DatabaseService } from '../database.service';
import { Public, CurrentUser } from './decorators';
import { AuthTokenPayload } from '@devpulse/types';

export class RefreshDto {
  refreshToken!: string;
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly databaseService: DatabaseService,
  ) {}

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
      throw new UnauthorizedException('User not found');
    }

    return userRecord;
  }

  /**
   * Refreshes JWT access token using opaque refresh token with rotation.
   * Public route.
   */
  @Public()
  @Post('refresh')
  async refreshTokens(@Body() body: RefreshDto) {
    if (!body?.refreshToken) {
      throw new UnauthorizedException('Refresh token is required');
    }

    const tokenHash = this.authService.hashToken(body.refreshToken);

    const existingToken = await this.databaseService.client.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });

    if (!existingToken) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    // Replay attack detection: if token is already revoked, revoke all tokens in family
    if (existingToken.isRevoked) {
      await this.databaseService.client.refreshToken.updateMany({
        where: { familyId: existingToken.familyId },
        data: { isRevoked: true, revokedAt: new Date() },
      });
      throw new UnauthorizedException('Refresh token reuse detected. Session terminated.');
    }

    // Check expiration
    if (new Date() > existingToken.expiresAt) {
      throw new UnauthorizedException('Refresh token expired');
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
