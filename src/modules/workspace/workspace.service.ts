import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { EventsGateway } from '../events/events.gateway.js';
import { JoinWorkspaceDto } from './dto/join-workspace.dto.js';
import {
  assertNotAdmin,
  WorkspaceDetailResponse,
  WorkspaceMemberInfo,
} from './workspace.shared.js';
import { WorkspaceTokenService } from './workspace-token.service.js';
import { WorkspaceOnboardingService } from './workspace-onboarding.service.js';
import { WorkspacePersonnelService } from './workspace-personnel.service.js';

export type { WorkspaceDetailResponse, WorkspaceMemberInfo };

/**
 * Facade coordinating workspace lifecycle, invite tokens, onboarding provisioning, and personnel operations.
 */
@Injectable()
export class WorkspaceService {
  private readonly logger = new Logger(WorkspaceService.name);
  private readonly tokenService: WorkspaceTokenService;
  private readonly onboardingService: WorkspaceOnboardingService;
  private readonly personnelService: WorkspacePersonnelService;

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventsGateway: EventsGateway,
    @Optional() tokenService?: WorkspaceTokenService,
    @Optional() onboardingService?: WorkspaceOnboardingService,
    @Optional() personnelService?: WorkspacePersonnelService,
  ) {
    this.tokenService =
      tokenService ?? new WorkspaceTokenService(this.prisma, this.eventsGateway);
    this.onboardingService =
      onboardingService ?? new WorkspaceOnboardingService(this.prisma);
    this.personnelService =
      personnelService ?? new WorkspacePersonnelService(this.prisma, this.eventsGateway);
  }

  /**
   * Get or create a team workspace for a registered regular user
   * Guarantees a valid, active single-use invite token is ready
   */
  async getOrCreateUserWorkspace(identifier: string): Promise<WorkspaceDetailResponse> {
    assertNotAdmin(identifier);

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
      const initialToken = `SVQ-AGT-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
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
      const newTokenStr = `SVQ-AGT-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
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

  generateSingleUseToken(identifier: string) {
    return this.tokenService.generateSingleUseToken(identifier);
  }

  validateInvite(token: string, sessionId?: string) {
    return this.tokenService.validateInvite(token, sessionId);
  }

  joinWorkspace(dto: JoinWorkspaceDto) {
    return this.tokenService.joinWorkspace(dto);
  }

  getLeaderTokenQuotaStatus(token: string, sessionId?: string) {
    return this.tokenService.getLeaderTokenQuotaStatus(token, sessionId);
  }

  togglePodQuotaLock(dto: Parameters<WorkspaceTokenService['togglePodQuotaLock']>[0]) {
    return this.tokenService.togglePodQuotaLock(dto);
  }

  lockLeaderQuota(dto: Parameters<WorkspaceTokenService['lockLeaderQuota']>[0]) {
    return this.tokenService.lockLeaderQuota(dto);
  }

  getAgentTokenStatus(token: string, sessionId?: string) {
    return this.tokenService.getAgentTokenStatus(token, sessionId);
  }

  claimAgentToken(dto: Parameters<WorkspaceTokenService['claimAgentToken']>[0]) {
    return this.tokenService.claimAgentToken(dto);
  }

  regenerateToken(oldToken?: string, identifier?: string, workspaceId?: string) {
    return this.tokenService.regenerateToken(oldToken, identifier, workspaceId);
  }

  setupCapacity(identifier: string, capacity: number) {
    return this.onboardingService.setupCapacity(identifier, capacity);
  }

  setupMultiPod(dto: Parameters<WorkspaceOnboardingService['setupMultiPod']>[0]) {
    return this.onboardingService.setupMultiPod(dto);
  }

  getOrganizationPods(identifier: string) {
    return this.onboardingService.getOrganizationPods(identifier);
  }

  createCustomPod(
    identifier: string,
    dto: Parameters<WorkspaceOnboardingService['createCustomPod']>[1],
  ) {
    return this.onboardingService.createCustomPod(identifier, dto);
  }

  setupMultiPodV2(dto: Parameters<WorkspaceOnboardingService['setupMultiPodV2']>[0]) {
    return this.onboardingService.setupMultiPodV2(dto);
  }

  getPendingLeaderTokens(identifier: string) {
    return this.onboardingService.getPendingLeaderTokens(identifier);
  }

  completeOnboarding(identifier: string) {
    return this.onboardingService.completeOnboarding(identifier);
  }

  saveOnboardingDraft(identifier: string, draftData: unknown) {
    return this.onboardingService.saveOnboardingDraft(identifier, draftData);
  }

  getOnboardingDraft(identifier: string) {
    return this.onboardingService.getOnboardingDraft(identifier);
  }

  deleteOnboardingDraft(identifier: string) {
    return this.onboardingService.deleteOnboardingDraft(identifier);
  }

  memberLogout(memberId: string, workspaceId?: string) {
    return this.personnelService.memberLogout(memberId, workspaceId);
  }

  purgeWorkspaceMembersOnLogout(ownerIdentifier: string) {
    return this.personnelService.purgeWorkspaceMembersOnLogout(ownerIdentifier);
  }

  checkMemberStatus(identifier: string) {
    return this.personnelService.checkMemberStatus(identifier);
  }

  removeMember(ownerIdentifier: string, memberId: string) {
    return this.personnelService.removeMember(ownerIdentifier, memberId);
  }

  getSuperAdminCockpitData(identifier: string) {
    return this.personnelService.getSuperAdminCockpitData(identifier);
  }

  renamePersonnel(userId: string, newFullName: string) {
    return this.personnelService.renamePersonnel(userId, newFullName);
  }

  transferPersonnel(dto: Parameters<WorkspacePersonnelService['transferPersonnel']>[0]) {
    return this.personnelService.transferPersonnel(dto);
  }

  promoteToLeader(dto: Parameters<WorkspacePersonnelService['promoteToLeader']>[0]) {
    return this.personnelService.promoteToLeader(dto);
  }

  swapPersonnel(dto: Parameters<WorkspacePersonnelService['swapPersonnel']>[0]) {
    return this.personnelService.swapPersonnel(dto);
  }

  createSpecializedPod(dto: Parameters<WorkspacePersonnelService['createSpecializedPod']>[0]) {
    return this.personnelService.createSpecializedPod(dto);
  }

  addSeatToPod(dto: Parameters<WorkspacePersonnelService['addSeatToPod']>[0]) {
    return this.personnelService.addSeatToPod(dto);
  }

  forceLogoutUser(
    userId?: string,
    username?: string,
    token?: string,
    requesterIdentifier?: string,
  ) {
    return this.personnelService.forceLogoutUser(userId, username, token, requesterIdentifier);
  }
}
