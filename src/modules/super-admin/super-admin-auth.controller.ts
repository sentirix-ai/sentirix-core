import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Public, SuperAdminOnly } from '../../common/auth/auth.decorators.js';
import type { AuthenticatedRequest } from '../../common/auth/jwt-auth.guard.js';
import {
  SuperAdminAuthService,
  SuperAdminProfileResponse,
} from './super-admin-auth.service.js';
import { SuperAdminLoginDto } from './dto/super-admin-login.dto.js';
import { SuperAdminUpdateAvatarDto } from './dto/super-admin-actions.dto.js';

@ApiTags('SuperAdminAuth')
@Controller('super-admin/auth')
export class SuperAdminAuthController {
  constructor(private readonly superAdminAuthService: SuperAdminAuthService) {}

  private extractIp(req: AuthenticatedRequest): string | undefined {
    const forwarded = req.headers['x-forwarded-for'];
    const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    return raw?.split(',')[0]?.trim() || undefined;
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Isolated Platform Founder login endpoint (issues SUPER_ADMIN_JWT_SECRET token)',
  })
  @ApiResponse({ status: 200, description: 'Platform Founder authenticated' })
  async login(
    @Req() req: AuthenticatedRequest,
    @Body() dto: SuperAdminLoginDto,
  ): Promise<SuperAdminProfileResponse> {
    return this.superAdminAuthService.login(dto, this.extractIp(req));
  }

  @ApiBearerAuth()
  @SuperAdminOnly()
  @Get('me')
  @ApiOperation({ summary: 'Retrieve authenticated Platform Founder profile' })
  async me(@Req() req: AuthenticatedRequest): Promise<SuperAdminProfileResponse> {
    return this.superAdminAuthService.getProfile(req.user!.userId);
  }

  @ApiBearerAuth()
  @SuperAdminOnly()
  @Post('avatar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update Platform Founder profile photo' })
  async updateAvatar(
    @Req() req: AuthenticatedRequest,
    @Body() dto: SuperAdminUpdateAvatarDto,
  ) {
    return this.superAdminAuthService.updateAvatar(
      req.user!.userId,
      dto.avatarUrl ?? null,
    );
  }

  @ApiBearerAuth()
  @SuperAdminOnly()
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Terminate Platform Founder session and record audit event' })
  async logout(@Req() req: AuthenticatedRequest) {
    return this.superAdminAuthService.logout(
      req.user!.userId,
      this.extractIp(req),
    );
  }
}
