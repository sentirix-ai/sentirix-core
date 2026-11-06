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
  isOnline?: boolean;
  presenceStatus?: 'ONLINE' | 'TERPUTUS' | 'OFFLINE';
  token?: string | null;
  tokenIsUsed?: boolean;
  needsRegeneration?: boolean;
  freshTokenReady?: boolean;
}

export interface WorkspaceDetailResponse {
  workspaceId: string;
  name: string;
  ownerName: string;
  isLeader?: boolean;
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
      include: {
        workspaceMembership: {
          include: {
            workspace: {
              include: {
                members: {
                  include: {
                    user: {
                      include: {
                        activitySessions: {
                          orderBy: { loginAt: 'desc' },
                          take: 1,
                        },
                      },
                    },
                  },
                  orderBy: { joinedAt: 'asc' },
                },
                inviteTokens: {
                  orderBy: { createdAt: 'desc' },
                },
              },
            },
          },
        },
        ownedWorkspaces: {
          include: {
            members: {
              include: {
                user: {
                  include: {
                    activitySessions: {
                      orderBy: { loginAt: 'desc' },
                      take: 1,
                    },
                  },
                },
              },
              orderBy: { joinedAt: 'asc' },
            },
            inviteTokens: {
              orderBy: { createdAt: 'desc' },
            },
          },
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    if (!user) {
      throw new NotFoundException(`User ${identifier} not found.`);
    }

    if (user.role === 'ADMIN' || user.username === 'pungkyrama') {
      throw new ForbiddenException('Admin accounts are excluded from workspace team links.');
    }

    // Check if user belongs to a Pod workspace first, then ownedWorkspaces
    let workspace = user.workspaceMembership?.workspace || user.ownedWorkspaces?.[0];

    // If not, create one (independent user setup)
    if (!workspace) {
      const initialToken = `STX-AGT-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
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
              role: 'AGENT',
            },
          },
        },
        include: {
          members: {
            include: {
              user: {
                include: {
                  activitySessions: {
                    orderBy: { loginAt: 'desc' },
                    take: 1,
                  },
                },
              },
            },
            orderBy: { joinedAt: 'asc' },
          },
          inviteTokens: {
            orderBy: { createdAt: 'desc' },
          },
        },
      });
      this.logger.log(`Created new workspace for user @${user.username} with initial single-use token.`);
    }

    const isLeader =
      user.workspaceMembership?.role === 'LEADER' ||
      (user.role as string) === 'LEADER' ||
      workspace.ownerId === user.id;

    const totalPodQuota = workspace.assignedQuota || workspace.maxMembers || 5;
    // For Leader, Active Team Capacity reflects the member quota (excluding leader).
    // E.g. Pod 1 has assignedQuota = 5 (1 Leader + 4 Members) -> capacity = 4 SEATS!
    const effectiveMaxMembers = isLeader ? Math.max(1, totalPodQuota - 1) : totalPodQuota;

    // Filter subordinate members (exclude the Leader themself)
    const subordinateMembers = isLeader
      ? (workspace.members || []).filter((m) => m.userId !== user.id && m.role !== 'LEADER')
      : (workspace.members || []);

    const now = Date.now();

    // Map subordinate members with real-time presence and token regeneration data
    const membersList: WorkspaceMemberInfo[] = subordinateMembers.map((m) => {
      const latestSession = m.user?.activitySessions?.[0];
      const isOnline = !!(
        latestSession &&
        latestSession.isOnline &&
        now - new Date(latestSession.lastHeartbeatAt).getTime() < 90000
      );

      let presenceStatus: 'ONLINE' | 'TERPUTUS' | 'OFFLINE' = 'OFFLINE';
      if (isOnline) {
        presenceStatus = 'ONLINE';
      } else {
        const isCloseBrowserOrDisconnect =
          latestSession?.logoutReason === 'BROWSER_CLOSED' ||
          latestSession?.logoutReason === 'UNEXPECTED_DISCONNECT';
        presenceStatus = isCloseBrowserOrDisconnect ? 'TERPUTUS' : 'OFFLINE';
      }

      // Correlate with token issued for this member
      const memberNameLower = (m.user?.fullName || '').toLowerCase().trim();
      const memberUsernameLower = (m.user?.username || '').toLowerCase().trim();

      const memberTokenRecord = workspace.inviteTokens?.find((tok) => {
        const usedByLower = (tok.usedBy || '').toLowerCase().trim();
        return (
          usedByLower &&
          (usedByLower === memberNameLower ||
            usedByLower === memberUsernameLower ||
            (memberNameLower && usedByLower.includes(memberNameLower)))
        );
      });

      const tokenString = memberTokenRecord?.token || null;
      const tokenIsUsed = memberTokenRecord?.isUsed ?? false;
      const needsRegeneration = !isOnline && (memberTokenRecord ? memberTokenRecord.isUsed : true);
      const freshTokenReady = !isOnline && memberTokenRecord ? !memberTokenRecord.isUsed : false;

      return {
        id: m.id,
        userId: m.userId,
        fullName: m.user?.fullName || m.user?.username || 'Team Agent',
        username: m.user?.username || '',
        role: m.role || 'AGENT',
        joinedAt: m.joinedAt,
        isOnline,
        presenceStatus,
        token: tokenString,
        tokenIsUsed,
        needsRegeneration,
        freshTokenReady,
      };
    });

    const currentMembersCount = membersList.length;
    const remainingSeats = Math.max(0, effectiveMaxMembers - currentMembersCount);

    // Ensure there is an active UNUSED AGENT token ready to copy/share if seats remain
    let activeToken = workspace.inviteTokens?.find(
      (t) => (t.role === 'AGENT' || !t.role) && !t.isUsed && !t.usedBy,
    );

    if (!activeToken && remainingSeats > 0) {
      const newTokenStr = `STX-AGT-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
      activeToken = await this.prisma.workspaceInviteToken.create({
        data: {
          workspaceId: workspace.id,
          token: newTokenStr,
          isUsed: false,
          role: 'AGENT',
        },
      });
      await this.prisma.workspace.update({
        where: { id: workspace.id },
        data: { inviteToken: newTokenStr },
      });
    }

    // Fallback token if workspace is full
    const displayToken =
      activeToken?.token ||
      workspace.inviteTokens?.find((t) => t.role === 'AGENT')?.token ||
      workspace.inviteTokens?.[0]?.token ||
      workspace.inviteToken;

    const baseUrl = process.env.FRONTEND_URL || 'http://localhost:3000';

    return {
      workspaceId: workspace.id,
      name: workspace.name,
      ownerName: user.fullName || user.username || 'Workspace Owner',
      isLeader,
      inviteToken: displayToken,
      inviteUrl: `${baseUrl}/join?token=${displayToken}`,
      isTokenUsed: activeToken ? activeToken.isUsed : false,
      maxMembers: effectiveMaxMembers,
      currentMembersCount,
      remainingSeats,
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
          { email: { equals: identifier, mode: 'insensitive' } },
        ],
      },
      include: {
        workspaceMembership: {
          include: {
            workspace: {
              include: { members: true },
            },
          },
        },
        ownedWorkspaces: {
          include: { members: true },
        },
      },
    });

    const activeWorkspace =
      user?.workspaceMembership?.workspace || user?.ownedWorkspaces?.[0];
    if (!user || !activeWorkspace) {
      throw new NotFoundException('Workspace not found for this user.');
    }

    const isLeader =
      user.workspaceMembership?.role === 'LEADER' ||
      (user.role as string) === 'LEADER' ||
      activeWorkspace.ownerId === user.id;

    const totalPodQuota = activeWorkspace.assignedQuota || activeWorkspace.maxMembers || 5;
    const effectiveMaxMembers = isLeader ? Math.max(1, totalPodQuota - 1) : totalPodQuota;
    const subordinateMembers = isLeader
      ? activeWorkspace.members.filter((m) => m.userId !== user.id && m.role !== 'LEADER')
      : activeWorkspace.members;

    if (subordinateMembers.length >= effectiveMaxMembers) {
      throw new BadRequestException(`Workspace is full (${effectiveMaxMembers}/${effectiveMaxMembers} members).`);
    }

    const newTokenStr = `STX-AGT-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    const newToken = await this.prisma.workspaceInviteToken.create({
      data: {
        workspaceId: activeWorkspace.id,
        token: newTokenStr,
        isUsed: false,
        role: 'AGENT',
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
      // 1. Immediately log out user activity session as MANUAL_LOGOUT in DB
      await this.prisma.userActivitySession.updateMany({
        where: { userId: memberId, isOnline: true },
        data: {
          isOnline: false,
          logoutAt: new Date(),
          logoutReason: 'MANUAL_LOGOUT',
        },
      });

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

      // Only delete membership for standalone demo workspaces without organization (preserve Multi-Pod team members)
      if (!membership.workspace.organizationId) {
        await this.prisma.workspaceMember.delete({
          where: { id: membership.id },
        });

        try {
          await this.prisma.user.delete({
            where: { id: memberId },
          });
        } catch (delErr) {
          this.logger.warn(`Could not delete member user ${memberId}: ${(delErr as Error)?.message}`);
        }
      }

      // Count remaining members
      const remainingCount = await this.prisma.workspaceMember.count({
        where: { workspaceId: wsId },
      });

      this.logger.log(`Member "${memberName}" logged out (MANUAL_LOGOUT). Remaining members: ${remainingCount}`);

      // Broadcast WebSocket notification to owner dashboard
      this.eventsGateway.server?.emit('team:member_left', {
        workspaceId: wsId,
        memberId,
        memberName,
        currentMembersCount: remainingCount,
      });

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

    // Determine if this is the last pod to lock quota (other pod(s) have already locked quota and no other unlocked pods remain)
    const isLastPod = otherUnlockedPodsCount === 0 && otherLockedPods.length > 0;

    // If it is the last pod, ONLY leave the single exact maximum quota (no options below 1..5, no options above 7..)!
    const allowedOptions = isLastPod
      ? [maxSubordinatesAllowed]
      : Array.from(
          { length: maxSubordinatesAllowed },
          (_, i) => i + 1,
        );

    const activeLeaderMember = currentWorkspace.members?.find(
      (m: any) => m.role === 'LEADER',
    );
    const isExistingLeader = !!activeLeaderMember;
    const existingLeaderName =
      activeLeaderMember?.user?.fullName ||
      activeLeaderMember?.user?.username ||
      tokenRecord.usedBy ||
      null;

    return {
      valid: true,
      token: tokenRecord.token,
      role: 'LEADER',
      isExistingLeader,
      existingLeaderName,
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
        isLastPod,
        maxSubordinatesAllowed,
        allowedOptions,
      },
    };
  }

  /**
   * Lock Leader Quota (Click Checkmark [✓]) & Auto-Generate Single-Use Agent Tokens
   * OR Re-login Existing Leader if Pod is already locked and active
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

    const tokenRecord = await this.prisma.workspaceInviteToken.findUnique({
      where: { token: cleanToken },
      include: {
        workspace: {
          include: {
            members: {
              include: { user: true },
            },
          },
        },
      },
    });

    if (!tokenRecord) {
      throw new NotFoundException('Token record not found.');
    }

    const workspace = tokenRecord.workspace;

    // Check if Pod ALREADY has a registered Leader (e.g. Meta, Tita re-logging in via regenerated token)
    const existingLeaderMember = workspace.members.find(
      (m: any) => m.role === 'LEADER',
    );

    if (existingLeaderMember && existingLeaderMember.user) {
      const leaderUser = existingLeaderMember.user;

      if (password && password.trim() !== '') {
        const passwordHash = crypto
          .createHash('sha256')
          .update(password.trim())
          .digest('hex');
        await this.prisma.user.update({
          where: { id: leaderUser.id },
          data: { passwordHash },
        });
      }

      // Mark single-use token as consumed upon successful login
      await this.prisma.workspaceInviteToken.update({
        where: { id: tokenRecord.id },
        data: {
          isUsed: true,
          usedBy: leaderUser.fullName || leaderUser.username,
          usedAt: new Date(),
        },
      });

      // Start presence activity session
      try {
        await this.prisma.userActivitySession.updateMany({
          where: { userId: leaderUser.id, isOnline: true },
          data: {
            isOnline: false,
            logoutAt: new Date(),
            logoutReason: 'SESI_BARU_DIMULAI',
          },
        });

        await this.prisma.userActivitySession.create({
          data: {
            userId: leaderUser.id,
            organizationId: workspace.organizationId,
            workspaceId: workspace.id,
            role: 'LEADER',
            loginAt: new Date(),
            lastHeartbeatAt: new Date(),
            isOnline: true,
          },
        });
      } catch (err) {
        this.logger.warn(`Could not start leader activity session: ${(err as Error)?.message}`);
      }

      // Fetch all agent tokens in this pod for the leader dashboard
      const agentTokens = await this.prisma.workspaceInviteToken.findMany({
        where: { workspaceId: workspace.id, role: 'AGENT' },
        select: { token: true },
      });

      this.logger.log(
        `Leader ${leaderUser.fullName} (@${leaderUser.username}) re-logged into Pod "${workspace.name}" via token ${cleanToken}.`,
      );

      return {
        success: true,
        isReLogin: true,
        leader: {
          id: leaderUser.id,
          username: leaderUser.username,
          fullName: leaderUser.fullName,
          email: leaderUser.email,
          role: 'LEADER',
          workspaceRole: 'LEADER',
          avatarText: (leaderUser.fullName || leaderUser.username || 'LD').slice(0, 2).toUpperCase(),
          workspaceId: workspace.id,
        },
        workspace: {
          id: workspace.id,
          name: workspace.name,
          assignedQuota: workspace.assignedQuota,
          isQuotaLocked: true,
        },
        agentTokens: agentTokens.map((t) => ({
          token: t.token,
          joinUrl: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/join?token=${t.token}`,
        })),
      };
    }

    const maxAllowed = quotaStatus.quotaStats.maxSubordinatesAllowed;
    // Auto-clamp chosen count to available capacity so leader activation never crashes
    const safeCount = Math.min(Math.max(1, chosenCount), maxAllowed);

    // 2. Create Leader User Account (First time activation)
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
    const totalPodQuota = 1 + safeCount; // 1 Leader + M Agen
    await this.prisma.workspace.update({
      where: { id: workspace.id },
      data: {
        assignedQuota: totalPodQuota,
        maxMembers: totalPodQuota,
        isQuotaLocked: true,
        lockedAt: new Date(),
      },
    });

    // Auto-lock neighboring pod if exactly 1 unlocked pod remains
    if (workspace.organizationId) {
      try {
        const remainingUnlocked = await this.prisma.workspace.findMany({
          where: {
            organizationId: workspace.organizationId,
            isQuotaLocked: false,
            id: { not: workspace.id },
          },
        });

        if (remainingUnlocked.length === 1) {
          const otherPod = remainingUnlocked[0];
          const allLocked = await this.prisma.workspace.findMany({
            where: {
              organizationId: workspace.organizationId,
              isQuotaLocked: true,
            },
          });
          const currentLockedSum = allLocked.reduce(
            (sum, p) => sum + p.assignedQuota,
            0,
          );
          const orgTotal =
            quotaStatus.organization?.totalSeats ||
            quotaStatus.quotaStats.totalSeats ||
            20;
          const remainder = Math.max(1, orgTotal - currentLockedSum);

          await this.prisma.workspace.update({
            where: { id: otherPod.id },
            data: {
              assignedQuota: remainder,
              maxMembers: remainder,
              isQuotaLocked: true,
              lockedAt: new Date(),
            },
          });
          this.logger.log(
            `Auto-locked neighboring Pod "${otherPod.name}" with remaining quota: ${remainder} seats.`,
          );
        }
      } catch (autoLockErr) {
        this.logger.warn(`Could not auto-lock neighboring pod: ${(autoLockErr as Error)?.message}`);
      }
    }

    // Start activity session for leader
    try {
      await this.prisma.userActivitySession.updateMany({
        where: { userId: leaderUser.id, isOnline: true },
        data: {
          isOnline: false,
          logoutAt: new Date(),
          logoutReason: 'SESI_BARU_DIMULAI',
        },
      });

      await this.prisma.userActivitySession.create({
        data: {
          userId: leaderUser.id,
          organizationId: workspace.organizationId,
          workspaceId: workspace.id,
          role: 'LEADER',
          loginAt: new Date(),
          lastHeartbeatAt: new Date(),
          isOnline: true,
        },
      });
    } catch (sessionErr) {
      this.logger.warn(`Failed to create leader activity session: ${(sessionErr as Error)?.message}`);
    }

    // 5. Mark Leader Token as Used (Single-Use Constraint)
    await this.prisma.workspaceInviteToken.update({
      where: { id: tokenRecord.id },
      data: {
        isUsed: true,
        usedBy: cleanName,
        usedAt: new Date(),
      },
    });

    // 6. Auto-generate exactly safeCount Single-Use Agent Tokens
    const agentTokens: any[] = [];
    for (let i = 0; i < safeCount; i++) {
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
      `Leader "${cleanName}" locked Pod "${workspace.name}" with 1 leader + ${safeCount} agents. Generated ${agentTokens.length} single-use agent tokens.`,
    );

    // 7. Emit WebSocket event for real-time quota sync and leader activation
    try {
      this.eventsGateway.server?.emit('workspace:quota-locked', {
        workspaceId: workspace.id,
        organizationId: workspace.organizationId,
        lockedPodQuota: totalPodQuota,
      });
      this.eventsGateway.server?.emit('leader:activated', {
        leaderName: cleanName,
        podName: workspace.name,
        workspaceId: workspace.id,
        organizationId: workspace.organizationId,
        agentQuota: safeCount,
        timestamp: new Date().toISOString(),
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

    const leaderMember =
      tokenRecord.workspace?.members?.find((m: any) => m.role === 'LEADER') ||
      tokenRecord.workspace?.members[0];

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
      leaderName: leaderMember?.user?.fullName || leaderMember?.user?.username || 'Pod Leader',
      assignedMemberName: tokenRecord.usedBy || null,
      isReLogin: !!tokenRecord.usedBy,
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
          include: {
            members: {
              include: { user: true },
            },
          },
        },
      },
    });

    if (!tokenRecord) {
      throw new NotFoundException('Token not found.');
    }

    const workspace = tokenRecord.workspace;

    // Check if an existing member with the exact same name or username already belongs to this workspace, or matches assigned token owner
    const allocatedName = (tokenRecord.usedBy || '').trim().toLowerCase();
    const existingMember = workspace.members.find(
      (m: any) =>
        m.user?.fullName?.trim().toLowerCase() === cleanName.toLowerCase() ||
        m.user?.username?.trim().toLowerCase() === cleanName.toLowerCase() ||
        (allocatedName && m.user?.fullName?.trim().toLowerCase() === allocatedName) ||
        (allocatedName && m.user?.username?.trim().toLowerCase() === allocatedName),
    );

    let agentUser: any = null;

    if (existingMember && existingMember.user) {
      // Re-login / restore access for existing member (e.g. Budi, Tini reclaiming access via regenerated token)
      agentUser = existingMember.user;
      if (password && password.trim() !== '') {
        const passwordHash = crypto
          .createHash('sha256')
          .update(password.trim())
          .digest('hex');
        await this.prisma.user.update({
          where: { id: agentUser.id },
          data: { passwordHash },
        });
      }
      this.logger.log(
        `Existing member "${cleanName}" (@${agentUser.username}) reclaimed token into Pod "${workspace.name}".`,
      );
    } else {
      // New member joining: check capacity strictly
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

      agentUser = await this.prisma.user.create({
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
    }

    // Mark single-use token as consumed
    await this.prisma.workspaceInviteToken.update({
      where: { id: tokenRecord.id },
      data: {
        isUsed: true,
        usedBy: cleanName,
        usedAt: existingMember ? (existingMember.joinedAt || new Date()) : new Date(),
      },
    });

    // Start activity session for agent
    try {
      await this.prisma.userActivitySession.updateMany({
        where: { userId: agentUser.id, isOnline: true },
        data: {
          isOnline: false,
          logoutAt: new Date(),
          logoutReason: 'SESI_BARU_DIMULAI',
        },
      });

      await this.prisma.userActivitySession.create({
        data: {
          userId: agentUser.id,
          organizationId: workspace.organizationId,
          workspaceId: workspace.id,
          role: 'AGENT',
          loginAt: new Date(),
          lastHeartbeatAt: new Date(),
          isOnline: true,
        },
      });
    } catch (sessionErr) {
      this.logger.warn(`Failed to create agent activity session: ${(sessionErr as Error)?.message}`);
    }

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
                tickets: {
                  include: {
                    messages: {
                      orderBy: { createdAt: 'asc' },
                    },
                  },
                },
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

        // Collect crisis tickets
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

    // Query presence and activity sessions for Leader & Member monitoring
    const allOrgUsers = await this.prisma.user.findMany({
      where: {
        OR: [
          { organizationId: org.id },
          { id: user.id },
        ],
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
          where: {
            status: { notIn: ['RESOLVED', 'CLOSED'] },
          },
          select: {
            id: true,
            ticketNumber: true,
            title: true,
            priority: true,
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    const presenceList = allOrgUsers.map((u) => {
      const isSuperAdmin = u.role === 'ADMIN' || u.id === user.id;
      const isLeader = u.workspaceMembership?.role === 'LEADER';
      const userRole = isSuperAdmin ? 'SUPER_ADMIN' : isLeader ? 'LEADER' : 'MEMBER';
      const podName =
        u.workspaceMembership?.workspace?.name ||
        (isSuperAdmin ? 'Executive Cockpit' : 'Belum Ditugaskan');

      const activeTicketsCount = (u as any).assignedTickets
        ? (u as any).assignedTickets.length
        : 0;

      const latestSession = u.activitySessions[0] || null;
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
      let operationalStateLabel = 'Siaga (Standby)';
      let workloadDescription = 'Siap Menerima Tiket';

      if (isSuperAdmin) {
        operationalState = 'EXECUTIVE_SUPERVISION';
        operationalStateLabel = 'Pengawasan Eksekutif';
        workloadDescription = 'Pusat Kendali Organisasi';
      } else if (isActuallyOnline) {
        if (activeTicketsCount > 0) {
          operationalState = 'SERVING';
          operationalStateLabel = 'Melayani Pelanggan';
          workloadDescription = `${activeTicketsCount} Tiket Aktif Ditangani`;
        } else {
          operationalState = 'STANDBY';
          operationalStateLabel = 'Siaga (Standby)';
          workloadDescription = 'Siap Menerima Tiket';
        }
      } else {
        const isCloseBrowserOrDisconnect =
          latestSession?.logoutReason === 'BROWSER_CLOSED' ||
          latestSession?.logoutReason === 'UNEXPECTED_DISCONNECT' ||
          !latestSession?.logoutReason;

        if (isCloseBrowserOrDisconnect) {
          operationalState = 'ABRUPT_DISCONNECT';
          operationalStateLabel = 'Terputus (Close Browser)';
          workloadDescription =
            activeTicketsCount > 0
              ? `Perhatian: ${activeTicketsCount} Tiket Ditinggalkan!`
              : 'Tidak Ada Tiket Tergantung';
        } else {
          operationalState = 'OFF_DUTY';
          operationalStateLabel = 'Off-Duty (Selesai Shift)';
          workloadDescription =
            activeTicketsCount > 0
              ? `${activeTicketsCount} Tiket Tertunda`
              : 'Meja Kerja Bebas';
        }
      }

      // Check if there was an unexpected disconnect
      let hadUnexpectedDisconnect = false;
      let unexpectedDisconnectTime: Date | null = null;
      let reconnectedTime: Date | null = null;
      let disconnectDowntimeSeconds = 0;

      for (let i = 0; i < u.activitySessions.length; i++) {
        const sess = u.activitySessions[i];
        if (
          sess.logoutReason === 'UNEXPECTED_DISCONNECT' ||
          sess.logoutReason === 'BROWSER_CLOSED'
        ) {
          hadUnexpectedDisconnect = true;
          unexpectedDisconnectTime = sess.logoutAt || sess.lastHeartbeatAt;
          if (i > 0) {
            const nextSess = u.activitySessions[i - 1];
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

      const sessionHistory = u.activitySessions.map((sess, sIdx) => {
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
          reconnectedAt = u.activitySessions[sIdx - 1].loginAt;
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
          isUserOnline: false,
          userStatus: 'UNCLAIMED',
          hadManualLogout: false,
        };
      }

      const matched = presenceList.find(
        (p) =>
          p.fullName?.toLowerCase() === effectiveUsedBy.toLowerCase() ||
          p.username?.toLowerCase() === effectiveUsedBy.toLowerCase(),
      );

      const hadManual =
        !matched?.isOnline &&
        (matched?.status === 'LOGOUT' ||
          matched?.sessionHistory?.[0]?.logoutReason === 'MANUAL_LOGOUT');

      const hadCloseBrowser =
        !matched?.isOnline && !hadManual;

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
        isUserOnline: matched ? matched.isOnline : false,
        userStatus: matched
          ? matched.isOnline
            ? 'ONLINE'
            : hadManual
              ? 'LOGOUT'
              : 'LOGOUT_CLOSE_BROWSER'
          : 'LOGOUT_CLOSE_BROWSER',
        hadManualLogout: hadManual,
        hadCloseBrowser: hadCloseBrowser,
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
      .reduce((sum, w) => sum + (w.assignedQuota || w.maxMembers || 0), 0);
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
        onlineCount: presenceList.filter((p) => p.role !== 'SUPER_ADMIN' && p.isOnline).length,
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

    // Generate new token string
    const prefix = tokenRecord.role === 'LEADER' ? 'STX-LDR-' : 'STX-AGT-';
    const newTokenStr =
      prefix + crypto.randomBytes(3).toString('hex').toUpperCase();

    let isAlreadyClaimed = false;
    let retainedUsedBy: string | null = null;
    let retainedUsedAt: Date | null = null;

    if (tokenRecord.role === 'LEADER') {
      const activeLeaderMember = await this.prisma.workspaceMember.findFirst({
        where: { workspaceId: tokenRecord.workspaceId, role: 'LEADER' },
        include: { user: true },
      });
      isAlreadyClaimed = !!activeLeaderMember || tokenRecord.isUsed;
      retainedUsedBy =
        activeLeaderMember?.user?.fullName ||
        activeLeaderMember?.user?.username ||
        tokenRecord.usedBy;
      retainedUsedAt = tokenRecord.usedAt || activeLeaderMember?.joinedAt || new Date();
    } else {
      // For AGENT member:
      // If token was already used or had an assigned user, preserve their activated status and name
      const previousName = (tokenRecord.usedBy || '').trim();
      if (previousName || tokenRecord.isUsed) {
        const activeMember = await this.prisma.workspaceMember.findFirst({
          where: {
            workspaceId: tokenRecord.workspaceId,
            role: 'AGENT',
            OR: [
              { user: { fullName: { equals: previousName, mode: 'insensitive' } } },
              { user: { username: { equals: previousName, mode: 'insensitive' } } },
            ],
          },
          include: { user: true },
        });

        if (activeMember && activeMember.user) {
          isAlreadyClaimed = true;
          retainedUsedBy = activeMember.user.fullName || activeMember.user.username;
          retainedUsedAt = activeMember.joinedAt || tokenRecord.usedAt || new Date();
        } else if (previousName) {
          isAlreadyClaimed = true;
          retainedUsedBy = previousName;
          retainedUsedAt = tokenRecord.usedAt || new Date();
        }
      }
    }

    // Update the existing token in-place to avoid bloated duplicate rows
    await this.prisma.workspaceInviteToken.update({
      where: { id: tokenRecord.id },
      data: {
        token: newTokenStr,
        isUsed: false,
        usedBy: retainedUsedBy,
        usedAt: null,
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
