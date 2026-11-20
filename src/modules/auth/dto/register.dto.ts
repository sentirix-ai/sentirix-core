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
    example: 'sarah_ops99',
    description: 'Username 3-20 characters: letters, numbers, dots, underscores. Strictly no spaces.',
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(3, { message: 'Username must be at least 3 characters long.' })
  @MaxLength(20, { message: 'Username must not exceed 20 characters.' })
  @Matches(/^[a-z0-9][a-z0-9._]*$/i, {
    message: 'Username must start with a letter or number and contain only letters, numbers, dots, and underscores.',
  })
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
