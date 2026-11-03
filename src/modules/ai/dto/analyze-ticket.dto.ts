import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class AnalyzeTicketDto {
  @ApiProperty({ example: 'Cannot access billing invoice and payment failed twice' })
  @IsString()
  @IsNotEmpty()
  title: string;

  @ApiProperty({
    example:
      'I have been trying to download my October invoice, but the button is broken and now my card has been charged twice without an active receipt. Please fix this immediately, my team is blocked!',
  })
  @IsString()
  @IsNotEmpty()
  description: string;

  @ApiPropertyOptional({ example: 'LOGISTICS' })
  @IsOptional()
  @IsString()
  industry?: string;
}

export class AnalyzeTicketResponseDto {
  @ApiProperty({ enum: ['POSITIVE', 'NEUTRAL', 'FRUSTRATED', 'URGENT'] })
  sentiment: 'POSITIVE' | 'NEUTRAL' | 'FRUSTRATED' | 'URGENT';

  @ApiProperty({ enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] })
  priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

  @ApiProperty({ type: [String], example: ['billing', 'invoice', 'payment'] })
  tags: string[];

  @ApiProperty({ example: 'Customer charged twice and unable to access invoice.' })
  summary: string;

  @ApiPropertyOptional({ example: 'pod-tech-01' })
  @IsOptional()
  @IsString()
  targetPodId?: string;

  @ApiPropertyOptional({ example: 'Pod Pelacakan Resi' })
  @IsOptional()
  @IsString()
  targetPodName?: string;

  @ApiPropertyOptional({ example: 92 })
  @IsOptional()
  confidenceScore?: number;
}
