import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  AnalyticsService,
  OwnerAnalyticsResponse,
} from '../analytics/analytics.service.js';
import { WorkspacePersonnelService } from '../workspace/workspace-personnel.service.js';
import { TicketsService } from '../tickets/tickets.service.js';
import { SuperAdminForceLogoutDto } from './dto/super-admin-actions.dto.js';

@Injectable()
export class SuperAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly analyticsService: AnalyticsService,
    private readonly workspacePersonnelService: WorkspacePersonnelService,
    private readonly ticketsService: TicketsService,
  ) {}

  async getOwnerDashboard(): Promise<OwnerAnalyticsResponse> {
    return this.analyticsService.getOwnerDashboardData(undefined, {
      verifiedSuperAdmin: true,
    });
  }

  async getTenantsOverview() {
    const organizations = await this.prisma.organization.findMany({
      include: {
        users: {
          where: { role: 'TENANT_OWNER' },
          select: {
            id: true,
            username: true,
            fullName: true,
            email: true,
            onboardingCompleted: true,
          },
        },
        workspaces: {
          include: {
            members: true,
            tickets: { select: { id: true, status: true } },
          },
        },
        activitySessions: {
          where: { isOnline: true },
          select: { id: true, lastHeartbeatAt: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const now = Date.now();
    return organizations.map((org) => {
      const claimedSeats = org.workspaces.reduce(
        (sum, w) => sum + w.members.length,
        0,
      );
      const openTicketsCount = org.workspaces.reduce(
        (sum, w) =>
          sum +
          w.tickets.filter((t) => t.status !== 'RESOLVED' && t.status !== 'CLOSED')
            .length,
        0,
      );
      const onlineStaffCount = org.activitySessions.filter(
        (s) => now - new Date(s.lastHeartbeatAt).getTime() < 90000,
      ).length;

      return {
        id: org.id,
        name: org.name,
        industry: org.industry,
        planTier: org.planTier,
        totalSeats: org.totalSeats,
        claimedSeats,
        podsCount: org.workspaces.length,
        openTicketsCount,
        onlineStaffCount,
        owner: org.users[0] || null,
        createdAt: org.createdAt.toISOString(),
      };
    });
  }

  async getCrossTenantCockpit(organizationId?: string) {
    return this.workspacePersonnelService.getCrossTenantCockpitData(organizationId);
  }

  async forceLogoutCrossTenant(
    actorId: string,
    dto: SuperAdminForceLogoutDto,
    ipAddress?: string,
  ) {
    const result = await this.workspacePersonnelService.forceLogoutUser(
      dto.userId,
      dto.username,
      dto.token,
    );

    try {
      await this.prisma.platformAuditEvent.create({
        data: {
          actorId,
          eventType: 'CROSS_TENANT_FORCE_LOGOUT',
          targetEntity: result.userId || dto.username || dto.token || 'unknown',
          details: {
            username: result.username,
            targetUserId: result.userId,
          },
          ipAddress: ipAddress ?? null,
        },
      });
    } catch {}

    return result;
  }

  async cleanupDemoTickets(actorId: string, ipAddress?: string) {
    const result = await this.ticketsService.cleanupDemoTickets();
    try {
      await this.prisma.platformAuditEvent.create({
        data: {
          actorId,
          eventType: 'DEMO_TICKETS_CLEANUP',
          targetEntity: 'tickets',
          details: { removedCount: result.count },
          ipAddress: ipAddress ?? null,
        },
      });
    } catch {}
    return result;
  }

  async getAuditEvents(limit = 100) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 200));
    const events = await this.prisma.platformAuditEvent.findMany({
      take: safeLimit,
      orderBy: { createdAt: 'desc' },
      include: {
        actor: {
          select: {
            id: true,
            username: true,
            fullName: true,
          },
        },
      },
    });

    return events.map((ev) => ({
      id: ev.id,
      actorId: ev.actorId,
      actorUsername: ev.actor?.username || ev.actor?.fullName || 'super-admin',
      eventType: ev.eventType,
      targetEntity: ev.targetEntity,
      details: ev.details,
      ipAddress: ev.ipAddress,
      createdAt: ev.createdAt.toISOString(),
    }));
  }
}
