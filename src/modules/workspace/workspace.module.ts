import { Module } from '@nestjs/common';
import { WorkspaceController } from './workspace.controller.js';
import { WorkspaceService } from './workspace.service.js';
import { WorkspaceTokenService } from './workspace-token.service.js';
import { WorkspaceOnboardingService } from './workspace-onboarding.service.js';
import { WorkspacePersonnelService } from './workspace-personnel.service.js';

@Module({
  controllers: [WorkspaceController],
  providers: [
    WorkspaceService,
    WorkspaceTokenService,
    WorkspaceOnboardingService,
    WorkspacePersonnelService,
  ],
  exports: [
    WorkspaceService,
    WorkspaceTokenService,
    WorkspaceOnboardingService,
    WorkspacePersonnelService,
  ],
})
export class WorkspaceModule {}
