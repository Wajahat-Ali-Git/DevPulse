import { Injectable } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import { config } from '@devpulse/config';
import { AuthTokenPayload, AuthTokens, UserRole } from '@devpulse/types';
import * as crypto from 'crypto';
import { AuthenticationException } from '../common/errors';

@Injectable()
export class AuthService {
  private readonly jwtSecret = config.auth.jwtSecret;
  private readonly jwtExpiresIn = config.auth.jwtExpiresIn || '15m';

  /**
   * Generates a signed JWT access token.
   */
  generateAccessToken(payload: Omit<AuthTokenPayload, 'iat' | 'exp'>): string {
    return jwt.sign(payload, this.jwtSecret, {
      expiresIn: this.jwtExpiresIn as any,
    });
  }

  /**
   * Verifies and decodes a JWT access token.
   */
  verifyAccessToken(token: string): AuthTokenPayload {
    try {
      const decoded = jwt.verify(token, this.jwtSecret) as AuthTokenPayload;
      return decoded;
    } catch (err: any) {
      if (err instanceof jwt.TokenExpiredError) {
        throw new AuthenticationException('Access token has expired');
      }
      throw new AuthenticationException('Invalid access token');
    }
  }

  /**
   * Generates a secure random opaque refresh token and its SHA-256 hash.
   */
  generateRefreshToken(): { token: string; hash: string } {
    const token = crypto.randomBytes(40).toString('hex');
    const hash = this.hashToken(token);
    return { token, hash };
  }

  /**
   * Generates a unique family ID for grouping rotated refresh tokens.
   */
  generateFamilyId(): string {
    return crypto.randomUUID();
  }

  /**
   * Computes SHA-256 hash of a raw token string.
   */
  hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  /**
   * Helper to issue access & refresh token pair.
   */
  issueTokenPair(
    user: { id: string; email: string; role: UserRole },
    sessionId?: string,
  ): AuthTokens & { refreshTokenHash: string; familyId: string } {
    const accessToken = this.generateAccessToken({
      sub: user.id,
      email: user.email,
      role: user.role,
      sessionId,
    });

    const { token: refreshToken, hash: refreshTokenHash } = this.generateRefreshToken();
    const familyId = this.generateFamilyId();

    return {
      accessToken,
      refreshToken,
      refreshTokenHash,
      familyId,
      tokenType: 'Bearer',
      expiresIn: 900, // 15 minutes in seconds
    };
  }
}
