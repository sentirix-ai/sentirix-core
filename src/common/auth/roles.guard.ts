import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_SUPER_ADMIN_ROUTE_KEY, ROLES_KEY } from './auth.decorators.js';
import type { AuthenticatedRequest } from './jwt-auth.guard.js';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isSuperAdminRoute = this.reflector.getAllAndOverride<boolean>(
      IS_SUPER_ADMIN_ROUTE_KEY,
      [context.getHandler(), context.getClass()],
    );

    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const userRole = (req.user?.role || '').toUpperCase();

    if (isSuperAdminRoute) {
      if (userRole !== 'SUPER_ADMIN' || req.user?.isSuperAdminToken !== true) {
        throw new ForbiddenException(
          'Access denied. Platform Founder privileges required.',
        );
      }
      return true;
    }

    const requiredRoles = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const normalizedRequired = requiredRoles.map((r) => r.toUpperCase());

    const allowed = normalizedRequired.some((target) => {
      if (target === userRole) return true;
      if (
        (target === 'TENANT_OWNER' || target === 'ADMIN') &&
        (userRole === 'TENANT_OWNER' || userRole === 'ADMIN')
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
