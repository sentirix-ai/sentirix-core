import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  Optional,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY, IS_SUPER_ADMIN_ROUTE_KEY } from './auth.decorators.js';
import {
  verifyJwt,
  verifySuperAdminJwt,
  VerifiedJwtPayload,
} from '../security/crypto.util.js';
import { PrismaService } from '../../modules/prisma/prisma.service.js';

export interface AuthenticatedUser {
  userId: string;
  username?: string;
  role: string;
  workspaceId?: string;
  organizationId?: string;
  isSuperAdminToken?: boolean;
}

export interface AuthenticatedRequest {
  headers: Record<string, string | string[] | undefined>;
  user?: AuthenticatedUser;
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Optional() private readonly prisma?: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const isSuperAdminRoute = this.reflector.getAllAndOverride<boolean>(
      IS_SUPER_ADMIN_ROUTE_KEY,
      [context.getHandler(), context.getClass()],
    );

    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const authHeader = req.headers['authorization'];
    const rawHeader = Array.isArray(authHeader) ? authHeader[0] : authHeader;

    if (!rawHeader || !rawHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Authentication required. Please sign in.');
    }

    const token = rawHeader.slice(7).trim();

    if (isSuperAdminRoute) {
      const payload: VerifiedJwtPayload | null = verifySuperAdminJwt(token);
      if (!payload) {
        throw new UnauthorizedException(
          'Invalid or expired Platform Founder session token.',
        );
      }

      let resolvedUsername = payload.username;
      if (this.prisma && payload.sub !== 'usr-admin-01') {
        try {
          const dbAdmin = await this.prisma.user.findUnique({
            where: { id: payload.sub },
            select: {
              id: true,
              username: true,
              role: true,
              founderProfile: { select: { id: true } },
            },
          });
          if (!dbAdmin || dbAdmin.role !== 'SUPER_ADMIN') {
            throw new UnauthorizedException(
              'Platform Founder privileges revoked or invalid.',
            );
          }
          resolvedUsername = dbAdmin.username || resolvedUsername;
        } catch (err) {
          if (err instanceof UnauthorizedException) throw err;
        }
      }

      req.user = {
        userId: payload.sub,
        username: resolvedUsername,
        role: 'SUPER_ADMIN',
        isSuperAdminToken: true,
      };
      return true;
    }

    const payload: VerifiedJwtPayload | null = verifyJwt(token);
    if (!payload) {
      throw new UnauthorizedException('Invalid or expired session token. Please sign in again.');
    }

    let resolvedRole = payload.role;
    let resolvedUsername = payload.username;
    let resolvedWorkspaceId = payload.workspaceId;
    let resolvedOrganizationId = payload.organizationId;

    // Resolve live role and organization scope from database
    if (this.prisma) {
      try {
        const dbUser = await this.prisma.user.findUnique({
          where: { id: payload.sub },
          select: {
            role: true,
            username: true,
            organizationId: true,
            workspaceMembership: {
              select: { role: true, workspaceId: true },
            },
            ownedWorkspaces: {
              select: { organizationId: true },
              take: 1,
            },
          },
        });
        if (dbUser) {
          if (dbUser.role === 'SUPER_ADMIN') {
            throw new UnauthorizedException(
              'Platform Founder must authenticate through the isolated Admin portal.',
            );
          }
          resolvedUsername = dbUser.username || resolvedUsername;
          resolvedWorkspaceId = dbUser.workspaceMembership?.workspaceId || resolvedWorkspaceId;
          resolvedOrganizationId =
            dbUser.organizationId ||
            dbUser.ownedWorkspaces?.[0]?.organizationId ||
            resolvedOrganizationId;
          if ((dbUser.role as string) === 'TENANT_OWNER') {
            resolvedRole = 'TENANT_OWNER';
          } else if (dbUser.workspaceMembership?.role === 'LEADER') {
            resolvedRole = 'POD_LEADER';
          } else {
            resolvedRole = dbUser.role;
          }
        }
      } catch (err) {
        if (err instanceof UnauthorizedException) throw err;
      }
    }

    req.user = {
      userId: payload.sub,
      username: resolvedUsername,
      role: resolvedRole,
      workspaceId: resolvedWorkspaceId,
      organizationId: resolvedOrganizationId,
      isSuperAdminToken: false,
    };

    return true;
  }
}
