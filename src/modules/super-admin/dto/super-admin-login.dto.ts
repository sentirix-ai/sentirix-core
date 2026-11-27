import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class SuperAdminLoginDto {
  @ApiProperty({
    example: 'admin@sevaniq.enterprise',
    description: 'Platform Founder username or email',
  })
  @IsString()
  @IsNotEmpty({ message: 'Administrator identifier is required.' })
  identifier: string;

  @ApiProperty({
    example: '••••••••••••',
    description: 'Platform Founder password',
  })
  @IsString()
  @IsNotEmpty({ message: 'Administrator password is required.' })
  password: string;
}
