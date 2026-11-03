import { Controller, Get, Query, BadRequestException } from '@nestjs/common';
import { AnalyticsService } from './analytics.service.js';

@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  /**
   * Executive Analytics & Marketing Dashboard for Platform Owner (@pungkyrama)
   */
  @Get('owner-dashboard')
  async getOwnerDashboard(@Query('identifier') identifier: string) {
    if (!identifier) {
      throw new BadRequestException('Admin identifier is required.');
    }
    return this.analyticsService.getOwnerDashboardData(identifier);
  }
}
