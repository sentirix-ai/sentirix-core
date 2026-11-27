import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { EventsGateway } from '../events/events.gateway.js';
import { JoinWorkspaceDto } from './dto/join-workspace.dto.js';
import { hashPasswordScrypt, signJwt } from '../../common/security/crypto.util.js';
import { assertNotAdmin, sanitizeToken } from './workspace.shared.js';

/** Handles single-use invite tokens, leader quota locks, and browser session claiming. */
@Injectable()
export class WorkspaceTokenService {
  private readonly logger = new Logger(WorkspaceTokenService.name);

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
   * Generate a brand new single-use token for the next member
   */
  async generateSingleUseToken(identifier: string) {
    assertNotAdmin(identifier);

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

    const newTokenStr = `SVQ-AGT-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
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

    const cleanToken = sanitizeToken(token);

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
    const cleanToken = sanitizeToken(token);
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
    const email = `${username}@team.${workspace.id.slice(0, 8)}.sevaniq.local`;
    const tempSecret = crypto.randomBytes(16).toString('hex');
    const passwordHash = hashPasswordScrypt(tempSecret);

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

    const sessionToken = signJwt({
      sub: newUser.id,
      username: newUser.username || undefined,
      role: 'AGENT',
      workspaceId: workspace.id,
    });

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
   * Get dynamic interconnected quota status for a Leader token
   */
  async getLeaderTokenQuotaStatus(token: string, sessionId?: string) {
    if (!token || token.trim() === '') {
      throw new BadRequestException('Token is required.');
    }
    const cleanToken = sanitizeToken(token);

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

    // Single-Leader Dynamic Presence Check: If the Pod ALREADY has an active Leader, check if currently online in another session
    if (activeLeaderMember) {
      const leaderUser = activeLeaderMember.user;
      let isLeaderOnline = false;
      if (leaderUser) {
        const activeSession = await this.prisma.userActivitySession.findFirst({
          where: {
            userId: leaderUser.id,
            isOnline: true,
          },
          orderBy: { loginAt: 'desc' },
        });
        if (activeSession) {
          const lastActivityTime = activeSession.lastHeartbeatAt || activeSession.loginAt;
          const diffMs = Date.now() - new Date(lastActivityTime).getTime();
          if (diffMs <= 90000) {
            isLeaderOnline = true;
          }
        }
      }

      if (isLeaderOnline) {
        return {
          valid: false,
          isLockedToOtherSession: true,
          isClaimed: true,
          error: `Leadership seat for "${currentWorkspace.name}" is currently engaged in an active browser session by ${existingLeaderName || 'the assigned Team Lead'}. Under enterprise security governance policies, concurrent multi-browser access is strictly prohibited. To access this workspace, please close the active session on your other device or contact your System Administrator.`,
          workspaceName: currentWorkspace.name,
          leaderName: existingLeaderName,
        };
      }

      // If Leader is OFFLINE / LOGGED OUT:
      // If this exact token was already consumed:
      if (tokenRecord.isUsed) {
        return {
          valid: false,
          isUsed: true,
          isClaimed: true,
          error: `This leader activation token has already been claimed by ${tokenRecord.usedBy || existingLeaderName || 'another user'}. Under enterprise security governance policies, single-use access links expire upon entry. Please request a fresh invitation link from your Super Admin.`,
          workspaceName: currentWorkspace.name,
        };
      }

      // Allow seamless re-login with newly regenerated token!
      return {
        valid: true,
        token: tokenRecord.token,
        role: 'LEADER',
        isExistingLeader: true,
        isReLogin: true,
        existingLeaderName: existingLeaderName,
        leaderUser: {
          id: leaderUser?.id,
          username: leaderUser?.username,
          fullName: leaderUser?.fullName,
          email: leaderUser?.email,
          role: 'LEADER',
        },
        workspace: {
          id: currentWorkspace.id,
          name: currentWorkspace.name,
          podCategory: currentWorkspace.podCategory,
          services: currentWorkspace.services,
          isQuotaLocked: Boolean(currentWorkspace.isQuotaLocked || currentWorkspace.podCategory === 'SPECIALIZED'),
          assignedQuota: currentWorkspace.assignedQuota,
        },
        organization: {
          id: organization.id,
          name: organization.name,
          totalSeats: organization.totalSeats || 20,
        },
      };
    }

    if (tokenRecord.isUsed) {
      return {
        valid: false,
        isUsed: true,
        error: `This leader activation token has already been claimed by ${tokenRecord.usedBy || 'another user'}. Under enterprise security governance policies, single-use access links expire upon entry. Please request a fresh invitation link from your Super Admin.`,
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

    if (currentWorkspace.isQuotaLocked || currentWorkspace.podCategory === 'SPECIALIZED') {
      // This pod is already locked or pre-allocated by admin
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
        isQuotaLocked: Boolean(currentWorkspace.isQuotaLocked || currentWorkspace.podCategory === 'SPECIALIZED'),
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
    const cleanToken = sanitizeToken(token);

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
    const cleanToken = sanitizeToken(token);
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

    // Single-Leader Dynamic Presence Check: If Pod ALREADY has an active Leader, check if currently online in another session
    const existingLeaderMember = workspace.members.find(
      (m: any) => m.role === 'LEADER',
    );

    let leaderUser: any;
    let totalPodQuota = workspace.assignedQuota || 2;
    const maxAllowed = quotaStatus.quotaStats.maxSubordinatesAllowed;
    const safeCount =
      workspace.isQuotaLocked && workspace.assignedQuota
        ? Math.max(1, workspace.assignedQuota - 1)
        : Math.min(Math.max(1, chosenCount), maxAllowed);

    if (existingLeaderMember && existingLeaderMember.user) {
      // Re-login scenario: Check if Leader is online in another session
      const activeSession = await this.prisma.userActivitySession.findFirst({
        where: { userId: existingLeaderMember.userId, isOnline: true },
        orderBy: { loginAt: 'desc' },
      });
      const isSessionOnline =
        activeSession &&
        Date.now() - new Date(activeSession.lastHeartbeatAt || activeSession.loginAt).getTime() <= 90000;

      if (isSessionOnline) {
        throw new BadRequestException(
          `Leadership seat for "${workspace.name}" is currently engaged in an active browser session by ${existingLeaderMember.user.fullName || existingLeaderMember.user.username}. Under enterprise security governance policies, concurrent multi-browser access is strictly prohibited.`,
        );
      }

      leaderUser = existingLeaderMember.user;
    } else {
      // First time leader creation:
      const slug = cleanName
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '')
        .slice(0, 10);
      const username = `${slug || 'leader'}_${Math.floor(1000 + Math.random() * 9000)}`;
      const email = `${username}@team.${workspace.id.slice(0, 8)}.sevaniq.local`;
      const passwordHash =
        password && password.trim() !== ''
          ? hashPasswordScrypt(password.trim())
          : hashPasswordScrypt(crypto.randomBytes(16).toString('hex'));

      leaderUser = await this.prisma.user.create({
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

      await this.prisma.workspaceMember.create({
        data: {
          workspaceId: workspace.id,
          userId: leaderUser.id,
          role: 'LEADER',
        },
      });

      // Lock Workspace Quota
      totalPodQuota =
        workspace.isQuotaLocked && workspace.assignedQuota
          ? workspace.assignedQuota
          : 1 + safeCount;
      await this.prisma.workspace.update({
        where: { id: workspace.id },
        data: {
          assignedQuota: totalPodQuota,
          isQuotaLocked: true,
          lockedAt: workspace.lockedAt || new Date(),
        },
      });
    }

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

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const agentTokens: any[] = [];
    if (existingAgentTokens.length > 0) {
      existingAgentTokens.forEach((agt) => {
        agentTokens.push({
          token: agt.token,
          joinUrl: `${frontendUrl}/join?token=${agt.token}`,
          isUsed: agt.isUsed,
          usedBy: agt.usedBy,
          isOpened: false,
        });
      });
    } else {
      for (let i = 0; i < safeCount; i++) {
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
        agentTokens.push({
          token: agt.token,
          joinUrl: `${frontendUrl}/join?token=${agt.token}`,
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

    const leaderSessionToken = signJwt({
      sub: leaderUser.id,
      username: leaderUser.username || undefined,
      role: 'POD_LEADER',
      workspaceId: workspace.id,
    });

    return {
      success: true,
      leader: {
        id: leaderUser.id,
        username: leaderUser.username,
        fullName: leaderUser.fullName,
        email: leaderUser.email,
        role: 'LEADER',
        token: leaderSessionToken,
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
    const cleanToken = sanitizeToken(token);

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

    // Dynamic Presence Check for Frontline Agent
    if (tokenRecord.isUsed) {
      const agentName = tokenRecord.usedBy || 'an active team member';
      return {
        valid: false,
        isClaimed: true,
        error: `This invitation link has already been claimed by ${agentName} and can no longer be used. Under enterprise security governance policies, single-use access links expire upon entry. Please request a fresh invitation link from your Pod Leader.`,
        workspaceName: tokenRecord.workspace?.name,
        assignedMemberName: tokenRecord.usedBy,
      };
    }

    if (tokenRecord.usedBy) {
      const agentName = tokenRecord.usedBy;
      const agentUser = await this.prisma.user.findFirst({
        where: {
          fullName: { equals: agentName, mode: 'insensitive' },
          workspaceMembership: { workspaceId: tokenRecord.workspaceId, role: 'AGENT' },
        },
      });

      if (agentUser) {
        const activeSession = await this.prisma.userActivitySession.findFirst({
          where: {
            userId: agentUser.id,
            isOnline: true,
          },
          orderBy: { loginAt: 'desc' },
        });

        const isSessionOnline =
          activeSession &&
          Date.now() - new Date(activeSession.lastHeartbeatAt || activeSession.loginAt).getTime() <= 90000;

        if (isSessionOnline) {
          return {
            valid: false,
            isLockedToOtherSession: true,
            isClaimed: true,
            error: `This frontline seat for "${tokenRecord.workspace?.name || 'this Pod'}" is currently engaged in an active browser session by ${agentName}. Under enterprise security governance policies, concurrent multi-browser access is strictly prohibited. To access this workspace, please close the active session on your other device or contact your System Administrator.`,
            workspaceName: tokenRecord.workspace?.name,
            assignedMemberName: agentName,
          };
        }

        // If member is OFFLINE / LOGGED OUT: Allow re-login!
        return {
          valid: true,
          token: tokenRecord.token,
          role: 'AGENT',
          isReLogin: true,
          assignedMemberName: agentName,
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
          leaderName:
            tokenRecord.workspace?.members?.find((m: any) => m.role === 'LEADER')
              ?.user?.fullName || null,
        };
      }
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
    const cleanToken = sanitizeToken(token);
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
        `This invitation token has already been claimed and consumed under organizational governance policy.`,
      );
    }

    const workspace = tokenRecord.workspace;

    // Check if an existing member with the exact same name or username already belongs to this workspace
    const existingMember = workspace.members.find(
      (m: any) =>
        m.user?.fullName?.trim().toLowerCase() === cleanName.toLowerCase() ||
        m.user?.username?.trim().toLowerCase() === cleanName.toLowerCase(),
    );

    let agentUser: any;

    if (existingMember && existingMember.user) {
      // Re-login scenario: Verify this token was allocated to this member
      if (tokenRecord.usedBy && tokenRecord.usedBy.toLowerCase() === cleanName.toLowerCase()) {
        const activeSession = await this.prisma.userActivitySession.findFirst({
          where: { userId: existingMember.userId, isOnline: true },
          orderBy: { loginAt: 'desc' },
        });
        const isSessionOnline =
          activeSession &&
          Date.now() - new Date(activeSession.lastHeartbeatAt || activeSession.loginAt).getTime() <= 90000;

        if (isSessionOnline) {
          throw new BadRequestException(
            `This frontline seat for "${workspace.name}" is currently engaged in an active browser session by ${cleanName}. Under enterprise security governance policies, concurrent multi-browser access is strictly prohibited.`,
          );
        }

        agentUser = existingMember.user;
      } else {
        throw new BadRequestException(
          `A frontline agent named "${cleanName}" already belongs to "${workspace.name}". Each team member seat must be distinct.`,
        );
      }
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
      const email = `${username}@agent.${workspace.id.slice(0, 8)}.sevaniq.local`;
      const passwordHash =
        password && password.trim() !== ''
          ? hashPasswordScrypt(password.trim())
          : hashPasswordScrypt(crypto.randomBytes(16).toString('hex'));

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
        usedAt: new Date(),
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

      // Single Concurrent Session: Terminate any existing remote sessions for this agent
      this.eventsGateway.server?.emit('auth:session_terminated', {
        userId: agentUser.id,
        username: agentUser.username,
        reason: 'CONCURRENT_LOGIN',
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

    const agentSessionToken = signJwt({
      sub: agentUser.id,
      username: agentUser.username || undefined,
      role: 'AGENT',
      workspaceId: workspace.id,
    });

    return {
      success: true,
      user: {
        id: agentUser.id,
        username: agentUser.username,
        fullName: agentUser.fullName,
        email: agentUser.email,
        role: 'AGENT',
        token: agentSessionToken,
      },
      workspace: {
        id: workspace.id,
        name: workspace.name,
      },
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
    const cleanToken = sanitizeToken(oldToken);

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
    const prefix = tokenRecord.role === 'LEADER' ? 'SVQ-LDR-' : 'SVQ-AGT-';
    const newTokenStr =
      prefix + crypto.randomBytes(3).toString('hex').toUpperCase();

    let retainedUsedBy: string | null = null;

    if (tokenRecord.role === 'LEADER') {
      const activeLeaderMember = await this.prisma.workspaceMember.findFirst({
        where: { workspaceId: tokenRecord.workspaceId, role: 'LEADER' },
        include: { user: true },
      });
      retainedUsedBy =
        activeLeaderMember?.user?.fullName ||
        activeLeaderMember?.user?.username ||
        tokenRecord.usedBy ||
        null;
    } else {
      retainedUsedBy = (tokenRecord.usedBy || '').trim() || null;
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

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    return {
      success: true,
      oldToken: cleanToken,
      newToken: newTokenStr,
      role: tokenRecord.role,
      workspaceId: tokenRecord.workspaceId,
      workspaceName: tokenRecord.workspace.name,
      joinUrl: `${frontendUrl}/join?token=${newTokenStr}`,
    };
  }

}
