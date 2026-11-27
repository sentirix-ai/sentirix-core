import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class SuperAdminForceLogoutDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  userId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  username?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  token?: string;
}

export class SuperAdminUpdateAvatarDto {
  @ApiPropertyOptional({ description: 'Base64 data URL or null to remove' })
  @IsOptional()
  avatarUrl?: string | null;
}
