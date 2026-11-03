import { IsString, IsNotEmpty, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateAvatarDto {
  @ApiProperty({ description: 'Username of the user' })
  @IsString()
  @IsNotEmpty()
  username: string;

  @ApiPropertyOptional({ description: 'Base64 data URL or image URL for avatar, or null to remove' })
  @IsOptional()
  avatarUrl?: string | null;

  @ApiPropertyOptional({ description: 'Optional user ID' })
  @IsOptional()
  @IsString()
  userId?: string;
}
