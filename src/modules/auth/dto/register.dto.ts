import { ApiProperty } from '@nestjs/swagger';
import {
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class RegisterDto {
  @ApiProperty({
    example: 'sarah_ops#',
    description: 'Username max 20 chars, special characters allowed, strictly no spaces',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(20, { message: 'Username must not exceed 20 characters.' })
  @Matches(/^[^\s]+$/, { message: 'Username must not contain any spaces.' })
  username: string;

  @ApiProperty({ example: 'sarah.jenkins@company.com' })
  @IsEmail({}, { message: 'Please provide a valid active work email address.' })
  @IsNotEmpty()
  email: string;

  @ApiProperty({ example: '+1 (555) 019-2834' })
  @IsString()
  @IsNotEmpty({ message: 'Active phone number is required.' })
  phone: string;

  @ApiProperty({ enum: ['EMAIL', 'PHONE'], default: 'EMAIL' })
  @IsEnum(['EMAIL', 'PHONE'], { message: 'Verification method must be either EMAIL or PHONE.' })
  verificationMethod: 'EMAIL' | 'PHONE';

  @ApiProperty({
    example: 'Secret@123',
    description:
      'Minimum 8 characters, at least 1 lowercase letter, 1 uppercase letter, and 1 special character',
  })
  @IsString()
  @MinLength(8, { message: 'Password must be at least 8 characters long.' })
  @Matches(/(?=.*[a-z])/, { message: 'Password must contain at least 1 lowercase letter.' })
  @Matches(/(?=.*[A-Z])/, { message: 'Password must contain at least 1 uppercase letter.' })
  @Matches(/(?=.*[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?~`])/, {
    message: 'Password must contain at least 1 special character.',
  })
  password: string;
}
