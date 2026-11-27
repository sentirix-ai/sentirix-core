import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
  BadRequestException,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { WorkspaceService } from './workspace.service.js';
import { JoinWorkspaceDto } from './dto/join-workspace.dto.js';
import { Public, Roles } from '../../common/auth/auth.decorators.js';
import type { AuthenticatedRequest } from '../../common/auth/jwt-auth.guard.js';

@ApiBearerAuth()
@Controller('workspace')
export class WorkspaceController {
  constructor(private readonly workspaceService: WorkspaceService) {}

  /**
   * Get or create workspace for a registered regular user
   * (Platform Founder is strictly rejected with 403 Forbidden)
   */
  @Get('my-workspace')
  async getMyWorkspace(
    @Req() req: AuthenticatedRequest,
    @Query('identifier') identifier?: string,
  ) {
    const effectiveIdentifier = identifier?.trim() || req.user?.username || req.user?.userId;
    if (!effectiveIdentifier) {
      throw new BadRequestException('User identifier is required.');
    }
    return this.workspaceService.getOrCreateUserWorkspace(effectiveIdentifier);
  }

  /**
   * Validate an invite link before showing the join form
   */
  @Public()
  @Get('validate-invite/:token')
  async validateInvite(
    @Param('token') token: string,
    @Query('sessionId') sessionId?: string,
  ) {
    return this.workspaceService.validateInvite(token, sessionId);
  }

  /**
   * One-Click Join Workspace (Full Name only)
   */
  @Public()
  @Post('join')
  async joinWorkspace(@Body() dto: JoinWorkspaceDto) {
    return this.workspaceService.joinWorkspace(dto);
  }

  /**
   * Generate a fresh single-use invite token (1 link for 1 member)
   */
  @Post('generate-token')
  async generateSingleUseToken(@Body('identifier') identifier: string) {
    if (!identifier) {
      throw new BadRequestException('User identifier is required.');
    }
    return this.workspaceService.generateSingleUseToken(identifier);
  }

  /**
   * Member Logout: purges member from active count and releases seat
   */
  @Post('member-logout')
  async memberLogout(
    @Body('memberId') memberId: string,
    @Body('workspaceId') workspaceId?: string,
  ) {
    if (!memberId) {
      return { success: true };
    }
    return this.workspaceService.memberLogout(memberId, workspaceId);
  }

  /**
   * Remove a member from the workspace
   */
  @Delete('member/:memberId')
  async removeMember(
    @Param('memberId') memberId: string,
    @Query('ownerIdentifier') ownerIdentifier: string,
  ) {
    if (!ownerIdentifier) {
      throw new BadRequestException('Owner identifier is required.');
    }
    return this.workspaceService.removeMember(ownerIdentifier, memberId);
  }

  /**
   * Purge all workspace members when the workspace owner logs out
   */
  @Post('purge-on-logout')
  async purgeOnLogout(@Body('identifier') identifier: string) {
    if (!identifier) {
      return { success: true };
    }
    return this.workspaceService.purgeWorkspaceMembersOnLogout(identifier);
  }

  /**
   * Check if a guest member account is still active in the database
   */
  @Public()
  @Get('member-status')
  async checkMemberStatus(@Query('userId') userId: string) {
    return this.workspaceService.checkMemberStatus(userId);
  }

  /**
   * Setup workspace capacity (1-8 members) and complete onboarding
   */
  @Post('setup-capacity')
  async setupCapacity(
    @Body('identifier') identifier: string,
    @Body('capacity') capacity: number,
  ) {
    if (!identifier) {
      throw new BadRequestException('User identifier is required.');
    }
    return this.workspaceService.setupCapacity(identifier, capacity);
  }

  /**
   * Setup dynamic enterprise multi-pods (Onboarding Steps 1-4)
   */
  @Post('setup-multi-pod')
  async setupMultiPod(
    @Body()
    dto: {
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
    },
  ) {
    if (!dto.identifier) {
      throw new BadRequestException('User identifier is required.');
    }
    return this.workspaceService.setupMultiPod(dto);
  }

  /**
   * Get all active pods for organization
   */
  @Get('pods')
  async getPods(@Query('identifier') identifier: string) {
    if (!identifier) {
      throw new BadRequestException('User identifier is required.');
    }
    return this.workspaceService.getOrganizationPods(identifier);
  }

  /**
   * Create custom pod dynamically
   */
  @Post('custom-pod')
  async createCustomPod(
    @Body('identifier') identifier: string,
    @Body()
    dto: {
      name: string;
      podCategory?: string;
      description?: string;
      maxMembers?: number;
      assignedQuota?: number;
    },
  ) {
    if (!identifier || !dto.name) {
      throw new BadRequestException('User identifier and pod name are required.');
    }
    return this.workspaceService.createCustomPod(identifier, dto);
  }

