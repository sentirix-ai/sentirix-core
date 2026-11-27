import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { PrismaModule } from './modules/prisma/prisma.module.js';
import { EventsModule } from './modules/events/events.module.js';
import { AiModule } from './modules/ai/ai.module.js';
import { TicketsModule } from './modules/tickets/tickets.module.js';
import { MessagesModule } from './modules/messages/messages.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { WorkspaceModule } from './modules/workspace/workspace.module.js';
import { SuperAdminModule } from './modules/super-admin/super-admin.module.js';
import { JwtAuthGuard } from './common/auth/jwt-auth.guard.js';
import { RolesGuard } from './common/auth/roles.guard.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    PrismaModule,
    EventsModule,
    AiModule,
    TicketsModule,
    MessagesModule,
    AuthModule,
    WorkspaceModule,
    SuperAdminModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: RolesGuard,
    },
  ],
})
export class AppModule {}
