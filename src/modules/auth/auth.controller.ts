import { Body, Controller, ForbiddenException, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AuthService, AuthUserResponse } from './auth.service.js';
import { RegisterDto } from './dto/register.dto.js';
import { LoginDto } from './dto/login.dto.js';
import { UpdateAvatarDto } from './dto/update-avatar.dto.js';
import { Public } from '../../common/auth/auth.decorators.js';
import type { AuthenticatedRequest } from '../../common/auth/jwt-auth.guard.js';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Register a new enterprise user account with strict password & username validation',
  })
  @ApiResponse({ status: 201, description: 'User account created and verification dispatched' })
  async register(@Body() dto: RegisterDto): Promise<AuthUserResponse> {
    return this.authService.register(dto);
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Tenant and frontline staff login endpoint (accepts username or work email)',
  })
  @ApiResponse({ status: 200, description: 'Authenticated successfully' })
  async login(@Body() dto: LoginDto): Promise<AuthUserResponse> {
    return this.authService.login(dto);
  }

  @ApiBearerAuth()
  @Post('avatar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update or remove user profile photo (avatar)' })
  @ApiResponse({ status: 200, description: 'Profile photo updated or removed successfully' })
  async updateAvatar(@Req() req: AuthenticatedRequest, @Body() dto: UpdateAvatarDto) {
    const actor = req.user;
    if (actor) {
      const isSelf =
        (dto.userId && actor.userId === dto.userId) ||
        (actor.username && actor.username.toLowerCase() === dto.username.trim().toLowerCase());
      if (!isSelf) {
        throw new ForbiddenException('You are not authorized to modify another user profile.');
      }
    }
    return this.authService.updateAvatar(dto);
  }

  @Public()
  @Post('heartbeat')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Ping user presence heartbeat' })
  async heartbeat(@Body('userId') userId: string) {
    if (!userId) return { success: false, error: 'userId is required' };
    return this.authService.heartbeat(userId);
  }

  @Public()
  @Post('session-start')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Start a user activity session upon login' })
  async startSession(
    @Body() body: { userId: string; role?: string; workspaceId?: string },
  ) {
    if (!body?.userId) return { success: false, error: 'userId is required' };
    return this.authService.startSession(body.userId, body.role, body.workspaceId);
  }

  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Logout and terminate active user presence session' })
  async logout(@Body() body: { userId: string; reason?: string }) {
    if (!body?.userId) return { success: false, error: 'userId is required' };
    return this.authService.logoutSession(body.userId, body.reason || 'MANUAL_LOGOUT');
  }

  @Public()
  @Post('beacon-logout')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Browser beacon close session' })
  async beaconLogout(@Body() body: { userId: string }) {
    if (!body?.userId) return { success: false };
    return this.authService.logoutSession(body.userId, 'BROWSER_CLOSED');
  }
}
