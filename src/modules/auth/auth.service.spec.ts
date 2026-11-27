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

  it('rejects Admin/Super Admin login attempts on the regular user login endpoint', async () => {
    await expect(
      service.login({
        identifier: 'attacker',
        password: 'wrong',
        role: 'ADMIN',
      }),
    ).rejects.toThrow(UnauthorizedException);

    await expect(
      service.login({
        identifier: 'pungkyrama',
        password: 'SomePassword@123',
        role: 'USER',
      }),
    ).rejects.toThrow(UnauthorizedException);

    prismaMock.user.findFirst.mockResolvedValue({
      id: 'usr-admin-01',
      username: 'custom_founder',
      email: 'founder@sevaniq.enterprise',
      role: 'SUPER_ADMIN',
      passwordHash: service.hashPassword('StrongRandomAdmin#2026!'),
    });

    await expect(
      service.login({
        identifier: 'custom_founder',
        password: 'StrongRandomAdmin#2026!',
        role: 'USER',
      }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('authenticates TENANT_OWNER with organizationId scope in JWT', async () => {
    const storedHash = service.hashPassword('OwnerPass@123');
    prismaMock.user.findFirst.mockResolvedValue({
      id: 'usr-owner-1',
      username: 'acme_owner',
      fullName: 'Acme Owner',
      email: 'owner@acme.com',
      phone: '+1-555-0188',
      passwordHash: storedHash,
      role: 'TENANT_OWNER',
      organizationId: 'org-acme-1',
      verificationMethod: 'EMAIL',
      onboardingCompleted: true,
      avatarUrl: null,
      workspaceMembership: null,
    });

    const res = await service.login({
      identifier: 'owner@acme.com',
      password: 'OwnerPass@123',
      role: 'USER',
    });

    expect(res.role).toBe('TENANT_OWNER');
    expect(res.organizationId).toBe('org-acme-1');
    expect(res.token).toBeTruthy();
  });
});
