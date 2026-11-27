import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class LoginDto {
  @ApiProperty({
    example: 'sarah.ops',
    description: 'Unified login field: enter either username or work email address',
  })
  @IsString()
  @IsNotEmpty({ message: 'Username or email is required.' })
  identifier: string;

  @ApiProperty({
    example: '••••••••••••',
    description: 'Account password',
  })
  @IsString()
  @IsNotEmpty({ message: 'Password is required.' })
  password: string;

  @ApiPropertyOptional({ enum: ['ADMIN', 'USER'], default: 'USER' })
  @IsOptional()
  @IsEnum(['ADMIN', 'USER'])
  role?: 'ADMIN' | 'USER' = 'USER';
}
