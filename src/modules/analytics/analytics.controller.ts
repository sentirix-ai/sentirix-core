import { Controller, Get, Query, BadRequestException, Req } from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { AnalyticsService } from './analytics.service.js';
import { Roles } from '../../common/auth/auth.decorators.js';
import type { AuthenticatedRequest } from '../../common/auth/jwt-auth.guard.js';

@ApiBearerAuth()
@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  /**
   * Executive Analytics & Marketing Dashboard for Platform Owner
   */
  @Roles('ADMIN', 'SUPER_ADMIN')
  @Get('owner-dashboard')
  async getOwnerDashboard(
    @Req() req: AuthenticatedRequest,
    @Query('identifier') identifier?: string,
  ) {
    const effectiveIdentifier = req.user?.username || identifier;
    if (!effectiveIdentifier) {
      throw new BadRequestException('Admin identifier is required.');
    }
    return this.analyticsService.getOwnerDashboardData(effectiveIdentifier);
  }
}
