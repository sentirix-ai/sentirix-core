import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import { AiService } from './ai.service.js';

function createConfigMock(values: Record<string, string | undefined>): ConfigService {
  return {
    get: vi.fn((key: string) => values[key]),
  } as unknown as ConfigService;
}

describe('AiService', () => {
  let service: AiService;

  beforeEach(() => {
    service = new AiService(
      createConfigMock({
        GEMINI_API_KEY: 'your_google_gemini_api_key_here',
        GEMINI_MODEL: 'gemini-3.8-flash',
      }),
    );
  });

  it('classifies outage tickets as URGENT/CRITICAL and routes to matching pod', async () => {
    const result = await service.analyzeTicket(
      'Production API down after deploy',
      'Urgent outage affecting billing invoice webhook processing immediately.',
      {
        industry: 'FINTECH',
        activePods: [
          {
            id: 'pod-billing',
            name: 'Billing & Invoicing Pod',
            category: 'BILLING',
            description: 'Handles invoice charges and billing disputes',
          },
          {
            id: 'pod-catchall',
            name: 'General Triage Pod',
            category: 'GENERAL',
            description: 'General requests',
            isCatchAll: true,
          },
        ],
      },
    );

    expect(result.sentiment).toBe('URGENT');
    expect(result.priority).toBe('CRITICAL');
    expect(result.tags).toEqual(expect.arrayContaining(['critical-sla', 'billing']));
    expect(result.targetPodId).toBe('pod-billing');
    expect(result.confidenceScore).toBe(80);
  });

  it('routes unmatched fallback tickets to the catch-all pod', async () => {
    const result = await service.analyzeTicket(
      'Question about onboarding guide',
      'Where can I find documentation for adding new staff members?',
      {
        activePods: [
          {
            id: 'pod-billing',
            name: 'Billing & Refunds',
            category: 'BILLING',
            description: 'Invoices and payment failures',
          },
          {
            id: 'pod-general',
            name: 'General Support',
            category: 'GENERAL',
            description: 'Catch all inquiries',
            isCatchAll: true,
          },
        ],
      },
    );

    expect(result.sentiment).toBe('NEUTRAL');
    expect(result.priority).toBe('MEDIUM');
    expect(result.tags).toContain('general-support');
    expect(result.targetPodId).toBe('pod-general');
  });

  it('falls back gracefully when Gemini API call throws an error', async () => {
    const mockAiClient = {
      models: {
        generateContent: vi.fn().mockRejectedValue(new Error('429 Rate Limit')),
      },
    };
    (service as unknown as { aiClient: typeof mockAiClient }).aiClient = mockAiClient;

    const triage = await service.analyzeTicket(
      'App crash with error 500',
      'Horrible broken experience when saving order.',
    );
    expect(triage.sentiment).toBe('FRUSTRATED');
    expect(triage.priority).toBe('HIGH');
    expect(triage.tags).toContain('bug');

    const draft = await service.draftReply({
      ticketTitle: 'App crash with error 500',
      ticketDescription: 'App crashes on save',
      conversationHistory: [],
      tone: 'professional',
    });
    expect(draft.draft).toContain('App crash with error 500');
  });

  it('provides industry fallback pods with bounded recommended seats (1-8)', async () => {
    const ecommerce = await service.generatePodsForIndustry('ECOMMERCE');
    expect(ecommerce.industry).toBe('ECOMMERCE');
    expect(ecommerce.pods.length).toBeGreaterThanOrEqual(4);
    for (const pod of ecommerce.pods) {
      expect(pod.recommendedSeats).toBeGreaterThanOrEqual(1);
      expect(pod.recommendedSeats).toBeLessThanOrEqual(8);
    }

    const autoDetected = await service.generatePodsForIndustry('OTHER', 'Cold Chain Logistics');
    expect(autoDetected.industry).toBe('LOGISTICS');

    const custom = await service.generatePodsForIndustry(
      'OTHER',
      'Boutique Yacht Charter Concierge',
    );
    expect(custom.industry).toBe('OTHER');
    expect(custom.pods[0]?.name).toContain('Boutique Yacht Charter Concierge');
  });

  it('detects cross-domain semantic mismatch when renaming baseline services', async () => {
    const mismatch = await service.validateServiceSemanticMatch({
      originalService: 'Billing & Invoice Reconciliation',
      newServiceName: 'Shipment Courier Tracking & Transit',
      industry: 'ECOMMERCE',
    });
    expect(mismatch.isCompatible).toBe(false);
    expect(mismatch.suggestAddAsNew).toBe(true);

    const compatible = await service.validateServiceSemanticMatch({
      originalService: 'Billing & Invoice Reconciliation',
      newServiceName: 'Payment Charge & Refund Verification',
      industry: 'ECOMMERCE',
    });
    expect(compatible.isCompatible).toBe(true);
    expect(compatible.suggestAddAsNew).toBe(false);
  });
});
