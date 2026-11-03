import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AiService } from './ai.service.js';
import { AnalyzeTicketDto, AnalyzeTicketResponseDto } from './dto/analyze-ticket.dto.js';
import { DraftReplyDto, DraftReplyResponseDto } from './dto/draft-reply.dto.js';
import { SummarizeThreadDto, SummarizeThreadResponseDto } from './dto/summarize-thread.dto.js';

@ApiTags('AI')
@Controller('ai')
export class AiController {
  constructor(private readonly aiService: AiService) {}

  @Post('analyze-ticket')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Analyze ticket sentiment, urgency priority, and auto-tags via Gemini AI' })
  @ApiResponse({ status: 200, type: AnalyzeTicketResponseDto })
  async analyzeTicket(@Body() dto: AnalyzeTicketDto): Promise<AnalyzeTicketResponseDto> {
    return this.aiService.analyzeTicket(dto.title, dto.description);
  }

  @Post('draft-reply')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Generate one-click AI reply draft grounded on conversation history & knowledge base' })
  @ApiResponse({ status: 200, type: DraftReplyResponseDto })
  async draftReply(@Body() dto: DraftReplyDto): Promise<DraftReplyResponseDto> {
    return this.aiService.draftReply(dto);
  }

  @Post('summarize-thread')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Summarize a long customer conversation thread into 3 key bullet points' })
  @ApiResponse({ status: 200, type: SummarizeThreadResponseDto })
  async summarizeThread(@Body() dto: SummarizeThreadDto): Promise<SummarizeThreadResponseDto> {
    return this.aiService.summarizeThread(dto);
  }

  @Post('generate-pods')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Auto-generate tailored multi-pods for any industry using Gemini 2.5 Flash' })
  async generatePods(
    @Body('industry') industry: string,
    @Body('customDescription') customDescription?: string,
  ) {
    return this.aiService.generatePodsForIndustry(industry, customDescription);
  }
}
