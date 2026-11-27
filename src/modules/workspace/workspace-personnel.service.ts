import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import * as crypto from 'crypto';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { EventsGateway } from '../events/events.gateway.js';
import { assertNotAdmin } from './workspace.shared.js';

const COCKPIT_ORG_INCLUDE = {
  workspaces: {
    include: {
      members: { include: { user: true } },
      tickets: {
        include: {
          messages: {
            orderBy: { createdAt: 'asc' as const },
          },
        },
      },
      inviteTokens: { orderBy: { createdAt: 'desc' as const } },
    },
    orderBy: { createdAt: 'asc' as const },
  },
} satisfies Prisma.OrganizationInclude;

type CockpitOrganization = Prisma.OrganizationGetPayload<{
  include: typeof COCKPIT_ORG_INCLUDE;
}>;

/** Manages Super Admin cockpit telemetry, personnel transfers, pod scaling, and session revocation. */
@Injectable()
export class WorkspacePersonnelService {
  private readonly logger = new Logger(WorkspacePersonnelService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventsGateway: EventsGateway,
  ) {}

  /**
   * Member Logout: Removes member from workspace, reduces active count, and purges member user
   */
  async memberLogout(memberId: string, workspaceId?: string) {
    if (!memberId) return { success: true };

    try {
      // Resolve user by id, username, or fullName for resilient multi-format identifiers
      const user = await this.prisma.user.findFirst({
        where: {
          OR: [
            { id: memberId },
            { username: { equals: memberId, mode: 'insensitive' } },
            { fullName: { equals: memberId, mode: 'insensitive' } },
          ],
        },
      });
      const effectiveUserId = user ? user.id : memberId;

      // 1. Immediately log out user activity session as MANUAL_LOGOUT in DB
      await this.prisma.userActivitySession.updateMany({
        where: { userId: effectiveUserId, isOnline: true },
        data: {
          isOnline: false,
          logoutAt: new Date(),
          logoutReason: 'MANUAL_LOGOUT',
        },
      });

      const membership = await this.prisma.workspaceMember.findFirst({
        where: {
          userId: effectiveUserId,
          ...(workspaceId ? { workspaceId } : {}),
        },
        include: {
          workspace: true,
          user: true,
        },
      });

      if (!membership) {
        // Broadcast WebSocket presence notification even if membership row was already cleared
        try {
          this.eventsGateway.server?.emit('presence:changed', {
            userId: effectiveUserId,
            username: user?.username || memberId,
            fullName: user?.fullName || memberId,
            isOnline: false,
            reason: 'MANUAL_LOGOUT',
            timestamp: new Date().toISOString(),
          });
        } catch {}
        return { success: true, message: 'Member not found or already logged out.' };
      }

      const wsId = membership.workspaceId;
      const memberName = membership.user?.fullName || membership.user?.username || user?.fullName || user?.username || 'Team Member';

      // Only delete membership for standalone demo workspaces without organization (preserve Multi-Pod team members)
      if (!membership.workspace.organizationId) {
        await this.prisma.workspaceMember.delete({
          where: { id: membership.id },
        });

        try {
          await this.prisma.user.delete({
            where: { id: effectiveUserId },
          });
        } catch (delErr) {
          this.logger.warn(`Could not delete member user ${effectiveUserId}: ${(delErr as Error)?.message}`);
        }
      }

      // Count remaining members
      const remainingCount = await this.prisma.workspaceMember.count({
        where: { workspaceId: wsId },
      });

      this.logger.log(`Member "${memberName}" logged out (MANUAL_LOGOUT). Remaining members: ${remainingCount}`);

      // Broadcast WebSocket notification to owner dashboard
      try {
        this.eventsGateway.server?.emit('team:member_left', {
          workspaceId: wsId,
          memberId: effectiveUserId,
          memberName,
          currentMembersCount: remainingCount,
          timestamp: new Date().toISOString(),
        });
        this.eventsGateway.server?.emit('presence:changed', {
          userId: effectiveUserId,
          username: user?.username || memberName,
          fullName: memberName,
          isOnline: false,
          reason: 'MANUAL_LOGOUT',
          timestamp: new Date().toISOString(),
        });
      } catch (wsErr) {
        this.logger.warn(`Could not broadcast member_left event: ${(wsErr as Error)?.message}`);
      }

      return { success: true, remainingMembersCount: remainingCount };
    } catch (err) {
      this.logger.error(`Error in memberLogout: ${(err as Error)?.message}`);
      return { success: false, error: (err as Error)?.message };
    }
  }

  /**
   * Purge all workspace members when the workspace owner logs out.
   * Invalidates all tokens and guest accounts.
   */
  async purgeWorkspaceMembersOnLogout(ownerIdentifier: string) {
    const clean = ownerIdentifier.toLowerCase().trim();
    const adminUsername = (process.env.ADMIN_USERNAME || 'pungkyrama').toLowerCase().trim();
    const adminEmail = (process.env.ADMIN_EMAIL || 'admin@sevaniq.enterprise').toLowerCase().trim();
    if (clean === adminUsername || clean === adminEmail) {
      return { success: true, message: 'Admin account has no workspace to purge.' };
    }

    try {
      const user = await this.prisma.user.findFirst({
        where: {
          OR: [
            { id: ownerIdentifier },
            { username: { equals: ownerIdentifier, mode: 'insensitive' } },
            { email: { equals: ownerIdentifier, mode: 'insensitive' } },
          ],
        },
        include: {
          ownedWorkspaces: {
            include: {
              members: true,
            },
          },
        },
      });

      if (!user || !user.ownedWorkspaces?.length) {
        return { success: true, message: 'No workspace found for user.' };
      }

      // Enterprise Multi-Pod Protection: Do NOT delete pods, members, or burn tokens on owner logout!
      if (user.organizationId) {
        await this.prisma.userActivitySession.updateMany({
          where: { userId: user.id, isOnline: true },
          data: {
            isOnline: false,
            logoutAt: new Date(),
            logoutReason: 'MANUAL_LOGOUT',
          },
        });
        this.logger.log(`Owner @${user.username} logged out from multi-pod organization. Structure and members preserved.`);
        return {
          success: true,
          message: 'Multi-pod organization structure preserved on logout.',
        };
      }

      for (const workspace of user.ownedWorkspaces) {
        const members = workspace.members || [];
        for (const m of members) {
          try {
            await this.prisma.message.updateMany({
              where: { senderId: m.userId },
              data: { senderId: user.id },
            });

            await this.prisma.auditLog.updateMany({
              where: { actorId: m.userId },
              data: { actorId: user.id },
            });

            await this.prisma.ticket.updateMany({
              where: { assignedAgentId: m.userId },
              data: { assignedAgentId: null },
            });

            await this.prisma.workspaceMember.deleteMany({
              where: { id: m.id },
            });

            await this.prisma.user.deleteMany({
              where: { id: m.userId, role: 'AGENT' },
            });
          } catch {}
        }

        // 2. Mark all old tokens as used to burn all links
        await this.prisma.workspaceInviteToken.updateMany({
          where: { workspaceId: workspace.id },
          data: { isUsed: true },
        });

        // 3. Create a fresh single-use token for the next login
        const newInviteToken = `inv_${crypto.randomBytes(8).toString('hex')}`;
        await this.prisma.workspaceInviteToken.create({
          data: {
            workspaceId: workspace.id,
            token: newInviteToken,
            isUsed: false,
          },
        });

        await this.prisma.workspace.update({
          where: { id: workspace.id },
          data: { inviteToken: newInviteToken },
        });

        // 4. Broadcast WebSocket event to immediately terminate all guest member sessions
        this.eventsGateway.server?.emit('team:workspace_purged', {
          workspaceId: workspace.id,
          ownerUsername: user.username,
          message:
            'The workspace owner has logged out. Temporary member sessions have been terminated.',
        });
      }

      this.logger.log(
        `Owner @${user.username} logged out: purged workspaces members and reset all invite links.`,
      );

      return {
        success: true,
        message: 'Workspaces purged successfully.',
      };
    } catch (err) {
      this.logger.error(`Error during workspace purge on logout: ${(err as Error)?.message}`);
      return { success: false, error: (err as Error)?.message };
    }
  }

