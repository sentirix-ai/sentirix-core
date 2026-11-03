import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  OnGatewayInit,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';

@WebSocketGateway({
  cors: {
    origin: '*',
  },
})
export class EventsGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(EventsGateway.name);

  afterInit() {
    this.logger.log('WebSocket Gateway initialized successfully.');
  }

  handleConnection(client: Socket) {
    this.logger.log(`Client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);
  }

  @SubscribeMessage('ticket:join')
  handleJoinTicket(@ConnectedSocket() client: Socket, @MessageBody() ticketId: string) {
    client.join(`ticket_${ticketId}`);
    this.logger.log(`Client ${client.id} joined room ticket_${ticketId}`);
    return { event: 'ticket:joined', data: ticketId };
  }

  @SubscribeMessage('ticket:leave')
  handleLeaveTicket(@ConnectedSocket() client: Socket, @MessageBody() ticketId: string) {
    client.leave(`ticket_${ticketId}`);
    this.logger.log(`Client ${client.id} left room ticket_${ticketId}`);
    return { event: 'ticket:left', data: ticketId };
  }

  /**
   * Agent Collision Warning (Zendesk-inspired)
   */
  @SubscribeMessage('agent:viewing')
  handleAgentViewing(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { ticketId: string; agentName: string },
  ) {
    client.to(`ticket_${payload.ticketId}`).emit('agent:viewing_alert', {
      ticketId: payload.ticketId,
      agentName: payload.agentName,
      timestamp: new Date().toISOString(),
    });
  }

  @SubscribeMessage('agent:typing')
  handleAgentTyping(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { ticketId: string; agentName: string; isTyping: boolean },
  ) {
    client.to(`ticket_${payload.ticketId}`).emit('agent:typing_status', payload);
  }

  // System Broadcast Methods
  broadcastTicketCreated(ticket: unknown) {
    this.server?.emit('ticket:created', ticket);
  }

  broadcastTicketUpdated(ticket: unknown) {
    this.server?.emit('ticket:updated', ticket);
  }

  broadcastNewMessage(ticketId: string, message: unknown) {
    this.server?.to(`ticket_${ticketId}`).emit('message:new', message);
    this.server?.emit('ticket:activity', { ticketId, message });
  }
}
