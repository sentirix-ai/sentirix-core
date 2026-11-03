import {
  Injectable,
  OnModuleInit,
  BadRequestException,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { RegisterDto } from './dto/register.dto.js';
import { LoginDto } from './dto/login.dto.js';
import { UpdateAvatarDto } from './dto/update-avatar.dto.js';

export interface AuthUserResponse {
  id: string;
  username: string;
  email: string;
  phone?: string;
  role: 'ADMIN' | 'USER';
  verificationMethod?: 'EMAIL' | 'PHONE';
  isVerified: boolean;
  avatarText: string;
  avatarUrl?: string | null;
  token?: string;
  onboardingCompleted?: boolean;
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
  private memoryUsers: StoredMemoryUser[] = [
    {
      id: 'usr-admin-01',
      username: 'pungkyrama',
      email: 'admin@sentrix.enterprise',
      phone: '+1-555-019-0000',
      passwordHash: this.hashPassword('0o0o 0o0o'),
      role: 'ADMIN',
      verificationMethod: 'EMAIL',
      isVerified: true,
      onboardingCompleted: true,
      createdAt: new Date().toISOString(),
    },
  ];

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    try {
      const adminExists = await this.prisma.user.findFirst({
        where: {
          OR: [
            { username: 'pungkyrama' },
            { email: 'admin@sentrix.enterprise' },
            { email: 'admin@sentirix.enterprise' },
            { email: 'admin@omniflow.enterprise' },
          ],
        },
      });

      if (!adminExists) {
        await this.prisma.user.create({
          data: {
            username: 'pungkyrama',
            fullName: 'Pungky Rama (Admin)',
            email: 'admin@sentrix.enterprise',
            phone: '+1-555-019-0000',
            passwordHash: this.hashPassword('0o0o 0o0o'),
            role: 'ADMIN',
          },
        });
        this.logger.log('Default Admin user (@pungkyrama) seeded into database.');
      }
    } catch (err) {
      this.logger.warn(`Could not seed default admin into db: ${(err as Error)?.message}`);
    }
  }

  // Cryptographic SHA-256 hash
  hashPassword(password: string): string {
    return crypto.createHash('sha256').update(password).digest('hex');
  }

  // Generate simulated secure JWT token
  private generateToken(userId: string, role: string): string {
    const payload = `${userId}:${role}:${Date.now()}`;
    return Buffer.from(payload).toString('base64');
  }

  async register(dto: RegisterDto): Promise<AuthUserResponse> {
    const lowerUsername = dto.username.toLowerCase();
    const lowerEmail = dto.email.toLowerCase();

    // Prevent overriding admin
    if (lowerUsername === 'pungkyrama') {
      throw new BadRequestException('This username is reserved for system administration.');
    }

    const passwordHash = this.hashPassword(dto.password);
    const userId = `usr-${Date.now().toString(36)}`;

    try {
      // 1. Check unique in PostgreSQL database first
      const existingDbUser = await this.prisma.user.findFirst({
        where: {
          OR: [
            { email: { equals: lowerEmail, mode: 'insensitive' } },
            { username: { equals: lowerUsername, mode: 'insensitive' } },
          ],
        },
      });

      if (existingDbUser) {
        throw new BadRequestException('An account with this username or email already exists.');
      }

      // 2. Insert into PostgreSQL
      const dbUser = await this.prisma.user.create({
        data: {
          username: dto.username,
          fullName: dto.username,
          email: dto.email,
          phone: dto.phone,
          passwordHash,
          role: 'CUSTOMER', // Default user role
          verificationMethod: dto.verificationMethod || 'EMAIL',
        },
      });

      this.logger.log(`User @${dto.username} registered successfully in PostgreSQL db_omniflow.`);

      return {
        id: dbUser.id,
        username: dbUser.username || dto.username,
        email: dbUser.email,
        phone: dbUser.phone || dto.phone,
        role: 'USER',
        verificationMethod: dto.verificationMethod,
        isVerified: true,
        avatarText: (dbUser.username || dto.username).slice(0, 2).toUpperCase(),
        token: this.generateToken(dbUser.id, 'USER'),
        onboardingCompleted: false,
      };
    } catch (err) {
      if (err instanceof BadRequestException) {
        throw err;
      }

      this.logger.warn(`Database insert failed, using memory store: ${(err as Error)?.message}`);

      // Check unique in memory
      const memoryDuplicate = this.memoryUsers.find(
        (u) => u.username.toLowerCase() === lowerUsername || u.email.toLowerCase() === lowerEmail,
      );
      if (memoryDuplicate) {
        throw new BadRequestException('An account with this username or email already exists.');
      }

      // Memory fallback
      const newUser: StoredMemoryUser = {
        id: userId,
        username: dto.username,
        email: dto.email,
        phone: dto.phone,
        passwordHash,
        role: 'USER',
        verificationMethod: dto.verificationMethod,
        isVerified: true,
        onboardingCompleted: false,
        createdAt: new Date().toISOString(),
      };

      this.memoryUsers.push(newUser);
      this.logger.log(`User @${dto.username} registered successfully (Memory Store).`);

      return {
        id: newUser.id,
        username: newUser.username,
        email: newUser.email,
        phone: newUser.phone,
        role: newUser.role,
        verificationMethod: newUser.verificationMethod,
        isVerified: newUser.isVerified,
        avatarText: newUser.username.slice(0, 2).toUpperCase(),
        token: this.generateToken(newUser.id, newUser.role),
        onboardingCompleted: false,
      };
    }
  }

  async login(dto: LoginDto): Promise<AuthUserResponse> {
    const cleanId = dto.identifier.trim();

    // 1. Direct Admin Credential Validation (pungkyrama & 0o0o 0o0o)
    if (cleanId === 'pungkyrama' && dto.password === '0o0o 0o0o') {
      this.logger.log('Admin Master login successful: @pungkyrama');
      let adminAvatarUrl: string | null = null;
      try {
        const dbAdmin = await this.prisma.user.findFirst({
          where: { username: 'pungkyrama' },
          select: { avatarUrl: true },
        });
        if (dbAdmin?.avatarUrl) adminAvatarUrl = dbAdmin.avatarUrl;
      } catch {}

      return {
        id: 'usr-admin-01',
        username: 'pungkyrama',
        email: 'admin@sentrix.enterprise',
        phone: '+1-555-019-0000',
        role: 'ADMIN',
        isVerified: true,
        avatarText: 'PR',
        avatarUrl: adminAvatarUrl || (this.memoryUsers[0] as any)?.avatarUrl || undefined,
        token: this.generateToken('usr-admin-01', 'ADMIN'),
        onboardingCompleted: true,
      };
    }

    if (dto.role === 'ADMIN') {
      throw new UnauthorizedException(
        'Invalid Admin credentials. Hint: username "pungkyrama" and password "0o0o 0o0o"',
      );
    }

    // 2. User Login: Unified search by username OR email
    const enteredHash = this.hashPassword(dto.password);
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
      });

      if (dbUser) {
        if (dbUser.passwordHash !== enteredHash) {
          throw new UnauthorizedException('Incorrect password. Please verify and try again.');
        }

        return {
          id: dbUser.id,
          username: dbUser.username || dbUser.fullName,
          email: dbUser.email,
          phone: dbUser.phone || undefined,
          role: dbUser.role === 'ADMIN' ? 'ADMIN' : 'USER',
          verificationMethod: (dbUser.verificationMethod as 'EMAIL' | 'PHONE') || 'EMAIL',
          isVerified: true,
          avatarText: (dbUser.username || dbUser.fullName).slice(0, 2).toUpperCase(),
          avatarUrl: dbUser.avatarUrl || undefined,
          token: this.generateToken(dbUser.id, dbUser.role),
          onboardingCompleted: dbUser.onboardingCompleted ?? false,
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

    if (memoryUser.passwordHash !== enteredHash) {
      throw new UnauthorizedException('Incorrect password. Please verify and try again.');
    }

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
      token: this.generateToken(memoryUser.id, memoryUser.role),
      onboardingCompleted: memoryUser.onboardingCompleted ?? false,
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
