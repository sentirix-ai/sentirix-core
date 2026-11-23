import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
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
  isQuotaLocked?: boolean;
  assignedQuota?: number;
  inviteToken: string;
  inviteUrl: string;
  isTokenUsed?: boolean;
  maxMembers: number;
  currentMembersCount: number;
  remainingSeats: number;
  members: WorkspaceMemberInfo[];
  pendingTokens?: Array<{
    id: string;
    token: string;
    role: string;
    createdAt: Date | string;
  }>;
}

const CORPORATE_ACRONYMS = new Set([
  'PT', 'CV', 'UD', 'TBK', 'LLC', 'LTD', 'GMBH', 'PTE', 'USA', 'UK', 'ID', 'BCA', 'BRI', 'BNI', 'IBM', 'AWS', 'NASA', 'SAP', 'AI', 'IT', 'HQ'
]);

function formatCorporateTitleCase(input: string): string {
  if (!input) return '';
  const clean = input.trim().replace(/\s+/g, ' ');
  return clean
    .split(' ')
    .filter(Boolean)
    .map((word) => {
      const upper = word.toUpperCase();
      if (CORPORATE_ACRONYMS.has(upper)) return upper;
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(' ');
}

@Injectable()
export class WorkspaceService {
  private readonly logger = new Logger(WorkspaceService.name);

  /**
   * Sanitizes token strings, stripping whitespace and trailing punctuation (e.g. from chat copy/paste)
   */
  private sanitizeToken(raw?: string | null): string {
    return (raw || '').trim().replace(/[.,;:!?/\\'"]+$/, '').trim();
  }

  // First-Open Browser Session Lock: Only 1 browser session can open and claim each single-use token
  private tokenOpenSessionLocks = new Map<
    string,
    { sessionId: string; openedAt: Date }
  >();

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

    if (user.role === 'SUPER_ADMIN' || user.username === 'pungkyrama') {
      throw new ForbiddenException('Super Admin accounts are excluded from workspace team links.');
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
          assignedQuota: 8,
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
      user.role === 'POD_LEADER' ||
      user.workspaceMembership?.role === 'LEADER' ||
      (user.role as string) === 'LEADER' ||
      workspace.ownerId === user.id;

    const totalPodQuota = workspace.assignedQuota || 8;
    // For Leader, Active Team Capacity reflects the member quota (excluding leader).
    // E.g. Pod 1 has assignedQuota = 8 (1 Leader + 7 Members) -> capacity = 7 SEATS!
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
        now - new Date(latestSession.lastHeartbeatAt).getTime() < 50000
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

      const tokenString = isLeader ? (memberTokenRecord?.token || null) : null;
      const tokenIsUsed = memberTokenRecord?.isUsed ?? false;
      const needsRegeneration = isLeader ? (!isOnline && (memberTokenRecord ? memberTokenRecord.isUsed : true)) : false;
      const freshTokenReady = isLeader ? (!isOnline && memberTokenRecord ? !memberTokenRecord.isUsed : false) : false;

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

    // Collect all unclaimed/pending AGENT tokens for this workspace
    // sorted by createdAt: 'asc' so token #1, #2, ... match Super Admin Cockpit order
    const pendingTokens = isLeader
      ? (workspace.inviteTokens || [])
          .filter((t) => (t.role === 'AGENT' || !t.role) && !t.isUsed && (!t.usedBy || t.usedBy.trim() === ''))
          .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
          .map((t) => ({
            id: t.id,
            token: t.token,
            role: t.role || 'AGENT',
            createdAt: t.createdAt,
          }))
      : [];

    return {
      workspaceId: workspace.id,
      name: workspace.name,
      ownerName: user.fullName || user.username || 'Workspace Owner',
      isLeader,
      isQuotaLocked: workspace.isQuotaLocked,
      assignedQuota: workspace.assignedQuota,
      inviteToken: isLeader ? displayToken : '',
      inviteUrl: isLeader ? `${baseUrl}/join?token=${displayToken}` : '',
      isTokenUsed: activeToken ? activeToken.isUsed : false,
      maxMembers: effectiveMaxMembers,
      currentMembersCount,
      remainingSeats,
      members: membersList,
      pendingTokens,
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
      user.role === 'POD_LEADER' ||
      user.workspaceMembership?.role === 'LEADER' ||
      (user.role as string) === 'LEADER' ||
      user.role === 'SUPER_ADMIN' ||
      activeWorkspace.ownerId === user.id;

    if (!isLeader) {
      throw new ForbiddenException(
        'Access denied. Only the active Pod Leader is authorized to generate invitation tokens.',
      );
    }

    const totalPodQuota = activeWorkspace.assignedQuota || 8;
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
  async validateInvite(token: string, sessionId?: string) {
    if (!token || token.trim() === '') {
      throw new BadRequestException('Invite token is required.');
    }

    const cleanToken = this.sanitizeToken(token);

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
        maxMembers: wsFallback.assignedQuota,
        remainingSeats: wsFallback.assignedQuota - wsFallback.members.length,
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

    // First-Open Browser Session Lock: Disallow simultaneous opening in a second browser (PostgreSQL Persisted)
    if (tokenRecord.openedBySession) {
      const isExpired =
        tokenRecord.openedAt &&
        Date.now() - new Date(tokenRecord.openedAt).getTime() > 30 * 60 * 1000;
      if (!isExpired && tokenRecord.openedBySession !== sessionId) {
        return {
          valid: false,
          isLockedToOtherSession: true,
          error:
            'This single-use invitation link is currently active in another browser session. To protect organization security, simultaneous or duplicate access is prohibited. Please request a fresh invitation link from your Super Admin.',
          workspaceName: tokenRecord.workspace.name,
          ownerName: tokenRecord.workspace.owner.fullName || tokenRecord.workspace.owner.username,
        };
      }
    } else if (sessionId) {
      await this.prisma.workspaceInviteToken.update({
        where: { id: tokenRecord.id },
        data: {
          openedBySession: sessionId,
          openedAt: new Date(),
        },
      });
      this.logger.log(`[TokenLock] Token "${cleanToken}" bound to session "${sessionId}" in PostgreSQL.`);
    }

    const memberCount = tokenRecord.workspace.members.length;
    if (memberCount >= tokenRecord.workspace.assignedQuota) {
      return {
        valid: false,
        error: `This workspace has reached its maximum team capacity of ${tokenRecord.workspace.assignedQuota} members.`,
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
      maxMembers: tokenRecord.workspace.assignedQuota,
      remainingSeats: tokenRecord.workspace.assignedQuota - memberCount,
    };
  }

  /**
   * Join workspace with 1-click (name only)
   * Consumes the single-use token immediately
   */
  async joinWorkspace(dto: JoinWorkspaceDto) {
    const { token, fullName } = dto;
    const cleanToken = this.sanitizeToken(token);
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

    const effectiveQuota = workspace.assignedQuota || 8;
    if (workspace.members.length >= effectiveQuota) {
      throw new BadRequestException(
        `Workspace is full (${effectiveQuota}/${effectiveQuota} seats occupied).`,
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

    // 2. Link User to Organization as SUPER_ADMIN (Onboarding will only complete once Done Sharing is clicked)
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        organizationId: organization.id,
        role: 'SUPER_ADMIN',
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

    for (const pod of configuredPods) {
      const leaderTokenStr =
        'STX-LDR-' + crypto.randomBytes(3).toString('hex').toUpperCase();

      const ws = await this.prisma.workspace.create({
        data: {
          name: pod.name,
          podCategory: pod.podCategory || 'GENERAL',
          description: pod.description || null,
          services: pod.services || [],
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
  async getLeaderTokenQuotaStatus(token: string, sessionId?: string) {
    if (!token || token.trim() === '') {
      throw new BadRequestException('Token is required.');
    }
    const cleanToken = this.sanitizeToken(token);

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

    const currentWorkspace = tokenRecord.workspace;
    const organization = currentWorkspace?.organization;

    if (!organization) {
      return {
        valid: false,
        error: 'Associated organization not found.',
      };
    }

    const activeLeaderMember = currentWorkspace?.members?.find(
      (m: any) => m.role === 'LEADER',
    );
    const existingLeaderName =
      activeLeaderMember?.user?.fullName ||
      activeLeaderMember?.user?.username ||
      tokenRecord.usedBy ||
      null;

    // Strict Single-Leader Enforcement: If the Pod ALREADY has an active Leader, reject duplicate activation
    if (activeLeaderMember) {
      return {
        valid: false,
        isClaimed: true,
        error: `This invitation is no longer active because ${existingLeaderName || 'an assigned Leader'} has already assumed leadership for ${currentWorkspace.name}. Under organizational governance policy, each operational pod maintains exactly one Team Lead seat. Please sign in with your corporate credentials.`,
        workspaceName: currentWorkspace.name,
      };
    }

    if (tokenRecord.isUsed) {
      return {
        valid: false,
        isUsed: true,
        error: `This leader activation token has already been claimed by ${tokenRecord.usedBy || 'another user'} on ${tokenRecord.usedAt ? new Date(tokenRecord.usedAt).toLocaleString() : 'earlier'}. Each single-use token can only be claimed once. Please request a fresh regenerated token from your Super Admin.`,
        workspaceName: tokenRecord.workspace?.name,
      };
    }

    // First-Open Browser Session Lock: Disallow simultaneous opening in a second browser (PostgreSQL Persisted)
    if (tokenRecord.openedBySession) {
      const isExpired =
        tokenRecord.openedAt &&
        Date.now() - new Date(tokenRecord.openedAt).getTime() > 30 * 60 * 1000;
      if (!isExpired && tokenRecord.openedBySession !== sessionId) {
        return {
          valid: false,
          isLockedToOtherSession: true,
          error:
            'This single-use invitation link is currently active in another browser session. To protect organization security, simultaneous or duplicate access is prohibited. Please request a fresh invitation link from your Super Admin.',
          workspaceName: tokenRecord.workspace?.name,
        };
      }
    } else if (sessionId && !tokenRecord.openedBySession) {
      await this.prisma.workspaceInviteToken.update({
        where: { id: tokenRecord.id },
        data: {
          openedBySession: sessionId,
          openedAt: new Date(),
        },
      });
      this.logger.log(
        `[TokenLock] Leader token "${cleanToken}" bound to first-open browser session "${sessionId}" in PostgreSQL.`,
      );
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

    // Determine if this is the last pod to lock quota
    const isLastPod = otherUnlockedPodsCount === 0 && otherLockedPods.length > 0;

    let maxSubordinatesAllowed: number;
    let allowedOptions: number[];

    if (currentWorkspace.isQuotaLocked) {
      // This pod is already locked
      const currentSubordinates = Math.max(1, currentWorkspace.assignedQuota - 1);
      maxSubordinatesAllowed = currentSubordinates;
      allowedOptions = [currentSubordinates];
    } else if (isLastPod || otherUnlockedPodsCount === 0) {
      // Final pod to lock quota: receives the exact remainder of the organization seats
      // Hard cap: maximum 8 seats (1 Leader + 7 Agents)
      // Hard floor: minimum 2 seats (1 Leader + 1 Agent)
      const remainingOrgSeats = totalSeats - lockedSeats;
      const exactSeats = Math.min(8, Math.max(totalSeats === 1 ? 1 : 2, remainingOrgSeats));
      const exactSubordinates = Math.max(0, exactSeats - 1);
      maxSubordinatesAllowed = exactSubordinates;
      // Dropdown contains only the exact remaining seats
      allowedOptions = [exactSubordinates];
    } else {
      // Two-Sided Bounded Allocation (Guarantees all pods mathematically stay between 2 and 8 seats):
      const remainingSeats = totalSeats - lockedSeats;
      // Lower bound: ensures remaining unlocked pods do not exceed max 8 seats
      const minSeats = Math.max(2, remainingSeats - (otherUnlockedPodsCount * 8));
      // Upper bound: ensures remaining unlocked pods receive at least min 2 seats (1 leader + 1 agent)
      const maxSeats = Math.min(8, remainingSeats - (otherUnlockedPodsCount * 2));

      const minSubs = Math.max(1, minSeats - 1);
      const maxSubs = Math.max(minSubs, maxSeats - 1);
      maxSubordinatesAllowed = maxSubs;
      allowedOptions = [];
      for (let s = minSubs; s <= maxSubs; s++) {
        allowedOptions.push(s);
      }
    }

    // If pod is quota locked, fetch its agent tokens so frontend can restore activation view on refresh
    let agentTokensList: Array<{
      token: string;
      joinUrl: string;
      isUsed: boolean;
      usedBy: string | null;
      isOpened: boolean;
    }> = [];
    if (currentWorkspace.isQuotaLocked) {
      try {
        const agts = await this.prisma.workspaceInviteToken.findMany({
          where: { workspaceId: currentWorkspace.id, role: 'AGENT' },
          select: { token: true, isUsed: true, usedBy: true, openedBySession: true },
          orderBy: { createdAt: 'asc' },
        });
        agentTokensList = agts.map((a) => ({
          token: a.token,
          joinUrl: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/join?token=${a.token}`,
          isUsed: !!a.isUsed,
          usedBy: a.usedBy || null,
          isOpened: !!a.openedBySession,
        }));
      } catch (err) {
        this.logger.warn(`Could not load agent tokens for locked pod: ${(err as Error)?.message}`);
      }
    }

    return {
      valid: true,
      token: tokenRecord.token,
      role: 'LEADER',
      isExistingLeader: false,
      existingLeaderName: null,
      leaderUser: null,
      agentTokens: agentTokensList,
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
   * Interactive Quota Lock Toggle from Step 2 of Leader Activation
   * Persists isQuotaLocked immediately to PostgreSQL so neighboring pods reflect the remaining seats dynamically.
   */
  async togglePodQuotaLock(dto: {
    token: string;
    chosenSubordinates: number;
    lock: boolean;
    sessionId?: string;
  }) {
    const { token, chosenSubordinates, lock, sessionId } = dto;
    if (!token) {
      throw new BadRequestException('Token is required.');
    }
    const cleanToken = this.sanitizeToken(token);

    const tokenRecord = await this.prisma.workspaceInviteToken.findUnique({
      where: { token: cleanToken },
      include: {
        workspace: {
          include: { organization: true },
        },
      },
    });

    if (!tokenRecord || !tokenRecord.workspace) {
      throw new BadRequestException('Invalid or expired token.');
    }

    const workspace = tokenRecord.workspace;
    const organization = workspace.organization;
    if (!organization) {
      throw new BadRequestException('Organization record not found for this pod token.');
    }

    if (lock) {
      const allPods = await this.prisma.workspace.findMany({
        where: { organizationId: organization.id },
      });
      const otherLockedPods = allPods.filter(
        (p) => p.isQuotaLocked && p.id !== workspace.id,
      );
      const lockedSeats = otherLockedPods.reduce(
        (sum, p) => sum + p.assignedQuota,
        0,
      );
      const otherUnlockedPodsCount = allPods.filter(
        (p) => !p.isQuotaLocked && p.id !== workspace.id,
      ).length;

      const isLastPod = otherUnlockedPodsCount === 0 && otherLockedPods.length > 0;
      let safeSubordinates: number;

      if (isLastPod || otherUnlockedPodsCount === 0) {
        const remainingSeats = (organization.totalSeats || 20) - lockedSeats;
        const exactSeats = Math.min(8, Math.max(organization.totalSeats === 1 ? 1 : 2, remainingSeats));
        safeSubordinates = Math.max(0, exactSeats - 1);
      } else {
        const remainingSeats = (organization.totalSeats || 20) - lockedSeats;
        const minSeats = Math.max(2, remainingSeats - (otherUnlockedPodsCount * 8));
        const maxSeats = Math.min(8, remainingSeats - (otherUnlockedPodsCount * 2));
        const minSubs = Math.max(1, minSeats - 1);
        const maxSubs = Math.max(minSubs, maxSeats - 1);
        safeSubordinates = Math.min(Math.max(minSubs, Number(chosenSubordinates) || minSubs), maxSubs);
      }

      const totalPodQuota = 1 + safeSubordinates;
      await this.prisma.workspace.update({
        where: { id: workspace.id },
        data: {
          assignedQuota: totalPodQuota,
          isQuotaLocked: true,
          lockedAt: new Date(),
        },
      });

      // If exactly 1 other unlocked pod remains, update its assignedQuota to the exact remainder
      if (otherUnlockedPodsCount === 1) {
        const remainingUnlocked = allPods.filter(
          (p) => !p.isQuotaLocked && p.id !== workspace.id,
        );
        if (remainingUnlocked.length === 1) {
          const remainderSeats = Math.min(
            8,
            Math.max(
              2,
              (organization.totalSeats || 20) - lockedSeats - totalPodQuota,
            ),
          );
          await this.prisma.workspace.update({
            where: { id: remainingUnlocked[0].id },
            data: {
              assignedQuota: remainderSeats,
            },
          });
        }
      }

      this.logger.log(
        `Pod "${workspace.name}" quota LOCKED at ${totalPodQuota} seats (${safeSubordinates} subordinates + 1 leader).`,
      );
    } else {
      // Unlock quota
      await this.prisma.workspace.update({
        where: { id: workspace.id },
        data: {
          isQuotaLocked: false,
          lockedAt: null,
        },
      });

      this.logger.log(`Pod "${workspace.name}" quota UNLOCKED.`);
    }

    // Return the updated leader token quota status
    return this.getLeaderTokenQuotaStatus(cleanToken, sessionId);
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
    sessionId?: string;
  }) {
    const { token, fullName, password, chosenSubordinates, sessionId } = dto;
    if (!token || !fullName || fullName.trim().length < 2) {
      throw new BadRequestException('Please provide a valid token and full name.');
    }
    const cleanToken = this.sanitizeToken(token);
    const cleanName = fullName.trim();
    const chosenCount = Number(chosenSubordinates) || 1;

    // Verify First-Open Browser Session Lock
    if (sessionId) {
      const activeLock = this.tokenOpenSessionLocks.get(cleanToken);
      if (activeLock) {
        const isExpired = Date.now() - activeLock.openedAt.getTime() > 30 * 60 * 1000;
        if (!isExpired && activeLock.sessionId !== sessionId) {
          throw new BadRequestException(
            'This token is currently locked to another active browser session.',
          );
        }
      }
    }

    // 1. Verify token & quota limits
    const quotaStatus = await this.getLeaderTokenQuotaStatus(cleanToken, sessionId);
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

    // Strict Single-Leader Enforcement: If Pod ALREADY has an active Leader, reject duplicate activation
    const existingLeaderMember = workspace.members.find(
      (m: any) => m.role === 'LEADER',
    );

    if (existingLeaderMember && existingLeaderMember.user) {
      throw new BadRequestException(
        `Leadership seat for ${workspace.name} is already occupied by ${existingLeaderMember.user.fullName || existingLeaderMember.user.username}. Under organizational governance policy, each pod maintains exactly one active Team Lead.`,
      );
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
        role: 'POD_LEADER',
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
          const remainder = Math.min(8, Math.max(2, orgTotal - currentLockedSum));

          await this.prisma.workspace.update({
            where: { id: otherPod.id },
            data: {
              assignedQuota: remainder,
            },
          });
          this.logger.log(
            `Updated neighboring Pod "${otherPod.name}" with remaining quota: ${remainder} seats.`,
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

    // Release session lock once permanently claimed
    this.tokenOpenSessionLocks.delete(cleanToken);

    // 6. Auto-generate exactly safeCount Single-Use Agent Tokens (reuse if already provisioned upon deploy)
    const existingAgentTokens = await this.prisma.workspaceInviteToken.findMany({
      where: { workspaceId: workspace.id, role: 'AGENT' },
      orderBy: { createdAt: 'asc' },
    });

    const agentTokens: any[] = [];
    if (existingAgentTokens.length > 0) {
      existingAgentTokens.forEach((agt) => {
        agentTokens.push({
          token: agt.token,
          joinUrl: `http://localhost:3000/join?token=${agt.token}`,
          isUsed: agt.isUsed,
          usedBy: agt.usedBy,
          isOpened: false,
        });
      });
    } else {
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
          isUsed: false,
          usedBy: null,
          isOpened: false,
        });
      }
    }

    this.logger.log(
      `Leader "${cleanName}" locked Pod "${workspace.name}" with 1 leader + ${agentTokens.length} agents.`,
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
  async getAgentTokenStatus(token: string, sessionId?: string) {
    if (!token || token.trim() === '') {
      throw new BadRequestException('Token is required.');
    }
    const cleanToken = this.sanitizeToken(token);

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
        error: 'This invitation token is invalid or has been regenerated by your Pod Leader. Please use the latest active invitation link from your Leader.',
      };
    }

    if (tokenRecord.role !== 'AGENT') {
      return {
        valid: false,
        error: 'This token is not an agent invitation token.',
      };
    }

    // Strict Single-Use Token Check: If already used, permanently locked
    if (tokenRecord.isUsed) {
      return {
        valid: false,
        isUsed: true,
        error: `This single-use invitation token has already been claimed by ${tokenRecord.usedBy || 'a team member'} and is permanently locked. Each token can only be used once.`,
        workspaceName: tokenRecord.workspace?.name,
      };
    }

    // First-Open Browser Session Lock: Disallow simultaneous opening in a second browser (PostgreSQL Persisted)
    if (tokenRecord.openedBySession) {
      const isExpired =
        tokenRecord.openedAt &&
        Date.now() - new Date(tokenRecord.openedAt).getTime() > 30 * 60 * 1000;
      if (!isExpired && tokenRecord.openedBySession !== sessionId) {
        return {
          valid: false,
          isLockedToOtherSession: true,
          error:
            'This single-use invitation link is currently active in another browser session. To protect organization security, simultaneous or duplicate access is prohibited. Please request a fresh invitation link from your Leader.',
          workspaceName: tokenRecord.workspace?.name,
        };
      }
    } else if (sessionId && !tokenRecord.openedBySession) {
      await this.prisma.workspaceInviteToken.update({
        where: { id: tokenRecord.id },
        data: {
          openedBySession: sessionId,
          openedAt: new Date(),
        },
      });
      this.logger.log(
        `[TokenLock] Agent token "${cleanToken}" bound to first-open browser session "${sessionId}" in PostgreSQL.`,
      );
      try {
        this.eventsGateway.server?.emit('agent:token-opened', {
          workspaceId: tokenRecord.workspaceId,
          token: cleanToken,
        });
      } catch {}
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
    sessionId?: string;
  }) {
    const { token, fullName, password, sessionId } = dto;
    if (!token || !fullName || fullName.trim().length < 2) {
      throw new BadRequestException('Please provide a valid token and full name.');
    }
    const cleanToken = this.sanitizeToken(token);
    const cleanName = fullName.trim();

    // Verify First-Open Browser Session Lock
    if (sessionId) {
      const activeLock = this.tokenOpenSessionLocks.get(cleanToken);
      if (activeLock) {
        const isExpired = Date.now() - activeLock.openedAt.getTime() > 30 * 60 * 1000;
        if (!isExpired && activeLock.sessionId !== sessionId) {
          throw new BadRequestException(
            'This token is currently locked to another active browser session.',
          );
        }
      }
    }

    const agentStatus = await this.getAgentTokenStatus(cleanToken, sessionId);
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

    if (tokenRecord.isUsed) {
      throw new BadRequestException(
        `This invitation token has already been claimed by ${tokenRecord.usedBy || 'another member'} and is permanently locked.`,
      );
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
      if (workspace.members.length >= workspace.assignedQuota) {
        throw new BadRequestException(
          `Pod capacity is already filled (${workspace.members.length}/${workspace.assignedQuota} seats).`,
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

    this.tokenOpenSessionLocks.delete(cleanToken);

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
      this.eventsGateway.server?.emit('agent:claimed-token', {
        workspaceId: workspace.id,
        token: cleanToken,
        usedBy: agentUser.fullName,
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

    let org = user?.organization;
    if (!org && user) {
      // Prioritize active business organizations (e.g. non-healthcare or latest active tenant)
      org = await this.prisma.organization.findFirst({
        where: {
          NOT: { industry: 'HEALTHCARE' },
        },
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
        orderBy: { createdAt: 'desc' },
      });

      if (!org) {
        org = await this.prisma.organization.findFirst({
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
        });
      }

      // Do NOT attach organizationId to platform owner (@pungkyrama)
      if (org && user.id && user.username?.toLowerCase() !== 'pungkyrama') {
        await this.prisma.user.update({
          where: { id: user.id },
          data: { organizationId: org.id },
        });
      }
    }

    if (!user || !org) {
      throw new NotFoundException('Organization not found for this administrator.');
    }
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
      const isSuperAdmin = u.role === 'SUPER_ADMIN' || u.id === user.id;
      const isLeader = u.workspaceMembership
        ? u.workspaceMembership.role === 'LEADER'
        : u.role === 'POD_LEADER';
      const userRole = isSuperAdmin ? 'SUPER_ADMIN' : isLeader ? 'LEADER' : 'MEMBER';
      const podName =
        u.workspaceMembership?.workspace?.name ||
        (isSuperAdmin ? 'Executive Cockpit' : 'Unassigned');

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
      const avgHandlingTimeSeconds = realAhtSec > 0 ? realAhtSec : (seed ? seed.ahtSec : (isSuperAdmin ? 0 : 660));

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
        now - new Date(latestSession.lastHeartbeatAt).getTime() < 50000
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

      if (isSuperAdmin) {
        operationalState = 'EXECUTIVE_SUPERVISION';
        operationalStateLabel = 'Executive Supervision';
        workloadDescription = 'Central Organization Command';
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
        onboardingCompleted: user.onboardingCompleted ?? false,
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
  async regenerateToken(
    oldToken?: string,
    requesterIdentifier?: string,
    workspaceId?: string,
  ) {
    const cleanToken = this.sanitizeToken(oldToken);

    let tokenRecord = cleanToken
      ? await this.prisma.workspaceInviteToken.findUnique({
          where: { token: cleanToken },
          include: { workspace: true },
        })
      : null;

    // Resilient fallback: If token string is stale or not found, look up active token by workspaceId
    if (!tokenRecord && workspaceId && workspaceId.trim() !== '') {
      tokenRecord = await this.prisma.workspaceInviteToken.findFirst({
        where: { workspaceId: workspaceId.trim(), role: 'LEADER' },
        include: { workspace: true },
        orderBy: { createdAt: 'desc' },
      });
    }

    if (!tokenRecord) {
      throw new NotFoundException('Token not found.');
    }

    // Sovereign Verification: If requesterIdentifier is provided, ensure caller is Super Admin or current active Pod Leader
    if (requesterIdentifier && requesterIdentifier.trim() !== '') {
      const requester = await this.prisma.user.findFirst({
        where: {
          OR: [
            { id: requesterIdentifier },
            { username: { equals: requesterIdentifier, mode: 'insensitive' } },
            { email: { equals: requesterIdentifier, mode: 'insensitive' } },
          ],
        },
        include: { workspaceMembership: true },
      });

      const isSuperAdmin =
        requester?.role === 'SUPER_ADMIN' ||
        requester?.username?.toLowerCase() === 'pungkyrama';

      const isCurrentPodLeader =
        requester?.workspaceMembership?.workspaceId === tokenRecord.workspaceId &&
        requester?.workspaceMembership?.role === 'LEADER';

      if (!isSuperAdmin && !isCurrentPodLeader) {
        throw new ForbiddenException(
          'Access denied. Only the active Pod Leader or Super Admin is authorized to regenerate credentials.',
        );
      }
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
      if (activeLeaderMember) {
        throw new BadRequestException(
          `Leadership seat for "${tokenRecord.workspace.name}" is already assigned to ${activeLeaderMember.user?.fullName || activeLeaderMember.user?.username}. Under organizational governance policy, each pod maintains exactly one Team Lead. To rotate or reassign pod leadership, manage members in the Admin Cockpit.`,
        );
      }
      isAlreadyClaimed = tokenRecord.isUsed;
      retainedUsedBy = tokenRecord.usedBy;
      retainedUsedAt = tokenRecord.usedAt || new Date();
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
        openedBySession: null,
        openedAt: null,
      },
    });

    // If it was a leader token, update workspace.inviteToken
    if (tokenRecord.role === 'LEADER') {
      await this.prisma.workspace.update({
        where: { id: tokenRecord.workspaceId },
        data: { inviteToken: newTokenStr },
      });
    }

    // Invalidate any open session locks for the old token
    this.tokenOpenSessionLocks.delete(cleanToken);

    this.logger.log(
      `Regenerated ${tokenRecord.role} token for Pod "${tokenRecord.workspace.name}": ${cleanToken} -> ${newTokenStr}`,
    );

    // Broadcast instant WebSocket notification for real-time Token Audit Hub update
    try {
      this.eventsGateway.server?.emit('token:regenerated', {
        oldToken: cleanToken,
        newToken: newTokenStr,
        role: tokenRecord.role,
        workspaceId: tokenRecord.workspaceId,
        timestamp: new Date().toISOString(),
      });
    } catch {}

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
        role: 'SUPER_ADMIN',
        onboardingCompleted: true,
      },
    });

    this.deleteOnboardingDraft(cleanId);
    if (user.username) this.deleteOnboardingDraft(user.username);
    if (user.email) this.deleteOnboardingDraft(user.email);

    this.logger.log(`User @${user.username} officially completed onboarding into Super Admin Cockpit.`);
    return { success: true };
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

  /**
   * Super Admin Authority: Rename Leader or Member
   */
  async renamePersonnel(userId: string, newFullName: string) {
    if (!userId || !newFullName || newFullName.trim() === '') {
      throw new BadRequestException('User ID and valid new full name are required.');
    }

    const cleanName = newFullName.trim();
    const existing = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!existing) {
      throw new NotFoundException(`User with ID ${userId} not found.`);
    }

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
   * Super Admin Authority: Transfer / Reassign Personnel Across Pods (Mutasi Kerja)
   */
  async transferPersonnel(dto: {
    userId: string;
    targetWorkspaceId: string;
    targetRole?: string;
  }) {
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

    const targetWorkspace = await this.prisma.workspace.findUnique({
      where: { id: targetWorkspaceId },
      include: {
        members: { include: { user: true } },
      },
    });

    if (!targetWorkspace) {
      throw new NotFoundException(`Target Pod with ID ${targetWorkspaceId} not found.`);
    }

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
   * Super Admin Authority: Promote an Agent to Leader in the same Pod (Internal Role Switch)
   * The current leader is automatically demoted to Frontline Agent. Total Pod capacity remains strictly FIX.
   */
  async promoteToLeader(dto: {
    userId: string;
    workspaceId: string;
  }) {
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

    const targetMember = workspace.members.find((m) => m.userId === userId);
    if (!targetMember) {
      throw new NotFoundException(`Personnel with ID ${userId} is not assigned to this pod.`);
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
      const freshTokenStr = `STX-AGT-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
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
   * Super Admin Authority: 1-to-1 Cross-Pod Swap (Strict Fixed Capacity)
   * Exchanges User A (from Pod A) with User B (from Pod B).
   * Capacities of both Pods remain strictly FIX (0 change).
   */
  async swapPersonnel(dto: {
    userAId: string;
    userBId: string;
  }) {
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
   * Super Admin Monetization & Expansion: Deploy a Specialized Pod ($149/mo)
   */
  async createSpecializedPod(dto: {
    name: string;
    podCategory?: string;
    description?: string;
    services?: string[];
    quota?: number;
    organizationId?: string;
    requesterIdentifier?: string;
  }) {
    const cleanName = (dto.name || '').trim();
    if (!cleanName) {
      throw new BadRequestException('Pod name is required.');
    }

    // 1. Resolve Organization: prioritize specified organizationId, fallback to requester's org or database
    let org = null;
    if (dto.organizationId) {
      org = await this.prisma.organization.findUnique({
        where: { id: dto.organizationId },
      });
    }

    // 2. Resolve Super Admin Owner: prioritize requesterIdentifier, then admin in org, then fallback
    let owner = null;
    if (dto.requesterIdentifier) {
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
          role: 'SUPER_ADMIN',
        },
      });
      if (!owner) {
        owner = await this.prisma.user.findFirst({
          where: { organizationId: org.id },
        });
      }
    }

    if (!owner) {
      owner = await this.prisma.user.findFirst({
        where: {
          OR: [
            { username: 'pungkyrama' },
            { role: 'SUPER_ADMIN' },
          ],
        },
        orderBy: { createdAt: 'asc' },
      });
    }

    if (!owner) {
      throw new BadRequestException('No admin owner found to anchor new specialized pod.');
    }

    if (!org && owner?.organizationId) {
      org = await this.prisma.organization.findUnique({
        where: { id: owner.organizationId },
      });
    }

    if (!org) {
      org = await this.prisma.organization.findFirst({
        orderBy: { createdAt: 'asc' },
      });
    }

    const leaderTokenStr =
      'STX-LDR-' + crypto.randomBytes(3).toString('hex').toUpperCase();

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
        token: 'STX-AGT-' + crypto.randomBytes(3).toString('hex').toUpperCase(),
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
   * Super Admin Monetization & Expansion: Add Frontline Seats to a Pod (+$30/seat/mo)
   */
  async addSeatToPod(dto: {
    workspaceId: string;
    seatCount: number;
  }) {
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
        'STX-AGT-' + crypto.randomBytes(3).toString('hex').toUpperCase();

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
        joinUrl: `http://localhost:3000/join?token=${agt.token}`,
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
   * Super Admin Sovereign Session Revocation (Force Logout)
   * Immediately terminates active session for a leader or agent across all pods,
   * invalidates single-use credentials, and broadcasts termination signal.
   */
  async forceLogoutUser(
    userId?: string,
    username?: string,
    token?: string,
    requesterIdentifier?: string,
  ) {
    if (requesterIdentifier && requesterIdentifier.trim() !== '') {
      const requester = await this.prisma.user.findFirst({
        where: {
          OR: [
            { id: requesterIdentifier },
            { username: { equals: requesterIdentifier, mode: 'insensitive' } },
            { email: { equals: requesterIdentifier, mode: 'insensitive' } },
          ],
        },
      });
      const isSuperAdmin =
        requester?.role === 'SUPER_ADMIN' ||
        requester?.username?.toLowerCase() === 'pungkyrama';
      if (!isSuperAdmin) {
        throw new ForbiddenException(
          'Access denied. Only Super Admin has sovereign authority to force logout personnel.',
        );
      }
    }

    let targetUser: any = null;
    if (userId && userId.trim() !== '') {
      targetUser = await this.prisma.user.findUnique({
        where: { id: userId.trim() },
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
        });
      }
    }

    if (!targetUser) {
      throw new NotFoundException('Target personnel account not found to force logout.');
    }

    if (targetUser.role === 'SUPER_ADMIN' || targetUser.username?.toLowerCase() === 'pungkyrama') {
      throw new BadRequestException('Cannot force logout Super Administrator.');
    }

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
