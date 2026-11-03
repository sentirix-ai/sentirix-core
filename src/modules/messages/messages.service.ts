import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { EventsGateway } from '../events/events.gateway.js';
import { CreateMessageDto } from './dto/message.dto.js';

export interface MessageRecord {
  id: string;
  ticketId: string;
  senderId: string;
  senderName: string;
  type: 'PUBLIC_REPLY' | 'INTERNAL_NOTE' | 'SYSTEM_EVENT';
  content: string;
  aiGenerated: boolean;
  createdAt: string;
}

@Injectable()
export class MessagesService {
  private readonly logger = new Logger(MessagesService.name);

  // Initial mock seed messages for demo/preview
  private memoryMessages: MessageRecord[] = [
    {
      id: 'msg-01',
      ticketId: 'tick-001',
      senderId: 'cust-01',
      senderName: 'Sarah Jenkins',
      type: 'PUBLIC_REPLY',
      content:
        'I clicked upgrade once, but my bank statement shows two identical charges of $1,200 on Oct 30. Please refund the duplicate immediately.',
      aiGenerated: false,
      createdAt: new Date(Date.now() - 3600000 * 3).toISOString(),
    },
    {
      id: 'msg-02',
      ticketId: 'tick-001',
      senderId: 'agent-01',
      senderName: 'Marcus Vance',
      type: 'INTERNAL_NOTE',
      content:
        'Stripe charge ID ch_3Pq9 indicates a double webhook trigger from our checkout form. Verified on Stripe dashboard. Need finance approval for manual void.',
      aiGenerated: false,
      createdAt: new Date(Date.now() - 3600000 * 2).toISOString(),
    },
    {
      id: 'msg-03',
      ticketId: 'tick-001',
      senderId: 'agent-01',
      senderName: 'Marcus Vance',
      type: 'PUBLIC_REPLY',
      content:
        'Hi Sarah, thanks for alerting us. I verified the duplicate charge and escalated it to our billing team. The second $1,200 is being reversed right now.',
      aiGenerated: true,
      createdAt: new Date(Date.now() - 3600000 * 1.5).toISOString(),
    },
  ];

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventsGateway: EventsGateway,
  ) {}

  async create(dto: CreateMessageDto): Promise<MessageRecord> {
    this.logger.log(`Creating message for ticket ${dto.ticketId} [${dto.type}]`);

    try {
      const created = await this.prisma.message.create({
        data: {
          ticketId: dto.ticketId,
          type: dto.type as any,
          content: dto.content,
          senderId: dto.senderId || 'user-unknown',
          aiGenerated: dto.aiGenerated || false,
        },
      });

      const record: MessageRecord = {
        id: created.id,
        ticketId: created.ticketId,
        senderId: created.senderId,
        senderName: dto.senderName || 'Support Agent',
        type: created.type as any,
        content: created.content,
        aiGenerated: created.aiGenerated,
        createdAt: created.createdAt.toISOString(),
      };

      this.eventsGateway.broadcastNewMessage(dto.ticketId, record);
      return record;
    } catch {
      // Memory fallback
      const newMsg: MessageRecord = {
        id: `msg-${Date.now().toString(36)}`,
        ticketId: dto.ticketId,
        senderId: dto.senderId || 'agent-01',
        senderName: dto.senderName || (dto.type === 'INTERNAL_NOTE' ? 'Marcus Vance (Internal)' : 'Support Agent'),
        type: dto.type,
        content: dto.content,
        aiGenerated: dto.aiGenerated || false,
        createdAt: new Date().toISOString(),
      };

      this.memoryMessages.push(newMsg);
      this.eventsGateway.broadcastNewMessage(dto.ticketId, newMsg);
      return newMsg;
    }
  }

  async findByTicketId(ticketId: string): Promise<MessageRecord[]> {
    try {
      const msgs = await this.prisma.message.findMany({
        where: { ticketId },
        include: { sender: true },
        orderBy: { createdAt: 'asc' },
      });

      if (msgs.length > 0) {
        return msgs.map((m) => ({
          id: m.id,
          ticketId: m.ticketId,
          senderId: m.senderId,
          senderName:
            m.type === 'INTERNAL_NOTE'
              ? `${m.sender?.fullName || 'Agent'} (Internal Note)`
              : m.sender?.fullName || 'Participant',
          type: m.type as any,
          content: m.content,
          aiGenerated: m.aiGenerated,
          createdAt: m.createdAt.toISOString(),
        }));
      }
    } catch {
      // Fallback
    }

    return this.memoryMessages.filter((m) => m.ticketId === ticketId);
  }
}
