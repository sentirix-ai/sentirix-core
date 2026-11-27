import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { AnalyticsModule } from '../analytics/analytics.module.js';
import { WorkspaceModule } from '../workspace/workspace.module.js';
import { TicketsModule } from '../tickets/tickets.module.js';
import { SuperAdminAuthService } from './super-admin-auth.service.js';
import { SuperAdminService } from './super-admin.service.js';
import { SuperAdminAuthController } from './super-admin-auth.controller.js';
import { SuperAdminController } from './super-admin.controller.js';

@Module({
  imports: [PrismaModule, AnalyticsModule, WorkspaceModule, TicketsModule],
  controllers: [SuperAdminAuthController, SuperAdminController],
  providers: [SuperAdminAuthService, SuperAdminService],
  exports: [SuperAdminAuthService, SuperAdminService],
})
export class SuperAdminModule {}
