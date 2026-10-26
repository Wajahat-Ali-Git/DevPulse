import {
  CanActivate,
  ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { AuthService } from '../auth.service';
import { IS_PUBLIC_KEY } from '../decorators/auth.decorators';
import { RedisService } from '../../redis.service';
import { AuthenticationException } from '../../common/errors';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authService: AuthService,
    private readonly redisService?: RedisService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const token = this.extractTokenFromHeader(request);

    if (!token) {
      throw new AuthenticationException('Authentication token missing');
    }

    const payload = this.authService.verifyAccessToken(token);

    // Optional fast-path session check via Redis if sessionId exists in token
    if (payload.sessionId && this.redisService?.client) {
      try {
        const isBlacklisted = await this.redisService.client.get(`session:revoked:${payload.sessionId}`);
        if (isBlacklisted) {
          throw new AuthenticationException('Session has been revoked');
        }
      } catch (err) {
        // If it's AuthenticationException, rethrow; otherwise allow DB/JWT fallback if Redis is unreachable
        if (err instanceof AuthenticationException) {
          throw err;
        }
      }
    }

    (request as any).user = payload;
    return true;
  }

  private extractTokenFromHeader(request: Request): string | undefined {
    const authHeader = request.headers.authorization;
    if (!authHeader) {
      return undefined;
    }

    const [type, token] = authHeader.split(' ');
    return type === 'Bearer' ? token : undefined;
  }
}