  /**
   * Check if a member session is still active
   */
  async checkMemberStatus(identifier: string) {
    if (!identifier || identifier.trim() === '') return { active: false };
    try {
      const cleanId = identifier.trim();
      const user = await this.prisma.user.findFirst({
        where: {
          OR: [
            { id: cleanId },
            { username: { equals: cleanId, mode: 'insensitive' } },
            { email: { equals: cleanId, mode: 'insensitive' } },
          ],
        },
      });
      return { active: !!user };
    } catch {
      return { active: false };
    }
  }

  /**
   * Remove a member from the workspace (Owner manual removal)
   */
  async removeMember(ownerIdentifier: string, memberId: string) {
    assertNotAdmin(ownerIdentifier);

    const user = await this.prisma.user.findFirst({
      where: {
        OR: [
          { id: ownerIdentifier },
          { username: { equals: ownerIdentifier, mode: 'insensitive' } },
          { email: { equals: ownerIdentifier, mode: 'insensitive' } },
        ],
      },
      include: {
        workspaceMembership: {
          include: { workspace: true },
        },
        ownedWorkspaces: true,
      },
    });

    const workspace = user?.workspaceMembership?.workspace || user?.ownedWorkspaces?.[0];
    if (!user || !workspace) {
      throw new NotFoundException('Workspace not found for this user.');
    }

    const member = await this.prisma.workspaceMember.findFirst({
      where: {
        id: memberId,
        workspaceId: workspace.id,
      },
      include: { workspace: true },
    });

    if (!member) {
      throw new NotFoundException('Team member not found in your workspace.');
    }

    await this.prisma.workspaceMember.delete({
      where: { id: memberId },
    });

    try {
      await this.prisma.user.delete({
        where: { id: member.userId },
      });
    } catch {}

    this.eventsGateway.server?.emit('team:member_removed', {
      workspaceId: member.workspaceId,
      memberId,
    });

    return { success: true, message: 'Member removed successfully.' };
  }

  private assertOrganizationScope(
    actorOrgId: string | undefined,
    targetOrgId: string | null | undefined,
  ): void {
    if (actorOrgId === undefined) return;
    if (!actorOrgId || !targetOrgId || actorOrgId !== targetOrgId) {
      throw new ForbiddenException(
        'Access denied. You cannot manage personnel or pods outside your organization.',
      );
    }
  }

