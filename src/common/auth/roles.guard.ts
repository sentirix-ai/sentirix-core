import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from './auth.decorators.js';
import type { AuthenticatedRequest } from './jwt-auth.guard.js';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const userRole = (req.user?.role || '').toUpperCase();
    const normalizedRequired = requiredRoles.map((r) => r.toUpperCase());

    const allowed = normalizedRequired.some((target) => {
      if (target === userRole) return true;
      if (
        (target === 'ADMIN' || target === 'SUPER_ADMIN') &&
        (userRole === 'ADMIN' || userRole === 'SUPER_ADMIN')
      ) {
        return true;
      }
      if (
        (target === 'LEADER' || target === 'POD_LEADER') &&
        (userRole === 'LEADER' || userRole === 'POD_LEADER')
      ) {
        return true;
      }
      return false;
    });

    if (!allowed) {
      throw new ForbiddenException(
        'Access denied. Insufficient role permissions for this operation.',
      );
    }

    return true;
  }
}
