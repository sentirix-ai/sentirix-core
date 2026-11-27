import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SuperAdminOnly } from '../../common/auth/auth.decorators.js';
import type { AuthenticatedRequest } from '../../common/auth/jwt-auth.guard.js';
import { SuperAdminService } from './super-admin.service.js';
import { SuperAdminForceLogoutDto } from './dto/super-admin-actions.dto.js';

@ApiTags('SuperAdminControlPlane')
@ApiBearerAuth()
@SuperAdminOnly()
@Controller('super-admin')
export class SuperAdminController {
  constructor(private readonly superAdminService: SuperAdminService) {}

  private extractIp(req: AuthenticatedRequest): string | undefined {
    const forwarded = req.headers['x-forwarded-for'];
    const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    return raw?.split(',')[0]?.trim() || undefined;
  }

  @Get('analytics/owner-dashboard')
  @ApiOperation({ summary: 'Platform Founder marketing analytics and user directory' })
  async getOwnerDashboard() {
    return this.superAdminService.getOwnerDashboard();
  }

  @Get('tenants')
  @ApiOperation({ summary: 'List all B2B tenant organizations and seat utilization' })
  async getTenants() {
    return this.superAdminService.getTenantsOverview();
  }

  @Get('cockpit')
  @ApiOperation({ summary: 'Inspect cross-tenant cockpit telemetry for an organization' })
  async getCrossTenantCockpit(@Query('organizationId') organizationId?: string) {
    return this.superAdminService.getCrossTenantCockpit(organizationId);
  }

  @Post('force-logout')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Sovereign cross-tenant session revocation with audit trail' })
  async forceLogout(
    @Req() req: AuthenticatedRequest,
    @Body() dto: SuperAdminForceLogoutDto,
  ) {
    return this.superAdminService.forceLogoutCrossTenant(
      req.user!.userId,
      dto,
      this.extractIp(req),
    );
  }

  @Post('tickets/demo-cleanup')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Global cleanup of showcase demo tickets' })
  async cleanupDemoTickets(@Req() req: AuthenticatedRequest) {
    return this.superAdminService.cleanupDemoTickets(
      req.user!.userId,
      this.extractIp(req),
    );
  }

  @Get('audit-events')
  @ApiOperation({ summary: 'List Platform Founder audit trail events' })
  async getAuditEvents(@Query('limit') limit?: string) {
    return this.superAdminService.getAuditEvents(limit ? Number(limit) : 100);
  }
}
