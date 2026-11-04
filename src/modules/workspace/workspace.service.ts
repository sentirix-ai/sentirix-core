import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { EventsGateway } from '../events/events.gateway.js';
import { JoinWorkspaceDto } from './dto/join-workspace.dto.js';

export interface WorkspaceMemberInfo {
  id: string;
  userId: string;
  fullName: string;
  username: string;
  role: string;
  joinedAt: Date | string;
}

export interface WorkspaceDetailResponse {
  workspaceId: string;
  name: string;
  ownerName: string;
  inviteToken: string;
  inviteUrl: string;
  isTokenUsed?: boolean;
  maxMembers: number;
  currentMembersCount: number;
  remainingSeats: number;
  members: WorkspaceMemberInfo[];
}

@Injectable()
export class WorkspaceService {
  private readonly logger = new Logger(WorkspaceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventsGateway: EventsGateway,
  ) {}

  /**
   * Helper to check if a user is Master Admin (@pungkyrama)
   */
  private assertNotAdmin(identifier: string) {
    const clean = identifier.toLowerCase().trim();
    if (clean === 'pungkyrama' || clean === 'admin@sentrix.enterprise') {
      throw new ForbiddenException(
        'Master Administrator (@pungkyrama) maintains global administrative privileges and does not use team invite links.',
      );
    }
  }

