import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { PrismaService } from '../prisma/prisma.service.js';
import { signJwt } from '../../common/security/crypto.util.js';
import { assertNotAdmin, formatCorporateTitleCase } from './workspace.shared.js';

/** Manages organization capacity, multi-pod provisioning, and onboarding drafts. */
@Injectable()
export class WorkspaceOnboardingService {
  private readonly logger = new Logger(WorkspaceOnboardingService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Set workspace capacity (1 to 8 members) and complete user onboarding
   */
  async setupCapacity(identifier: string, capacity: number) {
    assertNotAdmin(identifier);

    const clampedCapacity = Math.max(1, Math.min(8, Math.floor(Number(capacity) || 8)));

    const user = await this.prisma.user.findFirst({
      where: {
        OR: [
          { id: identifier },
          { username: { equals: identifier, mode: 'insensitive' } },
          { email: { equals: identifier, mode: 'insensitive' } },
        ],
      },
    });

    if (!user) {
      throw new NotFoundException(`User ${identifier} not found.`);
    }

    // Mark onboardingCompleted = true
    await this.prisma.user.update({
      where: { id: user.id },
      data: { onboardingCompleted: true },
    });

    // Check if workspace exists
    let workspace = await this.prisma.workspace.findFirst({
      where: { ownerId: user.id },
    });

    if (workspace) {
      workspace = await this.prisma.workspace.update({
        where: { id: workspace.id },
        data: { assignedQuota: clampedCapacity },
      });
    } else {
      const initialToken = `inv_${crypto.randomBytes(8).toString('hex')}`;
      workspace = await this.prisma.workspace.create({
        data: {
          name: `${user.fullName || user.username}'s Support Team`,
          ownerId: user.id,
          inviteToken: initialToken,
          assignedQuota: clampedCapacity,
          inviteTokens: {
            create: {
              token: initialToken,
              isUsed: false,
            },
          },
        },
      });
    }

    this.logger.log(`Setup capacity for user @${user.username}: ${clampedCapacity} members. Onboarding completed.`);

    return {
      success: true,
      capacity: clampedCapacity,
      workspaceId: workspace.id,
      onboardingCompleted: true,
    };
  }

  /**
   * Enterprise Multi-Pod Provisioning (Step 1-4 Onboarding)
   */
  async setupMultiPod(dto: {
    identifier: string;
    organizationName?: string;
    industry: string;
    customIndustryDescription?: string;
    totalSeats: number;
    leadershipMode?: 'UNIFIED' | 'DEDICATED';
    pods: Array<{
      name: string;
      podCategory: string;
      description?: string;
      seats?: number;
    }>;
  }) {
    assertNotAdmin(dto.identifier);

    const user = await this.prisma.user.findFirst({
      where: {
        OR: [
          { id: dto.identifier },
          { username: { equals: dto.identifier, mode: 'insensitive' } },
          { email: { equals: dto.identifier, mode: 'insensitive' } },
        ],
      },
      include: {
        organization: true,
      },
    });

    if (!user) {
      throw new NotFoundException(`User ${dto.identifier} not found.`);
    }

    const orgName =
      formatCorporateTitleCase(dto.organizationName || '') ||
      `${user.fullName || user.username}'s Enterprise`;

    // 1. Create or Update Organization
    let organization = user.organization;
    if (!organization) {
      organization = await this.prisma.organization.create({
        data: {
          name: orgName,
          industry: dto.industry || 'OTHER',
          customIndustryDescription: dto.customIndustryDescription || null,
          totalSeats: dto.totalSeats || 8,
          leadershipMode: dto.leadershipMode || 'UNIFIED',
        },
      });
    } else {
      organization = await this.prisma.organization.update({
        where: { id: organization.id },
        data: {
          name: orgName,
          industry: dto.industry || organization.industry,
          customIndustryDescription: dto.customIndustryDescription || organization.customIndustryDescription,
          totalSeats: dto.totalSeats || organization.totalSeats,
          leadershipMode: dto.leadershipMode || organization.leadershipMode,
        },
      });
    }

    // 2. Link User to Organization & mark onboarding complete
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        organizationId: organization.id,
        onboardingCompleted: true,
      },
    });

    // 3. Create configured Pods (Workspaces)
    const configuredPods =
      dto.pods && dto.pods.length > 0
        ? dto.pods
        : [
            {
              name: 'General Support Pod',
              podCategory: 'GENERAL',
              description: 'General customer inquiries',
              seats: 8,
            },
          ];

    const createdWorkspaces = [];

    for (const pod of configuredPods) {
      const initialToken = `inv_${crypto.randomBytes(8).toString('hex')}`;
      const ws = await this.prisma.workspace.create({
        data: {
          name: pod.name,
          podCategory: pod.podCategory || 'GENERAL',
          description: pod.description || null,
          assignedQuota: Math.max(1, Math.min(8, Number(pod.seats) || 8)),
          inviteToken: initialToken,
          ownerId: user.id,
          organizationId: organization.id,
          inviteTokens: {
            create: {
              token: initialToken,
              isUsed: false,
            },
          },
        },
        include: {
          members: true,
          inviteTokens: true,
        },
      });
      createdWorkspaces.push(ws);
    }

    // 4. Ensure Catch-All safety net exists
    const hasCatchAll = createdWorkspaces.some((w) => w.isCatchAll);
    if (!hasCatchAll) {
      const catchAllToken = `inv_${crypto.randomBytes(8).toString('hex')}`;
      const catchAllWs = await this.prisma.workspace.create({
        data: {
          name: 'Catch-All Triage Pod',
          podCategory: 'CATCH_ALL',
          description: 'Safety-net triage queue for unmapped or new customer topics',
          isCatchAll: true,
          assignedQuota: 8,
          inviteToken: catchAllToken,
          ownerId: user.id,
          organizationId: organization.id,
          inviteTokens: {
            create: {
              token: catchAllToken,
              isUsed: false,
            },
          },
        },
      });
      createdWorkspaces.push(catchAllWs);
    }

    this.logger.log(
      `Provisioned ${createdWorkspaces.length} pods for organization "${organization.name}"`,
    );

    return {
      success: true,
      organization: {
        id: organization.id,
        name: organization.name,
        industry: organization.industry,
        totalSeats: organization.totalSeats,
        leadershipMode: organization.leadershipMode,
      },
      workspaces: createdWorkspaces.map((w) => ({
        id: w.id,
        name: w.name,
        podCategory: w.podCategory,
        description: w.description,
        isCatchAll: w.isCatchAll,
        assignedQuota: w.assignedQuota,
        maxMembers: w.assignedQuota,
        inviteToken: w.inviteToken,
      })),
    };
  }

  /**
   * Get all active pods for user's organization
   */
  async getOrganizationPods(identifier: string) {
    const user = await this.prisma.user.findFirst({
      where: {
        OR: [
          { id: identifier },
          { username: { equals: identifier, mode: 'insensitive' } },
          { email: { equals: identifier, mode: 'insensitive' } },
        ],
      },
      include: {
        organization: {
          include: {
            workspaces: {
              include: {
                members: { include: { user: true } },
                tickets: { select: { id: true, status: true } },
              },
              orderBy: { createdAt: 'asc' },
            },
          },
        },
        ownedWorkspaces: {
          include: {
            members: { include: { user: true } },
            tickets: { select: { id: true, status: true } },
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!user) {
      throw new NotFoundException(`User ${identifier} not found.`);
    }

    const pods = user.organization?.workspaces || user.ownedWorkspaces || [];

    const displayIndustry =
      user.organization?.industry === 'OTHER' && user.organization?.customIndustryDescription
        ? user.organization.customIndustryDescription
        : user.organization?.industry || 'OTHER';

    return {
      organizationName:
        user.organization?.name || `${user.fullName || user.username}'s Team`,
      industry: displayIndustry,
      customIndustryDescription: user.organization?.customIndustryDescription || null,
      totalSeats: user.organization?.totalSeats || 8,
      leadershipMode: user.organization?.leadershipMode || 'UNIFIED',
      pods: pods.map((p) => {
        const openTickets =
          p.tickets?.filter(
            (t) => t.status !== 'RESOLVED' && t.status !== 'CLOSED',
          ).length || 0;
        return {
          id: p.id,
          name: p.name,
          podCategory: p.podCategory,
          description: p.description,
          isCatchAll: p.isCatchAll,
          assignedQuota: p.assignedQuota,
          maxMembers: p.assignedQuota,
          currentMembersCount: p.members?.length || 0,
          openTicketsCount: openTickets,
          inviteToken: p.inviteToken,
        };
      }),
    };
  }

  /**
   * Dynamically create a custom pod anytime
   */
  async createCustomPod(
    identifier: string,
    dto: {
      name: string;
      podCategory?: string;
      description?: string;
      maxMembers?: number;
    },
  ) {
    assertNotAdmin(identifier);

    const user = await this.prisma.user.findFirst({
      where: {
        OR: [
          { id: identifier },
          { username: { equals: identifier, mode: 'insensitive' } },
        ],
      },
      include: { organization: true },
    });

    if (!user) {
      throw new NotFoundException(`User ${identifier} not found.`);
    }

    const initialToken = `inv_${crypto.randomBytes(8).toString('hex')}`;
    const newPod = await this.prisma.workspace.create({
      data: {
        name: dto.name,
        podCategory: dto.podCategory || 'CUSTOM',
        description: dto.description || null,
        assignedQuota: Math.max(1, Math.min(8, Number(dto.maxMembers) || 8)),
        inviteToken: initialToken,
        ownerId: user.id,
        organizationId: user.organizationId || null,
        inviteTokens: {
          create: {
            token: initialToken,
            isUsed: false,
          },
        },
      },
      include: {
        members: true,
      },
    });

    this.logger.log(`Created custom pod "${dto.name}" for user @${user.username}`);

    return {
      success: true,
      pod: {
        id: newPod.id,
        name: newPod.name,
        podCategory: newPod.podCategory,
        description: newPod.description,
        isCatchAll: newPod.isCatchAll,
        assignedQuota: newPod.assignedQuota,
        maxMembers: newPod.assignedQuota,
        currentMembersCount: newPod.members.length,
        inviteToken: newPod.inviteToken,
      },
    };
  }

  /**
   * Enterprise Multi-Pod Provisioning v2 (Titanium Onboarding)
   * With Single-Use Leader Tokens and Multi-Service Mapping
   */
  async setupMultiPodV2(dto: {
    identifier: string;
    organizationName?: string;
    industry: string;
    customIndustryDescription?: string;
    totalSeats: number;
    leadershipMode?: 'UNIFIED' | 'DEDICATED';
    pods: Array<{
      name: string;
      podCategory: string;
      description?: string;
      services?: string[];
      seats?: number;
    }>;
  }) {
    assertNotAdmin(dto.identifier);

    const user = await this.prisma.user.findFirst({
      where: {
        OR: [
          { id: dto.identifier },
          { username: { equals: dto.identifier, mode: 'insensitive' } },
          { email: { equals: dto.identifier, mode: 'insensitive' } },
        ],
      },
      include: { organization: true },
    });

    if (!user) {
      throw new NotFoundException(`User ${dto.identifier} not found.`);
    }

    const orgName =
      formatCorporateTitleCase(dto.organizationName || '') ||
      `${user.fullName || user.username}'s Organization`;

    // 1. Create or Update Organization
    let organization = user.organization;
    if (!organization) {
      organization = await this.prisma.organization.create({
        data: {
          name: orgName,
          industry: dto.industry || 'OTHER',
          customIndustryDescription: dto.customIndustryDescription || null,
          totalSeats: Number(dto.totalSeats) || 20,
          leadershipMode: dto.leadershipMode || 'DEDICATED',
        },
      });
    } else {
      organization = await this.prisma.organization.update({
        where: { id: organization.id },
        data: {
          name: orgName,
          industry: dto.industry || organization.industry,
          customIndustryDescription:
            dto.customIndustryDescription || organization.customIndustryDescription,
          totalSeats: Number(dto.totalSeats) || organization.totalSeats,
          leadershipMode: dto.leadershipMode || organization.leadershipMode,
        },
      });
    }

    // 2. Link User to Organization as TENANT_OWNER (Onboarding completes once Done Sharing is clicked)
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        organizationId: organization.id,
        role: 'TENANT_OWNER',
        onboardingCompleted: false,
      },
    });

    // 3. Remove existing old workspaces for clean setup
    await this.prisma.workspace.deleteMany({
      where: { organizationId: organization.id },
    });

    // 4. Create Pods with Single-Use Leader Tokens
    const configuredPods =
      dto.pods && dto.pods.length > 0
        ? dto.pods
        : [
            {
              name: 'General Support Pod',
              podCategory: 'GENERAL',
              description: 'General customer inquiries',
              services: ['General Support'],
            },
          ];

    const createdWorkspaces: any[] = [];
    const leaderTokens: any[] = [];

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    for (const pod of configuredPods) {
      const leaderTokenStr =
        'SVQ-LDR-' + crypto.randomBytes(3).toString('hex').toUpperCase();

      const ws = await this.prisma.workspace.create({
        data: {
          name: pod.name,
          podCategory: pod.podCategory || 'GENERAL',
          description: pod.description || null,
          services: pod.services || [],
          assignedQuota: Number(pod.seats) || 8,
          isQuotaLocked: true,
          lockedAt: new Date(),
          inviteToken: leaderTokenStr,
          ownerId: user.id,
          organizationId: organization.id,
          inviteTokens: {
            create: {
              token: leaderTokenStr,
              role: 'LEADER',
              isUsed: false,
            },
          },
        },
        include: {
          inviteTokens: true,
        },
      });

      createdWorkspaces.push(ws);
      leaderTokens.push({
        workspaceId: ws.id,
        workspaceName: ws.name,
        podCategory: ws.podCategory,
        services: ws.services,
        token: leaderTokenStr,
        role: 'LEADER',
        isUsed: false,
        joinUrl: `${frontendUrl}/join?token=${leaderTokenStr}`,
      });
    }

    this.logger.log(
      `Provisioned v2 ${createdWorkspaces.length} pods with single-use leader tokens for ${organization.name}`,
    );

    const refreshedToken = signJwt({
      sub: user.id,
      username: user.username || undefined,
      role: 'TENANT_OWNER',
      organizationId: organization.id,
    });

    return {
      success: true,
      token: refreshedToken,
      organization: {
        id: organization.id,
        name: organization.name,
        industry: organization.industry,
        totalSeats: organization.totalSeats,
        leadershipMode: organization.leadershipMode,
      },
      pods: createdWorkspaces.map((w) => ({
        id: w.id,
        name: w.name,
        podCategory: w.podCategory,
        description: w.description,
        services: w.services,
        isQuotaLocked: w.isQuotaLocked,
        assignedQuota: w.assignedQuota,
      })),
      leaderTokens,
    };
  }

  /**
   * Fetch Pending Leader Tokens directly from PostgreSQL Database for Resilient Step 4 Recovery
   */
  async getPendingLeaderTokens(identifier: string) {
    if (!identifier || identifier.trim() === '') {
      throw new BadRequestException('Identifier is required.');
    }
    const cleanId = identifier.trim();
    const user = await this.prisma.user.findFirst({
      where: {
        OR: [
          { id: cleanId },
          { username: { equals: cleanId, mode: 'insensitive' } },
          { email: { equals: cleanId, mode: 'insensitive' } },
        ],
      },
      include: {
        organization: {
          include: {
            workspaces: {
              include: {
                inviteTokens: { orderBy: { createdAt: 'desc' } },
                members: { include: { user: true } },
              },
              orderBy: { createdAt: 'asc' },
            },
          },
        },
      },
    });

    if (!user || !user.organization) {
      return {
        success: true,
        hasPendingTokens: false,
        onboardingCompleted: user?.onboardingCompleted ?? false,
        leaderTokens: [],
      };
    }

    const leaderTokens: any[] = [];
    const pods: any[] = [];
    const allServicesSet = new Set<string>();
    const baseUrl = process.env.FRONTEND_URL || 'http://localhost:3000';

    for (const ws of user.organization.workspaces || []) {
      const activeLeader = ws.members?.find((m: any) => m.role === 'LEADER');
      const leaderTok = ws.inviteTokens?.find((t) => t.role === 'LEADER') || {
        token: ws.inviteToken,
        isUsed: !!activeLeader,
      };
      if (leaderTok?.token) {
        leaderTokens.push({
          workspaceId: ws.id,
          workspaceName: ws.name,
          podCategory: ws.podCategory,
          services: ws.services || [],
          token: leaderTok.token,
          role: 'LEADER',
          isUsed: !!activeLeader || (leaderTok.isUsed ?? false),
          joinUrl: `${baseUrl}/join?token=${leaderTok.token}`,
          isClaimed: !!activeLeader,
          leaderName:
            activeLeader?.user?.fullName ||
            activeLeader?.user?.username ||
            null,
        });
      }

      pods.push({
        name: ws.name,
        podCategory: ws.podCategory,
        description: ws.description || '',
        services: ws.services || [],
      });

      if (Array.isArray(ws.services)) {
        for (const s of ws.services) {
          if (s && s.trim()) allServicesSet.add(s.trim());
        }
      }
    }

    return {
      success: true,
      hasPendingTokens: leaderTokens.length > 0,
      onboardingCompleted: user.onboardingCompleted ?? false,
      organizationName: user.organization.name,
      industry: user.organization.industry,
      customIndustryDescription: user.organization.customIndustryDescription,
      totalSeats: user.organization.totalSeats,
      pods,
      availableServices: Array.from(allServicesSet),
      leaderTokens,
    };
  }

  /**
   * Complete Onboarding upon explicit Done Sharing click
   */
  async completeOnboarding(identifier: string) {
    if (!identifier || identifier.trim() === '') {
      throw new BadRequestException('Identifier is required.');
    }
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

    if (!user) {
      throw new NotFoundException('User not found.');
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        role: 'TENANT_OWNER',
        onboardingCompleted: true,
      },
    });

    this.deleteOnboardingDraft(cleanId);
    if (user.username) this.deleteOnboardingDraft(user.username);
    if (user.email) this.deleteOnboardingDraft(user.email);

    this.logger.log(`User @${user.username} officially completed onboarding into Company Cockpit.`);
    const refreshedToken = signJwt({
      sub: user.id,
      username: user.username || undefined,
      role: 'TENANT_OWNER',
      organizationId: user.organizationId || undefined,
    });
    return { success: true, token: refreshedToken };
  }

  /**
   * Onboarding Draft Persistence (Step 1, 2, 3 autosave across logins)
   */
  private readonly draftFilePath = path.join(process.cwd(), 'data', 'onboarding-drafts.json');

  private loadDraftsFromFile(): Record<string, any> {
    try {
      if (!fs.existsSync(this.draftFilePath)) {
        const dir = path.dirname(this.draftFilePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(this.draftFilePath, JSON.stringify({}), 'utf-8');
        return {};
      }
      const raw = fs.readFileSync(this.draftFilePath, 'utf-8');
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }

  private saveDraftsToFile(drafts: Record<string, any>) {
    try {
      const dir = path.dirname(this.draftFilePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.draftFilePath, JSON.stringify(drafts, null, 2), 'utf-8');
    } catch (e) {
      this.logger.error(`Failed to save onboarding drafts: ${(e as Error).message}`);
    }
  }

  saveOnboardingDraft(identifier: string, draftData: any) {
    if (!identifier || identifier.trim() === '') {
      return { success: false, error: 'Identifier is required.' };
    }
    const cleanId = identifier.trim().toLowerCase();
    const drafts = this.loadDraftsFromFile();
    const payload = {
      ...draftData,
      updatedAt: new Date().toISOString(),
    };

    drafts[cleanId] = payload;
    if (draftData.username && typeof draftData.username === 'string') {
      drafts[draftData.username.trim().toLowerCase()] = payload;
    }
    if (draftData.email && typeof draftData.email === 'string') {
      drafts[draftData.email.trim().toLowerCase()] = payload;
    }
    if (draftData.userId && typeof draftData.userId === 'string') {
      drafts[draftData.userId.trim().toLowerCase()] = payload;
    }

    this.saveDraftsToFile(drafts);
    return { success: true, draft: drafts[cleanId] };
  }

  getOnboardingDraft(identifier: string) {
    if (!identifier || identifier.trim() === '') return null;
    const cleanId = identifier.trim().toLowerCase();
    const drafts = this.loadDraftsFromFile();
    return drafts[cleanId] || null;
  }

  deleteOnboardingDraft(identifier: string) {
    if (!identifier || identifier.trim() === '') return;
    const cleanId = identifier.trim().toLowerCase();
    const drafts = this.loadDraftsFromFile();
    let changed = false;
    if (drafts[cleanId]) {
      const existing = drafts[cleanId];
      delete drafts[cleanId];
      changed = true;
      if (existing?.username && drafts[existing.username.trim().toLowerCase()]) {
        delete drafts[existing.username.trim().toLowerCase()];
      }
      if (existing?.email && drafts[existing.email.trim().toLowerCase()]) {
        delete drafts[existing.email.trim().toLowerCase()];
      }
      if (existing?.userId && drafts[existing.userId.trim().toLowerCase()]) {
        delete drafts[existing.userId.trim().toLowerCase()];
      }
    }
    if (changed) {
      this.saveDraftsToFile(drafts);
    }
  }
}
