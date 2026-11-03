import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsEnum, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class ChatMessageDto {
  @ApiProperty({ example: 'Customer' })
  @IsString()
  sender: string;

  @ApiProperty({ example: 'I need a refund for the duplicate charge.' })
  @IsString()
  content: string;
}

export class DraftReplyDto {
  @ApiProperty({ example: 'Duplicate charge on card' })
  @IsString()
  @IsNotEmpty()
  ticketTitle: string;

  @ApiProperty({ example: 'Charged twice on invoice #9012' })
  @IsString()
  @IsNotEmpty()
  ticketDescription: string;

  @ApiProperty({ type: [ChatMessageDto] })
  @IsArray()
  conversationHistory: ChatMessageDto[];

  @ApiPropertyOptional({ enum: ['professional', 'empathetic', 'concise'], default: 'professional' })
  @IsOptional()
  @IsEnum(['professional', 'empathetic', 'concise'])
  tone?: 'professional' | 'empathetic' | 'concise' = 'professional';

  @ApiPropertyOptional({ example: 'Refund policy: duplicate charges are refunded within 3-5 business days.' })
  @IsOptional()
  @IsString()
  knowledgeContext?: string;
}

export class DraftReplyResponseDto {
  @ApiProperty({ example: 'Dear Alex, thank you for reaching out. We apologize for the duplicate charge...' })
  draft: string;

  @ApiProperty({ example: ['Referenced refund policy Section 3.2'] })
  groundedSources: string[];
}
