import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsNotEmpty, IsOptional, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { ChatMessageDto } from './draft-reply.dto.js';
import { AttachmentDto } from './attachment.dto.js';

export class SummarizeThreadDto {
  @ApiProperty({ example: 'Bug in payment gateway' })
  @IsString()
  @IsNotEmpty()
  ticketTitle: string;

  @ApiProperty({ type: [ChatMessageDto] })
  @IsArray()
  messages: ChatMessageDto[];

  @ApiPropertyOptional({ type: [AttachmentDto], description: 'Visual evidence (screenshots or proof documents)' })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AttachmentDto)
  attachments?: AttachmentDto[];
}

export class SummarizeThreadResponseDto {
  @ApiProperty({
    type: [String],
    example: [
      'Customer reported duplicate credit card charge.',
      'Agent requested last 4 digits of card and transaction timestamp.',
      'Pending finance team confirmation for auto-refund.',
    ],
  })
  bulletPoints: string[];
}
