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
  async validateInvite(@Param('token') token: string) {
    return this.workspaceService.validateInvite(token);
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
  async getLeaderTokenStatus(@Param('token') token: string) {
    if (!token) {
      throw new BadRequestException('Token is required.');
    }
    return this.workspaceService.getLeaderTokenQuotaStatus(token);
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
    },
  ) {
    return this.workspaceService.lockLeaderQuota(dto);
  }

  /**
   * Validate Agent Single-Use Token
   */
  @Get('agent-token-status/:token')
  async getAgentTokenStatus(@Param('token') token: string) {
    if (!token) {
      throw new BadRequestException('Token is required.');
    }
    return this.workspaceService.getAgentTokenStatus(token);
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
   * Regenerate Single-Use Token for Leader or Agent
   */
  @Post('regenerate-token')
  async regenerateToken(@Body() body: { token?: string; identifier?: string }) {
    if (body?.token && body.token.trim() !== '') {
      return this.workspaceService.regenerateToken(body.token);
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
}

