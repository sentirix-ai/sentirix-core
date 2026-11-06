import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenAI } from '@google/genai';
import { AnalyzeTicketResponseDto } from './dto/analyze-ticket.dto.js';
import { DraftReplyDto, DraftReplyResponseDto } from './dto/draft-reply.dto.js';
import { SummarizeThreadDto, SummarizeThreadResponseDto } from './dto/summarize-thread.dto.js';

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private aiClient: GoogleGenAI | null = null;
  private readonly modelName: string;

  constructor(private readonly configService: ConfigService) {
    this.modelName =
      this.configService.get<string>('GEMINI_MODEL') || 'gemini-3.8-flash';

    const apiKey = this.configService.get<string>('GEMINI_API_KEY');
    if (apiKey && apiKey.trim() !== '' && apiKey !== 'your_google_gemini_api_key_here') {
      try {
        this.aiClient = new GoogleGenAI({ apiKey });
        this.logger.log(`Google Gemini API client initialized with model ${this.modelName}.`);
      } catch (err) {
        this.logger.warn(`Failed to initialize Google Gemini client: ${(err as Error).message}`);
      }
    } else {
      this.logger.warn(
        'GEMINI_API_KEY is not configured or empty. AI features will operate with intelligent fallback defaults.',
      );
    }
  }

  /**
   * 1. Dynamic AI Sentiment & Urgency Detector + Domain-Context Pod Routing
   */
  async analyzeTicket(
    title: string,
    description: string,
    context?: {
      industry?: string;
      activePods?: Array<{
        id: string;
        name: string;
        category?: string;
        description?: string;
        services?: string[];
        isCatchAll?: boolean;
      }>;
    },
  ): Promise<AnalyzeTicketResponseDto> {
    if (!this.aiClient) {
      return this.fallbackSentimentAnalysis(title, description, context);
    }

    try {
      const activePods = context?.activePods || [];
      const podsDescription =
        activePods.length > 0
          ? `\nACTIVE CLIENT OPERATIONAL PODS FOR ROUTING:\n${activePods
              .map(
                (p) =>
                  `- ID: "${p.id}", Name: "${p.name}", Category: "${p.category || 'GENERAL'}", Description: "${p.description || 'General requests'}", Services: "${(p.services || []).join(', ')}", CatchAll: ${!!p.isCatchAll}`,
              )
              .join('\n')}`
          : '';

      const prompt = `You are the Chief AI Triage Officer for Sentirix enterprise service operations.
Company Business Sector / Industry: "${context?.industry || 'General Business'}"
Analyze this inbound customer support ticket and classify it accurately.
${podsDescription}

Ticket Title: ${title}
Ticket Description: ${description}

Instructions:
1. Determine customer sentiment: "POSITIVE", "NEUTRAL", "FRUSTRATED", or "URGENT".
2. Determine urgency priority: "LOW", "MEDIUM", "HIGH", or "CRITICAL".
3. Assign 2-4 semantic tags.
4. Provide a 1-sentence summary.
5. If active pods are provided above, evaluate which pod ID best matches this issue.
   - If confidence is >= 70%, set targetPodId to that pod's ID and provide the pod name.
   - If unsure or confidence < 70%, route to the CatchAll pod ID (or null if none).
   - Provide confidenceScore from 0 to 100.

Return strictly JSON format:
{
  "sentiment": "POSITIVE" | "NEUTRAL" | "FRUSTRATED" | "URGENT",
  "priority": "LOW" | "MEDIUM" | "HIGH" | "CRITICAL",
  "tags": ["tag1", "tag2"],
  "summary": "1-sentence summary",
  "targetPodId": "string-or-null",
  "targetPodName": "string-or-null",
  "confidenceScore": 85
}`;

      const response = await this.aiClient.models.generateContent({
        model: this.modelName,
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
        },
      });

      const responseText = response.text?.trim() || '';
      const parsed = JSON.parse(responseText);

      return {
        sentiment: ['POSITIVE', 'NEUTRAL', 'FRUSTRATED', 'URGENT'].includes(parsed.sentiment)
          ? parsed.sentiment
          : 'NEUTRAL',
        priority: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(parsed.priority)
          ? parsed.priority
          : 'MEDIUM',
        tags: Array.isArray(parsed.tags) ? parsed.tags : ['support'],
        summary: parsed.summary || title,
        targetPodId: parsed.targetPodId || undefined,
        targetPodName: parsed.targetPodName || undefined,
        confidenceScore: typeof parsed.confidenceScore === 'number' ? parsed.confidenceScore : 85,
      };
    } catch (error) {
      this.logger.error(`Error in analyzeTicket AI call: ${(error as Error).message}`);
      return this.fallbackSentimentAnalysis(title, description, context);
    }
  }

  /**
   * Auto-generate tailored operational pods for any industry using Gemini 2.5 Flash
   */
  async generatePodsForIndustry(
    industry: string,
    customDescription?: string,
  ): Promise<{
    industry: string;
    pods: Array<{
      name: string;
      category: string;
      description: string;
      recommendedSeats: number;
      service?: string;
    }>;
    defaultServices?: string[];
  }> {
    const cleanIndustry = (industry || 'OTHER').trim();
    const cleanDesc = (customDescription || '').trim();

    if (this.aiClient) {
      try {
        const prompt = `You are a world-class enterprise operations architect for Sentirix.
The user is setting up a customer support organization.
Industry/Sector: "${cleanIndustry}"
${cleanDesc ? `Additional Specifics / Business Model: "${cleanDesc}"` : ''}

Generate exactly 6 specialized operational support pods (sub-teams) best suited for this exact business model using US industry standards.
Rules:
1. Max 8 members per pod (Amazon Two-Pizza Pod rule).
2. Pod names must be concise, professional, and directly address customer complaint drivers for this vertical.
3. Each pod must include a 1-sentence semantic description explaining what customer ticket topics it handles (crucial for AI routing).
4. Assign recommendedSeats between 1 and 4 for each pod.
5. Provide a primary specialized "service" name for each pod that represents its core service domain (e.g., "Flight Telemetry Diagnostics", "Acreage Mapping Analytics", "VIP Account Concierge").

Return strictly JSON format:
{
  "pods": [
    {
      "name": "string",
      "category": "UPPERCASE_SNAKE_CASE",
      "description": "string",
      "recommendedSeats": number,
      "service": "string"
    }
  ]
}`;

        const response = await this.aiClient.models.generateContent({
          model: this.modelName,
          contents: prompt,
          config: {
            responseMimeType: 'application/json',
          },
        });

        const parsed = JSON.parse(response.text?.trim() || '{}');
        if (Array.isArray(parsed.pods) && parsed.pods.length >= 2) {
          const mappedPods = parsed.pods.map((p: any) => ({
            name: String(p.name || 'Support Pod'),
            category: String(p.category || 'GENERAL').toUpperCase(),
            description: String(p.description || 'Handles customer requests'),
            recommendedSeats: Math.max(1, Math.min(8, Number(p.recommendedSeats) || 2)),
            service: String(p.service || p.name?.replace(/\s+Pod$/i, '') || 'Customer Service').trim(),
          }));
          return {
            industry: cleanIndustry,
            pods: mappedPods,
            defaultServices: mappedPods.map((p: { service: string }) => p.service),
          };
        }
      } catch (err) {
        this.logger.warn(`Gemini generatePods error: ${(err as Error).message}. Falling back to presets.`);
      }
    }

    const fallback = this.getFallbackPodsForIndustry(cleanIndustry, cleanDesc);
    return {
      ...fallback,
      defaultServices:
        fallback.defaultServices ||
        fallback.pods.map((p: any) => p.service || p.name.replace(/\s+Pod$/i, '').trim()),
    };
  }

  /**
   * 2. AI One-Click Reply Drafter (Intercom Fin-inspired)
   */
  async draftReply(dto: DraftReplyDto): Promise<DraftReplyResponseDto> {
    if (!this.aiClient) {
      return {
        draft: `Hello,\n\nThank you for reaching out regarding "${dto.ticketTitle}". We have received your request and our support engineering team is currently investigating the issue.\n\nWe will update you as soon as more details are available.\n\nBest regards,\nSupport Team`,
        groundedSources: dto.knowledgeContext ? ['Standard Support Policy'] : [],
      };
    }

    try {
      const historyText = dto.conversationHistory
        .map((m) => `${m.sender}: ${m.content}`)
        .join('\n');

      const toneGuideline =
        dto.tone === 'empathetic'
          ? 'Use an understanding, highly empathetic and apologetic tone.'
          : dto.tone === 'concise'
            ? 'Be direct, crisp, action-oriented, and brief.'
            : 'Maintain an executive, polite, and professional tone.';

      const prompt = `You are Sentrix AI Copilot assisting a human support agent.
Ticket Title: ${dto.ticketTitle}
Initial Complaint: ${dto.ticketDescription}

Conversation History:
${historyText || 'No prior messages.'}

${dto.knowledgeContext ? `Official Knowledge Base Reference Documents:\n${dto.knowledgeContext}` : ''}

Tone: ${toneGuideline}

Instructions:
- Write a ready-to-send response to the customer.
- If Knowledge Base reference is provided, strictly ground your facts on it and do not invent policies.
- Address the customer politely and outline the clear resolution or next action steps.`;

      const response = await this.aiClient.models.generateContent({
        model: this.modelName,
        contents: prompt,
      });

      return {
        draft: response.text?.trim() || 'Could not generate draft.',
        groundedSources: dto.knowledgeContext ? ['Knowledge Base Reference Document'] : [],
      };
    } catch (error) {
      this.logger.error(`Error in draftReply AI call: ${(error as Error).message}`);
      return {
        draft: `Hello, thank you for reaching out. We are actively reviewing "${dto.ticketTitle}" and will get back to you shortly.`,
        groundedSources: [],
      };
    }
  }

  /**
   * 3. AI Thread Summarizer
   */
  async summarizeThread(dto: SummarizeThreadDto): Promise<SummarizeThreadResponseDto> {
    if (!this.aiClient) {
      return {
        bulletPoints: [
          `Customer reported: ${dto.ticketTitle}`,
          `${dto.messages.length} messages in conversation thread.`,
          'Status is actively monitored by support agent.',
        ],
      };
    }

    try {
      const historyText = dto.messages.map((m) => `${m.sender}: ${m.content}`).join('\n');

      const prompt = `Summarize this customer support thread into exactly 3 concise, high-impact bullet points:
1. Core problem reported by customer
2. Actions taken or discussed so far
3. Current blocker or immediate next step required

Ticket: ${dto.ticketTitle}
Messages:
${historyText}

Return as a JSON array of 3 strings: ["point 1", "point 2", "point 3"]`;

      const response = await this.aiClient.models.generateContent({
        model: this.modelName,
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
        },
      });

      const parsed = JSON.parse(response.text?.trim() || '[]');
      return {
        bulletPoints: Array.isArray(parsed) && parsed.length > 0
          ? parsed
          : ['Issue reported', 'Discussion in progress', 'Awaiting resolution'],
      };
    } catch (error) {
      this.logger.error(`Error in summarizeThread AI call: ${(error as Error).message}`);
      return {
        bulletPoints: [
          `Ticket: ${dto.ticketTitle}`,
          'Conversation in progress with customer.',
          'Next action: review latest message.',
        ],
      };
    }
  }

  /**
   * Deterministic Fallback Triage when offline or API key unconfigured
   */
  private fallbackSentimentAnalysis(
    title: string,
    description: string,
    context?: {
      industry?: string;
      activePods?: Array<{
        id: string;
        name: string;
        category?: string;
        description?: string;
        isCatchAll?: boolean;
      }>;
    },
  ): AnalyzeTicketResponseDto {
    const combined = `${title} ${description}`.toLowerCase();

    let sentiment: 'POSITIVE' | 'NEUTRAL' | 'FRUSTRATED' | 'URGENT' = 'NEUTRAL';
    let priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' = 'MEDIUM';
    const tags: string[] = [];

    if (
      combined.includes('angry') ||
      combined.includes('horrible') ||
      combined.includes('terrible') ||
      combined.includes('broken') ||
      combined.includes('unacceptable')
    ) {
      sentiment = 'FRUSTRATED';
      priority = 'HIGH';
    }

    if (
      combined.includes('urgent') ||
      combined.includes('immediately') ||
      combined.includes('down') ||
      combined.includes('outage') ||
      combined.includes('production')
    ) {
      sentiment = 'URGENT';
      priority = 'CRITICAL';
      tags.push('critical-sla');
    }

    if (combined.includes('billing') || combined.includes('invoice') || combined.includes('charge')) {
      tags.push('billing');
    }

    if (combined.includes('bug') || combined.includes('error') || combined.includes('crash')) {
      tags.push('bug');
    }

    if (tags.length === 0) tags.push('general-support');

    // Pod Routing fallback matching
    let targetPodId: string | undefined = undefined;
    let targetPodName: string | undefined = undefined;
    const activePods = context?.activePods || [];

    if (activePods.length > 0) {
      // Find matching pod by keywords in name or description
      const matched = activePods.find((p) => {
        const pTokens = `${p.name} ${p.category || ''} ${p.description || ''}`.toLowerCase();
        return tags.some((t) => pTokens.includes(t)) ||
          (combined.includes('resi') && pTokens.includes('resi')) ||
          (combined.includes('refund') && pTokens.includes('refund')) ||
          (combined.includes('billing') && pTokens.includes('billing')) ||
          (combined.includes('api') && pTokens.includes('api'));
      });

      if (matched) {
        targetPodId = matched.id;
        targetPodName = matched.name;
      } else {
        const catchAll = activePods.find((p) => p.isCatchAll);
        if (catchAll) {
          targetPodId = catchAll.id;
          targetPodName = catchAll.name;
        }
      }
    }

    return {
      sentiment,
      priority,
      tags,
      summary: title,
      targetPodId,
      targetPodName,
      confidenceScore: targetPodId ? 80 : 50,
    };
  }

  /**
   * Data-Backed Industry Benchmark Pod Presets (Zendesk, TSIA, Gartner, Stripe Research)
   */
  getFallbackPodsForIndustry(
    industry: string,
    customDescription?: string,
  ): {
    industry: string;
    pods: Array<{
      name: string;
      category: string;
      description: string;
      recommendedSeats: number;
      service?: string;
    }>;
    defaultServices?: string[];
  } {
    const key = (industry || 'OTHER').toUpperCase().trim();

    // 1. E-COMMERCE, D2C & RETAIL BRANDS
    if (key.includes('ECOMMERCE') || key.includes('RETAIL') || key.includes('COMMERCE')) {
      return {
        industry: 'ECOMMERCE',
        pods: [
          {
            name: 'WISMO & Carrier Exceptions Pod',
            category: 'WISMO',
            description: 'Where is my order tracking, carrier delays, stuck shipments, lost parcels',
            recommendedSeats: 3,
          },
          {
            name: 'Returns, Exchanges & Damaged Claims Pod',
            category: 'RETURNS',
            description: 'RMA return labels, defective products, sizing exchanges, customer refunds',
            recommendedSeats: 2,
          },
          {
            name: 'Checkout, Payments & Promotions Pod',
            category: 'PROMOTIONS',
            description: 'Failed checkout, coupon code errors, payment gateways, tax exemption',
            recommendedSeats: 2,
          },
          {
            name: 'VIP Concierge & High-LTV Buyers Pod',
            category: 'VIP',
            description: 'Priority white-glove support, instant replacement warranties, loyalty perks',
            recommendedSeats: 1,
          },
          {
            name: 'Merchant Onboarding & Catalog Compliance Pod',
            category: 'MERCHANT',
            description: 'Marketplace seller accounts, catalog listings, policy violations, payout holds',
            recommendedSeats: 2,
          },
          {
            name: 'Product Quality & Brand Protection Pod',
            category: 'QUALITY',
            description: 'Counterfeit reports, manufacturing defect investigations, recall notices',
            recommendedSeats: 1,
          },
        ],
      };
    }

    // 2. LOGISTICS, FREIGHT & 3PL COURIERS
    if (
      key.includes('LOGISTICS') ||
      key.includes('EKSPEDISI') ||
      key.includes('COURIER') ||
      key.includes('KURIR') ||
      key.includes('FREIGHT')
    ) {
      return {
        industry: 'LOGISTICS',
        pods: [
          {
            name: 'Linehaul & Transit Hub Exceptions Pod',
            category: 'LINEHAUL',
            description: 'Interstate sorting hub bottlenecks, highway fleet breakdowns, damaged manifests',
            recommendedSeats: 3,
          },
          {
            name: 'Last-Mile & Delivery Route Exceptions Pod',
            category: 'LAST_MILE',
            description: 'Driver failed delivery attempts, locked gates, incorrect addresses, sameday rerouting',
            recommendedSeats: 2,
          },
          {
            name: 'Freight Damage & Insurance Claims Pod',
            category: 'CLAIMS',
            description: 'Broken seal investigations, transit damage BAP, cargo insurance settlements',
            recommendedSeats: 2,
          },
          {
            name: 'B2B Shipper Accounts & COD Settlement Pod',
            category: 'COD_ACCOUNTS',
            description: 'Driver cash-on-delivery reconciliation, enterprise shipper billing, weight disputes',
            recommendedSeats: 1,
          },
          {
            name: 'Fleet Dispatch & Special Handling Pod',
            category: 'DISPATCH',
            description: 'Palletized heavy freight, cold-chain temperature monitoring, urgent sameday dispatch',
            recommendedSeats: 2,
          },
          {
            name: 'Courier Misconduct & Driver Operations Pod',
            category: 'DRIVER_OPS',
            description: 'Driver ethics complaints, falsified delivery signatures, courier safety escalations',
            recommendedSeats: 1,
          },
        ],
      };
    }

    // 3. FINTECH, NEOBANKS & DIGITAL PAYMENTS
    if (
      key.includes('FINTECH') ||
      key.includes('BANK') ||
      key.includes('PAYMENT') ||
      key.includes('KEUANGAN')
    ) {
      return {
        industry: 'FINTECH',
        pods: [
          {
            name: 'ACH, Wire & Real-Time Transfer Disputes Pod',
            category: 'TRANSFERS',
            description: 'ACH clearing delays, failed wire transfers, routing errors, manual ledger reversals',
            recommendedSeats: 3,
          },
          {
            name: 'Biometric KYC & Account Security Pod',
            category: 'KYC',
            description: 'SSN/Driver license verification, selfie liveness checks, 2FA lockouts, password resets',
            recommendedSeats: 2,
          },
          {
            name: 'Fraud, Scam & Chargeback Defense Pod',
            category: 'FRAUD',
            description: 'Visa/Mastercard chargeback representment, unauthorized card activity, phishing freezes',
            recommendedSeats: 2,
          },
          {
            name: 'B2B Payment Gateway & Webhook Pod',
            category: 'GATEWAY_API',
            description: 'Developer merchant API 5xx timeouts, webhook signature errors, daily batch settlements',
            recommendedSeats: 1,
          },
          {
            name: 'Digital Lending, BNPL & Collections Pod',
            category: 'LENDING',
            description: 'Installment payment disputes, interest penalty adjustments, credit bureau reporting',
            recommendedSeats: 2,
          },
          {
            name: 'Treasury, Settlement & Clearing Pod',
            category: 'TREASURY',
            description: 'Liquidity settlement, cross-border currency conversion, institutional bank reconciliation',
            recommendedSeats: 1,
          },
        ],
      };
    }

    // 4. B2B SAAS & TECH ENTERPRISE
    if (key.includes('SAAS') || key.includes('TECH') || key.includes('SOFTWARE')) {
      return {
        industry: 'SAAS',
        pods: [
          {
            name: 'Tier-1 User Access & Admin Onboarding Pod',
            category: 'TIER_1',
            description: 'User invitations, RBAC role permissions, password resets, basic platform guidance',
            recommendedSeats: 3,
          },
          {
            name: 'Tier-2 API, Webhooks & Developer Interop Pod',
            category: 'TIER_2',
            description: 'REST API 5xx errors, webhook retry limits, payload validation, SDK client libraries',
            recommendedSeats: 2,
          },
          {
            name: 'Tier-3 Application Bug & Engineering Escalations Pod',
            category: 'TIER_3',
            description: 'Core platform bugs, database corruption, software regression, engineering tickets',
            recommendedSeats: 2,
          },
          {
            name: 'Enterprise Security, SAML SSO & SCIM Pod',
            category: 'SECURITY',
            description: 'Okta/Azure AD SSO setup, SCIM directory sync, SOC2 audit logs, privacy compliance',
            recommendedSeats: 1,
          },
          {
            name: 'Subscription Invoicing, Sales Tax & Procurement Pod',
            category: 'BILLING',
            description: 'Annual enterprise PO billing, tax receipts, credit card updates, seat licensing add-ons',
            recommendedSeats: 2,
          },
          {
            name: 'P0/P1 Downtime & SLA Escalations Pod',
            category: 'SLA_INCIDENT',
            description: 'Critical system outage, contractual SLA breaches, executive incident notifications',
            recommendedSeats: 1,
          },
        ],
      };
    }

    // 5. HEALTHCARE, TELEMEDICINE & MEDTECH
    if (key.includes('HEALTH') || key.includes('MEDIS') || key.includes('DOKTER')) {
      return {
        industry: 'HEALTHCARE',
        pods: [
          {
            name: 'Urgent Triage & Clinical Escalations Pod',
            category: 'TRIAGE',
            description: 'Emergency patient symptoms, immediate ambulance/ER hospital rerouting, urgent hotlines',
            recommendedSeats: 3,
          },
          {
            name: 'Doctor Appointments & Telehealth Video Pod',
            category: 'APPOINTMENTS',
            description: 'Physician scheduling, video room technical glitches, doctor delay notifications',
            recommendedSeats: 2,
          },
          {
            name: 'Digital Prescriptions & Pharmacy Delivery Pod',
            category: 'PHARMACY',
            description: 'Electronic Rx verification, partner pharmacy stockouts, sterile medicine dispatch',
            recommendedSeats: 2,
          },
          {
            name: 'Health Insurance Claims & Prior Auth Pod',
            category: 'INSURANCE',
            description: 'Cashless insurance guarantee letters, prior authorization appeals, deductible reviews',
            recommendedSeats: 2,
          },
          {
            name: 'Electronic Health Records & Patient Privacy Pod',
            category: 'RECORDS',
            description: 'HIPAA consent, encrypted lab test results, official doctor medical summary letters',
            recommendedSeats: 1,
          },
          {
            name: 'Chronic Care & Patient Follow-up Pod',
            category: 'CHRONIC_CARE',
            description: 'Long-term patient medication reminders, regular check-up scheduling, home health support',
            recommendedSeats: 1,
          },
        ],
      };
    }

    // 6. REAL ESTATE, PROPTECH & PROPERTY MANAGEMENT
    if (key.includes('REAL_ESTATE') || key.includes('PROPERTY') || key.includes('PROPERTI')) {
      return {
        industry: 'REAL_ESTATE',
        pods: [
          {
            name: 'Tenant Emergency Maintenance & Repairs Pod',
            category: 'MAINTENANCE',
            description: 'Burst plumbing, HVAC/heating failure, emergency lockouts, electrical hazards',
            recommendedSeats: 3,
          },
          {
            name: 'Lease Agreements, Move-in & Key Handover Pod',
            category: 'LEASING',
            description: 'Lease renewals, move-in inspection reports, digital key codes, tenant onboarding',
            recommendedSeats: 2,
          },
          {
            name: 'Rent Collection & Security Deposit Disputes Pod',
            category: 'RENT_DEPOSIT',
            description: 'Monthly rent payments, security deposit refund disputes, ledger accounting',
            recommendedSeats: 2,
          },
          {
            name: 'HOA Compliance, Noise & Parking Violations Pod',
            category: 'HOA_COMPLIANCE',
            description: 'Neighbor noise complaints, pet permit violations, resident parking disputes',
            recommendedSeats: 1,
          },
          {
            name: 'Property Amenities & Building Facilities Pod',
            category: 'AMENITIES',
            description: 'Gym/pool access codes, package locker malfunctions, elevator maintenance requests',
            recommendedSeats: 1,
          },
          {
            name: 'Landlord Relations & Vendor Work Orders Pod',
            category: 'VENDORS',
            description: 'Owner financial statements, contractor repair approvals, municipal inspection permits',
            recommendedSeats: 1,
          },
        ],
      };
    }

    // 7. TRAVEL, HOSPITALITY & AIRLINES
    if (key.includes('TRAVEL') || key.includes('HOTEL') || key.includes('WISATA') || key.includes('AIRLINE')) {
      return {
        industry: 'TRAVEL',
        pods: [
          {
            name: 'Flight Rescheduling & Airline Disruptions Pod',
            category: 'FLIGHTS',
            description: 'Involuntary airline schedule changes, weather cancellations, name corrections, baggage',
            recommendedSeats: 3,
          },
          {
            name: 'Hotel Bookings & Property Disputes Pod',
            category: 'HOTELS',
            description: 'Overbooked rooms upon arrival, property quality disputes, deposit returns, early check-in',
            recommendedSeats: 2,
          },
          {
            name: 'Trip Disruptions & 24/7 Emergency Assistance Pod',
            category: 'EMERGENCY',
            description: 'Blizzard ground stops, natural disaster evacuations, lost passports abroad, emergency hotline',
            recommendedSeats: 2,
          },
          {
            name: 'Corporate Travel & MICE Group Bookings Pod',
            category: 'CORPORATE_TRAVEL',
            description: 'Group bookings over 10 guests, corporate negotiated rates, business travel invoicing',
            recommendedSeats: 1,
          },
          {
            name: 'Rental Car & Airport Ground Transport Pod',
            category: 'GROUND_TRANSPORT',
            description: 'Airport shuttles, rental vehicle pickup delays, toll pass billing, drop-off disputes',
            recommendedSeats: 1,
          },
          {
            name: 'Travel Insurance & Cancellation Claims Pod',
            category: 'TRAVEL_CLAIMS',
            description: 'Medical cancellation claims, travel disruption coverage payouts, non-refundable waivers',
            recommendedSeats: 1,
          },
        ],
      };
    }

    // 8. GAMING, ESPORTS & INTERACTIVE MEDIA
    if (key.includes('GAMING') || key.includes('GAME') || key.includes('ESPORT')) {
      return {
        industry: 'GAMING',
        pods: [
          {
            name: 'Account Security, 2FA Recovery & Stolen Items Pod',
            category: 'ACCOUNT_SECURITY',
            description: 'Compromised gamer accounts, 2FA recovery, stolen high-value inventory items',
            recommendedSeats: 3,
          },
          {
            name: 'In-Game Purchases & Virtual Currency Refund Pod',
            category: 'PURCHASES',
            description: 'Microtransaction payment failures, unauthorized minor purchases, battle pass claims',
            recommendedSeats: 2,
          },
          {
            name: 'Player Toxicity, Cheating & Ban Appeals Pod',
            category: 'BAN_APPEALS',
            description: 'Anti-cheat ban appeals, voice/chat harassment reports, code of conduct enforcement',
            recommendedSeats: 2,
          },
          {
            name: 'Server Latency, Bugs & Game Client Crashes Pod',
            category: 'TECH_BUGS',
            description: 'High ping latency, matchmaking disconnects, patch update client crashes, quest bugs',
            recommendedSeats: 2,
          },
          {
            name: 'Guilds, Clan Support & Community Events Pod',
            category: 'COMMUNITY',
            description: 'Guild leader transfers, community tournament support, special in-game drop events',
            recommendedSeats: 1,
          },
          {
            name: 'Esports Tournaments & Anti-Cheat Disputes Pod',
            category: 'ESPORTS',
            description: 'Competitive tournament rulings, hardware ban investigations, prize payout disputes',
            recommendedSeats: 1,
          },
        ],
      };
    }

    // 9. TELECOMMUNICATIONS, BROADBAND & FIBER ISPS
    if (key.includes('TELECOM') || key.includes('ISP') || key.includes('FIBER') || key.includes('INTERNET')) {
      return {
        industry: 'TELECOM',
        pods: [
          {
            name: 'Network Outage & Area Downtime Escalations Pod',
            category: 'OUTAGE',
            description: 'Neighborhood fiber cuts, mass service outages, core network routing failures',
            recommendedSeats: 3,
          },
          {
            name: 'Field Technician On-Site Dispatch Pod',
            category: 'FIELD_TECH',
            description: 'New line installations, technician truck roll scheduling, drop wire physical repairs',
            recommendedSeats: 2,
          },
          {
            name: 'Modem/Router Hardware & Wi-Fi Diagnostics Pod',
            category: 'HARDWARE',
            description: 'Lightning-damaged router swaps, Wi-Fi mesh configuration, optical signal diagnostics',
            recommendedSeats: 2,
          },
          {
            name: 'Billing Invoices & Promotional Rate Expirations Pod',
            category: 'TELECOM_BILLING',
            description: 'Post-promo bill increase disputes, equipment rental charges, service cancellation fees',
            recommendedSeats: 2,
          },
          {
            name: 'SIM Card, eSIM & Mobile Number Porting Pod',
            category: 'MOBILE_PORTING',
            description: 'Carrier number porting requests, eSIM activation QR issues, roaming data blocks',
            recommendedSeats: 1,
          },
          {
            name: 'Enterprise Dedicated Fiber & SLA Leased Lines Pod',
            category: 'ENTERPRISE_FIBER',
            description: 'Dedicated corporate DIA fiber, multi-gigabit throughput, strict 99.99% SLA metrics',
            recommendedSeats: 1,
          },
        ],
      };
    }

    // 10. AUTOMOTIVE, EV MOBILITY & FLEET SERVICES
    if (key.includes('AUTO') || key.includes('CAR') || key.includes('VEHICLE') || key.includes('MOBILITY')) {
      return {
        industry: 'AUTOMOTIVE',
        pods: [
          {
            name: 'Roadside Assistance & Emergency Towing Pod',
            category: 'ROADSIDE',
            description: 'Flat tire dispatch, dead battery jumpstarts, highway towing, emergency vehicle lockout',
            recommendedSeats: 3,
          },
          {
            name: 'EV Charging Station & App Billing Issues Pod',
            category: 'EV_CHARGING',
            description: 'Charging station connector failures, session billing errors, RFID card authentication',
            recommendedSeats: 2,
          },
          {
            name: 'Vehicle Warranty, Recall & Maintenance Booking Pod',
            category: 'WARRANTY',
            description: 'Factory safety recalls, powertrain warranty claims, scheduled dealership services',
            recommendedSeats: 2,
          },
          {
            name: 'Car Rental Bookings, Toll Charges & Damage Claims Pod',
            category: 'RENTAL_CLAIMS',
            description: 'Electronic toll tag disputes, post-trip damage claims, vehicle security deposit returns',
            recommendedSeats: 2,
          },
          {
            name: 'Fleet Telematics & Commercial Vehicle Logistics Pod',
            category: 'FLEET',
            description: 'Commercial fleet ELD compliance, telematics GPS tracking errors, driver safety scorecards',
            recommendedSeats: 1,
          },
          {
            name: 'Auto Insurance Claims & Accident Reports Pod',
            category: 'ACCIDENT_REPORTS',
            description: 'Accident report intake, digital damage photos, body shop repair estimate authorizations',
            recommendedSeats: 1,
          },
        ],
      };
    }

    // 11. PROFESSIONAL LEGAL & CPA TAX SERVICES
    if (
      key.includes('LEGAL') ||
      key.includes('TAX') ||
      key.includes('ACCOUNTING') ||
      key.includes('PROFESSIONAL') ||
      key.includes('HUKUM') ||
      key.includes('PAJAK')
    ) {
      return {
        industry: 'PROFESSIONAL_SERVICES',
        pods: [
          {
            name: 'Tax Filing Deadlines & IRS Document Collection Pod',
            category: 'TAX_FILING',
            description: 'W-2 / 1099 tax document intake, IRS deadline tracking, extension request filings',
            recommendedSeats: 3,
          },
          {
            name: 'Client Retainer Onboarding & Scope Agreements Pod',
            category: 'RETAINER_ENGAGEMENT',
            description: 'Engagement letters, client retainer agreements, scope of work clarifications',
            recommendedSeats: 2,
          },
          {
            name: 'Attorney & Consultant Consultation Scheduling Pod',
            category: 'CONSULTATION',
            description: 'Partner attorney appointments, expert witness bookings, confidential prep sessions',
            recommendedSeats: 2,
          },
          {
            name: 'Secure Document Vault & Compliance Audit Pod',
            category: 'DOCUMENT_VAULT',
            description: 'Encrypted document delivery, client privilege compliance, financial audit workpapers',
            recommendedSeats: 2,
          },
          {
            name: 'Billing Invoices, Trust Accounting & Retainers Pod',
            category: 'IOLTA_BILLING',
            description: 'IOLTA trust account accounting, hourly legal invoices, credit card retainer refills',
            recommendedSeats: 1,
          },
          {
            name: 'Corporate Entity Formation & Legal Filings Pod',
            category: 'CORPORATE_FILINGS',
            description: 'LLC / C-Corp state filings, registered agent notices, annual franchise tax reminders',
            recommendedSeats: 1,
          },
        ],
      };
    }

    // 12. EDUCATION, BOOTCAMPS & EDTECH
    if (
      key.includes('EDTECH') ||
      key.includes('EDU') ||
      key.includes('SEKOLAH') ||
      key.includes('KURSUS') ||
      key.includes('LEARNING')
    ) {
      return {
        industry: 'EDTECH',
        pods: [
          {
            name: 'LMS Platform & Virtual Classroom Pod',
            category: 'LMS',
            description: 'Live webinar stream buffering, Safe Exam Browser issues, assignment upload errors',
            recommendedSeats: 3,
          },
          {
            name: 'Tuition Payments, Financial Aid & Billing Pod',
            category: 'TUITION',
            description: 'Tuition installment plans, scholarship disbursements, financial graduation clearances',
            recommendedSeats: 2,
          },
          {
            name: 'Academic Advising & Tutor Support Pod',
            category: 'TUTORING',
            description: 'Curriculum pathway planning, 1-on-1 mentor appointments, thesis advisor escalations',
            recommendedSeats: 2,
          },
          {
            name: 'Student Certification & Degree Verification Pod',
            category: 'CREDENTIALS',
            description: 'Digital degree verification, course completion certificates, transcript requests',
            recommendedSeats: 2,
          },
          {
            name: 'Admissions, Placement & Enrollment Counseling Pod',
            category: 'ADMISSIONS',
            description: 'Application intake, placement test technical support, international student I-20 queries',
            recommendedSeats: 1,
          },
          {
            name: 'Exam Integrity & Proctoring Support Pod',
            category: 'PROCTORING',
            description: 'Remote webcam proctoring lockouts, room scan verification, identity match appeals',
            recommendedSeats: 1,
          },
        ],
      };
    }

    // 13. CUSTOM / GENERAL (OTHER)
    const customLabel = customDescription
      ? ` (${customDescription.slice(0, 15)})`
      : '';
    const otherPods = [
      {
        name: `Frontline Customer Operations Pod${customLabel}`,
        category: 'OPERATIONS',
        description: 'Frontline customer orders, general inquiries, immediate ticket intake',
        recommendedSeats: 3,
        service: customDescription ? `${customDescription.slice(0, 24)} Operations` : 'Frontline Operations & Ticket Triage',
      },
      {
        name: 'Billing, Invoicing & Payment Verification Pod',
        category: 'BILLING',
        description: 'Payment verification, invoice receipts, bank wire reconciliation, refunds',
        recommendedSeats: 2,
        service: 'Billing, Invoicing & Payment Verification',
      },
      {
        name: 'Product Quality & Replacement Warranty Pod',
        category: 'QUALITY',
        description: 'Product defects, replacement unit dispatches, warranty service requests',
        recommendedSeats: 2,
        service: 'Product Quality & Replacement Warranty',
      },
      {
        name: 'Technical & Application Support Pod',
        category: 'TECH_SUPPORT',
        description: 'Software login issues, hardware diagnostics, account settings troubleshooting',
        recommendedSeats: 2,
        service: 'Technical & Application Support',
      },
      {
        name: 'Account Security & Profile Management Pod',
        category: 'SECURITY',
        description: 'Password resets, 2FA authorization, profile data updates, access permissions',
        recommendedSeats: 1,
        service: 'Account Security & Profile Management',
      },
      {
        name: 'Executive & High-Priority SLA Escalations Pod',
        category: 'VIP_SLA',
        description: 'Director-level escalations, breached contractual SLAs, strategic VIP accounts',
        recommendedSeats: 1,
        service: 'Executive & High-Priority SLA Escalations',
      },
    ];

    return {
      industry: 'OTHER',
      pods: otherPods,
      defaultServices: otherPods.map((p) => p.service),
    };
  }
}
