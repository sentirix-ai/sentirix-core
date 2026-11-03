import { Global, Module } from '@nestjs/common';
import { EventsGateway } from './events.gateway.js';

@Global()
@Module({
  providers: [EventsGateway],
  exports: [EventsGateway],
})
export class EventsModule {}