  /**
   * Get or create a team workspace for a registered regular user
   * Guarantees a valid, active single-use invite token is ready
   */
  async getOrCreateUserWorkspace(identifier: string): Promise<WorkspaceDetailResponse> {
    this.assertNotAdmin(identifier);

    // Find user in DB
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

    if (user.role === 'ADMIN' || user.username === 'pungkyrama') {
      throw new ForbiddenException('Admin accounts are excluded from workspace team links.');
    }

    // Check if user already has a workspace
    let workspace = await this.prisma.workspace.findFirst({
      where: { ownerId: user.id },
      include: {
        members: {
          include: {
            user: true,
          },
          orderBy: { joinedAt: 'asc' },
        },
        inviteTokens: {
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    // If not, create one
    if (!workspace) {
      const initialToken = `inv_${crypto.randomBytes(8).toString('hex')}`;
      workspace = await this.prisma.workspace.create({
        data: {
          name: `${user.fullName || user.username}'s Support Team`,
          ownerId: user.id,
          inviteToken: initialToken,
          maxMembers: 8,
          inviteTokens: {
            create: {
              token: initialToken,
              isUsed: false,
            },
          },
        },
        include: {
          members: {
            include: { user: true },
            orderBy: { joinedAt: 'asc' },
          },
          inviteTokens: {
            orderBy: { createdAt: 'desc' },
          },
        },
      });
      this.logger.log(`Created new workspace for user @${user.username} with initial single-use token.`);
    }

    // Ensure there is at least one active UNUSED token available
    let activeToken = workspace.inviteTokens?.find((t) => !t.isUsed);
    if (!activeToken) {
      const newTokenStr = `inv_${crypto.randomBytes(8).toString('hex')}`;
      activeToken = await this.prisma.workspaceInviteToken.create({
        data: {
          workspaceId: workspace.id,
          token: newTokenStr,
          isUsed: false,
        },
      });
      await this.prisma.workspace.update({
        where: { id: workspace.id },
        data: { inviteToken: newTokenStr },
      });
    }

    const membersList: WorkspaceMemberInfo[] = (workspace.members || []).map((m) => ({
      id: m.id,
      userId: m.userId,
      fullName: m.user?.fullName || m.user?.username || 'Team Agent',
      username: m.user?.username || '',
      role: m.role || 'MEMBER',
      joinedAt: m.joinedAt,
    }));

    const baseUrl = process.env.FRONTEND_URL || 'http://localhost:3000';

    return {
      workspaceId: workspace.id,
      name: workspace.name,
      ownerName: user.fullName || user.username || 'Workspace Owner',
      inviteToken: activeToken.token,
      inviteUrl: `${baseUrl}/join?token=${activeToken.token}`,
      isTokenUsed: false,
      maxMembers: workspace.maxMembers,
      currentMembersCount: membersList.length,
      remainingSeats: Math.max(0, workspace.maxMembers - membersList.length),
      members: membersList,
    };
  }

  /**
   * Generate a brand new single-use token for the next member
   */
  async generateSingleUseToken(identifier: string) {
    this.assertNotAdmin(identifier);

    const user = await this.prisma.user.findFirst({
      where: {
        OR: [
          { id: identifier },
          { username: { equals: identifier, mode: 'insensitive' } },
        ],
      },
      include: {
        ownedWorkspaces: {
          include: { members: true },
        },
      },
    });

    const activeWorkspace = user?.ownedWorkspaces?.[0];
    if (!user || !activeWorkspace) {
      throw new NotFoundException('Workspace not found for this user.');
    }

    if (activeWorkspace.members.length >= activeWorkspace.maxMembers) {
      throw new BadRequestException('Workspace is full (8/8 members).');
    }

    const newTokenStr = `inv_${crypto.randomBytes(8).toString('hex')}`;
    const newToken = await this.prisma.workspaceInviteToken.create({
      data: {
        workspaceId: activeWorkspace.id,
        token: newTokenStr,
        isUsed: false,
      },
    });

    await this.prisma.workspace.update({
      where: { id: activeWorkspace.id },
      data: { inviteToken: newTokenStr },
    });

    const baseUrl = process.env.FRONTEND_URL || 'http://localhost:3000';

    return {
      success: true,
      inviteToken: newToken.token,
      inviteUrl: `${baseUrl}/join?token=${newToken.token}`,
    };
  }

  /**
   * Validate an invite link by single-use token
   */
  async validateInvite(token: string) {
    if (!token || token.trim() === '') {
      throw new BadRequestException('Invite token is required.');
    }

    const cleanToken = token.trim();

    // Check in single-use tokens table first
    const tokenRecord = await this.prisma.workspaceInviteToken.findUnique({
      where: { token: cleanToken },
      include: {
        workspace: {
          include: {
            owner: { select: { id: true, fullName: true, username: true } },
            members: true,
          },
        },
      },
    });

    if (!tokenRecord) {
      // Fallback check on workspace.inviteToken
      const wsFallback = await this.prisma.workspace.findFirst({
        where: { inviteToken: cleanToken },
        include: {
          owner: { select: { id: true, fullName: true, username: true } },
          members: true,
        },
      });

      if (!wsFallback) {
        return {
          valid: false,
          error: 'Invalid or expired invite link. Please contact your workspace administrator.',
        };
      }

      return {
        valid: true,
        workspaceId: wsFallback.id,
        workspaceName: wsFallback.name,
        ownerName: wsFallback.owner.fullName || wsFallback.owner.username,
        currentMembers: wsFallback.members.length,
        maxMembers: wsFallback.maxMembers,
        remainingSeats: wsFallback.maxMembers - wsFallback.members.length,
      };
    }

    // Single-use enforcement: if token was already used by someone
    if (tokenRecord.isUsed) {
      return {
        valid: false,
        error: `This invitation link has already been used by ${tokenRecord.usedBy || 'another team member'}. Each link can only be used by 1 person. Please request a new link from the workspace owner.`,
        workspaceName: tokenRecord.workspace.name,
        ownerName: tokenRecord.workspace.owner.fullName || tokenRecord.workspace.owner.username,
      };
    }

    const memberCount = tokenRecord.workspace.members.length;
    if (memberCount >= tokenRecord.workspace.maxMembers) {
      return {
        valid: false,
        error: `This workspace has reached its maximum team capacity of ${tokenRecord.workspace.maxMembers} members.`,
        workspaceName: tokenRecord.workspace.name,
        ownerName: tokenRecord.workspace.owner.fullName || tokenRecord.workspace.owner.username,
      };
    }

    return {
      valid: true,
      workspaceId: tokenRecord.workspace.id,
      workspaceName: tokenRecord.workspace.name,
      ownerName: tokenRecord.workspace.owner.fullName || tokenRecord.workspace.owner.username,
      currentMembers: memberCount,
      maxMembers: tokenRecord.workspace.maxMembers,
      remainingSeats: tokenRecord.workspace.maxMembers - memberCount,
    };
  }

  /**
   * Join workspace with 1-click (name only)
   * Consumes the single-use token immediately
   */
  async joinWorkspace(dto: JoinWorkspaceDto) {
    const { token, fullName } = dto;
    const cleanToken = token.trim();
    const cleanName = fullName.trim();

    if (!cleanName || cleanName.length < 2) {
      throw new BadRequestException('Please provide your full name (at least 2 characters).');
    }

    // 1. Find token record
    let tokenRecord = await this.prisma.workspaceInviteToken.findUnique({
      where: { token: cleanToken },
      include: {
        workspace: {
          include: {
            owner: true,
            members: { include: { user: true } },
          },
        },
      },
    });

    let workspace: any = null;

    if (tokenRecord) {
      if (tokenRecord.isUsed) {
        throw new BadRequestException(
          `This invitation link has already been used by ${tokenRecord.usedBy || 'another member'}. Each link can only be used once. Please request a new invite link.`,
        );
      }
      workspace = tokenRecord.workspace;
    } else {
      // Fallback
      workspace = await this.prisma.workspace.findFirst({
        where: { inviteToken: cleanToken },
        include: {
          owner: true,
          members: { include: { user: true } },
        },
      });
    }

    if (!workspace) {
      throw new NotFoundException('Workspace not found for this invitation token.');
    }

    if (workspace.members.length >= workspace.maxMembers) {
      throw new BadRequestException(
        `Workspace is full (${workspace.maxMembers}/${workspace.maxMembers} seats occupied).`,
      );
    }

    // Generate member credentials
    const slug = cleanName
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')
      .slice(0, 12);
    const randomSuffix = Math.floor(1000 + Math.random() * 9000);
    const username = `${slug || 'agent'}_${randomSuffix}`;
    const email = `${username}@team.${workspace.id.slice(0, 8)}.sentrix.local`;
    const tempSecret = crypto.randomBytes(16).toString('hex');
    const passwordHash = crypto.createHash('sha256').update(tempSecret).digest('hex');

    // Create User record with role AGENT
    const newUser = await this.prisma.user.create({
      data: {
        username,
        fullName: cleanName,
        email,
        passwordHash,
        role: 'AGENT',
      },
    });

    // Link to Workspace
    const membership = await this.prisma.workspaceMember.create({
      data: {
        workspaceId: workspace.id,
        userId: newUser.id,
        role: 'AGENT',
      },
    });

    // Mark single-use token as CONSUMED (isUsed = true)
    if (tokenRecord) {
      await this.prisma.workspaceInviteToken.update({
        where: { id: tokenRecord.id },
        data: {
          isUsed: true,
          usedBy: cleanName,
          usedAt: new Date(),
        },
      });
    } else {
      // Create a used record for fallback
      await this.prisma.workspaceInviteToken.create({
        data: {
          workspaceId: workspace.id,
          token: cleanToken,
          isUsed: true,
          usedBy: cleanName,
          usedAt: new Date(),
        },
      });
    }

    this.logger.log(
      `User "${cleanName}" (@${username}) joined workspace "${workspace.name}" via Single-Use Link. Token consumed.`,
    );

    // Broadcast WebSocket notification to workspace channel
    this.eventsGateway.server?.emit('team:member_joined', {
      workspaceId: workspace.id,
      newMember: {
        id: membership.id,
        userId: newUser.id,
        fullName: cleanName,
        username,
        role: 'AGENT',
        joinedAt: membership.joinedAt,
      },
      currentMembersCount: workspace.members.length + 1,
    });

    const tokenPayload = `${newUser.id}:AGENT:${Date.now()}`;
    const sessionToken = Buffer.from(tokenPayload).toString('base64');

    return {
      success: true,
      user: {
        id: newUser.id,
        username: cleanName,
        systemUsername: newUser.username,
        email: newUser.email,
        role: 'AGENT',
        isGuestMember: true,
        isVerified: true,
        avatarText: cleanName.slice(0, 2).toUpperCase(),
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        token: sessionToken,
      },
    };
  }

  /**
   * Member Logout: Removes member from workspace, reduces active count, and purges member user
   */
  async memberLogout(memberId: string, workspaceId?: string) {
    if (!memberId) return { success: true };

    try {
      const membership = await this.prisma.workspaceMember.findFirst({
        where: {
          userId: memberId,
          ...(workspaceId ? { workspaceId } : {}),
        },
        include: {
          workspace: true,
          user: true,
        },
      });

      if (!membership) {
        return { success: true, message: 'Member not found or already logged out.' };
      }

      const wsId = membership.workspaceId;
      const memberName = membership.user?.fullName || membership.user?.username || 'Team Member';

      // Delete membership
      await this.prisma.workspaceMember.delete({
        where: { id: membership.id },
      });

      // Delete user
      try {
        await this.prisma.user.delete({
          where: { id: memberId },
        });
      } catch (delErr) {
        this.logger.warn(`Could not delete member user ${memberId}: ${(delErr as Error)?.message}`);
      }

      // Count remaining members
      const remainingCount = await this.prisma.workspaceMember.count({
        where: { workspaceId: wsId },
      });

      this.logger.log(`Member "${memberName}" logged out. Remaining members: ${remainingCount}`);

      // Broadcast WebSocket notification to owner dashboard
      this.eventsGateway.server?.emit('team:member_left', {
        workspaceId: wsId,
        memberId,
        memberName,
        currentMembersCount: remainingCount,
      });

      return {
        success: true,
        message: 'Member logged out successfully.',
        currentMembersCount: remainingCount,
      };
    } catch (err) {
      this.logger.error(`Error during member logout: ${(err as Error)?.message}`);
      return { success: false, error: (err as Error)?.message };
    }
  }

  /**
   * Purge all workspace members when the workspace owner logs out.
   * Invalidates all tokens and guest accounts.
   */
  async purgeWorkspaceMembersOnLogout(ownerIdentifier: string) {
    const clean = ownerIdentifier.toLowerCase().trim();
    if (clean === 'pungkyrama' || clean === 'admin@sentrix.enterprise') {
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
  async checkMemberStatus(userId: string) {
    if (!userId) return { active: false };
    try {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
      });
      return { active: !!user };
    } catch {
      return { active: true };
    }
  }

  /**
   * Remove a member from the workspace (Owner manual removal)
   */
  async removeMember(ownerIdentifier: string, memberId: string) {
    this.assertNotAdmin(ownerIdentifier);

    const user = await this.prisma.user.findFirst({
      where: {
        OR: [
          { id: ownerIdentifier },
          { username: { equals: ownerIdentifier, mode: 'insensitive' } },
        ],
      },
      include: { ownedWorkspaces: true },
    });

    if (!user || !user.ownedWorkspaces?.length) {
      throw new NotFoundException('Workspace not found for this user.');
    }

    const member = await this.prisma.workspaceMember.findFirst({
      where: {
        id: memberId,
        workspace: { ownerId: user.id },
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

  /**
   * Set workspace capacity (1 to 8 members) and complete user onboarding
   */
  async setupCapacity(identifier: string, capacity: number) {
    this.assertNotAdmin(identifier);

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
        data: { maxMembers: clampedCapacity },
      });
    } else {
      const initialToken = `inv_${crypto.randomBytes(8).toString('hex')}`;
      workspace = await this.prisma.workspace.create({
        data: {
          name: `${user.fullName || user.username}'s Support Team`,
          ownerId: user.id,
          inviteToken: initialToken,
          maxMembers: clampedCapacity,
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
    this.assertNotAdmin(dto.identifier);

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

    const orgName = dto.organizationName?.trim() || `${user.fullName || user.username}'s Enterprise`;

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
          maxMembers: Math.max(1, Math.min(8, Number(pod.seats) || 8)),
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
          maxMembers: 8,
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
        maxMembers: w.maxMembers,
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

    return {
      organizationName:
        user.organization?.name || `${user.fullName || user.username}'s Team`,
      industry: user.organization?.industry || 'OTHER',
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
          maxMembers: p.maxMembers,
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
    this.assertNotAdmin(identifier);

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
        maxMembers: Math.max(1, Math.min(8, Number(dto.maxMembers) || 8)),
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
        maxMembers: newPod.maxMembers,
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
    this.assertNotAdmin(dto.identifier);

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
      dto.organizationName?.trim() ||
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

    // 2. Link User to Organization as ADMIN
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        organizationId: organization.id,
        role: 'ADMIN',
        onboardingCompleted: true,
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

    for (const pod of configuredPods) {
      const leaderTokenStr =
        'STX-LDR-' + crypto.randomBytes(3).toString('hex').toUpperCase();

      const ws = await this.prisma.workspace.create({
        data: {
          name: pod.name,
          podCategory: pod.podCategory || 'GENERAL',
          description: pod.description || null,
          services: pod.services || [],
          maxMembers: 8,
          assignedQuota: 8,
          isQuotaLocked: false,
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
        joinUrl: `http://localhost:3000/join?token=${leaderTokenStr}`,
      });
    }

    this.logger.log(
      `Provisioned v2 ${createdWorkspaces.length} pods with single-use leader tokens for ${organization.name}`,
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
   * Get dynamic interconnected quota status for a Leader token
   */
  async getLeaderTokenQuotaStatus(token: string) {
    if (!token || token.trim() === '') {
      throw new BadRequestException('Token is required.');
    }
    const cleanToken = token.trim();

    const tokenRecord = await this.prisma.workspaceInviteToken.findUnique({
      where: { token: cleanToken },
      include: {
        workspace: {
          include: {
            organization: true,
            members: { include: { user: true } },
          },
        },
      },
    });

    if (!tokenRecord) {
      return {
        valid: false,
        error: 'Invalid or unknown invitation token.',
      };
    }

    if (tokenRecord.role !== 'LEADER') {
      return {
        valid: false,
        error: 'This token is not a Leader activation token.',
      };
    }

    if (tokenRecord.isUsed) {
      return {
        valid: false,
        isUsed: true,
        error: `This leader activation token has already been claimed by ${tokenRecord.usedBy || 'another user'} on ${tokenRecord.usedAt ? new Date(tokenRecord.usedAt).toLocaleString() : 'earlier'}. Each token can only be claimed once.`,
        workspaceName: tokenRecord.workspace?.name,
      };
    }

    const currentWorkspace = tokenRecord.workspace;
    const organization = currentWorkspace?.organization;

    if (!organization) {
      return {
        valid: false,
        error: 'Associated organization not found.',
      };
    }

    // Fetch all workspaces in this organization
    const allPods = await this.prisma.workspace.findMany({
      where: { organizationId: organization.id },
      include: {
        members: { include: { user: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    const totalSeats = organization.totalSeats || 20;
    const totalPods = allPods.length;

    // Filter pods locked by other leaders
    const otherLockedPods = allPods.filter(
      (p) => p.isQuotaLocked && p.id !== currentWorkspace.id,
    );
    const lockedSeats = otherLockedPods.reduce(
      (sum, p) => sum + p.assignedQuota,
      0,
    );

    // Other unlocked pods (excluding this current pod)
    const otherUnlockedPodsCount = allPods.filter(
      (p) => !p.isQuotaLocked && p.id !== currentWorkspace.id,
    ).length;

    // Interconnected quota formula:
    // M_k^max = min(7, max(1, totalSeats - lockedSeats - 1 - otherUnlockedPodsCount))
    const calculatedMax = totalSeats - lockedSeats - 1 - otherUnlockedPodsCount;
    const maxSubordinatesAllowed = Math.min(7, Math.max(1, calculatedMax));

    const allowedOptions = Array.from(
      { length: maxSubordinatesAllowed },
      (_, i) => i + 1,
    );

    return {
      valid: true,
      token: tokenRecord.token,
      role: 'LEADER',
      workspace: {
        id: currentWorkspace.id,
        name: currentWorkspace.name,
        podCategory: currentWorkspace.podCategory,
        services: currentWorkspace.services,
        isQuotaLocked: currentWorkspace.isQuotaLocked,
        assignedQuota: currentWorkspace.assignedQuota,
      },
      organization: {
        id: organization.id,
        name: organization.name,
        totalSeats,
      },
      quotaStats: {
        totalSeats,
        totalPods,
        lockedSeats,
        lockedPodsCount: otherLockedPods.length,
        otherUnlockedPodsCount,
        maxSubordinatesAllowed,
        allowedOptions,
      },
    };
  }

  /**
   * Lock Leader Quota (Click Checkmark [✓]) & Auto-Generate Single-Use Agent Tokens
   */
  async lockLeaderQuota(dto: {
    token: string;
    fullName: string;
    password?: string;
    chosenSubordinates: number;
  }) {
    const { token, fullName, password, chosenSubordinates } = dto;
    if (!token || !fullName || fullName.trim().length < 2) {
      throw new BadRequestException('Please provide a valid token and full name.');
    }
    const cleanToken = token.trim();
    const cleanName = fullName.trim();
    const chosenCount = Number(chosenSubordinates) || 1;

    // 1. Verify token & quota limits
    const quotaStatus = await this.getLeaderTokenQuotaStatus(cleanToken);
    if (!quotaStatus.valid || !quotaStatus.quotaStats) {
      throw new BadRequestException(
        (quotaStatus as any).error || 'Token is not valid.',
      );
    }

    if (chosenCount > quotaStatus.quotaStats.maxSubordinatesAllowed) {
      throw new BadRequestException(
        `Chosen quota (${chosenCount}) exceeds the current maximum allowed (${quotaStatus.quotaStats.maxSubordinatesAllowed}) based on remaining organization capacity.`,
      );
    }

    const tokenRecord = await this.prisma.workspaceInviteToken.findUnique({
      where: { token: cleanToken },
      include: { workspace: true },
    });

    if (!tokenRecord) {
      throw new NotFoundException('Token record not found.');
    }

    const workspace = tokenRecord.workspace;

    // 2. Create Leader User Account
    const slug = cleanName
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')
      .slice(0, 10);
    const username = `${slug || 'leader'}_${Math.floor(1000 + Math.random() * 9000)}`;
    const email = `${username}@team.${workspace.id.slice(0, 8)}.sentrix.local`;
    const passwordHash =
      password && password.trim() !== ''
        ? crypto.createHash('sha256').update(password.trim()).digest('hex')
        : crypto.createHash('sha256').update('0o0o 0o0o').digest('hex');

    const leaderUser = await this.prisma.user.create({
      data: {
        username,
        fullName: cleanName,
        email,
        passwordHash,
        role: 'AGENT',
        organizationId: workspace.organizationId,
        onboardingCompleted: true,
      },
    });

    // 3. Bind Leader to Workspace
    await this.prisma.workspaceMember.create({
      data: {
        workspaceId: workspace.id,
        userId: leaderUser.id,
        role: 'LEADER',
      },
    });

    // 4. Lock Workspace Quota
    const totalPodQuota = 1 + chosenCount; // 1 Leader + M Agen
    await this.prisma.workspace.update({
      where: { id: workspace.id },
      data: {
        assignedQuota: totalPodQuota,
        maxMembers: totalPodQuota,
        isQuotaLocked: true,
        lockedAt: new Date(),
      },
    });

    // 5. Mark Leader Token as Used (Single-Use Constraint)
    await this.prisma.workspaceInviteToken.update({
      where: { id: tokenRecord.id },
      data: {
        isUsed: true,
        usedBy: cleanName,
        usedAt: new Date(),
      },
    });

    // 6. Auto-generate exactly chosenCount Single-Use Agent Tokens
    const agentTokens: any[] = [];
    for (let i = 0; i < chosenCount; i++) {
      const agtTokenStr =
        'STX-AGT-' + crypto.randomBytes(3).toString('hex').toUpperCase();
      const agt = await this.prisma.workspaceInviteToken.create({
        data: {
          workspaceId: workspace.id,
          token: agtTokenStr,
          role: 'AGENT',
          isUsed: false,
        },
      });
      agentTokens.push({
        token: agt.token,
        joinUrl: `http://localhost:3000/join?token=${agt.token}`,
      });
    }

    this.logger.log(
      `Leader "${cleanName}" locked Pod "${workspace.name}" with 1 leader + ${chosenCount} agents. Generated ${agentTokens.length} single-use agent tokens.`,
    );

    // 7. Emit WebSocket event for real-time quota sync
    try {
      this.eventsGateway.server?.emit('workspace:quota-locked', {
        workspaceId: workspace.id,
        organizationId: workspace.organizationId,
        lockedPodQuota: totalPodQuota,
      });
    } catch {
      // ignore websocket failure
    }

    return {
      success: true,
      leader: {
        id: leaderUser.id,
        username: leaderUser.username,
        fullName: leaderUser.fullName,
        email: leaderUser.email,
        role: 'LEADER',
      },
      workspace: {
        id: workspace.id,
        name: workspace.name,
        assignedQuota: totalPodQuota,
        isQuotaLocked: true,
      },
      agentTokens,
    };
  }

  /**
   * Validate Agent Single-Use Token
   */
  async getAgentTokenStatus(token: string) {
    if (!token || token.trim() === '') {
      throw new BadRequestException('Token is required.');
    }
    const cleanToken = token.trim();

    const tokenRecord = await this.prisma.workspaceInviteToken.findUnique({
      where: { token: cleanToken },
      include: {
        workspace: {
          include: {
            organization: true,
            members: {
              where: { role: 'LEADER' },
              include: { user: true },
            },
          },
        },
      },
    });

    if (!tokenRecord) {
      return {
        valid: false,
        error: 'Invalid or unknown agent invitation token.',
      };
    }

    if (tokenRecord.role !== 'AGENT') {
      return {
        valid: false,
        error: 'This token is not an agent invitation token.',
      };
    }

    if (tokenRecord.isUsed) {
      return {
        valid: false,
        isUsed: true,
        error: `This agent token has already been claimed by ${tokenRecord.usedBy || 'another team member'} on ${tokenRecord.usedAt ? new Date(tokenRecord.usedAt).toLocaleString() : 'earlier'}. Each token can only be claimed once.`,
        workspaceName: tokenRecord.workspace?.name,
      };
    }

    const leaderMember = tokenRecord.workspace?.members[0];

    return {
      valid: true,
      token: tokenRecord.token,
      role: 'AGENT',
      workspace: {
        id: tokenRecord.workspace?.id,
        name: tokenRecord.workspace?.name,
        podCategory: tokenRecord.workspace?.podCategory,
        services: tokenRecord.workspace?.services,
      },
      organization: {
        id: tokenRecord.workspace?.organization?.id,
        name: tokenRecord.workspace?.organization?.name,
      },
      leaderName: leaderMember?.user?.fullName || 'Pod Leader',
    };
  }

  /**
   * Claim Agent Single-Use Token and Join Pod
   */
  async claimAgentToken(dto: {
    token: string;
    fullName: string;
    password?: string;
  }) {
    const { token, fullName, password } = dto;
    if (!token || !fullName || fullName.trim().length < 2) {
      throw new BadRequestException('Please provide a valid token and full name.');
    }
    const cleanToken = token.trim();
    const cleanName = fullName.trim();

    const agentStatus = await this.getAgentTokenStatus(cleanToken);
    if (!agentStatus.valid) {
      throw new BadRequestException(agentStatus.error || 'Token is not valid.');
    }

    const tokenRecord = await this.prisma.workspaceInviteToken.findUnique({
      where: { token: cleanToken },
      include: {
        workspace: {
          include: { members: true },
        },
      },
    });

    if (!tokenRecord) {
      throw new NotFoundException('Token not found.');
    }

    const workspace = tokenRecord.workspace;

    if (workspace.members.length >= workspace.maxMembers) {
      throw new BadRequestException(
        `Pod capacity is already filled (${workspace.members.length}/${workspace.maxMembers} seats).`,
      );
    }

    // Create Agent user
    const slug = cleanName
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')
      .slice(0, 10);
    const username = `${slug || 'agent'}_${Math.floor(1000 + Math.random() * 9000)}`;
    const email = `${username}@agent.${workspace.id.slice(0, 8)}.sentrix.local`;
    const passwordHash =
      password && password.trim() !== ''
        ? crypto.createHash('sha256').update(password.trim()).digest('hex')
        : crypto.createHash('sha256').update('0o0o 0o0o').digest('hex');

    const agentUser = await this.prisma.user.create({
      data: {
        username,
        fullName: cleanName,
        email,
        passwordHash,
        role: 'AGENT',
        organizationId: workspace.organizationId,
        onboardingCompleted: true,
      },
    });

    // Add to WorkspaceMember
    await this.prisma.workspaceMember.create({
      data: {
        workspaceId: workspace.id,
        userId: agentUser.id,
        role: 'AGENT',
      },
    });

    // Mark single-use token as consumed
    await this.prisma.workspaceInviteToken.update({
      where: { id: tokenRecord.id },
      data: {
        isUsed: true,
        usedBy: cleanName,
        usedAt: new Date(),
      },
    });

    try {
      this.eventsGateway.server?.emit('workspace:member-joined', {
        workspaceId: workspace.id,
        member: {
          id: agentUser.id,
          fullName: agentUser.fullName,
          role: 'AGENT',
        },
      });
    } catch {
      // ignore
    }

    return {
      success: true,
      user: {
        id: agentUser.id,
        username: agentUser.username,
        fullName: agentUser.fullName,
        email: agentUser.email,
        role: 'AGENT',
      },
      workspace: {
        id: workspace.id,
        name: workspace.name,
      },
    };
  }

  /**
   * Super Admin Executive Control Cockpit Data
   */
  async getSuperAdminCockpitData(identifier: string) {
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
                tickets: true,
                inviteTokens: { orderBy: { createdAt: 'desc' } },
              },
              orderBy: { createdAt: 'asc' },
            },
          },
        },
      },
    });

    if (!user || !user.organization) {
      throw new NotFoundException('Organization not found for this administrator.');
    }

    const org = user.organization;
    const workspaces = org.workspaces || [];

    // Calculate metrics
    let totalClaimedSeats = 0;
    let totalLockedPods = 0;
    const tokenAudit: any[] = [];
    const crisisTickets: any[] = [];

    const podsData = workspaces.map((ws) => {
      if (ws.isQuotaLocked) totalLockedPods++;
      totalClaimedSeats += ws.members.length;

      const leaderMember = ws.members.find((m) => m.role === 'LEADER');
      const openTickets = ws.tickets.filter(
        (t) => t.status !== 'RESOLVED' && t.status !== 'CLOSED',
      );

      // Collect crisis tickets
      ws.tickets.forEach((t) => {
        if (t.priority === 'CRITICAL' && t.status !== 'CLOSED') {
          crisisTickets.push({
            id: t.id,
            ticketNumber: t.ticketNumber,
            title: t.title,
            priority: t.priority,
            sentiment: t.sentiment,
            podName: ws.name,
            createdAt: t.createdAt,
          });
        }
      });

      // Collect tokens for audit
      ws.inviteTokens.forEach((tok) => {
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
        maxMembers: ws.maxMembers,
        membersCount: ws.members.length,
        leaderName: leaderMember?.user?.fullName || null,
        leaderClaimed: !!leaderMember,
        openTicketsCount: openTickets.length,
      };
    });

    tokenAudit.sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );

    return {
      organization: {
        id: org.id,
        name: org.name,
        industry: org.industry,
        totalSeats: org.totalSeats,
        planTier: org.planTier,
        leadershipMode: org.leadershipMode,
      },
      stats: {
        totalSeats: org.totalSeats,
        claimedSeats: totalClaimedSeats,
        seatUtilizationPercentage: Math.min(
          100,
          Math.round((totalClaimedSeats / (org.totalSeats || 1)) * 100),
        ),
        totalPods: workspaces.length,
        lockedPods: totalLockedPods,
        crisisCount: crisisTickets.length,
      },
      workspaces: podsData,
      tokenAudit,
      crisisTickets,
    };
  }

  /**
   * Regenerate a Single-Use Token for a Pod Leader or Frontline Agent
   * Invalidates old token and issues a fresh one
   */
  async regenerateToken(oldToken: string) {
    if (!oldToken || oldToken.trim() === '') {
      throw new BadRequestException('Token is required.');
    }
    const cleanToken = oldToken.trim();

    const tokenRecord = await this.prisma.workspaceInviteToken.findUnique({
      where: { token: cleanToken },
      include: { workspace: true },
    });

    if (!tokenRecord) {
      throw new NotFoundException('Token not found.');
    }

    // Invalidate old token
    await this.prisma.workspaceInviteToken.update({
      where: { id: tokenRecord.id },
      data: {
        isUsed: true,
        usedBy: 'REVOKED_FOR_REGENERATION',
        usedAt: new Date(),
      },
    });

    // Generate new token string
    const prefix = tokenRecord.role === 'LEADER' ? 'STX-LDR-' : 'STX-AGT-';
    const newTokenStr =
      prefix + crypto.randomBytes(3).toString('hex').toUpperCase();

    await this.prisma.workspaceInviteToken.create({
      data: {
        workspaceId: tokenRecord.workspaceId,
        token: newTokenStr,
        role: tokenRecord.role,
        isUsed: false,
      },
    });

    // If it was a leader token, update workspace.inviteToken
    if (tokenRecord.role === 'LEADER') {
      await this.prisma.workspace.update({
        where: { id: tokenRecord.workspaceId },
        data: { inviteToken: newTokenStr },
      });
    }

    this.logger.log(
      `Regenerated ${tokenRecord.role} token for Pod "${tokenRecord.workspace.name}": ${cleanToken} -> ${newTokenStr}`,
    );

    return {
      success: true,
      oldToken: cleanToken,
      newToken: newTokenStr,
      role: tokenRecord.role,
      workspaceId: tokenRecord.workspaceId,
      workspaceName: tokenRecord.workspace.name,
      joinUrl: `http://localhost:3000/join?token=${newTokenStr}`,
    };
  }
}
