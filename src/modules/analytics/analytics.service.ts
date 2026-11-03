import { Injectable, ForbiddenException, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

export interface OwnerAnalyticsResponse {
  summary: {
    totalUsers: number;
    totalWorkspaces: number;
    totalActiveMembers: number;
    totalTickets: number;
    emailVerifiedCount: number;
    phoneVerifiedCount: number;
    completedOnboardingCount: number;
    onboardingRate: number;
  };
  capacityDistribution: {
    capacity: number;
    count: number;
    percentage: number;
    label: string;
  }[];
  growthTrend: {
    date: string;
    dayLabel: string;
    signups: number;
    activeWorkspaces: number;
  }[];
  usersDirectory: {
    id: string;
    username: string;
    fullName: string;
    email: string;
    phone: string | null;
    role: string;
    verificationMethod: string;
    onboardingCompleted: boolean;
    createdAt: string;
    workspace?: {
      id: string;
      name: string;
      maxMembers: number;
      currentMembersCount: number;
      remainingSeats: number;
      totalTokensGenerated: number;
    } | null;
  }[];
}

@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Asserts that the requester is Master Admin (@pungkyrama)
   */
  assertAdmin(identifier?: string) {
    const clean = identifier?.toLowerCase().trim();
    if (clean !== 'pungkyrama' && clean !== 'admin@sentrix.enterprise') {
      throw new ForbiddenException(
        'Access denied. Owner Analytics & Marketing Dashboard is restricted exclusively to Platform Founder (@pungkyrama).',
      );
    }
  }

  async getOwnerDashboardData(identifier?: string): Promise<OwnerAnalyticsResponse> {
    this.assertAdmin(identifier);

    // 1. Fetch Users excluding master admin
    const nonAdminUsers = await this.prisma.user.findMany({
      where: {
        NOT: { username: 'pungkyrama' },
      },
      include: {
        ownedWorkspaces: {
          include: {
            members: true,
            inviteTokens: true,
          },
        },
        workspaceMembership: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    const totalUsers = nonAdminUsers.length;
    const emailVerifiedCount = nonAdminUsers.filter(
      (u) => (u.verificationMethod || 'EMAIL').toUpperCase() === 'EMAIL',
    ).length;
    const phoneVerifiedCount = nonAdminUsers.filter(
      (u) => (u.verificationMethod || '').toUpperCase() === 'PHONE',
    ).length;
    const completedOnboardingCount = nonAdminUsers.filter((u) => u.onboardingCompleted).length;
    const onboardingRate =
      totalUsers > 0 ? Math.round((completedOnboardingCount / totalUsers) * 100) : 100;

    // 2. Workspaces & Members Metrics
    const workspaces = await this.prisma.workspace.findMany({
      include: {
        members: true,
        inviteTokens: true,
      },
    });

    const totalWorkspaces = workspaces.length;
    const totalActiveMembers = await this.prisma.workspaceMember.count();
    const totalTickets = await this.prisma.ticket.count();

    // 3. Capacity Distribution (1 to 8 members)
    const capacityCounts: Record<number, number> = {
      1: 0,
      2: 0,
      3: 0,
      4: 0,
      5: 0,
      6: 0,
      7: 0,
      8: 0,
    };

    workspaces.forEach((ws) => {
      const cap = ws.maxMembers || 8;
      if (capacityCounts[cap] !== undefined) {
        capacityCounts[cap]++;
      }
    });

    const capacityDistribution = [1, 2, 3, 4, 5, 6, 7, 8].map((cap) => {
      const count = capacityCounts[cap] || 0;
      const percentage = totalWorkspaces > 0 ? Math.round((count / totalWorkspaces) * 100) : 0;
      let label = `${cap} Member`;
      if (cap === 1) label = '1 Member (Solo)';
      else if (cap <= 3) label = `${cap} Members (Agile Pod)`;
      else if (cap <= 5) label = `${cap} Members (Standard Squad)`;
      else label = `${cap} Members (Enterprise Tier)`;

      return {
        capacity: cap,
        count,
        percentage,
        label,
      };
    });

    // 4. Growth Trend (Last 7 Days)
    const growthTrend = [];
    const now = new Date();
    const dayNames = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];

    for (let i = 6; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().split('T')[0];
      const dayLabel = dayNames[d.getDay()];

      // Count signups on this date
      const signupsOnDay = nonAdminUsers.filter((u) => {
        const uDate = new Date(u.createdAt).toISOString().split('T')[0];
        return uDate === dateStr;
      }).length;

      growthTrend.push({
        date: dateStr,
        dayLabel: `${dayLabel} (${d.getDate()}/${d.getMonth() + 1})`,
        signups: signupsOnDay,
        activeWorkspaces: totalWorkspaces,
      });
    }

    // 5. User Directory / Leads Table
    const usersDirectory = nonAdminUsers.map((u) => {
      const ws = u.ownedWorkspaces?.[0];
      return {
        id: u.id,
        username: u.username || 'unknown',
        fullName: u.fullName || u.username || 'Anonymous User',
        email: u.email,
        phone: u.phone || null,
        role: u.role,
        verificationMethod: u.verificationMethod || 'EMAIL',
        onboardingCompleted: u.onboardingCompleted,
        createdAt: u.createdAt.toISOString(),
        workspace: ws
          ? {
              id: ws.id,
              name: ws.name,
              maxMembers: ws.maxMembers,
              currentMembersCount: ws.members.length,
              remainingSeats: Math.max(0, ws.maxMembers - ws.members.length),
              totalTokensGenerated: ws.inviteTokens.length,
            }
          : null,
      };
    });

    return {
      summary: {
        totalUsers,
        totalWorkspaces,
        totalActiveMembers,
        totalTickets,
        emailVerifiedCount,
        phoneVerifiedCount,
        completedOnboardingCount,
        onboardingRate,
      },
      capacityDistribution,
      growthTrend,
      usersDirectory,
    };
  }
}
