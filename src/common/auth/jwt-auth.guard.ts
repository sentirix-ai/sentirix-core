import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  Optional,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from './auth.decorators.js';
import { verifyJwt, VerifiedJwtPayload } from '../security/crypto.util.js';
import { PrismaService } from '../../modules/prisma/prisma.service.js';

export interface AuthenticatedUser {
  userId: string;
  username?: string;
  role: string;
  workspaceId?: string;
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

    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const authHeader = req.headers['authorization'];
    const rawHeader = Array.isArray(authHeader) ? authHeader[0] : authHeader;

    if (!rawHeader || !rawHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Authentication required. Please sign in.');
    }

    const token = rawHeader.slice(7).trim();
    const payload: VerifiedJwtPayload | null = verifyJwt(token);
    if (!payload) {
      throw new UnauthorizedException('Invalid or expired session token. Please sign in again.');
    }

    let resolvedRole = payload.role;
    let resolvedUsername = payload.username;
    let resolvedWorkspaceId = payload.workspaceId;

    // Resolve live role from database when available so onboarding promotion or role changes take effect immediately
    if (this.prisma && payload.sub !== 'usr-admin-01') {
      try {
        const dbUser = await this.prisma.user.findUnique({
          where: { id: payload.sub },
          select: {
            role: true,
            username: true,
            workspaceMembership: {
              select: { role: true, workspaceId: true },
            },
          },
        });
        if (dbUser) {
          resolvedUsername = dbUser.username || resolvedUsername;
          resolvedWorkspaceId = dbUser.workspaceMembership?.workspaceId || resolvedWorkspaceId;
          if (dbUser.role === 'SUPER_ADMIN') {
            resolvedRole = 'SUPER_ADMIN';
          } else if (dbUser.workspaceMembership?.role === 'LEADER') {
            resolvedRole = 'POD_LEADER';
          } else {
            resolvedRole = dbUser.role;
          }
        }
      } catch {
        // Fall back to signed JWT claims if DB lookup is unavailable
      }
    }

    req.user = {
      userId: payload.sub,
      username: resolvedUsername,
      role: resolvedRole,
      workspaceId: resolvedWorkspaceId,
    };

    return true;
  }
}
