import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { SuperAdminAuthService } from './super-admin-auth.service.js';
import { SuperAdminService } from './super-admin.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { AnalyticsService } from '../analytics/analytics.service.js';
import type { WorkspacePersonnelService } from '../workspace/workspace-personnel.service.js';
import type { TicketsService } from '../tickets/tickets.service.js';
import {
  hashPasswordScrypt,
  verifyJwt,
  verifySuperAdminJwt,
} from '../../common/security/crypto.util.js';

function createPrismaMock() {
  return {
    user: {
      findFirst: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    },
    platformFounderProfile: {
      upsert: vi.fn().mockResolvedValue({}),
    },
    platformAuditEvent: {
      create: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([]),
    },
    userActivitySession: {
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    organization: {
      findMany: vi.fn().mockResolvedValue([]),
    },
  };
}

describe('SuperAdminModule (Isolated Control Plane)', () => {
  let prismaMock: ReturnType<typeof createPrismaMock>;
  let authService: SuperAdminAuthService;

  beforeEach(() => {
    prismaMock = createPrismaMock();
    authService = new SuperAdminAuthService(prismaMock as unknown as PrismaService);
  });

  it('rejects non-founder credentials and legacy fallback passwords', async () => {
    const originalAdminPass = process.env.ADMIN_PASSWORD;
    delete process.env.ADMIN_PASSWORD;
    try {
      prismaMock.user.findFirst.mockResolvedValue(null);

      await expect(
        authService.login({ identifier: 'pungkyrama', password: '0o0o 0o0o' }),
      ).rejects.toThrow(UnauthorizedException);

      await expect(
        authService.login({ identifier: 'random_tenant', password: 'Password@123' }),
      ).rejects.toThrow(UnauthorizedException);
    } finally {
      if (originalAdminPass !== undefined) {
        process.env.ADMIN_PASSWORD = originalAdminPass;
      }
    }
  });

  it('issues SUPER_ADMIN_JWT_SECRET token rejected by regular verifyJwt and records audit event', async () => {
    const strongPass = 'FounderStrongPass#2026!';
    prismaMock.user.findFirst.mockResolvedValue({
      id: 'usr-admin-01',
      username: 'pungkyrama',
      fullName: 'Pungky Rama',
      email: 'admin@sevaniq.enterprise',
      phone: '+1-555-019-0000',
      role: 'SUPER_ADMIN',
      passwordHash: hashPasswordScrypt(strongPass),
      avatarUrl: null,
      founderProfile: {
        crownBadge: 'GOLD_CROWN_PLATFORM_SOVEREIGN',
        systemTitle: 'Platform Founder & System Sovereign',
      },
    });

    const result = await authService.login(
      { identifier: 'pungkyrama', password: strongPass },
      '127.0.0.1',
    );

    expect(result.role).toBe('SUPER_ADMIN');
    expect(result.token).toBeTruthy();
    expect(verifySuperAdminJwt(result.token!)?.sub).toBe('usr-admin-01');
    expect(verifyJwt(result.token!)).toBeNull();
    expect(prismaMock.platformAuditEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          actorId: 'usr-admin-01',
          eventType: 'SUPER_ADMIN_LOGIN',
        }),
      }),
    );
  });

  it('lists tenant organizations and records audit events on cross-tenant force logout', async () => {
    prismaMock.organization.findMany.mockResolvedValue([
      {
        id: 'org-1',
        name: 'Acme Support',
        industry: 'SAAS',
        planTier: 'MULTI_POD_ENTERPRISE',
        totalSeats: 8,
        createdAt: new Date('2026-11-27T00:00:00Z'),
        users: [
          {
            id: 'usr-owner-1',
            username: 'acme_owner',
            fullName: 'Acme Owner',
            email: 'owner@acme.com',
            onboardingCompleted: true,
          },
        ],
        workspaces: [
          {
            id: 'ws-1',
            members: [{ id: 'm1' }, { id: 'm2' }],
            tickets: [{ id: 't1', status: 'OPEN' }, { id: 't2', status: 'RESOLVED' }],
          },
        ],
        activitySessions: [{ id: 's1', lastHeartbeatAt: new Date() }],
      },
    ]);

    const personnelMock = {
      getCrossTenantCockpitData: vi.fn(),
      forceLogoutUser: vi.fn().mockResolvedValue({
        success: true,
        userId: 'usr-agent-9',
        username: 'agent_9',
      }),
    };

    const superAdminService = new SuperAdminService(
      prismaMock as unknown as PrismaService,
      { getOwnerDashboardData: vi.fn() } as unknown as AnalyticsService,
      personnelMock as unknown as WorkspacePersonnelService,
      { cleanupDemoTickets: vi.fn() } as unknown as TicketsService,
    );

    const tenants = await superAdminService.getTenantsOverview();
    expect(tenants).toHaveLength(1);
    expect(tenants[0]).toMatchObject({
      id: 'org-1',
      name: 'Acme Support',
      claimedSeats: 2,
      openTicketsCount: 1,
      onlineStaffCount: 1,
    });

    await superAdminService.forceLogoutCrossTenant(
      'usr-admin-01',
      { userId: 'usr-agent-9' },
      '127.0.0.1',
    );
    expect(personnelMock.forceLogoutUser).toHaveBeenCalledWith(
      'usr-agent-9',
      undefined,
      undefined,
    );
    expect(prismaMock.platformAuditEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          actorId: 'usr-admin-01',
          eventType: 'CROSS_TENANT_FORCE_LOGOUT',
        }),
      }),
    );
  });
});
