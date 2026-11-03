import { Module } from '@nestjs/common';
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
import { AnalyticsModule } from './modules/analytics/analytics.module.js';

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
    AnalyticsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
