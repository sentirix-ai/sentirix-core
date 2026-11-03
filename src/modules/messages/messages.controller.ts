import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { MessagesService, MessageRecord } from './messages.service.js';
import { CreateMessageDto } from './dto/message.dto.js';

@ApiTags('Messages')
@Controller('messages')
export class MessagesController {
  constructor(private readonly messagesService: MessagesService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Post a public reply or private internal note to a ticket and broadcast via WebSocket',
  })
  @ApiResponse({ status: 201, description: 'Message created and broadcast' })
  async create(@Body() dto: CreateMessageDto): Promise<MessageRecord> {
    return this.messagesService.create(dto);
  }

  @Get('ticket/:ticketId')
  @ApiOperation({ summary: 'Retrieve full conversation history for a specific ticket' })
  async findByTicketId(@Param('ticketId') ticketId: string): Promise<MessageRecord[]> {
    return this.messagesService.findByTicketId(ticketId);
  }
}
