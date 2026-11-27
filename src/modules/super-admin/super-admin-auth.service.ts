import {
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  hashPasswordScrypt,
  signSuperAdminJwt,
  verifyPasswordHash,
} from '../../common/security/crypto.util.js';
import { SuperAdminLoginDto } from './dto/super-admin-login.dto.js';

export interface SuperAdminProfileResponse {
  id: string;
  username: string;
  fullName: string;
  email: string;
  phone?: string;
  role: 'SUPER_ADMIN';
  avatarText: string;
  avatarUrl?: string | null;
  token?: string;
  crownBadge?: string;
  systemTitle?: string;
}

@Injectable()
export class SuperAdminAuthService {
  private readonly logger = new Logger(SuperAdminAuthService.name);

  constructor(private readonly prisma: PrismaService) {}

  private getAdminUsername(): string {
    return (process.env.ADMIN_USERNAME || 'pungkyrama').trim();
  }

  private getAdminEmail(): string {
    return (process.env.ADMIN_EMAIL || 'admin@sevaniq.enterprise').trim();
  }

  private getAdminPassword(): string | null {
    const envPass = process.env.ADMIN_PASSWORD?.trim();
    return envPass || null;
  }

  private async recordAudit(
    actorId: string,
    eventType: string,
    targetEntity?: string,
    details?: Record<string, unknown>,
    ipAddress?: string,
  ): Promise<void> {
    try {
      await this.prisma.platformAuditEvent.create({
        data: {
          actorId,
          eventType,
          targetEntity: targetEntity ?? null,
          details: (details ?? {}) as any,
          ipAddress: ipAddress ?? null,
        },
      });
    } catch {
      // Skip audit persistence when running with mocked DB or transient errors
    }
  }

  async login(
    dto: SuperAdminLoginDto,
    ipAddress?: string,
  ): Promise<SuperAdminProfileResponse> {
    const cleanId = dto.identifier.trim();
    const adminUsername = this.getAdminUsername();
    const adminEmail = this.getAdminEmail();
    const adminPassword = this.getAdminPassword();

    let dbAdmin: {
      id: string;
      username: string | null;
      fullName: string;
      email: string;
      phone: string | null;
      role: string;
      passwordHash: string;
      avatarUrl: string | null;
      founderProfile?: {
        crownBadge: string;
        systemTitle: string;
      } | null;
    } | null = null;

    try {
      dbAdmin = await this.prisma.user.findFirst({
        where: {
          role: 'SUPER_ADMIN',
          OR: [
            { username: { equals: cleanId, mode: 'insensitive' } },
            { email: { equals: cleanId, mode: 'insensitive' } },
          ],
        },
        select: {
          id: true,
          username: true,
          fullName: true,
          email: true,
          phone: true,
          role: true,
          passwordHash: true,
          avatarUrl: true,
          founderProfile: {
            select: {
              crownBadge: true,
              systemTitle: true,
            },
          },
        },
      });
    } catch {}

    const matchesEnvAdmin =
      cleanId.toLowerCase() === adminUsername.toLowerCase() ||
      cleanId.toLowerCase() === adminEmail.toLowerCase();

    if (!dbAdmin && !matchesEnvAdmin) {
      throw new UnauthorizedException('Invalid administrator credentials.');
    }

    let authorized = false;
    if (dbAdmin && dbAdmin.passwordHash) {
      const check = verifyPasswordHash(dto.password, dbAdmin.passwordHash);
      authorized = check.valid;
      if (authorized && check.needsRehash) {
        this.prisma.user
          .update({
            where: { id: dbAdmin.id },
            data: { passwordHash: hashPasswordScrypt(dto.password) },
          })
          .catch(() => {});
      }
    } else if (matchesEnvAdmin && adminPassword) {
      const a = crypto.createHash('sha256').update(dto.password).digest();
      const b = crypto.createHash('sha256').update(adminPassword).digest();
      authorized = crypto.timingSafeEqual(a, b);
    }

    if (!authorized) {
      throw new UnauthorizedException('Invalid administrator credentials.');
    }

    const effectiveId = dbAdmin?.id || 'usr-admin-01';
    const effectiveUsername = dbAdmin?.username || adminUsername;
    const effectiveEmail = dbAdmin?.email || adminEmail;
    const effectiveFullName = dbAdmin?.fullName || 'Platform Founder';

    if (dbAdmin) {
      try {
        await this.prisma.platformFounderProfile.upsert({
          where: { userId: dbAdmin.id },
          update: { lastSystemAuditAt: new Date() },
          create: {
            userId: dbAdmin.id,
            crownBadge: 'GOLD_CROWN_PLATFORM_SOVEREIGN',
            systemTitle: 'Platform Founder & System Sovereign',
            lastSystemAuditAt: new Date(),
          },
        });
      } catch {}

      await this.recordAudit(
        dbAdmin.id,
        'SUPER_ADMIN_LOGIN',
        effectiveUsername,
        { channel: 'isolated-super-admin-portal' },
        ipAddress,
      );
    }

    this.logger.log(`Isolated Platform Founder login: @${effectiveUsername}`);

    const token = signSuperAdminJwt({
      sub: effectiveId,
      username: effectiveUsername,
    });

    return {
      id: effectiveId,
      username: effectiveUsername,
      fullName: effectiveFullName,
      email: effectiveEmail,
      phone: dbAdmin?.phone || '+1-555-019-0000',
      role: 'SUPER_ADMIN',
      avatarText: effectiveUsername.slice(0, 2).toUpperCase(),
      avatarUrl: dbAdmin?.avatarUrl ?? null,
      token,
      crownBadge:
        dbAdmin?.founderProfile?.crownBadge || 'GOLD_CROWN_PLATFORM_SOVEREIGN',
      systemTitle:
        dbAdmin?.founderProfile?.systemTitle ||
        'Platform Founder & System Sovereign',
    };
  }

