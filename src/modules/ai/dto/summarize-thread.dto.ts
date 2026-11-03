import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsNotEmpty, IsString } from 'class-validator';
import { ChatMessageDto } from './draft-reply.dto.js';

export class SummarizeThreadDto {
  @ApiProperty({ example: 'Bug in payment gateway' })
  @IsString()
  @IsNotEmpty()
  ticketTitle: string;

  @ApiProperty({ type: [ChatMessageDto] })
  @IsArray()
  messages: ChatMessageDto[];
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
