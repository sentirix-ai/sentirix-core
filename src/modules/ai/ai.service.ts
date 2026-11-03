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
  private readonly modelName = 'gemini-2.5-flash';

  constructor(private readonly configService: ConfigService) {
    const apiKey = this.configService.get<string>('GEMINI_API_KEY');
    if (apiKey && apiKey.trim() !== '' && apiKey !== 'your_google_gemini_api_key_here') {
      try {
        this.aiClient = new GoogleGenAI({ apiKey });
        this.logger.log('Google Gemini API client initialized successfully.');
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
                  `- ID: "${p.id}", Name: "${p.name}", Category: "${p.category || 'GENERAL'}", Description: "${p.description || 'General requests'}", CatchAll: ${!!p.isCatchAll}`,
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
    }>;
  }> {
    const cleanIndustry = (industry || 'OTHER').trim();
    const cleanDesc = (customDescription || '').trim();

    if (this.aiClient) {
      try {
        const prompt = `You are a world-class enterprise operations architect for Sentirix.
The user is setting up a customer support organization.
Industry/Sector: "${cleanIndustry}"
${cleanDesc ? `Additional Specifics: "${cleanDesc}"` : ''}

Generate exactly 3 to 4 specialized operational support pods (sub-teams) best suited for this exact business model.
Rules:
1. Max 8 members per pod (Amazon Two-Pizza Pod rule).
2. Pod names must be concise, professional, and directly address customer complaint drivers for this vertical.
3. Each pod must include a 1-sentence semantic description explaining what customer ticket topics it handles (crucial for AI routing).
4. Assign recommendedSeats between 1 and 4 for each pod (total sum around 8).

Return strictly JSON format:
{
  "pods": [
    {
      "name": "string",
      "category": "UPPERCASE_SNAKE_CASE",
      "description": "string",
      "recommendedSeats": number
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
          return {
            industry: cleanIndustry,
            pods: parsed.pods.map((p: any) => ({
              name: String(p.name || 'Support Pod'),
              category: String(p.category || 'GENERAL').toUpperCase(),
              description: String(p.description || 'Handles customer requests'),
              recommendedSeats: Math.max(1, Math.min(8, Number(p.recommendedSeats) || 2)),
            })),
          };
        }
      } catch (err) {
        this.logger.warn(`Gemini generatePods error: ${(err as Error).message}. Falling back to presets.`);
      }
    }

    return this.getFallbackPodsForIndustry(cleanIndustry, cleanDesc);
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
    }>;
  } {
    const key = (industry || 'OTHER').toUpperCase().trim();

    if (key.includes('ECOMMERCE') || key.includes('RETAIL') || key.includes('COMMERCE')) {
      return {
        industry: 'ECOMMERCE',
        pods: [
          {
            name: 'Order Fulfillment & Shipping Pod',
            category: 'FULFILLMENT',
            description: 'Where is my order (WISMO), shipping status, delivery delays',
            recommendedSeats: 3,
          },
          {
            name: 'Refunds, Exchanges & Returns Pod',
            category: 'RETURNS',
            description: 'Customer returns, product exchanges, wallet refunds, damaged items',
            recommendedSeats: 2,
          },
          {
            name: 'Promotions, Vouchers & Checkout Pod',
            category: 'PROMOTIONS',
            description: 'Coupon codes, loyalty points, cart checkout errors, flash sales',
            recommendedSeats: 2,
          },
          {
            name: 'VIP High-LTV Buyers Pod',
            category: 'VIP',
            description: 'High-value customer escalations, white-glove concierge support',
            recommendedSeats: 1,
          },
        ],
      };
    }

    if (
      key.includes('LOGISTICS') ||
      key.includes('EKSPEDISI') ||
      key.includes('COURIER') ||
      key.includes('KURIR')
    ) {
      return {
        industry: 'LOGISTICS',
        pods: [
          {
            name: 'Pod Pelacakan Resi & Status Pengiriman',
            category: 'TRACKING',
            description: 'Resi stuck, manifest delay, transit hub exceptions, tracking updates',
            recommendedSeats: 3,
          },
          {
            name: 'Pod Klaim Kehilangan & Kerusakan Paket',
            category: 'CLAIMS',
            description: 'Lost parcel investigation, transit damage claims, insurance payouts',
            recommendedSeats: 2,
          },
          {
            name: 'Pod Penjadwalan Pick-up & Dispatch Armada',
            category: 'DISPATCH',
            description: 'Courier route dispatch, warehouse pick-up requests, sameday slots',
            recommendedSeats: 2,
          },
          {
            name: 'Pod Akun Korporat B2B & Rekonsiliasi COD',
            category: 'CORPORATE_COD',
            description: 'B2B enterprise merchant contracts, COD remittance, bulk billing',
            recommendedSeats: 1,
          },
        ],
      };
    }

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
            name: 'Transaction Disputes & Settlement Pod',
            category: 'SETTLEMENT',
            description: 'Failed transactions, double billing, pending bank transfers, clearing',
            recommendedSeats: 3,
          },
          {
            name: 'KYC & Account Security Verification Pod',
            category: 'KYC',
            description: 'Identity verification, biometric KYC, account lockout, OTP reset',
            recommendedSeats: 2,
          },
          {
            name: 'Anti-Fraud & Chargeback Investigation Pod',
            category: 'FRAUD',
            description: 'Card chargebacks, unauthorized transactions, fraud alerts',
            recommendedSeats: 2,
          },
          {
            name: 'B2B Merchant Integrations & Invoicing Pod',
            category: 'MERCHANT_B2B',
            description: 'Payment gateway API keys, webhook failures, corporate settlement',
            recommendedSeats: 1,
          },
        ],
      };
    }

    if (key.includes('SAAS') || key.includes('TECH') || key.includes('SOFTWARE')) {
      return {
        industry: 'SAAS',
        pods: [
          {
            name: 'Technical & API Integrations Pod',
            category: 'TECHNICAL',
            description: 'REST API, Webhooks, 504 timeouts, SDK libraries, code bugs',
            recommendedSeats: 3,
          },
          {
            name: 'Billing, Invoices & Subscriptions Pod',
            category: 'BILLING',
            description: 'Recurring payments, invoice tax receipts, plan upgrade/downgrade',
            recommendedSeats: 2,
          },
          {
            name: 'Security, IAM & Single Sign-On Pod',
            category: 'SECURITY',
            description: 'SAML, Okta, Azure AD, 2FA enforcement, audit compliance',
            recommendedSeats: 2,
          },
          {
            name: 'Enterprise VIP SLA Escalations Pod',
            category: 'VIP_SLA',
            description: 'Contract SLA penalty credits, dedicated CSM tickets, high priority',
            recommendedSeats: 1,
          },
        ],
      };
    }

    if (key.includes('HEALTH') || key.includes('MEDIS') || key.includes('DOKTER')) {
      return {
        industry: 'HEALTHCARE',
        pods: [
          {
            name: 'Doctor Consultation & Appointments Pod',
            category: 'APPOINTMENTS',
            description: 'Telemedicine scheduling, doctor delay alerts, video call links',
            recommendedSeats: 3,
          },
          {
            name: 'Pharmacy & Digital Prescription Pod',
            category: 'PHARMACY',
            description: 'Medication fulfillment, prescription verification, courier dispatch',
            recommendedSeats: 2,
          },
          {
            name: 'Health Insurance & Policy Claims Pod',
            category: 'INSURANCE',
            description: 'Cashless insurance claims, policy coverage verification, hospital letters',
            recommendedSeats: 2,
          },
          {
            name: 'Medical Records & Patient Privacy Pod',
            category: 'RECORDS',
            description: 'Lab test results, patient data consent, confidential health inquiries',
            recommendedSeats: 1,
          },
        ],
      };
    }

    if (key.includes('TRAVEL') || key.includes('HOTEL') || key.includes('WISATA')) {
      return {
        industry: 'TRAVEL',
        pods: [
          {
            name: 'Flight & Train Reschedule / Refund Pod',
            category: 'FLIGHTS',
            description: 'Airline schedule changes, flight cancellations, ticket refunds',
            recommendedSeats: 3,
          },
          {
            name: 'Hotel Bookings & Property Relations Pod',
            category: 'HOTELS',
            description: 'Room confirmations, early check-in, no-show disputes, vouchers',
            recommendedSeats: 2,
          },
          {
            name: 'Emergency & Trip Disruption Pod',
            category: 'EMERGENCY',
            description: 'Natural disaster re-routing, lost baggage assistance, 24/7 hotline',
            recommendedSeats: 2,
          },
          {
            name: 'VIP Concierge & Corporate Travel Pod',
            category: 'VIP_TRAVEL',
            description: 'Corporate business trips, luxury itinerary planning, executive perks',
            recommendedSeats: 1,
          },
        ],
      };
    }

    if (
      key.includes('EDTECH') ||
      key.includes('EDU') ||
      key.includes('SEKOLAH') ||
      key.includes('KURSUS')
    ) {
      return {
        industry: 'EDTECH',
        pods: [
          {
            name: 'LMS Platform & Virtual Classroom Pod',
            category: 'LMS',
            description: 'Live webinar access, video buffering, exam browser issues',
            recommendedSeats: 3,
          },
          {
            name: 'Tuition Fees & Certification Pod',
            category: 'TUITION',
            description: 'Installment plans, scholarships, graduation certificate issuance',
            recommendedSeats: 2,
          },
          {
            name: 'Student Counseling & Academic Tutors Pod',
            category: 'TUTORING',
            description: 'Assignment feedback, course curriculum questions, mentor support',
            recommendedSeats: 3,
          },
        ],
      };
    }

    const customLabel = customDescription
      ? ` (${customDescription.slice(0, 15)})`
      : '';
    return {
      industry: 'OTHER',
      pods: [
        {
          name: `Operations & Inquiries Pod${customLabel}`,
          category: 'OPERATIONS',
          description: 'Frontline customer orders, service inquiries, general requests',
          recommendedSeats: 3,
        },
        {
          name: 'Billing, Invoicing & Finance Pod',
          category: 'BILLING',
          description: 'Payment verification, invoices, bank refunds, account statements',
          recommendedSeats: 2,
        },
        {
          name: 'Product Quality & Warranty Pod',
          category: 'QUALITY',
          description: 'Defect reports, quality control claims, replacement requests',
          recommendedSeats: 2,
        },
        {
          name: 'VIP & High-Priority Escalations Pod',
          category: 'VIP',
          description: 'Critical business escalation, director review, high priority SLA',
          recommendedSeats: 1,
        },
      ],
    };
  }
}
