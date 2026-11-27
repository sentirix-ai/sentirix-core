import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { WorkspaceService } from './workspace.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { EventsGateway } from '../events/events.gateway.js';

function createPrismaWorkspaceMock() {
  return {
    user: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    workspace: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    workspaceMember: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
    workspaceInviteToken: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
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

describe('WorkspaceService', () => {
  let prismaMock: ReturnType<typeof createPrismaWorkspaceMock>;
  let eventsMock: EventsGateway;
  let service: WorkspaceService;

  beforeEach(() => {
    prismaMock = createPrismaWorkspaceMock();
    eventsMock = createEventsMock();
    service = new WorkspaceService(
      prismaMock as unknown as PrismaService,
      eventsMock,
    );
  });

  describe('Strict Governance & Hard Defense (RBAC)', () => {
    it('blocks Super Admin (@pungkyrama) from workspace team links with 403 Forbidden', async () => {
      await expect(service.getOrCreateUserWorkspace('pungkyrama')).rejects.toThrow(
        ForbiddenException,
      );
      await expect(
        service.getOrCreateUserWorkspace('admin@sevaniq.enterprise'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('censors invite tokens and pendingTokens when an AGENT calls getOrCreateUserWorkspace', async () => {
      prismaMock.user.findFirst.mockResolvedValue({
        id: 'usr-agent-1',
        username: 'budi_agent',
        fullName: 'Budi Santoso',
        email: 'budi@agent.sevaniq.local',
        role: 'AGENT',
        ownedWorkspaces: [],
        workspaceMembership: {
          role: 'AGENT',
          workspace: {
            id: 'ws-pod-1',
            name: 'Pod 01: Billing',
            ownerId: 'usr-owner-1',
            inviteToken: 'SVQ-AGT-SECRET1',
            isQuotaLocked: true,
            assignedQuota: 4,
            members: [
              {
                id: 'mem-1',
                userId: 'usr-agent-1',
                role: 'AGENT',
                joinedAt: new Date('2026-11-20T00:00:00Z'),
                user: {
                  id: 'usr-agent-1',
                  username: 'budi_agent',
                  fullName: 'Budi Santoso',
                  activitySessions: [],
                },
              },
            ],
            inviteTokens: [
              {
                id: 'tok-1',
                token: 'SVQ-AGT-SECRET1',
                role: 'AGENT',
                isUsed: false,
                usedBy: null,
                createdAt: new Date('2026-11-20T00:00:00Z'),
              },
            ],
          },
        },
      });

      const res = await service.getOrCreateUserWorkspace('budi_agent');
      expect(res.isLeader).toBe(false);
      expect(res.inviteToken).toBe('');
      expect(res.inviteUrl).toBe('');
      expect(res.pendingTokens).toEqual([]);
      expect(res.members[0]?.token).toBeNull();
    });

    it('denies AGENT from generating new invite tokens with 403 Forbidden', async () => {
      prismaMock.user.findFirst.mockResolvedValue({
        id: 'usr-agent-1',
        username: 'budi_agent',
        role: 'AGENT',
        ownedWorkspaces: [],
        workspaceMembership: {
          role: 'AGENT',
          workspace: {
            id: 'ws-pod-1',
            ownerId: 'usr-owner-1',
            assignedQuota: 4,
            members: [],
          },
        },
      });

      await expect(service.generateSingleUseToken('budi_agent')).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  describe('Single-Use Token & First-Open Browser Lock', () => {
    it('locks an opened invite token to the first browser session and blocks concurrent sessions', async () => {
      prismaMock.workspaceInviteToken.findUnique.mockResolvedValue({
        id: 'tok-1',
        token: 'SVQ-AGT-ABC123',
        isUsed: false,
        usedBy: null,
        openedBySession: null,
        openedAt: null,
        workspace: {
          id: 'ws-1',
          name: 'Pod 01: Support',
          assignedQuota: 4,
          owner: { id: 'owner-1', fullName: 'Owner', username: 'owner' },
          members: [],
        },
      });
      prismaMock.workspaceInviteToken.update.mockResolvedValue({});

      const firstOpen = await service.validateInvite('SVQ-AGT-ABC123', 'sess_browser_1');
      expect(firstOpen.valid).toBe(true);
      expect(prismaMock.workspaceInviteToken.update).toHaveBeenCalledWith({
        where: { id: 'tok-1' },
        data: expect.objectContaining({ openedBySession: 'sess_browser_1' }),
      });

      // Second browser opens the same token within 30 minutes
      prismaMock.workspaceInviteToken.findUnique.mockResolvedValue({
        id: 'tok-1',
        token: 'SVQ-AGT-ABC123',
        isUsed: false,
        usedBy: null,
        openedBySession: 'sess_browser_1',
        openedAt: new Date(),
        workspace: {
          id: 'ws-1',
          name: 'Pod 01: Support',
          assignedQuota: 4,
          owner: { id: 'owner-1', fullName: 'Owner', username: 'owner' },
          members: [],
        },
      });

      const secondOpen = await service.validateInvite('SVQ-AGT-ABC123', 'sess_browser_2');
      expect(secondOpen.valid).toBe(false);
      expect(secondOpen.isLockedToOtherSession).toBe(true);
    });

    it('consumes single-use token on joinWorkspace and rejects subsequent reuse', async () => {
      const tokenRecord = {
        id: 'tok-join-1',
        token: 'SVQ-AGT-JOIN01',
        isUsed: false,
        usedBy: null,
        workspace: {
          id: 'ws-1',
          name: 'Pod 01: Operations',
          assignedQuota: 4,
          owner: { id: 'owner-1', username: 'owner' },
          members: [],
        },
      };

      prismaMock.workspaceInviteToken.findUnique.mockResolvedValueOnce(tokenRecord);
      prismaMock.user.create.mockResolvedValue({
        id: 'usr-new-1',
        username: 'siti_1234',
        fullName: 'Siti Rahma',
        email: 'siti_1234@team.ws-1.sevaniq.local',
      });
      prismaMock.workspaceMember.create.mockResolvedValue({
        id: 'mem-new-1',
        joinedAt: new Date(),
      });
      prismaMock.workspaceInviteToken.update.mockResolvedValue({});

      const joinResult = await service.joinWorkspace({
        token: 'SVQ-AGT-JOIN01',
        fullName: 'Siti Rahma',
      });
      expect(joinResult.success).toBe(true);
      expect(joinResult.user.role).toBe('AGENT');
      expect(prismaMock.workspaceInviteToken.update).toHaveBeenCalledWith({
        where: { id: 'tok-join-1' },
        data: expect.objectContaining({
          isUsed: true,
          usedBy: 'Siti Rahma',
        }),
      });

      // Reuse of consumed token must fail
      prismaMock.workspaceInviteToken.findUnique.mockResolvedValueOnce({
        ...tokenRecord,
        isUsed: true,
        usedBy: 'Siti Rahma',
      });

      await expect(
        service.joinWorkspace({ token: 'SVQ-AGT-JOIN01', fullName: 'Another User' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('enforces pod capacity limits when claiming agent token', async () => {
      prismaMock.workspaceInviteToken.findUnique.mockResolvedValue({
        id: 'tok-agt-cap',
        token: 'SVQ-AGT-FULL01',
        role: 'AGENT',
        isUsed: false,
        usedBy: null,
        openedBySession: null,
        workspaceId: 'ws-full',
        workspace: {
          id: 'ws-full',
          name: 'Pod 01: Billing',
          assignedQuota: 2,
          organizationId: 'org-1',
          organization: { id: 'org-1', name: 'Acme' },
          members: [
            { id: 'm1', role: 'LEADER', user: { id: 'u1', fullName: 'Lead', username: 'lead' } },
            { id: 'm2', role: 'AGENT', user: { id: 'u2', fullName: 'Agent 1', username: 'agt1' } },
          ],
        },
      });

      await expect(
        service.claimAgentToken({ token: 'SVQ-AGT-FULL01', fullName: 'Agent 2' }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('Pod Quota Bounds & Token Regeneration Governance', () => {
    it('computes two-sided bounded subordinate options for multi-pod organizations', async () => {
      prismaMock.workspaceInviteToken.findUnique.mockResolvedValue({
        id: 'tok-ldr-1',
        token: 'SVQ-LDR-001',
        role: 'LEADER',
        isUsed: false,
        usedBy: null,
        openedBySession: null,
        workspace: {
          id: 'ws-1',
          name: 'Pod 01',
          podCategory: 'GENERAL',
          services: ['Billing'],
          isQuotaLocked: false,
          assignedQuota: 8,
          organization: { id: 'org-1', name: 'FinCorp', totalSeats: 10 },
          members: [],
        },
      });
      prismaMock.workspace.findMany.mockResolvedValue([
        { id: 'ws-1', isQuotaLocked: false, assignedQuota: 8, members: [] },
        { id: 'ws-2', isQuotaLocked: false, assignedQuota: 8, members: [] },
      ]);

      const status = await service.getLeaderTokenQuotaStatus('SVQ-LDR-001');
      expect(status.valid).toBe(true);
      expect(status.quotaStats).toBeDefined();
      // With 10 total seats and 1 other unlocked pod (needs 2..8 seats), ws-1 can take 2..8 total seats (1..7 subordinates)
      expect(status.quotaStats!.allowedOptions).toEqual([1, 2, 3, 4, 5, 6, 7]);
    });

    it('rejects token regeneration by unauthorized AGENT and allows Super Admin', async () => {
      const tokenRow = {
        id: 'tok-regen-1',
        token: 'SVQ-AGT-OLD123',
        role: 'AGENT',
        workspaceId: 'ws-1',
        usedBy: 'Agent A',
        workspace: { id: 'ws-1', name: 'Pod 01' },
      };

      prismaMock.workspaceInviteToken.findUnique.mockResolvedValue(tokenRow);
      prismaMock.user.findFirst.mockResolvedValue({
        id: 'usr-agent',
        username: 'agent_a',
        role: 'AGENT',
        workspaceMembership: { workspaceId: 'ws-1', role: 'AGENT' },
      });

      await expect(
        service.regenerateToken('SVQ-AGT-OLD123', 'agent_a'),
      ).rejects.toThrow(ForbiddenException);

      // Now requester is Super Admin
      prismaMock.user.findFirst.mockResolvedValue({
        id: 'usr-admin-01',
        username: 'pungkyrama',
        role: 'SUPER_ADMIN',
        workspaceMembership: null,
      });
      prismaMock.workspaceInviteToken.update.mockResolvedValue({});

      const res = await service.regenerateToken('SVQ-AGT-OLD123', 'pungkyrama');
      expect(res.success).toBe(true);
      expect(res.oldToken).toBe('SVQ-AGT-OLD123');
      expect(res.newToken).toMatch(/^SVQ-AGT-[0-9A-F]{6}$/);
      expect(prismaMock.workspaceInviteToken.update).toHaveBeenCalledWith({
        where: { id: 'tok-regen-1' },
        data: expect.objectContaining({
          token: res.newToken,
          isUsed: false,
          usedBy: 'Agent A',
        }),
      });
    });

    it('blocks TENANT_OWNER from mutating personnel or pods in another organization (403 IDOR guard)', async () => {
      prismaMock.user.findUnique.mockResolvedValue({
        id: 'usr-other-org',
        role: 'AGENT',
        organizationId: 'org-B',
        workspaceMembership: { workspace: { organizationId: 'org-B' } },
      });

      await expect(
        service.renamePersonnel('usr-other-org', 'Tampered Name', 'org-A'),
      ).rejects.toThrow(ForbiddenException);

      prismaMock.workspace.findUnique.mockResolvedValue({
        id: 'ws-other-org',
        organizationId: 'org-B',
        assignedQuota: 4,
        members: [],
        inviteTokens: [],
      });

      await expect(
        service.addSeatToPod({ workspaceId: 'ws-other-org', seatCount: 1 }, 'org-A'),
      ).rejects.toThrow(ForbiddenException);
    });
  });
});
