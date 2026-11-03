import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsEnum, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateTicketDto {
  @ApiProperty({ example: 'Production database latency is critical after v2.4 upgrade' })
  @IsString()
  @IsNotEmpty()
  title: string;

  @ApiProperty({
    example:
      'We are noticing 5000ms query latency on checkout endpoint after the latest deployment. Users cannot complete payment.',
  })
  @IsString()
  @IsNotEmpty()
  description: string;

  @ApiPropertyOptional({ example: 'user-uuid-123' })
  @IsOptional()
  @IsString()
  customerId?: string;

  @ApiPropertyOptional({ example: 'Sarah Jenkins (CTO, HyperScale Inc)' })
  @IsOptional()
  @IsString()
  customerName?: string;

  @ApiPropertyOptional({ type: [String], example: ['database', 'production', 'latency'] })
  @IsOptional()
  @IsArray()
  tags?: string[];

  @ApiPropertyOptional({ example: 'pod-uuid-123' })
  @IsOptional()
  @IsString()
  workspaceId?: string;
}

export class UpdateTicketStatusDto {
  @ApiProperty({ enum: ['NEW', 'OPEN', 'PENDING', 'RESOLVED', 'CLOSED'], example: 'IN_PROGRESS' })
  @IsEnum(['NEW', 'OPEN', 'PENDING', 'RESOLVED', 'CLOSED'])
  status: 'NEW' | 'OPEN' | 'PENDING' | 'RESOLVED' | 'CLOSED';
}

export class AssignTicketDto {
  @ApiProperty({ example: 'agent-uuid-456' })
  @IsString()
  @IsNotEmpty()
  agentId: string;
}

export class TransferTicketPodDto {
  @ApiProperty({ example: 'workspace-pod-uuid' })
  @IsString()
  @IsNotEmpty()
  targetPodId: string;

  @ApiPropertyOptional({ example: 'Transferred from Billing Pod. Issue is a technical timeout.' })
  @IsOptional()
  @IsString()
  handoverNote?: string;

  @ApiPropertyOptional({ example: 'agent-uuid' })
  @IsOptional()
  @IsString()
  actorId?: string;
}
