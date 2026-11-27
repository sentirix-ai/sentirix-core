import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { EventsGateway } from '../events/events.gateway.js';

function createPrismaAuthMock() {
  return {
    user: {
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    userActivitySession: {
      findFirst: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
    },
  };
}

function createEventsMock(): EventsGateway {
  return {
    server: {
      emit: vi.fn(),
    },
  } as unknown as EventsGateway;
}

describe('AuthService', () => {
  let prismaMock: ReturnType<typeof createPrismaAuthMock>;
  let service: AuthService;

  beforeEach(() => {
    prismaMock = createPrismaAuthMock();
    service = new AuthService(
      prismaMock as unknown as PrismaService,
      createEventsMock(),
    );
  });

  it('normalizes username/email on registration and hashes password without plaintext exposure', async () => {
    prismaMock.user.findFirst.mockResolvedValue(null);
    prismaMock.user.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'usr-123',
      ...data,
      onboardingCompleted: false,
    }));

    const result = await service.register({
      username: 'Sarah_Ops99',
      email: 'Sarah.Ops@Company.COM',
      phone: '+1-555-0100',
      verificationMethod: 'EMAIL',
      password: 'Password@123',
    });

    expect(result.id).toBe('usr-123');
    expect(result.username).toBe('sarah_ops99');
    expect(result.email).toBe('sarah.ops@company.com');
    expect(result.token).toBeTruthy();

    const createCallArg = prismaMock.user.create.mock.calls[0]?.[0] as {
      data: { passwordHash: string };
    };
    expect(createCallArg.data.passwordHash).toBeDefined();
    expect(createCallArg.data.passwordHash).not.toBe('Password@123');
  });

  it('rejects reserved administrator username during signup', async () => {
    await expect(
      service.register({
        username: 'PungkyRama',
        email: 'impostor@example.com',
        phone: '+1-555-0199',
        verificationMethod: 'EMAIL',
        password: 'Password@123',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects duplicate email or username during signup', async () => {
    prismaMock.user.findFirst.mockResolvedValue({
      id: 'usr-existing',
      username: 'existing_user',
      email: 'existing@company.com',
    });

    await expect(
      service.register({
        username: 'existing_user',
        email: 'other@company.com',
        phone: '+1-555-0199',
        verificationMethod: 'EMAIL',
        password: 'Password@123',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('authenticates valid database user and rejects invalid password', async () => {
    const storedHash = service.hashPassword('Secret@123');
    prismaMock.user.findFirst.mockResolvedValue({
      id: 'usr-valid-1',
      username: 'alice_ops',
      fullName: 'Alice Operations',
      email: 'alice@company.com',
      phone: '+1-555-0101',
      passwordHash: storedHash,
      role: 'CUSTOMER',
      verificationMethod: 'EMAIL',
      onboardingCompleted: true,
      avatarUrl: null,
      workspaceMembership: {
        role: 'LEADER',
        workspaceId: 'ws-pod-1',
        workspace: { name: 'Pod 01: Billing' },
      },
    });

    const loginSuccess = await service.login({
      identifier: 'alice@company.com',
      password: 'Secret@123',
      role: 'USER',
    });

    expect(loginSuccess.id).toBe('usr-valid-1');
    expect(loginSuccess.role).toBe('POD_LEADER');
    expect(loginSuccess.workspaceId).toBe('ws-pod-1');
    expect(loginSuccess.token).toBeTruthy();

    await expect(
      service.login({
        identifier: 'alice@company.com',
        password: 'WrongPassword@123',
        role: 'USER',
      }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('rejects invalid admin credentials when role is ADMIN', async () => {
    await expect(
      service.login({
        identifier: 'attacker',
        password: 'wrong',
        role: 'ADMIN',
      }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('rejects legacy hardcoded admin password and verifies Super Admin via database scrypt hash', async () => {
    const originalAdminPass = process.env.ADMIN_PASSWORD;
    delete process.env.ADMIN_PASSWORD;
    try {
      const noEnvService = new AuthService(
        prismaMock as unknown as PrismaService,
        createEventsMock(),
      );
      prismaMock.user.findFirst.mockResolvedValue(null);

      // Must reject legacy leaked password when no DB hash / ADMIN_PASSWORD exists
      await expect(
        noEnvService.login({
          identifier: 'pungkyrama',
          password: '0o0o 0o0o',
          role: 'ADMIN',
        }),
      ).rejects.toThrow(UnauthorizedException);

      // Must authenticate against hashed database record and reject wrong password
      const strongPass = 'StrongRandomAdmin#2026!';
      prismaMock.user.findFirst.mockResolvedValue({
        id: 'usr-admin-01',
        username: 'pungkyrama',
        email: 'admin@sevaniq.enterprise',
        passwordHash: noEnvService.hashPassword(strongPass),
        avatarUrl: null,
      });

      const ok = await noEnvService.login({
        identifier: 'pungkyrama',
        password: strongPass,
        role: 'ADMIN',
      });
      expect(ok.username).toBe('pungkyrama');
      expect(ok.token).toBeTruthy();

      await expect(
        noEnvService.login({
          identifier: 'pungkyrama',
          password: '0o0o 0o0o',
          role: 'ADMIN',
        }),
      ).rejects.toThrow(UnauthorizedException);
    } finally {
      if (originalAdminPass !== undefined) {
        process.env.ADMIN_PASSWORD = originalAdminPass;
      }
    }
  });
});
