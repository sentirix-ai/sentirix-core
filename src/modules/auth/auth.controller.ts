import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AuthService, AuthUserResponse } from './auth.service.js';
import { RegisterDto } from './dto/register.dto.js';
import { LoginDto } from './dto/login.dto.js';
import { UpdateAvatarDto } from './dto/update-avatar.dto.js';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Register a new enterprise user account with strict password & username validation',
  })
  @ApiResponse({ status: 201, description: 'User account created and verification dispatched' })
  async register(@Body() dto: RegisterDto): Promise<AuthUserResponse> {
    return this.authService.register(dto);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Unified login endpoint (accepts username or email, authenticates Admin or regular User)',
  })
  @ApiResponse({ status: 200, description: 'Authenticated successfully' })
  async login(@Body() dto: LoginDto): Promise<AuthUserResponse> {
    return this.authService.login(dto);
  }

  @Post('avatar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update or remove user profile photo (avatar)' })
  @ApiResponse({ status: 200, description: 'Profile photo updated or removed successfully' })
  async updateAvatar(@Body() dto: UpdateAvatarDto) {
    return this.authService.updateAvatar(dto);
  }
}
