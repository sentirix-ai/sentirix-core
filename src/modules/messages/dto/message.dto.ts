import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsEnum, IsNotEmpty, IsOptional, IsString } from 'class-validator';

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
}
