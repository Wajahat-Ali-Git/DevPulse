import {
  CanActivate,
  ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { Request } from 'express';
import { AuthenticationException } from '../../common/errors';

/**
 * Guard for the GitHub OAuth callback endpoint.
 *
 * Ensures both `code` and `state` query parameters are present before
 * allowing the request to reach the controller. The actual CSRF state
 * validation is delegated to GitHubOAuthService inside the controller.
 */
@Injectable()
export class GitHubOAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const { code, state, error, error_description } = request.query as Record<string, string>;

    // GitHub may return an error on the callback if the user denied access
    if (error) {
      const description = error_description
        ? decodeURIComponent(error_description)
        : 'GitHub OAuth authorization was denied or failed.';
      throw new AuthenticationException(description);
    }

    if (!code) {
      throw new AuthenticationException('Missing authorization code from GitHub OAuth callback');
    }

    if (!state) {
      throw new AuthenticationException('Missing state parameter from GitHub OAuth callback');
    }

    return true;
  }
}
