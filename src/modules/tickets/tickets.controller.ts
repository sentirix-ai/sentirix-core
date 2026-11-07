import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { TicketsService, TicketRecord } from './tickets.service.js';
import {
  CreateTicketDto,
  UpdateTicketStatusDto,
  AssignTicketDto,
  TransferTicketPodDto,
} from './dto/ticket.dto.js';

@ApiTags('Tickets')
@Controller('tickets')
export class TicketsController {
  constructor(private readonly ticketsService: TicketsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create a new ticket with automatic Gemini AI sentiment & priority triage',
  })
  @ApiResponse({ status: 201, description: 'Ticket created and AI triage executed' })
  async create(@Body() dto: CreateTicketDto): Promise<TicketRecord> {
    return this.ticketsService.create(dto);
  }

  @Get()
  @ApiOperation({ summary: 'List and filter tickets by status, priority, search keyword, or workspace/pod' })
  @ApiQuery({ name: 'status', required: false, enum: ['NEW', 'OPEN', 'PENDING', 'RESOLVED', 'CLOSED'] })
  @ApiQuery({ name: 'priority', required: false, enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiQuery({ name: 'isMember', required: false, type: Boolean })
  @ApiQuery({ name: 'workspaceId', required: false, type: String })
  async findAll(
    @Query('status') status?: string,
    @Query('priority') priority?: string,
    @Query('search') search?: string,
    @Query('isMember') isMember?: string,
    @Query('workspaceId') workspaceId?: string,
  ): Promise<TicketRecord[]> {
    return this.ticketsService.findAll(status, priority, search, isMember === 'true', workspaceId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get details of a single ticket by ID' })
  async findOne(@Param('id') id: string): Promise<TicketRecord> {
    return this.ticketsService.findOne(id);
  }

  @Patch(':id/status')
  @ApiOperation({ summary: 'Update ticket lifecycle status' })
  async updateStatus(
    @Param('id') id: string,
    @Body() dto: UpdateTicketStatusDto,
  ): Promise<TicketRecord> {
    return this.ticketsService.updateStatus(id, dto);
  }

  @Patch(':id/assign')
  @ApiOperation({ summary: 'Assign ticket to an agent' })
  async assign(@Param('id') id: string, @Body() dto: AssignTicketDto): Promise<TicketRecord> {
    return this.ticketsService.assign(id, dto);
  }

  @Patch(':id/transfer-pod')
  @ApiOperation({ summary: 'Transfer ticket to another pod (Cross-Pod Handover)' })
  async transferPod(
    @Param('id') id: string,
    @Body() dto: TransferTicketPodDto,
  ): Promise<TicketRecord> {
    return this.ticketsService.transferPod(id, dto.targetPodId, dto.handoverNote, dto.actorId);
  }

  @Post('demo/cleanup')
  @ApiOperation({ summary: 'Clean up all demo showcase tickets' })
  async cleanupDemo(): Promise<{ count: number }> {
    return this.ticketsService.cleanupDemoTickets();
  }
}
