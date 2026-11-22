import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsBoolean, IsEnum, IsNotEmpty, IsOptional, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { AttachmentDto } from '../../ai/dto/attachment.dto.js';

export class CreateMessageDto {
  @ApiProperty({ example: 'tick-001' })
  @IsString()
  @IsNotEmpty()
  ticketId: string;

  @ApiProperty({
    enum: ['PUBLIC_REPLY', 'INTERNAL_NOTE', 'SYSTEM_EVENT'],
    default: 'PUBLIC_REPLY',
    example: 'PUBLIC_REPLY',
  })
  @IsEnum(['PUBLIC_REPLY', 'INTERNAL_NOTE', 'SYSTEM_EVENT'])
  type: 'PUBLIC_REPLY' | 'INTERNAL_NOTE' | 'SYSTEM_EVENT';

  @ApiProperty({ example: 'We have refunded the second charge of $1,200. Confirmation #TX-8831' })
  @IsString()
  @IsNotEmpty()
  content: string;

  @ApiPropertyOptional({ example: 'agent-01' })
  @IsOptional()
  @IsString()
  senderId?: string;

  @ApiPropertyOptional({ example: 'Marcus Vance' })
  @IsOptional()
  @IsString()
  senderName?: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  aiGenerated?: boolean = false;

  @ApiPropertyOptional({ type: [AttachmentDto], description: 'Optional screenshots or proof documents' })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AttachmentDto)
  attachments?: AttachmentDto[];

  @ApiPropertyOptional({ example: 'receipt.pdf' })
  @IsOptional()
  @IsString()
  attachmentName?: string;

  @ApiPropertyOptional({ example: 'application/pdf' })
  @IsOptional()
  @IsString()
  attachmentType?: string;

  @ApiPropertyOptional({ description: 'Base64 data or data URL' })
  @IsOptional()
  @IsString()
  attachmentData?: string;
}