  /**
   * Enterprise Multi-Pod Provisioning v2 (Titanium Onboarding)
   */
  @Post('setup-multi-pod-v2')
  async setupMultiPodV2(
    @Body()
    dto: {
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
    },
  ) {
    if (!dto.identifier) {
      throw new BadRequestException('User identifier is required.');
    }
    return this.workspaceService.setupMultiPodV2(dto);
  }

  /**
   * Get dynamic interconnected quota status for a Leader token
   */
  @Public()
  @Get('leader-token-status/:token')
  async getLeaderTokenStatus(
    @Param('token') token: string,
    @Query('sessionId') sessionId?: string,
  ) {
    if (!token) {
      throw new BadRequestException('Token is required.');
    }
    return this.workspaceService.getLeaderTokenQuotaStatus(token, sessionId);
  }

  /**
   * Interactive Quota Lock Toggle from Step 2 of Leader Activation
   */
  @Public()
  @Post('toggle-pod-quota-lock')
  async togglePodQuotaLock(
    @Body()
    dto: {
      token: string;
      chosenSubordinates: number;
      lock: boolean;
      sessionId?: string;
    },
  ) {
    return this.workspaceService.togglePodQuotaLock(dto);
  }

  /**
   * Lock Leader Quota (Click Checkmark [✓]) & Auto-Generate Single-Use Agent Tokens
   */
  @Public()
  @Post('lock-leader-quota')
  async lockLeaderQuota(
    @Body()
    dto: {
      token: string;
      fullName: string;
      password?: string;
      chosenSubordinates: number;
      sessionId?: string;
    },
  ) {
    return this.workspaceService.lockLeaderQuota(dto);
  }

  /**
   * Validate Agent Single-Use Token
   */
  @Public()
  @Get('agent-token-status/:token')
  async getAgentTokenStatus(
    @Param('token') token: string,
    @Query('sessionId') sessionId?: string,
  ) {
    if (!token) {
      throw new BadRequestException('Token is required.');
    }
    return this.workspaceService.getAgentTokenStatus(token, sessionId);
  }

  /**
   * Claim Agent Single-Use Token and Join Pod
   */
  @Public()
  @Post('claim-agent-token')
  async claimAgentToken(
    @Body()
    dto: {
      token: string;
      fullName: string;
      password?: string;
      sessionId?: string;
    },
  ) {
    return this.workspaceService.claimAgentToken(dto);
  }

  /**
   * Get Tenant Owner Company Cockpit Data (strictly scoped to caller's organization)
   */
  @Roles('TENANT_OWNER')
  @Get('cockpit')
  async getCompanyCockpit(@Req() req: AuthenticatedRequest) {
    if (!req.user?.userId) {
      throw new BadRequestException('Authenticated Tenant Owner is required.');
    }
    return this.workspaceService.getCompanyCockpitData(
      req.user.userId,
      req.user.organizationId,
    );
  }

  /**
   * Get Pending Leader Tokens for Resilient Step 4
   */
  @Get('pending-leader-tokens')
  async getPendingLeaderTokens(@Query('identifier') identifier: string) {
    if (!identifier) {
      throw new BadRequestException('User identifier is required.');
    }
    return this.workspaceService.getPendingLeaderTokens(identifier);
  }

  /**
   * Complete Onboarding
   */
  @Post('complete-onboarding')
  async completeOnboarding(@Body() body: { identifier: string }) {
    if (!body?.identifier) {
      throw new BadRequestException('User identifier is required.');
    }
    return this.workspaceService.completeOnboarding(body.identifier);
  }

  /**
   * Save Onboarding In-Progress Draft (Step 1, 2, 3 autosave)
   */
  @Post('onboarding-draft')
  async saveOnboardingDraft(@Body() body: { identifier: string; draft: any }) {
    if (!body?.identifier) {
      throw new BadRequestException('User identifier is required.');
    }
    return this.workspaceService.saveOnboardingDraft(body.identifier, body.draft);
  }

  /**
   * Get Onboarding In-Progress Draft
   */
  @Get('onboarding-draft')
  async getOnboardingDraft(@Query('identifier') identifier: string) {
    if (!identifier) {
      throw new BadRequestException('User identifier is required.');
    }
    const draft = this.workspaceService.getOnboardingDraft(identifier);
    return { success: true, draft };
  }

  /**
   * Delete Onboarding In-Progress Draft
   */
  @Delete('onboarding-draft')
  async deleteOnboardingDraft(@Query('identifier') identifier: string) {
    if (!identifier) {
      throw new BadRequestException('User identifier is required.');
    }
    this.workspaceService.deleteOnboardingDraft(identifier);
    return { success: true };
  }