  async getProfile(userId: string): Promise<SuperAdminProfileResponse> {
    const admin = await this.prisma.user.findFirst({
      where: { id: userId, role: 'SUPER_ADMIN' },
      include: { founderProfile: true },
    });

    if (!admin) {
      throw new UnauthorizedException('Platform Founder session is invalid.');
    }

    const username = admin.username || this.getAdminUsername();
    return {
      id: admin.id,
      username,
      fullName: admin.fullName,
      email: admin.email,
      phone: admin.phone || undefined,
      role: 'SUPER_ADMIN',
      avatarText: username.slice(0, 2).toUpperCase(),
      avatarUrl: admin.avatarUrl ?? null,
      crownBadge:
        admin.founderProfile?.crownBadge || 'GOLD_CROWN_PLATFORM_SOVEREIGN',
      systemTitle:
        admin.founderProfile?.systemTitle ||
        'Platform Founder & System Sovereign',
    };
  }

  async updateAvatar(
    userId: string,
    avatarUrl: string | null,
  ): Promise<{ success: boolean; avatarUrl: string | null; message: string }> {
    const admin = await this.prisma.user.findFirst({
      where: { id: userId, role: 'SUPER_ADMIN' },
    });
    if (!admin) {
      throw new UnauthorizedException('Platform Founder account not found.');
    }

    await this.prisma.user.update({
      where: { id: admin.id },
      data: { avatarUrl: avatarUrl || null },
    });

    return {
      success: true,
      avatarUrl: avatarUrl || null,
      message: avatarUrl
        ? 'Platform Founder profile photo updated.'
        : 'Platform Founder profile photo removed.',
    };
  }

  async logout(userId: string, ipAddress?: string): Promise<{ success: boolean }> {
    try {
      await this.prisma.userActivitySession.updateMany({
        where: { userId, isOnline: true },
        data: {
          isOnline: false,
          logoutAt: new Date(),
          logoutReason: 'MANUAL_LOGOUT',
        },
      });
      await this.recordAudit(userId, 'SUPER_ADMIN_LOGOUT', userId, {}, ipAddress);
    } catch {}

    return { success: true };
  }
}
