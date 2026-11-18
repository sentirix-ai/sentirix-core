import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
  BadRequestException,
} from '@nestjs/common';
import { WorkspaceService } from './workspace.service.js';
import { JoinWorkspaceDto } from './dto/join-workspace.dto.js';

@Controller('workspace')
export class WorkspaceController {
  constructor(private readonly workspaceService: WorkspaceService) {}

  /**
   * Get or create workspace for a registered regular user
   * (Admin @pungkyrama is strictly rejected with 403 Forbidden)
   */
  @Get('my-workspace')
  async getMyWorkspace(@Query('identifier') identifier: string) {
    if (!identifier || identifier.trim() === '') {
      throw new BadRequestException('User identifier is required.');
    }
    return this.workspaceService.getOrCreateUserWorkspace(identifier);
  }

  /**
   * Validate an invite link before showing the join form
   */
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
   * Lock Leader Quota (Click Checkmark [✓]) & Auto-Generate Single-Use Agent Tokens
   */
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
   * Get Super Admin Executive Cockpit Data
   */
  @Get('super-admin-cockpit')
  async getSuperAdminCockpit(@Query('identifier') identifier: string) {
    if (!identifier) {
      throw new BadRequestException('Administrator identifier is required.');
    }
    return this.workspaceService.getSuperAdminCockpitData(identifier);
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
   * Regenerate Single-Use Token for Leader or Agent
   */
  @Post('regenerate-token')
  async regenerateToken(
    @Body() body: { token?: string; identifier?: string; workspaceId?: string },
  ) {
    if (
      (body?.token && body.token.trim() !== '') ||
      (body?.workspaceId && body.workspaceId.trim() !== '')
    ) {
      return this.workspaceService.regenerateToken(
        body.token,
        body.identifier,
        body.workspaceId,
      );
    }
    if (body?.identifier && body.identifier.trim() !== '') {
      const ws = await this.workspaceService.getOrCreateUserWorkspace(body.identifier);
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
   * Super Admin Authority: Rename Leader or Member Personnel
   */
  @Post('rename-personnel')
  async renamePersonnel(
    @Body() body: { userId: string; newFullName: string },
  ) {
    if (!body?.userId || !body?.newFullName?.trim()) {
      throw new BadRequestException('userId and newFullName are required.');
    }
    return this.workspaceService.renamePersonnel(body.userId, body.newFullName);
  }

  /**
   * Super Admin Authority: Transfer / Reassign Personnel Across Pods (Mutasi Kerja)
   */
  @Post('transfer-personnel')
  async transferPersonnel(
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
    return this.workspaceService.transferPersonnel(body);
  }

  /**
   * Super Admin Authority: Promote an Agent to Leader in the same Pod (Role Switch)
   */
  @Post('promote-leader')
  async promoteLeader(
    @Body() body: { userId: string; workspaceId: string },
  ) {
    if (!body?.userId || !body?.workspaceId) {
      throw new BadRequestException('userId and workspaceId are required.');
    }
    return this.workspaceService.promoteToLeader(body);
  }

  /**
   * Super Admin Authority: 1-to-1 Cross-Pod Swap (Strict Fixed Capacity)
   */
  @Post('swap-personnel')
  async swapPersonnel(
    @Body() body: { userAId: string; userBId: string },
  ) {
    if (!body?.userAId || !body?.userBId) {
      throw new BadRequestException('userAId and userBId are required.');
    }
    return this.workspaceService.swapPersonnel(body);
  }

  /**
   * Super Admin Monetization & Expansion: Deploy a Specialized Pod ($149/mo)
   */
  @Post('create-pod')
  async createPod(
    @Body()
    body: {
      name: string;
      podCategory?: string;
      description?: string;
      services?: string[];
      quota?: number;
      organizationId?: string;
    },
  ) {
    if (!body?.name?.trim()) {
      throw new BadRequestException('Pod name is required.');
    }
    return this.workspaceService.createSpecializedPod(body);
  }

  /**
   * Super Admin Monetization & Expansion: Add Frontline Seats to a Pod (+$30/seat/mo)
   */
  @Post('add-seat')
  async addSeat(
    @Body()
    body: {
      workspaceId: string;
      seatCount: number;
    },
  ) {
    if (!body?.workspaceId) {
      throw new BadRequestException('workspaceId is required.');
    }
    return this.workspaceService.addSeatToPod(body);
  }
}

