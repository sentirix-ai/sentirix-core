import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';

export class JoinWorkspaceDto {
  @IsString()
  @IsNotEmpty()
  token: string;

  @IsString()
  @IsNotEmpty()
  @MinLength(2, { message: 'Name must be at least 2 characters long' })
  @MaxLength(50, { message: 'Name must not exceed 50 characters' })
  fullName: string;
}
