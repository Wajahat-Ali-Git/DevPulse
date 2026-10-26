import {
  CanActivate,
  ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@devpulse/types';
import { ROLES_KEY } from '../decorators/auth.decorators';
import { AuthorizationException } from '../../common/errors';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const user = request.user;

    if (!user || !user.role) {
      throw new AuthorizationException('Access denied: insufficient permissions');
    }

    const hasRole = requiredRoles.includes(user.role);
    if (!hasRole) {
      throw new AuthorizationException(
        `Access denied: required role is [${requiredRoles.join(', ')}], current role is [${user.role}]`,
      );
    }

    return true;
  }
}
