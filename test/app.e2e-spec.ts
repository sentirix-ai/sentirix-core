import { describe, it, beforeEach, afterEach, vi } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { AppModule } from './../src/app.module.js';
import { PrismaService } from './../src/modules/prisma/prisma.service.js';
import { signJwt } from './../src/common/security/crypto.util.js';

describe('Sevaniq Core API (e2e)', () => {
  let app: INestApplication<App>;

  const prismaStub = {
    $connect: vi.fn().mockResolvedValue(undefined),
    $disconnect: vi.fn().mockResolvedValue(undefined),
    user: {
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
      update: vi.fn(),
    },
    workspace: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
    },
    workspaceInviteToken: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
    ticket: {
      findMany: vi.fn().mockResolvedValue([]),
    },
  };

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue(prismaStub)
      .compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('GET /api/v1 responds with service health string (public)', () => {
    return request(app.getHttpServer())
      .get('/api/v1')
      .expect(200)
      .expect('Hello World!');
  });

  it('POST /api/v1/auth/register rejects weak password and non-whitelisted fields', () => {
    return request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({
        username: 'validuser',
        email: 'valid@company.com',
        phone: '+15550100',
        verificationMethod: 'EMAIL',
        password: 'weak',
        injectedAdminFlag: true,
      })
      .expect(400);
  });

  it('POST /api/v1/tickets rejects empty payload via global ValidationPipe (public portal)', () => {
    return request(app.getHttpServer())
      .post('/api/v1/tickets')
      .send({})
      .expect(400);
  });

  it('GET /api/v1/tickets rejects unauthenticated requests with 401 Unauthorized', () => {
    return request(app.getHttpServer())
      .get('/api/v1/tickets')
      .expect(401);
  });

  it('GET /api/v1/workspace/super-admin-cockpit rejects AGENT JWT with 403 Forbidden', () => {
    const agentJwt = signJwt({
      sub: 'usr-agent-1',
      username: 'agent_budi',
      role: 'AGENT',
    });

    return request(app.getHttpServer())
      .get('/api/v1/workspace/super-admin-cockpit?identifier=pungkyrama')
      .set('Authorization', `Bearer ${agentJwt}`)
      .expect(403);
  });

  it('GET /api/v1/workspace/my-workspace rejects Super Admin (@pungkyrama) even with valid JWT (403)', () => {
    const adminJwt = signJwt({
      sub: 'usr-admin-01',
      username: 'pungkyrama',
      role: 'SUPER_ADMIN',
    });

    return request(app.getHttpServer())
      .get('/api/v1/workspace/my-workspace?identifier=pungkyrama')
      .set('Authorization', `Bearer ${adminJwt}`)
      .expect(403);
  });
});