  /**
   * Regenerate Single-Use Token for Leader or Agent
   */
  @Post('regenerate-token')
  async regenerateToken(
    @Req() req: AuthenticatedRequest,
    @Body() body: { token?: string; identifier?: string; workspaceId?: string },
  ) {
    const verifiedIdentifier = req.user?.username || body.identifier;
    const actor = req.user
      ? {
          userId: req.user.userId,
          role: req.user.role,
          organizationId: req.user.organizationId,
        }
      : undefined;
    if (
      (body?.token && body.token.trim() !== '') ||
      (body?.workspaceId && body.workspaceId.trim() !== '')
    ) {
      return this.workspaceService.regenerateToken(
        body.token,
        verifiedIdentifier,
        body.workspaceId,
        actor,
      );
    }
    if (verifiedIdentifier && verifiedIdentifier.trim() !== '') {
      const ws = await this.workspaceService.getOrCreateUserWorkspace(verifiedIdentifier);
      return {
        success: true,
        newToken: ws.inviteToken,
        joinUrl: ws.inviteUrl,
        workspace: ws,
      };
    }
    throw new BadRequestException('Either token or identifier is required.');
  }

  /**
   * Tenant Owner Session Revocation (Force Logout within own organization)
   */
  @Roles('TENANT_OWNER')
  @Post('force-logout')
  async forceLogout(
    @Req() req: AuthenticatedRequest,
    @Body()
    body: {
      userId?: string;
      username?: string;
      token?: string;
    },
  ) {
    return this.workspaceService.forceLogoutUser(
      body?.userId,
      body?.username,
      body?.token,
      req.user?.organizationId,
    );
  }

  /**
   * Tenant Owner Authority: Rename Leader or Member Personnel
   */
  @Roles('TENANT_OWNER')
  @Post('rename-personnel')
  async renamePersonnel(
    @Req() req: AuthenticatedRequest,
    @Body() body: { userId: string; newFullName: string },
  ) {
    if (!body?.userId || !body?.newFullName?.trim()) {
      throw new BadRequestException('userId and newFullName are required.');
    }
    return this.workspaceService.renamePersonnel(
      body.userId,
      body.newFullName,
      req.user?.organizationId,
    );
  }

  /**
   * Tenant Owner Authority: Transfer / Reassign Personnel Across Pods (Mutasi Kerja)
   */
  @Roles('TENANT_OWNER')
  @Post('transfer-personnel')
  async transferPersonnel(
    @Req() req: AuthenticatedRequest,
    @Body()
    body: {
      userId: string;
      targetWorkspaceId: string;
      targetRole?: string;
    },
  ) {
    if (!body?.userId || !body?.targetWorkspaceId) {
      throw new BadRequestException(
        'userId and targetWorkspaceId are required.',
      );
    }
    return this.workspaceService.transferPersonnel(body, req.user?.organizationId);
  }

  /**
   * Tenant Owner Authority: Promote an Agent to Leader in the same Pod (Role Switch)
   */
  @Roles('TENANT_OWNER')
  @Post('promote-leader')
  async promoteLeader(
    @Req() req: AuthenticatedRequest,
    @Body() body: { userId: string; workspaceId: string },
  ) {
    if (!body?.userId || !body?.workspaceId) {
      throw new BadRequestException('userId and workspaceId are required.');
    }
    return this.workspaceService.promoteToLeader(body, req.user?.organizationId);
  }

  /**
   * Tenant Owner Authority: 1-to-1 Cross-Pod Swap (Strict Fixed Capacity)
   */
  @Roles('TENANT_OWNER')
  @Post('swap-personnel')
  async swapPersonnel(
    @Req() req: AuthenticatedRequest,
    @Body() body: { userAId: string; userBId: string },
  ) {
    if (!body?.userAId || !body?.userBId) {
      throw new BadRequestException('userAId and userBId are required.');
    }
    return this.workspaceService.swapPersonnel(body, req.user?.organizationId);
  }

  /**
   * Tenant Owner Expansion: Deploy a Specialized Pod ($149/mo)
   */
  @Roles('TENANT_OWNER')
  @Post('create-pod')
  async createPod(
    @Req() req: AuthenticatedRequest,
    @Body()
    body: {
      name: string;
      podCategory?: string;
      description?: string;
      services?: string[];
      quota?: number;
      organizationId?: string;
      requesterIdentifier?: string;
    },
  ) {
    if (!body?.name?.trim()) {
      throw new BadRequestException('Pod name is required.');
    }
    return this.workspaceService.createSpecializedPod(
      body,
      req.user?.userId,
      req.user?.organizationId,
    );
  }

  /**
   * Tenant Owner Expansion: Add Frontline Seats to a Pod (+$30/seat/mo)
   */
  @Roles('TENANT_OWNER')
  @Post('add-seat')
  async addSeat(
    @Req() req: AuthenticatedRequest,
    @Body()
    body: {
      workspaceId: string;
      seatCount: number;
    },
  ) {
    if (!body?.workspaceId) {
      throw new BadRequestException('workspaceId is required.');
    }
    return this.workspaceService.addSeatToPod(body, req.user?.organizationId);
  }
}

