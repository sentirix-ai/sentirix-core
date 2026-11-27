import {
  Injectable,
  OnModuleInit,
  BadRequestException,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { PrismaService } from '../prisma/prisma.service.js';
import { EventsGateway } from '../events/events.gateway.js';
import { RegisterDto } from './dto/register.dto.js';
import { LoginDto } from './dto/login.dto.js';
import { UpdateAvatarDto } from './dto/update-avatar.dto.js';
import {
  hashPasswordScrypt,
  verifyPasswordHash,
  signJwt,
} from '../../common/security/crypto.util.js';

export interface AuthUserResponse {
  id: string;
  username: string;
  fullName?: string;
  email: string;
  phone?: string;
  role:
    | 'TENANT_OWNER'
    | 'POD_LEADER'
    | 'AGENT'
    | 'CUSTOMER'
    | 'ADMIN'
    | 'USER'
    | 'LEADER';
  organizationId?: string;
  workspaceRole?: string;
  workspaceId?: string;
  workspaceName?: string;
  isGuestMember?: boolean;
  verificationMethod?: 'EMAIL' | 'PHONE';
  isVerified: boolean;
  avatarText: string;
  avatarUrl?: string | null;
  token?: string;
  onboardingCompleted?: boolean;
  onboardingDraft?: any;
}

interface StoredMemoryUser {
  id: string;
  username: string;
  email: string;
  phone: string;
  passwordHash: string;
  role: 'ADMIN' | 'USER';
  verificationMethod: 'EMAIL' | 'PHONE';
  isVerified: boolean;
  avatarUrl?: string | null;
  onboardingCompleted?: boolean;
  createdAt: string;
}

@Injectable()
export class AuthService implements OnModuleInit {
  private readonly logger = new Logger(AuthService.name);

  // In-memory fallback for local development resilience
  private memoryUsers: StoredMemoryUser[] = [];

  private getAdminUsername(): string {
    return (process.env.ADMIN_USERNAME || 'pungkyrama').trim();
  }

  private getAdminEmail(): string {
    return (process.env.ADMIN_EMAIL || 'admin@sevaniq.enterprise').trim();
  }

  private getAdminPassword(): string | null {
    const envPass = process.env.ADMIN_PASSWORD?.trim();
    return envPass || null;
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventsGateway: EventsGateway,
  ) {
    this.memoryUsers = [];
  }

  async onModuleInit() {
    try {
      const adminUsername = this.getAdminUsername();
      const adminEmail = this.getAdminEmail();
      const adminPassword = this.getAdminPassword();
      const adminExists = await this.prisma.user.findFirst({
        where: {
          OR: [
            { username: adminUsername },
            { email: adminEmail },
            { email: 'admin@sevaniq.enterprise' },
          ],
        },
      });

      if (!adminExists && adminPassword) {
        await this.prisma.user.create({
          data: {
            username: adminUsername,
            fullName: 'Pungky Rama (Admin)',
            email: adminEmail,
            phone: '+1-555-019-0000',
            passwordHash: this.hashPassword(adminPassword),
            role: 'SUPER_ADMIN',
          },
        });
        this.logger.log(`Default Super Admin user (@${adminUsername}) seeded into database.`);
      }
    } catch (err) {
      this.logger.warn(`Could not seed default admin into db: ${(err as Error)?.message}`);
    }
  }

  /**
   * Start User Activity Session for Presence Tracking
   */
  async startSession(userId: string, role?: string, workspaceId?: string) {
    try {
      const user = await this.prisma.user.findFirst({
        where: {
          OR: [
            { id: userId },
            { username: { equals: userId, mode: 'insensitive' } },
            { email: { equals: userId, mode: 'insensitive' } },
          ],
        },
        include: { workspaceMembership: true },
      });
      if (!user) return null;

      // Prevent duplicate ghost sessions: if there is already an active session created within the last 15 seconds, reuse it
      const existingRecentSession = await this.prisma.userActivitySession.findFirst({
        where: {
          userId: user.id,
          isOnline: true,
          loginAt: {
            gte: new Date(Date.now() - 15000),
          },
        },
        orderBy: { loginAt: 'desc' },
      });

      if (existingRecentSession) {
        return await this.prisma.userActivitySession.update({
          where: { id: existingRecentSession.id },
          data: {
            lastHeartbeatAt: new Date(),
            ...(workspaceId ? { workspaceId } : {}),
            ...(role ? { role } : {}),
          },
        });
      }

      // Close all previous active sessions for this user so they don't produce duplicate ghost online sessions
      await this.prisma.userActivitySession.updateMany({
        where: {
          userId: user.id,
          isOnline: true,
        },
        data: {
          isOnline: false,
          logoutAt: new Date(),
          logoutReason: 'SESI_BARU_DIMULAI',
        },
      });

      const effectiveRole =
        role ||
        (user.role === 'SUPER_ADMIN'
          ? 'SUPER_ADMIN'
          : user.role === 'POD_LEADER' || user.workspaceMembership?.role === 'LEADER'
            ? 'POD_LEADER'
            : user.role || 'AGENT');
      const effectiveWorkspaceId =
        workspaceId || user.workspaceMembership?.workspaceId || null;

      const session = await this.prisma.userActivitySession.create({
        data: {
          userId: user.id,
          organizationId: user.organizationId,
          workspaceId: effectiveWorkspaceId,
          role: effectiveRole,
          loginAt: new Date(),
          lastHeartbeatAt: new Date(),
          isOnline: true,
        },
      });
      return session;
    } catch (e) {
      this.logger.error(`Failed to start activity session: ${(e as Error).message}`);
      return null;
    }
  }

  /**
   * Heartbeat ping every 15-20s from active browser tab
   */
  async heartbeat(userId: string) {
    try {
      const user = await this.prisma.user.findFirst({
        where: {
          OR: [
            { id: userId },
            { username: { equals: userId, mode: 'insensitive' } },
            { email: { equals: userId, mode: 'insensitive' } },
          ],
        },
      });

      if (!user) {
        return { success: false, active: false, reason: 'USER_NOT_FOUND' };
      }

      const activeSession = await this.prisma.userActivitySession.findFirst({
        where: { userId: user.id, isOnline: true },
        orderBy: { loginAt: 'desc' },
      });

      if (activeSession) {
        await this.prisma.userActivitySession.update({
          where: { id: activeSession.id },
          data: { lastHeartbeatAt: new Date() },
        });
        return { success: true, active: true, sessionId: activeSession.id };
      } else {
        const latestSession = await this.prisma.userActivitySession.findFirst({
          where: { userId: user.id },
          orderBy: { loginAt: 'desc' },
        });

        // Only reject if Super Admin explicitly revoked this session under Zero-Trust protocol
        if (
          latestSession &&
          !latestSession.isOnline &&
          latestSession.logoutReason === 'ADMIN_FORCE_LOGOUT'
        ) {
          return {
            success: false,
            active: false,
            reason: 'ADMIN_FORCE_LOGOUT',
          };
        }

        const newSession = await this.startSession(user.id);
        return { success: true, active: true, sessionId: newSession?.id };
      }
    } catch (e) {
      return { success: false, active: false, error: (e as Error).message };
    }
  }

  /**
   * Clean Logout Session
   */
  async logoutSession(userId: string, reason = 'MANUAL_LOGOUT') {
    try {
      if (!userId) return { success: true };

      // Resolve user by id, username, or fullName for resilient multi-format identifiers
      const user = await this.prisma.user.findFirst({
        where: {
          OR: [
            { id: userId },
            { username: { equals: userId, mode: 'insensitive' } },
            { fullName: { equals: userId, mode: 'insensitive' } },
          ],
        },
      });

      const effectiveUserId = user ? user.id : userId;
      const effectiveName = user?.fullName || user?.username || userId;

      await this.prisma.userActivitySession.updateMany({
        where: { userId: effectiveUserId, isOnline: true },
        data: {
          isOnline: false,
          logoutAt: new Date(),
          logoutReason: reason,
        },
      });

      this.logger.log(`User session terminated for ${effectiveName} (${effectiveUserId}) with reason: ${reason}`);

      // Automated Hanging Ticket Radar Guard: Flag unresolved tickets held by this departing staff
      try {
        const hangingReason =
          reason === 'MANUAL_LOGOUT'
            ? 'AGENT_LOGOUT_BEFORE_RESOLVED'
            : reason === 'BROWSER_CLOSE' || reason === 'ABRUPT_DISCONNECT'
            ? 'AGENT_ABRUPT_DISCONNECT'
            : `AGENT_DISCONNECTED_${reason}`;

        const hangingTickets = await this.prisma.ticket.findMany({
          where: {
            assignedAgentId: effectiveUserId,
            status: { in: ['NEW', 'OPEN', 'PENDING'] },
            isHanging: false,
          },
        });

        if (hangingTickets.length > 0) {
          const now = new Date();
          await this.prisma.ticket.updateMany({
            where: {
              id: { in: hangingTickets.map((t) => t.id) },
            },
            data: {
              isHanging: true,
              hangingReason,
              hangingSince: now,
            },
          });

          this.logger.warn(
            `Automated Hanging Radar: Flagged ${hangingTickets.length} tickets as hanging due to ${reason} by ${effectiveName}`,
          );

          for (const t of hangingTickets) {
            this.eventsGateway.broadcastTicketUpdated({
              ...t,
              isHanging: true,
              hangingReason,
              hangingSince: now.toISOString(),
            });
          }
        }
      } catch (hangingErr) {
        this.logger.warn(`Could not flag hanging tickets: ${(hangingErr as Error)?.message}`);
      }

      // Broadcast instant WebSocket presence notification to Cockpit & connected admin hubs
      try {
        this.eventsGateway.server?.emit('presence:changed', {
          userId: effectiveUserId,
          username: user?.username || userId,
          fullName: user?.fullName || userId,
          isOnline: false,
          reason,
          timestamp: new Date().toISOString(),
        });
        this.eventsGateway.server?.emit('team:member_left', {
          memberId: effectiveUserId,
          memberName: effectiveName,
          reason,
          timestamp: new Date().toISOString(),
        });
      } catch (wsErr) {
        this.logger.warn(`Could not broadcast websocket presence change: ${(wsErr as Error)?.message}`);
      }

      return { success: true };
    } catch (e) {
      return { success: false, error: (e as Error).message };
    }
  }

  // Salted scrypt password hash
  hashPassword(password: string): string {
    return hashPasswordScrypt(password);
  }

  // Generate cryptographically signed HS256 JWT token for tenant/staff sessions
  private generateToken(
    userId: string,
    role: string,
    username?: string,
    workspaceId?: string,
    organizationId?: string,
  ): string {
    return signJwt({
      sub: userId,
      role,
      username,
      workspaceId,
      organizationId,
    });
  }

  // Retrieve persistent onboarding draft for any associated identifier
  private getOnboardingDraftForUser(identifiers: (string | undefined | null)[]): any {
    try {
      const draftPath = path.join(process.cwd(), 'data', 'onboarding-drafts.json');
      if (!fs.existsSync(draftPath)) return null;
      const raw = fs.readFileSync(draftPath, 'utf-8');
      const drafts = JSON.parse(raw);
      for (const id of identifiers) {
        if (id) {
          const key = id.toLowerCase().trim();
          if (drafts[key]) {
            return drafts[key];
          }
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  // Delete onboarding draft from file for any associated identifier (guarantees clean slate on new registration)
  private deleteOnboardingDraftForUser(identifiers: (string | undefined | null)[]): void {
    try {
      const draftPath = path.join(process.cwd(), 'data', 'onboarding-drafts.json');
      if (!fs.existsSync(draftPath)) return;
      const raw = fs.readFileSync(draftPath, 'utf-8');
      const drafts = JSON.parse(raw);
      let changed = false;
      for (const id of identifiers) {
        if (id) {
          const key = id.toLowerCase().trim();
          if (drafts[key]) {
            delete drafts[key];
            changed = true;
          }
        }
      }
      if (changed) {
        fs.writeFileSync(draftPath, JSON.stringify(drafts, null, 2), 'utf-8');
      }
    } catch {}
  }

  async register(dto: RegisterDto): Promise<AuthUserResponse> {
    const rawUsername = dto.username.toLowerCase().trim();
    const lowerUsername = rawUsername.replace(/[^a-z0-9._]/g, '');
    const lowerEmail = dto.email.toLowerCase().trim();

    if (lowerUsername.length < 3) {
      throw new BadRequestException('Username must be at least 3 characters long.');
    }

    if (lowerUsername.length > 20) {
      throw new BadRequestException('Username cannot exceed 20 characters.');
    }

    if (!/^[a-z0-9]/.test(lowerUsername)) {
      throw new BadRequestException('Username must start with a letter or number.');
    }

    if (!/^[a-z0-9._]+$/.test(lowerUsername)) {
      throw new BadRequestException(
        'Username can only contain lowercase letters (a-z), numbers (0-9), dots (.), and underscores (_).',
      );
    }

    // Prevent overriding admin
    if (lowerUsername === this.getAdminUsername().toLowerCase()) {
      throw new BadRequestException('This username is reserved for system administration.');
    }

    const passwordHash = this.hashPassword(dto.password);
    const userId = `usr-${Date.now().toString(36)}`;

    try {
      // 1. Check unique in PostgreSQL database first (Strict Case-Insensitive)
      const existingDbUser = await this.prisma.user.findFirst({
        where: {
          OR: [
            { email: { equals: lowerEmail, mode: 'insensitive' } },
            { username: { equals: lowerUsername, mode: 'insensitive' } },
          ],
        },
      });

      if (existingDbUser) {
        if (existingDbUser.username?.toLowerCase() === lowerUsername) {
          throw new BadRequestException(`Username "@${lowerUsername}" is already registered. Please choose another username or log in.`);
        }
        throw new BadRequestException(`An account with email "${lowerEmail}" is already registered. Please log in.`);
      }

      // 2. Insert into PostgreSQL with normalized lowercase username and email
      const dbUser = await this.prisma.user.create({
        data: {
          username: lowerUsername,
          fullName: lowerUsername,
          email: lowerEmail,
          phone: dto.phone?.trim(),
          passwordHash,
          role: 'CUSTOMER', // Default user role
          verificationMethod: dto.verificationMethod || 'EMAIL',
        },
      });

      this.logger.log(`User @${lowerUsername} registered successfully in PostgreSQL db_sevaniq.`);
      // Ensure clean slate by wiping any stale draft files for this username/email
      this.deleteOnboardingDraftForUser([lowerUsername, lowerEmail]);

      return {
        id: dbUser.id,
        username: dbUser.username || lowerUsername,
        email: dbUser.email,
        phone: dbUser.phone || dto.phone,
        role: 'USER',
        verificationMethod: dto.verificationMethod,
        isVerified: true,
        avatarText: (dbUser.username || lowerUsername).slice(0, 2).toUpperCase(),
        token: this.generateToken(dbUser.id, 'USER', dbUser.username || lowerUsername),
        onboardingCompleted: false,
      };
    } catch (err) {
      if (err instanceof BadRequestException) {
        throw err;
      }

      this.logger.warn(`Database insert failed, using memory store: ${(err as Error)?.message}`);

      // Check unique in memory (Strict Case-Insensitive)
      const memoryDuplicate = this.memoryUsers.find(
        (u) => u.username.toLowerCase() === lowerUsername || u.email.toLowerCase() === lowerEmail,
      );
      if (memoryDuplicate) {
        if (memoryDuplicate.username.toLowerCase() === lowerUsername) {
          throw new BadRequestException(`Username "@${lowerUsername}" is already registered. Please choose another username or log in.`);
        }
        throw new BadRequestException(`An account with email "${lowerEmail}" is already registered. Please log in.`);
      }

      // Memory fallback with normalized lowercase
      const newUser: StoredMemoryUser = {
        id: userId,
        username: lowerUsername,
        email: lowerEmail,
        phone: dto.phone?.trim(),
        passwordHash,
        role: 'USER',
        verificationMethod: dto.verificationMethod,
        isVerified: true,
        onboardingCompleted: false,
        createdAt: new Date().toISOString(),
      };

      this.memoryUsers.push(newUser);
      this.logger.log(`User @${lowerUsername} registered successfully (Memory Store).`);

      return {
        id: newUser.id,
        username: newUser.username,
        email: newUser.email,
        phone: newUser.phone,
        role: newUser.role,
        verificationMethod: newUser.verificationMethod,
        isVerified: newUser.isVerified,
        avatarText: newUser.username.slice(0, 2).toUpperCase(),
        token: this.generateToken(newUser.id, newUser.role, newUser.username),
        onboardingCompleted: false,
      };
    }
  }

  async login(dto: LoginDto): Promise<AuthUserResponse> {
    const cleanId = dto.identifier.trim();
    const adminUsername = this.getAdminUsername();
    const adminEmail = this.getAdminEmail();

    // Platform Founder must authenticate exclusively through /api/v1/super-admin/auth/login
    const isPlatformAdminIdentifier =
      cleanId.toLowerCase() === adminUsername.toLowerCase() ||
      cleanId.toLowerCase() === adminEmail.toLowerCase();

    if (
      isPlatformAdminIdentifier ||
      dto.role === 'ADMIN' ||
      (dto.role as string) === 'SUPER_ADMIN'
    ) {
      throw new UnauthorizedException(
        'Invalid credentials. Please verify your username or email and password.',
      );
    }

    // 2. User Login: Unified search by username OR email
    const lowerId = cleanId.toLowerCase();

    // Try finding in database first
    try {
      const dbUser = await this.prisma.user.findFirst({
        where: {
          OR: [
            { email: { equals: cleanId, mode: 'insensitive' } },
            { username: { equals: cleanId, mode: 'insensitive' } },
            { fullName: { equals: cleanId, mode: 'insensitive' } },
          ],
        },
        include: {
          workspaceMembership: {
            include: { workspace: true },
          },
        },
      });

      if (dbUser) {
        if (dbUser.role === 'SUPER_ADMIN') {
          throw new UnauthorizedException(
            'Invalid credentials. Please verify your username or email and password.',
          );
        }

        const pwCheck = verifyPasswordHash(dto.password, dbUser.passwordHash);
        if (!pwCheck.valid) {
          throw new UnauthorizedException('Incorrect password. Please verify and try again.');
        }

        // Transparently upgrade legacy unsalted SHA-256 hashes to salted scrypt
        if (pwCheck.needsRehash) {
          this.prisma.user
            .update({
              where: { id: dbUser.id },
              data: { passwordHash: this.hashPassword(dto.password) },
            })
            .catch(() => {});
        }

        const wsRole = dbUser.workspaceMembership?.role;
        const isLeader = wsRole === 'LEADER';
        const effectiveRole: AuthUserResponse['role'] =
          (dbUser.role as string) === 'TENANT_OWNER'
            ? 'TENANT_OWNER'
            : dbUser.role === 'POD_LEADER' || isLeader
              ? 'POD_LEADER'
              : (dbUser.role as AuthUserResponse['role']);

        const draft = this.getOnboardingDraftForUser([
          dbUser.username,
          dbUser.email,
          dbUser.id,
          lowerId,
        ]);

        return {
          id: dbUser.id,
          username: dbUser.username || dbUser.fullName,
          fullName: (dbUser.fullName || dbUser.username) ?? undefined,
          email: dbUser.email,
          phone: dbUser.phone || undefined,
          role: effectiveRole,
          organizationId: dbUser.organizationId || undefined,
          workspaceRole: wsRole || undefined,
          workspaceId: dbUser.workspaceMembership?.workspaceId || undefined,
          workspaceName: dbUser.workspaceMembership?.workspace?.name || undefined,
          isGuestMember: wsRole === 'AGENT',
          verificationMethod: (dbUser.verificationMethod as 'EMAIL' | 'PHONE') || 'EMAIL',
          isVerified: true,
          avatarText: (dbUser.username || dbUser.fullName).slice(0, 2).toUpperCase(),
          avatarUrl: dbUser.avatarUrl || undefined,
          token: this.generateToken(
            dbUser.id,
            effectiveRole,
            dbUser.username || dbUser.fullName,
            dbUser.workspaceMembership?.workspaceId || undefined,
            dbUser.organizationId || undefined,
          ),
          onboardingCompleted: dbUser.onboardingCompleted ?? false,
          onboardingDraft: draft || null,
        };
      }
    } catch (err) {
      if (err instanceof UnauthorizedException) throw err;
      // Fallback to memory
    }

    // Memory Search Fallback
    const memoryUser = this.memoryUsers.find(
      (u) => u.username.toLowerCase() === lowerId || u.email.toLowerCase() === lowerId,
    );

    if (!memoryUser) {
      throw new UnauthorizedException(
        'No account found matching this username or email. Please sign up first.',
      );
    }

    const memCheck = verifyPasswordHash(dto.password, memoryUser.passwordHash);
    if (!memCheck.valid) {
      throw new UnauthorizedException('Incorrect password. Please verify and try again.');
    }

    const memoryDraft = this.getOnboardingDraftForUser([
      memoryUser.username,
      memoryUser.email,
      memoryUser.id,
      lowerId,
    ]);

    return {
      id: memoryUser.id,
      username: memoryUser.username,
      email: memoryUser.email,
      phone: memoryUser.phone,
      role: memoryUser.role,
      verificationMethod: memoryUser.verificationMethod,
      isVerified: memoryUser.isVerified,
      avatarText: memoryUser.username.slice(0, 2).toUpperCase(),
      avatarUrl: memoryUser.avatarUrl || undefined,
      token: this.generateToken(memoryUser.id, memoryUser.role, memoryUser.username),
      onboardingCompleted: memoryUser.onboardingCompleted ?? false,
      onboardingDraft: memoryDraft || null,
    };
  }

  // Update or Remove user avatar
  async updateAvatar(dto: UpdateAvatarDto): Promise<{ success: boolean; avatarUrl?: string | null; message: string }> {
    const cleanUsername = dto.username.trim();
    const avatarUrl = dto.avatarUrl || null;

    // 1. Try updating in Database
    try {
      const user = await this.prisma.user.findFirst({
        where: {
          OR: [
            { username: { equals: cleanUsername, mode: 'insensitive' } },
            ...(dto.userId ? [{ id: dto.userId }] : []),
          ],
        },
      });

      if (user) {
        if (user.role === 'SUPER_ADMIN') {
          throw new UnauthorizedException('Platform Founder avatar must be updated via Super Admin portal.');
        }
        await this.prisma.user.update({
          where: { id: user.id },
          data: { avatarUrl },
        });
        this.logger.log(`Avatar photo updated for @${user.username} in database.`);
      }
    } catch (err) {
      this.logger.warn(`Could not update avatar in database: ${(err as Error)?.message}`);
    }

    // 2. Also sync to in-memory store
    const memUser = this.memoryUsers.find(
      (u) =>
        u.username.toLowerCase() === cleanUsername.toLowerCase() ||
        (dto.userId && u.id === dto.userId),
    );
    if (memUser) {
      memUser.avatarUrl = avatarUrl;
    }

    return {
      success: true,
      avatarUrl,
      message: avatarUrl ? 'Profile photo updated successfully.' : 'Profile photo removed.',
    };
  }
}