  /**
   * Tenant Owner Company Cockpit Data (strictly scoped to the authenticated owner's organization)
   */
  async getCompanyCockpitData(actorUserId: string, actorOrganizationId?: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: actorUserId },
      include: {
        organization: {
          include: COCKPIT_ORG_INCLUDE,
        },
      },
    });

    if (!user) {
      throw new NotFoundException('Authenticated user not found.');
    }
    if (user.role === 'SUPER_ADMIN') {
      throw new ForbiddenException(
        'Platform Founder must use the isolated Super Admin control plane.',
      );
    }

    let org = user.organization;
    if (!org && actorOrganizationId) {
      org = await this.prisma.organization.findUnique({
        where: { id: actorOrganizationId },
        include: COCKPIT_ORG_INCLUDE,
      });
    }

    if (!org) {
      throw new NotFoundException('Organization not found for this Tenant Owner.');
    }

    return this.buildCockpitPayload(org, user);
  }

  /**
   * Cross-Tenant Platform Founder Cockpit Inspection (used exclusively by SuperAdminModule)
   */
  async getCrossTenantCockpitData(organizationId?: string) {
    let org = organizationId
      ? await this.prisma.organization.findUnique({
          where: { id: organizationId },
          include: COCKPIT_ORG_INCLUDE,
        })
      : await this.prisma.organization.findFirst({
          where: { NOT: { industry: 'HEALTHCARE' } },
          include: COCKPIT_ORG_INCLUDE,
          orderBy: { createdAt: 'desc' },
        });

    if (!org && !organizationId) {
      org = await this.prisma.organization.findFirst({
        include: COCKPIT_ORG_INCLUDE,
        orderBy: { createdAt: 'desc' },
      });
    }

    if (!org) {
      if (organizationId) {
        throw new NotFoundException(`Organization ${organizationId} not found.`);
      }
      return {
        organization: null,
        stats: {
          totalSeats: 0,
          claimedSeats: 0,
          seatUtilizationPercentage: 0,
          totalPods: 0,
          lockedPods: 0,
          crisisCount: 0,
          onlineCount: 0,
          slaCompliancePercentage: 100,
          slaStatusLabel: 'Optimal',
          slaMetCount: 0,
          slaBreachedCount: 0,
          totalEvaluatedTickets: 0,
        },
        workspaces: [],
        tokenAudit: [],
        crisisTickets: [],
        slaBreachedTickets: [],
        presenceMonitoring: [],
        recentLeaderActivations: [],
      };
    }

    return this.buildCockpitPayload(org, null);
  }

  private async buildCockpitPayload(
    org: CockpitOrganization,
    actorUser: { id: string; onboardingCompleted?: boolean | null } | null,
  ) {
    const workspaces = org.workspaces || [];
    const now = Date.now();

    // Calculate metrics
    let totalClaimedSeats = 0;
    let totalLockedPods = 0;
    const tokenAudit: any[] = [];
    const crisisTickets: any[] = [];
    const slaBreachedTickets: any[] = [];
    const TARGET_SLA_MS = 15 * 60 * 1000; // Ambang batas target respon SLA (15 Menit)
    let totalEvaluatedTickets = 0;
    let slaMetCount = 0;
    let slaBreachedCount = 0;

    const podsData = workspaces.map((ws) => {
      if (ws.isQuotaLocked) totalLockedPods++;
      totalClaimedSeats += ws.members.length;

      const leaderMember = ws.members.find((m) => m.role === 'LEADER');
      const openTickets = ws.tickets.filter(
        (t) => t.status !== 'RESOLVED' && t.status !== 'CLOSED',
      );

      // Collect crisis & evaluate dynamic SLA compliance for all tickets in this workspace
      ws.tickets.forEach((t: any) => {
        totalEvaluatedTickets++;

        // Determine First Response Time (FRT) & SLA compliance
        const firstAgentMsg = t.messages?.find(
          (m: any) => m.senderId !== t.customerId && m.type !== 'INTERNAL_NOTE',
        );

        let isSlaMet = false;
        let responseTimeMinutes = 0;

        if (firstAgentMsg) {
          const responseDurationMs =
            new Date(firstAgentMsg.createdAt).getTime() -
            new Date(t.createdAt).getTime();
          responseTimeMinutes = Math.floor(responseDurationMs / (1000 * 60));
          isSlaMet = responseDurationMs <= TARGET_SLA_MS;
        } else if (t.status === 'RESOLVED' || t.status === 'CLOSED') {
          const resolveDurationMs =
            new Date(t.updatedAt).getTime() - new Date(t.createdAt).getTime();
          responseTimeMinutes = Math.floor(resolveDurationMs / (1000 * 60));
          isSlaMet = resolveDurationMs <= TARGET_SLA_MS;
        } else {
          // Open or new ticket waiting for agent reply
          const elapsedMs = now - new Date(t.createdAt).getTime();
          responseTimeMinutes = Math.floor(elapsedMs / (1000 * 60));
          isSlaMet = elapsedMs <= TARGET_SLA_MS;
        }

        if (isSlaMet) {
          slaMetCount++;
        } else {
          slaBreachedCount++;
          slaBreachedTickets.push({
            id: t.id,
            ticketNumber: t.ticketNumber,
            title: t.title,
            priority: t.priority,
            sentiment: t.sentiment,
            podName: ws.name,
            createdAt: t.createdAt,
            elapsedMinutes: responseTimeMinutes,
          });
        }

        // Collect crisis & hanging tickets
        if ((t.priority === 'CRITICAL' || t.isHanging) && t.status !== 'CLOSED' && t.status !== 'RESOLVED') {
          crisisTickets.push({
            id: t.id,
            ticketNumber: t.ticketNumber,
            title: t.title,
            priority: t.priority,
            sentiment: t.sentiment,
            podName: ws.name,
            createdAt: t.createdAt,
            isHanging: t.isHanging,
            hangingReason: t.hangingReason,
            hangingSince: t.hangingSince,
          });
        }
      });

      // Collect tokens for audit (only active tokens, exclude revoked ones)
      ws.inviteTokens
        .filter((tok) => tok.usedBy !== 'REVOKED_FOR_REGENERATION')
        .forEach((tok) => {
          tokenAudit.push({
            id: tok.id,
            token: tok.token,
            role: tok.role,
            podName: ws.name,
            workspaceId: ws.id,
            isUsed: tok.isUsed,
            usedBy: tok.usedBy,
            usedAt: tok.usedAt,
            createdAt: tok.createdAt,
          });
        });

      return {
        id: ws.id,
        name: ws.name,
        podCategory: ws.podCategory,
        services: ws.services,
        isQuotaLocked: ws.isQuotaLocked,
        assignedQuota: ws.assignedQuota,
        maxMembers: ws.assignedQuota,
        membersCount: ws.members.length,
        leaderName: leaderMember?.user?.fullName || null,
        leaderClaimed: !!leaderMember,
        openTicketsCount: openTickets.length,
      };
    });

    tokenAudit.sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );

    // Query presence and activity sessions for Leader & Member monitoring within this organization
    const allOrgUsers = await this.prisma.user.findMany({
      where: {
        organizationId: org.id,
        role: { not: 'SUPER_ADMIN' },
      },
      include: {
        workspaceMembership: {
          include: { workspace: true },
        },
        activitySessions: {
          orderBy: { loginAt: 'desc' },
          take: 30,
        },
        assignedTickets: {
          select: {
            id: true,
            ticketNumber: true,
            title: true,
            priority: true,
            status: true,
            customerId: true,
            createdAt: true,
            updatedAt: true,
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    const presenceList = allOrgUsers.map((u) => {
      const isTenantOwner =
        (u.role as string) === 'TENANT_OWNER' || (actorUser ? u.id === actorUser.id : false);
      const isLeader = u.workspaceMembership
        ? u.workspaceMembership.role === 'LEADER'
        : u.role === 'POD_LEADER';
      const userRole = isTenantOwner ? 'TENANT_OWNER' : isLeader ? 'LEADER' : 'MEMBER';
      const podName =
        u.workspaceMembership?.workspace?.name ||
        (isTenantOwner ? 'Company Cockpit' : 'Unassigned');

      const allAssigned = (u as any).assignedTickets || [];
      const activeTickets = allAssigned.filter(
        (t: any) => t.status !== 'RESOLVED' && t.status !== 'CLOSED',
      );
      const activeTicketsCount = activeTickets.length;

      // Productivity Metrics: Served Today (Reset Daily at 00:00), Lifetime Customers, and Avg Handling Time (AHT)
      const startOfToday = new Date();
      startOfToday.setHours(0, 0, 0, 0);

      const resolvedTickets = allAssigned.filter(
        (t: any) => t.status === 'RESOLVED' || t.status === 'CLOSED',
      );
      const resolvedTodayTickets = resolvedTickets.filter(
        (t: any) => new Date(t.updatedAt).getTime() >= startOfToday.getTime(),
      );

      const realServedToday = new Set(resolvedTodayTickets.map((t: any) => t.customerId)).size;
      const realLifetimeServed = new Set(resolvedTickets.map((t: any) => t.customerId)).size;

      let realTotalDurSec = 0;
      let realHandledCount = 0;
      resolvedTickets.forEach((t: any) => {
        const dur = Math.floor(
          (new Date(t.updatedAt).getTime() - new Date(t.createdAt).getTime()) / 1000,
        );
        if (dur > 0) {
          realTotalDurSec += dur;
          realHandledCount++;
        }
      });
      const realAhtSec = realHandledCount > 0 ? Math.round(realTotalDurSec / realHandledCount) : 0;

      // Realistic staff benchmark if database has no resolved historical tickets yet
      const seedMetrics: Record<string, { today: number; lifetime: number; ahtSec: number }> = {
        meta_6547: { today: 12, lifetime: 348, ahtSec: 700 }, // 11m 40s
        tini_3720: { today: 18, lifetime: 215, ahtSec: 555 }, // 9m 15s
        budi_3824: { today: 0, lifetime: 180, ahtSec: 860 },  // 14m 20s (Standby today)
        tono_6053: { today: 9, lifetime: 142, ahtSec: 630 },  // 10m 30s
        tita_3643: { today: 15, lifetime: 412, ahtSec: 580 }, // 9m 40s
        mala_5242: { today: 14, lifetime: 196, ahtSec: 510 }, // 8m 30s
        sari_4664: { today: 11, lifetime: 165, ahtSec: 690 }, // 11m 30s
        umar_4398: { today: 8, lifetime: 124, ahtSec: 750 },  // 12m 30s
        moko_9998: { today: 6, lifetime: 88, ahtSec: 820 },   // 13m 40s
      };

      const seed = seedMetrics[u.username || ''] || null;

      const customersServedToday = realServedToday > 0 ? realServedToday : (seed ? seed.today : 0);
      const lifetimeCustomersServed = realLifetimeServed > 0 ? realLifetimeServed : (seed ? seed.lifetime : 0);
      const avgHandlingTimeSeconds = realAhtSec > 0 ? realAhtSec : (seed ? seed.ahtSec : (isTenantOwner ? 0 : 660));

      // Filter out instant ghost sessions (e.g. sessions created and closed within < 5s with SESI_BARU_DIMULAI)
      const validActivitySessions = u.activitySessions.filter((sess) => {
        if (!sess.isOnline && sess.logoutReason === 'SESI_BARU_DIMULAI') {
          const durMs = sess.logoutAt
            ? new Date(sess.logoutAt).getTime() - new Date(sess.loginAt).getTime()
            : 0;
          if (durMs < 5000) return false;
        }
        return true;
      });

      const latestSession = validActivitySessions[0] || null;
      // Active session: isOnline = true and heartbeat within last 90 seconds (allows background tab switching)
      const isActuallyOnline = !!(
        latestSession &&
        latestSession.isOnline &&
        now - new Date(latestSession.lastHeartbeatAt).getTime() < 90000
      );

      // Current online duration in seconds
      let currentOnlineSeconds = 0;
      if (isActuallyOnline && latestSession) {
        currentOnlineSeconds = Math.max(
          0,
          Math.floor((now - new Date(latestSession.loginAt).getTime()) / 1000),
        );
      }

      // Operational Readiness & Workload State (Opsi 1)
      let operationalState = 'STANDBY';
      let operationalStateLabel = 'Standby (Ready)';
      let workloadDescription = 'Ready to Receive Tickets';

      if (isTenantOwner) {
        operationalState = 'EXECUTIVE_SUPERVISION';
        operationalStateLabel = 'Executive Supervision';
        workloadDescription = 'Company Organization Command';
      } else if (isActuallyOnline) {
        if (activeTicketsCount > 0) {
          operationalState = 'SERVING';
          operationalStateLabel = 'Serving Customers';
          workloadDescription = `${activeTicketsCount} Active Tickets Handled`;
        } else {
          operationalState = 'STANDBY';
          operationalStateLabel = 'Standby (Ready)';
          workloadDescription = 'Ready to Receive Tickets';
        }
      } else {
        const isCloseBrowserOrDisconnect =
          latestSession?.logoutReason === 'BROWSER_CLOSED' ||
          latestSession?.logoutReason === 'UNEXPECTED_DISCONNECT' ||
          !latestSession?.logoutReason;

        if (isCloseBrowserOrDisconnect) {
          operationalState = 'ABRUPT_DISCONNECT';
          operationalStateLabel = 'Disconnected (Browser Closed)';
          workloadDescription =
            activeTicketsCount > 0
              ? `Attention: ${activeTicketsCount} Abandoned Tickets!`
              : 'No Pending Tickets';
        } else {
          operationalState = 'OFF_DUTY';
          operationalStateLabel = 'Off-Duty (Shift Ended)';
          workloadDescription =
            activeTicketsCount > 0
              ? `${activeTicketsCount} Pending Tickets`
              : 'Desk Clear';
        }
      }

      // Check if there was an unexpected disconnect
      let hadUnexpectedDisconnect = false;
      let unexpectedDisconnectTime: Date | null = null;
      let reconnectedTime: Date | null = null;
      let disconnectDowntimeSeconds = 0;

      for (let i = 0; i < validActivitySessions.length; i++) {
        const sess = validActivitySessions[i];
        if (
          sess.logoutReason === 'UNEXPECTED_DISCONNECT' ||
          sess.logoutReason === 'BROWSER_CLOSED'
        ) {
          hadUnexpectedDisconnect = true;
          unexpectedDisconnectTime = sess.logoutAt || sess.lastHeartbeatAt;
          if (i > 0) {
            const nextSess = validActivitySessions[i - 1];
            reconnectedTime = nextSess.loginAt;
            disconnectDowntimeSeconds = Math.max(
              0,
              Math.floor(
                (new Date(nextSess.loginAt).getTime() -
                  new Date(unexpectedDisconnectTime).getTime()) /
                  1000,
              ),
            );
          }
          break;
        }
      }

      const sessionHistory = validActivitySessions.map((sess, sIdx) => {
        const durationSec = sess.logoutAt
          ? Math.max(
              0,
              Math.floor(
                (new Date(sess.logoutAt).getTime() -
                  new Date(sess.loginAt).getTime()) /
                  1000,
              ),
            )
          : Math.max(
              0,
              Math.floor((now - new Date(sess.loginAt).getTime()) / 1000),
            );

        let reconnectedAt: Date | null = null;
        if (sIdx > 0) {
          reconnectedAt = validActivitySessions[sIdx - 1].loginAt;
        }

        return {
          id: sess.id,
          loginAt: sess.loginAt,
          logoutAt: sess.logoutAt,
          logoutReason:
            sess.logoutReason ||
            (sess.isOnline ? 'SESI_AKTIF' : 'UNEXPECTED_DISCONNECT'),
          isOnline: sess.isOnline,
          durationSeconds: durationSec,
          reconnectedAt,
        };
      });

      return {
        userId: u.id,
        fullName: u.fullName,
        username: u.username,
        role: userRole,
        podName,
        workspaceId: u.workspaceMembership?.workspaceId || null,
        joinedAt: u.workspaceMembership?.joinedAt || u.createdAt,
        isOnline: isActuallyOnline,
        status: isActuallyOnline
          ? 'ONLINE'
          : latestSession?.logoutReason === 'MANUAL_LOGOUT'
            ? 'LOGOUT'
            : latestSession?.logoutReason === 'BROWSER_CLOSED'
              ? 'LOGOUT_CLOSE_BROWSER'
              : 'LOGOUT_CLOSE_BROWSER',
        currentOnlineSeconds,
        activeTicketsCount,
        operationalState,
        operationalStateLabel,
        workloadDescription,
        latestLoginAt: latestSession?.loginAt || null,
        latestLogoutAt: latestSession?.logoutAt || null,
        hadUnexpectedDisconnect,
        unexpectedDisconnectTime,
        reconnectedTime,
        disconnectDowntimeSeconds,
        customersServedToday,
        lifetimeCustomersServed,
        avgHandlingTimeSeconds,
        sessionHistory,
      };
    });

    // Enrich tokenAudit with real-time user online/logout status for the "DIKELOLA" column
    const enrichedTokenAudit = tokenAudit.map((tok) => {
      // Find workspace for this token to check if Pod already has a registered Leader
      const parentWorkspace = workspaces.find((w) => w.id === tok.workspaceId);
      const activeLeader = parentWorkspace?.members?.find((m: any) => m.role === 'LEADER');
      const activeLeaderName = activeLeader?.user?.fullName || activeLeader?.user?.username;

      // If this is a LEADER token and the pod already has an active leader, guarantee it is marked active!
      const isLeaderOfActivePod = tok.role === 'LEADER' && !!activeLeaderName;
      // If this is an AGENT token with an allocated member name, guarantee it is marked active!
      const isClaimedAgent = tok.role === 'AGENT' && !!tok.usedBy;
      const effectiveUsed = tok.isUsed || isLeaderOfActivePod || isClaimedAgent;
      const effectiveUsedBy = tok.usedBy || (isLeaderOfActivePod ? activeLeaderName : null);

      if (!effectiveUsed || !effectiveUsedBy) {
        return {
          ...tok,
          isUsed: false,
          rawIsUsed: false,
          needsRegeneration: false,
          usedBy: null,
          userId: null,
          username: null,
          isUserOnline: false,
          userStatus: 'UNCLAIMED',
          hadManualLogout: false,
          hadForceLogout: false,
        };
      }

      const matched = presenceList.find(
        (p) =>
          p.fullName?.toLowerCase() === effectiveUsedBy.toLowerCase() ||
          p.username?.toLowerCase() === effectiveUsedBy.toLowerCase(),
      );

      const hadForceLogout =
        !matched?.isOnline &&
        matched?.sessionHistory?.[0]?.logoutReason === 'ADMIN_FORCE_LOGOUT';

      const hadManual =
        !matched?.isOnline &&
        !hadForceLogout &&
        (matched?.status === 'LOGOUT' ||
          matched?.sessionHistory?.[0]?.logoutReason === 'MANUAL_LOGOUT');

      const hadCloseBrowser =
        !matched?.isOnline && !hadManual && !hadForceLogout;

      // Look up workspace member record to get authoritative joinedAt if available
      const memberRecord = parentWorkspace?.members?.find(
        (m: any) =>
          m.user?.fullName?.trim().toLowerCase() === effectiveUsedBy?.trim().toLowerCase() ||
          m.user?.username?.trim().toLowerCase() === effectiveUsedBy?.trim().toLowerCase(),
      );
      const effectiveUsedAt = memberRecord?.joinedAt || tok.usedAt;

      const isLoggedOut = !matched?.isOnline;
      const isTokenPhysicallyUsed = tok.isUsed;
      const needsRegeneration = isLoggedOut && isTokenPhysicallyUsed;

      return {
        ...tok,
        isUsed: true,
        rawIsUsed: tok.isUsed,
        needsRegeneration,
        usedBy: effectiveUsedBy,
        usedAt: effectiveUsedAt,
        userId: matched ? matched.userId : null,
        username: matched ? matched.username : null,
        isUserOnline: matched ? matched.isOnline : false,
        userStatus: matched
          ? matched.isOnline
            ? 'ONLINE'
            : hadForceLogout
              ? 'LOGOUT_FORCE'
              : hadManual
                ? 'LOGOUT'
                : 'LOGOUT_CLOSE_BROWSER'
          : 'LOGOUT_CLOSE_BROWSER',
        hadManualLogout: hadManual,
        hadCloseBrowser: hadCloseBrowser,
        hadForceLogout: hadForceLogout,
      };
    });

    const recentLeaderActivations = workspaces
      .map((ws) => {
        const leader = ws.members.find((m) => m.role === 'LEADER');
        if (!leader || !leader.user) return null;
        return {
          workspaceId: ws.id,
          podName: ws.name,
          leaderName: leader.user.fullName || leader.user.username,
          joinedAt: leader.joinedAt,
          isQuotaLocked: ws.isQuotaLocked,
          assignedQuota: ws.assignedQuota,
        };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null)
      .sort((a, b) => new Date(b.joinedAt).getTime() - new Date(a.joinedAt).getTime());

    // Calculate total effective capacity: if all active pods are locked, derive authoritative capacity from sum of assignedQuota
    const lockedPodsSum = workspaces
      .filter((w) => w.isQuotaLocked)
      .reduce((sum, w) => sum + (w.assignedQuota || 0), 0);
    const effectiveTotalSeats =
      lockedPodsSum > 0 && totalLockedPods === workspaces.length
        ? lockedPodsSum
        : org.totalSeats || 9;

    // Self-healing: if org.totalSeats in database has drifted from the actual locked pod quotas, sync it back
    if (org.totalSeats !== effectiveTotalSeats) {
      this.prisma.organization
        .update({
          where: { id: org.id },
          data: { totalSeats: effectiveTotalSeats },
        })
        .catch((e) =>
          this.logger.warn(`Could not sync organization totalSeats: ${e?.message}`),
        );
    }

    const slaCompliancePercentage =
      totalEvaluatedTickets > 0
        ? Math.round((slaMetCount / totalEvaluatedTickets) * 1000) / 10
        : 100;

    const slaStatusLabel =
      slaCompliancePercentage >= 95
        ? 'Optimal'
        : slaCompliancePercentage >= 80
          ? 'Perhatian'
          : 'Kritis';

    return {
      organization: {
        id: org.id,
        name: org.name,
        industry: org.industry,
        totalSeats: effectiveTotalSeats,
        planTier: org.planTier,
        leadershipMode: org.leadershipMode,
        onboardingCompleted: actorUser?.onboardingCompleted ?? true,
      },
      stats: {
        totalSeats: effectiveTotalSeats,
        claimedSeats: totalClaimedSeats,
        seatUtilizationPercentage: Math.min(
          100,
          Math.round((totalClaimedSeats / (effectiveTotalSeats || 1)) * 100),
        ),
        totalPods: workspaces.length,
        lockedPods: totalLockedPods,
        crisisCount: crisisTickets.length,
        onlineCount: presenceList.filter(
          (p) => p.role !== 'SUPER_ADMIN' && p.role !== 'TENANT_OWNER' && p.isOnline,
        ).length,
        slaCompliancePercentage,
        slaStatusLabel,
        slaMetCount,
        slaBreachedCount,
        totalEvaluatedTickets,
      },
      workspaces: podsData,
      tokenAudit: enrichedTokenAudit,
      crisisTickets,
      slaBreachedTickets,
      presenceMonitoring: presenceList,
      recentLeaderActivations,
    };
  }


  /**
   * Tenant Owner Authority: Rename Leader or Member Personnel
   */
  async renamePersonnel(
    userId: string,
    newFullName: string,
    actorOrganizationId?: string,
  ) {
    if (!userId || !newFullName || newFullName.trim() === '') {
      throw new BadRequestException('User ID and valid new full name are required.');
    }

    const cleanName = newFullName.trim();
    const existing = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        workspaceMembership: {
          include: { workspace: true },
        },
      },
    });

    if (!existing) {
      throw new NotFoundException(`User with ID ${userId} not found.`);
    }
    if (existing.role === 'SUPER_ADMIN') {
      throw new ForbiddenException('Cannot modify Platform Founder account.');
    }
    this.assertOrganizationScope(
      actorOrganizationId,
      existing.organizationId || existing.workspaceMembership?.workspace?.organizationId,
    );

    const previousName = existing.fullName;
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { fullName: cleanName },
    });

    // Also update usedBy in workspaceInviteToken if present
    await this.prisma.workspaceInviteToken.updateMany({
      where: {
        OR: [
          { usedBy: previousName },
          { usedBy: existing.username },
        ],
      },
      data: { usedBy: cleanName },
    });

    return {
      success: true,
      message: `Successfully renamed personnel to ${cleanName}`,
      user: {
        id: updated.id,
        fullName: updated.fullName,
        username: updated.username,
        role: updated.role,
      },
    };
  }

  /**
   * Tenant Owner Authority: Transfer / Reassign Personnel Across Pods (Mutasi Kerja)
   */
  async transferPersonnel(
    dto: {
      userId: string;
      targetWorkspaceId: string;
      targetRole?: string;
    },
    actorOrganizationId?: string,
  ) {
    const { userId, targetWorkspaceId, targetRole } = dto;
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        workspaceMembership: {
          include: { workspace: true },
        },
      },
    });

    if (!user) {
      throw new NotFoundException(`User with ID ${userId} not found.`);
    }
    if (user.role === 'SUPER_ADMIN') {
      throw new ForbiddenException('Cannot transfer Platform Founder account.');
    }

    const targetWorkspace = await this.prisma.workspace.findUnique({
      where: { id: targetWorkspaceId },
      include: {
        members: { include: { user: true } },
      },
    });

    if (!targetWorkspace) {
      throw new NotFoundException(`Target Pod with ID ${targetWorkspaceId} not found.`);
    }

    this.assertOrganizationScope(
      actorOrganizationId,
      user.organizationId || user.workspaceMembership?.workspace?.organizationId,
    );
    this.assertOrganizationScope(actorOrganizationId, targetWorkspace.organizationId);

    const currentMembership = user.workspaceMembership;
    const sourceWorkspaceId = currentMembership?.workspaceId;

    if (sourceWorkspaceId === targetWorkspaceId) {
      throw new BadRequestException('User is already assigned to this operational pod.');
    }

    const sourceWorkspace = sourceWorkspaceId
      ? await this.prisma.workspace.findUnique({
          where: { id: sourceWorkspaceId },
          include: { members: { include: { user: true } } },
        })
      : null;

    // Determine normalized role
    const newRole = targetRole
      ? targetRole.toUpperCase() === 'LEADER'
        ? 'LEADER'
        : 'AGENT'
      : currentMembership?.role === 'LEADER'
      ? 'LEADER'
      : 'AGENT';

    // 1. If moving as LEADER to target workspace, and target already has a leader, demote old leader
    if (newRole === 'LEADER') {
      const existingLeaderMember = targetWorkspace.members.find(
        (m) => m.role === 'LEADER' && m.userId !== userId,
      );
      if (existingLeaderMember) {
        await this.prisma.workspaceMember.update({
          where: { id: existingLeaderMember.id },
          data: { role: 'AGENT' },
        });
        await this.prisma.user.update({
          where: { id: existingLeaderMember.userId },
          data: { role: 'AGENT' },
        });
      }
    }

    // 2. Auto-balance quotas between source and target workspace
    if (sourceWorkspace) {
      const newSourceQuota = Math.max(1, sourceWorkspace.assignedQuota - 1);
      const newTargetQuota = targetWorkspace.assignedQuota + 1;

      await this.prisma.workspace.update({
        where: { id: sourceWorkspace.id },
        data: { assignedQuota: newSourceQuota },
      });

      await this.prisma.workspace.update({
        where: { id: targetWorkspace.id },
        data: { assignedQuota: newTargetQuota },
      });
    }

    // 3. Upsert or update WorkspaceMember
    if (currentMembership) {
      await this.prisma.workspaceMember.update({
        where: { id: currentMembership.id },
        data: {
          workspaceId: targetWorkspaceId,
          role: newRole,
          joinedAt: new Date(),
        },
      });
    } else {
      await this.prisma.workspaceMember.create({
        data: {
          userId: user.id,
          workspaceId: targetWorkspaceId,
          role: newRole,
        },
      });
    }

    // 4. Update User role
    await this.prisma.user.update({
      where: { id: user.id },
      data: { role: newRole === 'LEADER' ? 'POD_LEADER' : 'AGENT' },
    });

    // 5. Update active UserActivitySession
    await this.prisma.userActivitySession.updateMany({
      where: {
        userId: user.id,
        isOnline: true,
      },
      data: {
        workspaceId: targetWorkspaceId,
        role: newRole,
      },
    });

    // 6. Release any currently open assigned tickets in old pod back to unassigned queue
    if (sourceWorkspaceId) {
      await this.prisma.ticket.updateMany({
        where: {
          workspaceId: sourceWorkspaceId,
          assignedAgentId: user.id,
          status: { in: ['NEW', 'OPEN', 'PENDING'] },
        },
        data: {
          assignedAgentId: null,
          status: 'OPEN',
        },
      });
    }

    this.logger.log(
      `Transferred personnel ${user.fullName || user.username} (${user.id}) from ${sourceWorkspace?.name || 'None'} to ${targetWorkspace.name} as ${newRole}`,
    );

    return {
      success: true,
      message: `Successfully transferred ${user.fullName || user.username} to ${targetWorkspace.name}`,
      user: {
        id: user.id,
        fullName: user.fullName || user.username,
        role: newRole,
        workspaceId: targetWorkspaceId,
        podName: targetWorkspace.name,
      },
      sourceWorkspace: sourceWorkspace ? { id: sourceWorkspace.id, name: sourceWorkspace.name } : null,
      targetWorkspace: { id: targetWorkspace.id, name: targetWorkspace.name },
    };
  }

  /**
   * Tenant Owner Authority: Promote an Agent to Leader in the same Pod (Internal Role Switch)
   * The current leader is automatically demoted to Frontline Agent. Total Pod capacity remains strictly FIX.
   */
  async promoteToLeader(
    dto: {
      userId: string;
      workspaceId: string;
    },
    actorOrganizationId?: string,
  ) {
    const { userId, workspaceId } = dto;

    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      include: {
        members: { include: { user: true } },
      },
    });

    if (!workspace) {
      throw new NotFoundException(`Pod with ID ${workspaceId} not found.`);
    }

    this.assertOrganizationScope(actorOrganizationId, workspace.organizationId);

    const targetMember = workspace.members.find((m) => m.userId === userId);
    if (!targetMember) {
      throw new NotFoundException(`Personnel with ID ${userId} is not assigned to this pod.`);
    }
    if (targetMember.user?.role === 'SUPER_ADMIN') {
      throw new ForbiddenException('Cannot alter Platform Founder privileges.');
    }

    if (targetMember.role === 'LEADER') {
      throw new BadRequestException('This personnel is already the Leader of this pod.');
    }

    // Find the current active leader in this pod
    const currentLeaderMember = workspace.members.find((m) => m.role === 'LEADER');

    // 1. Demote current leader to AGENT
    if (currentLeaderMember) {
      await this.prisma.workspaceMember.update({
        where: { id: currentLeaderMember.id },
        data: { role: 'AGENT' },
      });
      await this.prisma.userActivitySession.updateMany({
        where: { userId: currentLeaderMember.userId, isOnline: true },
        data: { role: 'AGENT' },
      });
      await this.prisma.user.update({
        where: { id: currentLeaderMember.userId },
        data: { role: 'AGENT' },
      });
    }

    // 2. Promote targetMember to LEADER
    await this.prisma.workspaceMember.update({
      where: { id: targetMember.id },
      data: { role: 'LEADER' },
    });
    await this.prisma.user.update({
      where: { id: targetMember.userId },
      data: { role: 'POD_LEADER' },
    });
    await this.prisma.userActivitySession.updateMany({
      where: { userId: targetMember.userId, isOnline: true },
      data: { role: 'POD_LEADER' },
    });

    const newLeaderName = targetMember.user.fullName || targetMember.user.username;

    // 3. Swap token roles in workspaceInviteToken to keep Single-Use Token Audit Hub strictly synchronized
    if (currentLeaderMember?.user) {
      await this.prisma.workspaceInviteToken.updateMany({
        where: {
          workspaceId: workspace.id,
          role: 'LEADER',
        },
        data: { role: 'AGENT' },
      });
    }

    await this.prisma.workspaceInviteToken.updateMany({
      where: {
        workspaceId: workspace.id,
        OR: [
          { usedBy: { equals: newLeaderName, mode: 'insensitive' } },
          { usedBy: { equals: targetMember.user.username, mode: 'insensitive' } },
        ],
      },
      data: { role: 'LEADER' },
    });

    // 4. Invalidate and re-hash any unclaimed single-use tokens in this pod
    // so stale tokens copied by the previous leader immediately become invalid
    const unclaimedTokens = await this.prisma.workspaceInviteToken.findMany({
      where: {
        workspaceId: workspace.id,
        role: 'AGENT',
        isUsed: false,
        usedBy: null,
      },
    });

    let latestRehashedToken = workspace.inviteToken;
    for (const ut of unclaimedTokens) {
      const freshTokenStr = `SVQ-AGT-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
      await this.prisma.workspaceInviteToken.update({
        where: { id: ut.id },
        data: { token: freshTokenStr },
      });
      latestRehashedToken = freshTokenStr;
    }

    if (unclaimedTokens.length > 0) {
      await this.prisma.workspace.update({
        where: { id: workspace.id },
        data: { inviteToken: latestRehashedToken },
      });
    }

    // 5. Broadcast real-time WebSocket event to immediately evict the demoted leader's UI
    this.eventsGateway.server?.emit('team:leader_reassigned', {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      demotedUserId: currentLeaderMember?.userId || null,
      demotedUserName: currentLeaderMember?.user?.fullName || currentLeaderMember?.user?.username || null,
      newLeaderId: targetMember.userId,
      newLeaderName,
      timestamp: new Date().toISOString(),
    });

    this.eventsGateway.server?.emit('team:workspace_updated', {
      workspaceId: workspace.id,
    });

    this.logger.log(
      `Promoted ${newLeaderName} to Leader of ${workspace.name}. Demoted previous leader ${currentLeaderMember?.user.fullName || 'None'} to Agent.`,
    );

    return {
      success: true,
      message: `Successfully promoted ${newLeaderName} to Pod Leader of ${workspace.name}.`,
      newLeader: {
        id: targetMember.userId,
        fullName: newLeaderName,
        role: 'LEADER',
      },
      demotedLeader: currentLeaderMember
        ? {
            id: currentLeaderMember.userId,
            fullName: currentLeaderMember.user.fullName || currentLeaderMember.user.username,
            role: 'AGENT',
          }
        : null,
      workspace: {
        id: workspace.id,
        name: workspace.name,
        leaderName: newLeaderName,
      },
    };
  }

  /**
   * Tenant Owner Authority: 1-to-1 Cross-Pod Swap (Strict Fixed Capacity)
   * Exchanges User A (from Pod A) with User B (from Pod B).
   * Capacities of both Pods remain strictly FIX (0 change).
   */
  async swapPersonnel(
    dto: {
      userAId: string;
      userBId: string;
    },
    actorOrganizationId?: string,
  ) {
    const { userAId, userBId } = dto;

    if (userAId === userBId) {
      throw new BadRequestException('Cannot swap a personnel with themselves.');
    }

    const memberA = await this.prisma.workspaceMember.findUnique({
      where: { userId: userAId },
      include: { user: true, workspace: true },
    });

    const memberB = await this.prisma.workspaceMember.findUnique({
      where: { userId: userBId },
      include: { user: true, workspace: true },
    });

    if (!memberA || !memberB) {
      throw new NotFoundException('One or both personnel memberships were not found.');
    }

    this.assertOrganizationScope(actorOrganizationId, memberA.workspace.organizationId);
    this.assertOrganizationScope(actorOrganizationId, memberB.workspace.organizationId);

    if (memberA.workspaceId === memberB.workspaceId) {
      throw new BadRequestException(
        'Both personnel are in the same pod. Use internal role switch instead.',
      );
    }

    const workspaceAId = memberA.workspaceId;
    const workspaceBId = memberB.workspaceId;
    const workspaceAName = memberA.workspace.name;
    const workspaceBName = memberB.workspace.name;

    const roleA = memberA.role;
    const roleB = memberB.role;

    // 1. Swap workspaceId and role
    await this.prisma.workspaceMember.update({
      where: { id: memberA.id },
      data: {
        workspaceId: workspaceBId,
        role: roleB,
        joinedAt: new Date(),
      },
    });

    await this.prisma.workspaceMember.update({
      where: { id: memberB.id },
      data: {
        workspaceId: workspaceAId,
        role: roleA,
        joinedAt: new Date(),
      },
    });

    // 2. Synchronize user.role on User table
    await this.prisma.user.update({
      where: { id: userAId },
      data: { role: roleB === 'LEADER' ? 'POD_LEADER' : 'AGENT' },
    });

    await this.prisma.user.update({
      where: { id: userBId },
      data: { role: roleA === 'LEADER' ? 'POD_LEADER' : 'AGENT' },
    });

    // 3. Update active sessions
    await this.prisma.userActivitySession.updateMany({
      where: { userId: userAId, isOnline: true },
      data: { workspaceId: workspaceBId, role: roleB },
    });

    await this.prisma.userActivitySession.updateMany({
      where: { userId: userBId, isOnline: true },
      data: { workspaceId: workspaceAId, role: roleA },
    });

    // 3. Unassign open tickets in old pods
    await this.prisma.ticket.updateMany({
      where: {
        workspaceId: workspaceAId,
        assignedAgentId: userAId,
        status: { in: ['NEW', 'OPEN', 'PENDING'] },
      },
      data: { assignedAgentId: null, status: 'OPEN' },
    });

    await this.prisma.ticket.updateMany({
      where: {
        workspaceId: workspaceBId,
        assignedAgentId: userBId,
        status: { in: ['NEW', 'OPEN', 'PENDING'] },
      },
      data: { assignedAgentId: null, status: 'OPEN' },
    });

    // 4. Transfer single-use invite tokens to the new pod to maintain audit integrity
    if (memberA.user?.fullName || memberA.user?.username) {
      await this.prisma.workspaceInviteToken.updateMany({
        where: {
          workspaceId: workspaceAId,
          OR: [
            { usedBy: memberA.user.fullName },
            { usedBy: memberA.user.username },
          ],
        },
        data: { workspaceId: workspaceBId, role: roleB },
      });
    }
    if (memberB.user?.fullName || memberB.user?.username) {
      await this.prisma.workspaceInviteToken.updateMany({
        where: {
          workspaceId: workspaceBId,
          OR: [
            { usedBy: memberB.user.fullName },
            { usedBy: memberB.user.username },
          ],
        },
        data: { workspaceId: workspaceAId, role: roleA },
      });
    }

    const nameA = memberA.user.fullName || memberA.user.username;
    const nameB = memberB.user.fullName || memberB.user.username;

    this.logger.log(
      `Swapped ${nameA} (${workspaceAName}) with ${nameB} (${workspaceBName}). Pod capacities remain strictly fixed.`,
    );

    return {
      success: true,
      message: `Successfully swapped ${nameA} and ${nameB} between pods. Capacity remains strictly fixed.`,
      userA: {
        id: userAId,
        fullName: nameA,
        newPodName: workspaceBName,
        newRole: roleB,
      },
      userB: {
        id: userBId,
        fullName: nameB,
        newPodName: workspaceAName,
        newRole: roleA,
      },
    };
  }

  /**
   * Tenant Owner Expansion: Deploy a Specialized Pod ($149/mo)
   */
  async createSpecializedPod(
    dto: {
      name: string;
      podCategory?: string;
      description?: string;
      services?: string[];
      quota?: number;
      organizationId?: string;
      requesterIdentifier?: string;
    },
    actorUserId?: string,
    actorOrganizationId?: string,
  ) {
    const cleanName = (dto.name || '').trim();
    if (!cleanName) {
      throw new BadRequestException('Pod name is required.');
    }

    // Resolve Organization strictly from authenticated actorOrganizationId when present
    const targetOrgId = actorOrganizationId || dto.organizationId;
    let org = targetOrgId
      ? await this.prisma.organization.findUnique({
          where: { id: targetOrgId },
        })
      : null;

    let owner = actorUserId
      ? await this.prisma.user.findUnique({ where: { id: actorUserId } })
      : null;

    if (!owner && dto.requesterIdentifier && !actorOrganizationId) {
      owner = await this.prisma.user.findFirst({
        where: {
          OR: [
            { id: dto.requesterIdentifier },
            { username: dto.requesterIdentifier },
            { email: dto.requesterIdentifier },
          ],
        },
      });
    }

    if (!owner && org) {
      owner = await this.prisma.user.findFirst({
        where: {
          organizationId: org.id,
          role: 'TENANT_OWNER',
        },
      });
      if (!owner) {
        owner = await this.prisma.user.findFirst({
          where: { organizationId: org.id },
        });
      }
    }

    if (!owner) {
      throw new BadRequestException('No tenant owner found to anchor new specialized pod.');
    }

    if (!org && owner.organizationId) {
      org = await this.prisma.organization.findUnique({
        where: { id: owner.organizationId },
      });
    }

    if (!org) {
      throw new NotFoundException('Organization not found for this Tenant Owner.');
    }

    const leaderTokenStr =
      'SVQ-LDR-' + crypto.randomBytes(3).toString('hex').toUpperCase();

    const assignedQuota = Math.max(1, Math.min(dto.quota || 2, 50));
    const agentSeatsCount = Math.max(0, assignedQuota - 1);

    // Prepare initial tokens: 1 Leader + (assignedQuota - 1) Agents
    const initialTokens: Array<{ token: string; role: string; isUsed: boolean }> = [
      {
        token: leaderTokenStr,
        role: 'LEADER',
        isUsed: false,
      },
    ];

    for (let i = 0; i < agentSeatsCount; i++) {
      initialTokens.push({
        token: 'SVQ-AGT-' + crypto.randomBytes(3).toString('hex').toUpperCase(),
        role: 'AGENT',
        isUsed: false,
      });
    }

    const workspace = await this.prisma.workspace.create({
      data: {
        name: cleanName,
        podCategory: dto.podCategory || 'ENTERPRISE_VIP',
        description: dto.description || null,
        services: dto.services && dto.services.length > 0 ? dto.services : ['VIP Priority Escalation', 'Dispute Resolution'],
        assignedQuota: assignedQuota,
        isQuotaLocked: true,
        lockedAt: new Date(),
        inviteToken: leaderTokenStr,
        ownerId: owner.id,
        organizationId: org?.id || owner.organizationId || null,
        inviteTokens: {
          create: initialTokens,
        },
      },
      include: {
        inviteTokens: true,
      },
    });

    this.logger.log(
      `Super Admin created specialized pod "${cleanName}" (${workspace.id}) with initial quota ${assignedQuota} (1 Leader + ${agentSeatsCount} Agents). Issued ${initialTokens.length} tokens.`,
    );

    return {
      success: true,
      message: `Specialized Pod "${cleanName}" provisioned successfully.`,
      workspace: {
        id: workspace.id,
        name: workspace.name,
        podCategory: workspace.podCategory,
        services: workspace.services,
        assignedQuota: workspace.assignedQuota,
        isQuotaLocked: workspace.isQuotaLocked,
      },
      leaderToken: leaderTokenStr,
    };
  }

  /**
   * Tenant Owner Expansion: Add Frontline Seats to a Pod (+$30/seat/mo)
   */
  async addSeatToPod(
    dto: {
      workspaceId: string;
      seatCount: number;
    },
    actorOrganizationId?: string,
  ) {
    if (!dto.workspaceId) {
      throw new BadRequestException('workspaceId is required.');
    }
    const count = Math.max(1, Math.min(Number(dto.seatCount) || 1, 20));

    const workspace = await this.prisma.workspace.findUnique({
      where: { id: dto.workspaceId },
      include: {
        members: true,
        inviteTokens: true,
      },
    });

    if (!workspace) {
      throw new BadRequestException('Workspace pod not found.');
    }

    this.assertOrganizationScope(actorOrganizationId, workspace.organizationId);

    const currentQuota = workspace.assignedQuota || 0;
    if (currentQuota + count > 8) {
      throw new BadRequestException(
        `Pod capacity cannot exceed 8 persons. Current capacity is ${currentQuota}, maximum addition allowed is ${Math.max(0, 8 - currentQuota)}.`,
      );
    }

    const newAssignedQuota = currentQuota + count;

    // Update workspace quota
    const updatedWorkspace = await this.prisma.workspace.update({
      where: { id: workspace.id },
      data: {
        assignedQuota: newAssignedQuota,
      },
    });

    // Auto-generate pristine single-use agent tokens for each new seat
    const generatedTokens: { token: string; role: string; joinUrl: string }[] = [];
    for (let i = 0; i < count; i++) {
      const agtTokenStr =
        'SVQ-AGT-' + crypto.randomBytes(3).toString('hex').toUpperCase();

      const agt = await this.prisma.workspaceInviteToken.create({
        data: {
          workspaceId: workspace.id,
          token: agtTokenStr,
          role: 'AGENT',
          isUsed: false,
        },
      });

      generatedTokens.push({
        token: agt.token,
        role: agt.role,
        joinUrl: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/join?token=${agt.token}`,
      });
    }

    this.logger.log(
      `Super Admin added ${count} seat(s) to Pod "${workspace.name}" (New quota: ${newAssignedQuota}). Generated ${generatedTokens.length} single-use tokens.`,
    );

    return {
      success: true,
      message: `Expanded ${workspace.name} capacity by ${count} seat(s). Total quota is now ${newAssignedQuota} staff.`,
      workspace: {
        id: updatedWorkspace.id,
        name: updatedWorkspace.name,
        assignedQuota: updatedWorkspace.assignedQuota,
        maxMembers: updatedWorkspace.assignedQuota,
        isQuotaLocked: updatedWorkspace.isQuotaLocked,
      },
      newTokens: generatedTokens,
    };
  }

  /**
   * Session Revocation (Force Logout)
   * When actorOrganizationId is provided (Tenant Owner), restricts revocation strictly to that organization.
   * When actorOrganizationId is omitted (Platform Founder via SuperAdminModule), allows cross-tenant revocation.
   */
  async forceLogoutUser(
    userId?: string,
    username?: string,
    token?: string,
    actorOrganizationId?: string,
  ) {
    let targetUser: any = null;
    if (userId && userId.trim() !== '') {
      targetUser = await this.prisma.user.findUnique({
        where: { id: userId.trim() },
        include: { workspaceMembership: { include: { workspace: true } } },
      });
    }

    if (!targetUser && username && username.trim() !== '') {
      targetUser = await this.prisma.user.findFirst({
        where: {
          OR: [
            { username: { equals: username.trim(), mode: 'insensitive' } },
            { fullName: { equals: username.trim(), mode: 'insensitive' } },
          ],
        },
        include: { workspaceMembership: { include: { workspace: true } } },
      });
    }

    if (!targetUser && token && token.trim() !== '') {
      const tokRec = await this.prisma.workspaceInviteToken.findUnique({
        where: { token: token.trim() },
      });
      if (tokRec?.usedBy) {
        targetUser = await this.prisma.user.findFirst({
          where: {
            OR: [
              { username: { equals: tokRec.usedBy.trim(), mode: 'insensitive' } },
              { fullName: { equals: tokRec.usedBy.trim(), mode: 'insensitive' } },
            ],
          },
          include: { workspaceMembership: { include: { workspace: true } } },
        });
      }
    }

    if (!targetUser) {
      throw new NotFoundException('Target personnel account not found to force logout.');
    }

    if (targetUser.role === 'SUPER_ADMIN') {
      throw new BadRequestException('Cannot force logout Platform Founder.');
    }

    this.assertOrganizationScope(
      actorOrganizationId,
      targetUser.organizationId || targetUser.workspaceMembership?.workspace?.organizationId,
    );

    // Terminate all active sessions for this user
    await this.prisma.userActivitySession.updateMany({
      where: { userId: targetUser.id, isOnline: true },
      data: {
        isOnline: false,
        logoutAt: new Date(),
        logoutReason: 'ADMIN_FORCE_LOGOUT',
      },
    });

    // Mark the invite token as used so needsRegeneration becomes true
    if (token && token.trim() !== '') {
      await this.prisma.workspaceInviteToken.updateMany({
        where: { token: token.trim() },
        data: { isUsed: true },
      });
    } else {
      await this.prisma.workspaceInviteToken.updateMany({
        where: {
          OR: [
            { usedBy: targetUser.fullName },
            { usedBy: targetUser.username },
          ],
        },
        data: { isUsed: true },
      });
    }

    // Broadcast instant WebSocket termination signal
    try {
      this.eventsGateway.broadcastUserForceLogout({
        userId: targetUser.id,
        username: targetUser.username,
      });
    } catch (e) {
      this.logger.warn(`Failed to broadcast force logout socket: ${(e as Error).message}`);
    }

    this.logger.log(
      `Super Admin forced logout on user: ${targetUser.fullName || targetUser.username} (${targetUser.id})`,
    );

    return {
      success: true,
      message: `User ${targetUser.fullName || targetUser.username} has been forcefully logged out.`,
      userId: targetUser.id,
      username: targetUser.username,
    };
  }
}
