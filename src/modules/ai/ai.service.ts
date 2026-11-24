import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenAI } from '@google/genai';
import { AnalyzeTicketResponseDto } from './dto/analyze-ticket.dto.js';
import { DraftReplyDto, DraftReplyResponseDto } from './dto/draft-reply.dto.js';
import { SummarizeThreadDto, SummarizeThreadResponseDto } from './dto/summarize-thread.dto.js';
import { AttachmentDto } from './dto/attachment.dto.js';

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
   * Helper to format base64/data-uri attachments into Gemini SDK inlineData parts
   */
  private formatAttachmentPart(att: { mimeType?: string; data: string; fileName?: string }): {
    inlineData: { data: string; mimeType: string };
  } {
    let cleanData = att.data || '';
    let cleanMime = att.mimeType || 'image/png';

    if (cleanData.startsWith('data:')) {
      const commaIdx = cleanData.indexOf(',');
      if (commaIdx !== -1) {
        const meta = cleanData.substring(5, commaIdx);
        const semiIdx = meta.indexOf(';');
        if (semiIdx !== -1) {
          cleanMime = meta.substring(0, semiIdx);
        }
        cleanData = cleanData.substring(commaIdx + 1);
      }
    }

    cleanData = cleanData.replace(/\s/g, '');

    return {
      inlineData: {
        data: cleanData,
        mimeType: cleanMime,
      },
    };
  }

  /**
   * 1. Dynamic AI Sentiment & Urgency Detector + Domain-Context Pod Routing (Multimodal Capable)
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
      attachments?: AttachmentDto[];
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

      const hasAttachments = Array.isArray(context?.attachments) && context!.attachments.length > 0;
      const visualInstructions = hasAttachments
        ? `\nVISUAL EVIDENCE ATTACHED (${context!.attachments!.length} document(s)):
Inspect each attached screenshot or PDF receipt carefully.
Check for error codes, server crash dialogs, payment failed indicators, transaction totals, or invoice discrepancies.
Incorporate visual insights to calibrate urgency priority and customer sentiment accurately.`
        : '';

      const prompt = `You are the Chief AI Triage Officer for Sentirix enterprise service operations.
Company Business Sector / Industry: "${context?.industry || 'General Business'}"
Analyze this inbound customer support ticket and classify it accurately.
${podsDescription}

Ticket Title: ${title}
Ticket Description: ${description}
${visualInstructions}

Instructions:
1. Determine customer sentiment: "POSITIVE", "NEUTRAL", "FRUSTRATED", or "URGENT".
2. Determine urgency priority: "LOW", "MEDIUM", "HIGH", or "CRITICAL".
3. Assign 2-4 semantic tags.
4. Provide a 1-sentence summary (mentioning visual proof if verified).
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

      const contents: any[] = [];
      if (hasAttachments) {
        for (const att of context!.attachments!) {
          try {
            contents.push(this.formatAttachmentPart(att));
          } catch (e) {
            this.logger.warn(`Could not format attachment part for triage: ${(e as Error).message}`);
          }
        }
      }
      contents.push(prompt);

      const response = await this.aiClient.models.generateContent({
        model: this.modelName,
        contents,
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
            name: String(p.name || 'Support').replace(/\s+Pod$/i, '').trim(),
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
   * Validate whether a renamed baseline service preserves the original functional domain
   * or diverges into an entirely different business meaning using Gemini AI.
   */
  async validateServiceSemanticMatch(dto: {
    originalService: string;
    newServiceName: string;
    industry?: string;
  }): Promise<{
    isCompatible: boolean;
    confidenceScore: number;
    explanation: string;
    suggestAddAsNew: boolean;
  }> {
    const original = (dto.originalService || '').trim();
    const candidate = (dto.newServiceName || '').trim();
    const industry = (dto.industry || 'General Business').trim();

    if (!original || !candidate) {
      return {
        isCompatible: false,
        confidenceScore: 0,
        explanation: 'Category name cannot be empty.',
        suggestAddAsNew: false,
      };
    }

    if (original.toLowerCase() === candidate.toLowerCase()) {
      return {
        isCompatible: true,
        confidenceScore: 100,
        explanation: 'The proposed name is identical to the baseline category.',
        suggestAddAsNew: false,
      };
    }

    if (this.aiClient) {
      try {
        const prompt = `You are the Chief AI Service Governance Architect for Sentirix B2B enterprise customer operations.
A company in the "${industry}" sector is attempting to rename one of Sentirix's 6 core baseline complaint categories.

Baseline Service Name: "${original}"
Proposed New Service Name: "${candidate}"

Task:
Analyze whether the Proposed Name ("${candidate}") maintains the same core operational domain, customer complaint scope, or functional responsibility as the Baseline Service ("${original}") - such as corporate terminology, synonyms, or domain rephrasing.

Evaluation Rules:
1. "isCompatible: true": If the proposed name is a synonym, corporate phrasing, or reasonable variation of the SAME operational domain (e.g. "WISMO & Carrier Exceptions" renamed to "Linehaul Dispatch & Courier Route Tracking", or "Billing Invoices" renamed to "Accounts Receivable & Payment Disputes").
2. "isCompatible: false": If the proposed name represents a FUNDAMENTALLY DIFFERENT operational domain or unrelated department (e.g. renaming a delivery/shipping service to "Corporate Tax & Legal Retainers", "Influencer Sponsorships", "Talent Acquisition", or "Property Damage Insurance").
3. "explanation": Provide a polite, direct, executive-grade explanation in polished US English (e.g. "This baseline category is dedicated to ${industry} operations. The proposed name belongs to an unrelated department. To protect frontline response times and triage accuracy, we recommend adding this as a new category.").
4. "suggestAddAsNew": true if rejected, recommending that the user keep the baseline and add their new topic as a custom category (+ Add Custom Ticket Category).

Return strictly JSON format:
{
  "isCompatible": boolean,
  "confidenceScore": number,
  "explanation": "string",
  "suggestAddAsNew": boolean
}`;

        const response = await this.aiClient.models.generateContent({
          model: this.modelName,
          contents: prompt,
          config: {
            responseMimeType: 'application/json',
          },
        });

        const parsed = JSON.parse(response.text || '{}');
        return {
          isCompatible: typeof parsed.isCompatible === 'boolean' ? parsed.isCompatible : true,
          confidenceScore: typeof parsed.confidenceScore === 'number' ? parsed.confidenceScore : 85,
          explanation: parsed.explanation || (parsed.isCompatible ? 'The proposed name aligns with the core functional scope of this baseline category.' : 'This proposed name diverges from the core operational scope of this baseline category.'),
          suggestAddAsNew: !!parsed.suggestAddAsNew,
        };
      } catch (err) {
        this.logger.warn(`AI semantic validation fallback applied: ${(err as Error).message}`);
      }
    }

    return this.fallbackSemanticValidation(original, candidate, industry);
  }

  private fallbackSemanticValidation(
    original: string,
    candidate: string,
    industry: string,
  ): {
    isCompatible: boolean;
    confidenceScore: number;
    explanation: string;
    suggestAddAsNew: boolean;
  } {
    const origLower = original.toLowerCase();
    const candLower = candidate.toLowerCase();

    const clusters: Array<{ domain: string; keywords: string[] }> = [
      {
        domain: 'Shipping & Delivery Logistics',
        keywords: [
          'wismo', 'ship', 'carrier', 'delivery', 'transit', 'tracking', 'logistik', 'kurir', 'ekspedisi', 'paket', 'resi', 'antar', 'rts', 'fleet', 'depot'
        ],
      },
      {
        domain: 'Billing & Finance',
        keywords: [
          'billing', 'invoice', 'payment', 'charge', 'refund', 'tagihan', 'pembayaran', 'uang', 'transaksi', 'biaya', 'bayar', 'tarik', 'dispute', 'voucher', 'promo'
        ],
      },
      {
        domain: 'Technical Diagnostics & Engineering',
        keywords: [
          'bug', 'error', 'api', 'webhook', 'crash', 'down', 'sre', 'code', 'sistem', 'gangguan', 'teknis', 'kendala', 'server', 'database', 'access', 'login'
        ],
      },
      {
        domain: 'Clinical Healthcare & Telehealth',
        keywords: [
          'triage', 'doctor', 'telehealth', 'rx', 'prescription', 'clinic', 'ehr', 'hipaa', 'obat', 'dokter', 'pasien', 'klinik', 'resep', 'medis', 'darurat'
        ],
      },
      {
        domain: 'Corporate Tax, Legal, or Marketing',
        keywords: [
          'pajak', 'tax', 'irs', 'legal', 'hukum', 'influencer', 'endorse', 'marketing', 'iklan', 'hrd', 'rekrutmen', 'lowongan', 'kebakaran'
        ],
      },
    ];

    const origCluster = clusters.find((c) => c.keywords.some((kw) => origLower.includes(kw)));
    const candCluster = clusters.find((c) => c.keywords.some((kw) => candLower.includes(kw)));

    if (origCluster && candCluster && origCluster.domain !== candCluster.domain) {
      return {
        isCompatible: false,
        confidenceScore: 90,
        explanation: `This baseline category is dedicated to ${origCluster.domain}. The proposed name belongs to ${candCluster.domain}. To protect your frontline response times and triage accuracy, we recommend adding this as a new category.`,
        suggestAddAsNew: true,
      };
    }

    return {
      isCompatible: true,
      confidenceScore: 80,
      explanation: 'The proposed name aligns with the core functional scope of this baseline category.',
      suggestAddAsNew: false,
    };
  }

  /**
   * 2. AI One-Click Reply Drafter (Multimodal Vision Supported)
   */
  async draftReply(dto: DraftReplyDto): Promise<DraftReplyResponseDto> {
    const hasAttachments = Array.isArray(dto.attachments) && dto.attachments.length > 0;

    if (!this.aiClient) {
      const visualNote = hasAttachments
        ? `\n\n[Visual Diagnostics]: Attached document/screenshot ("${dto.attachments![0].fileName}") has been verified and referenced in this resolution.`
        : '';
      return {
        draft: `Hello,\n\nThank you for reaching out regarding "${dto.ticketTitle}". We have received your request and our support engineering team is currently investigating the issue.${visualNote}\n\nWe will update you as soon as more details are available.\n\nBest regards,\nSupport Team`,
        groundedSources: [
          ...(dto.knowledgeContext ? ['Standard Support Policy'] : []),
          ...(hasAttachments ? [`Visual Evidence (${dto.attachments!.map((a) => a.fileName).join(', ')})`] : []),
        ],
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

      const visualInstructions = hasAttachments
        ? `\nVISUAL EVIDENCE ATTACHED (${dto.attachments!.length} document(s)):
Inspect each attached image or PDF screenshot carefully.
Extract any visible text, error messages, HTTP status codes, transaction IDs, invoice numbers, dollar amounts, or UI anomalies.
Ground your draft response directly on the visual evidence provided in these attachments.`
        : '';

      const prompt = `You are Sentrix AI Copilot assisting a human support agent.
Ticket Title: ${dto.ticketTitle}
Initial Complaint: ${dto.ticketDescription}

Conversation History:
${historyText || 'No prior messages.'}

${dto.knowledgeContext ? `Official Knowledge Base Reference Documents:\n${dto.knowledgeContext}` : ''}
${visualInstructions}

Tone: ${toneGuideline}

Instructions:
- Write a ready-to-send response to the customer.
- If visual evidence (screenshots, receipts, PDFs) is attached, explicitly reference the specific details, error messages, or transaction amounts observed in the attachment so the customer knows their evidence was carefully reviewed.
- If Knowledge Base reference is provided, strictly ground your facts on it and do not invent policies.
- Address the customer politely and outline the clear resolution or next action steps.`;

      const contents: any[] = [];
      if (hasAttachments) {
        for (const att of dto.attachments!) {
          try {
            contents.push(this.formatAttachmentPart(att));
          } catch (e) {
            this.logger.warn(`Failed to format attachment part for AI: ${(e as Error).message}`);
          }
        }
      }
      contents.push(prompt);

      const response = await this.aiClient.models.generateContent({
        model: this.modelName,
        contents,
      });

      return {
        draft: response.text?.trim() || 'Could not generate draft.',
        groundedSources: [
          ...(dto.knowledgeContext ? ['Knowledge Base Reference Document'] : []),
          ...(hasAttachments ? [`Visual Evidence (${dto.attachments!.map((a) => a.fileName).join(', ')})`] : []),
        ],
      };
    } catch (error) {
      this.logger.error(`Error in draftReply AI call: ${(error as Error).message}`);
      return {
        draft: `Hello, thank you for reaching out. We are actively reviewing "${dto.ticketTitle}" and will get back to you shortly.`,
        groundedSources: hasAttachments ? [`Visual Evidence (${dto.attachments!.map((a) => a.fileName).join(', ')})`] : [],
      };
    }
  }

  /**
   * 3. AI Thread Summarizer (Multimodal Vision Supported)
   */
  async summarizeThread(dto: SummarizeThreadDto): Promise<SummarizeThreadResponseDto> {
    const hasAttachments = Array.isArray(dto.attachments) && dto.attachments.length > 0;

    if (!this.aiClient) {
      return {
        bulletPoints: [
          `Customer reported: ${dto.ticketTitle}`,
          `${dto.messages.length} messages in conversation thread.` +
            (hasAttachments ? ` (${dto.attachments!.length} visual document(s) attached)` : ''),
          'Status is actively monitored by support agent.',
        ],
      };
    }

    try {
      const historyText = dto.messages.map((m) => `${m.sender}: ${m.content}`).join('\n');

      const visualInstructions = hasAttachments
        ? `\nVISUAL EVIDENCE ATTACHED (${dto.attachments!.length} document(s)):
Inspect all attached screenshots/documents. Incorporate any key error codes, transaction IDs, or payment details directly into the summary.`
        : '';

      const prompt = `Summarize this customer support thread into exactly 3 concise, high-impact bullet points:
1. Core problem reported by customer (include visual findings if screenshots/documents are attached)
2. Actions taken or discussed so far
3. Current blocker or immediate next step required

Ticket: ${dto.ticketTitle}
Messages:
${historyText}
${visualInstructions}

Return as a JSON array of 3 strings: ["point 1", "point 2", "point 3"]`;

      const contents: any[] = [];
      if (hasAttachments) {
        for (const att of dto.attachments!) {
          try {
            contents.push(this.formatAttachmentPart(att));
          } catch (e) {
            this.logger.warn(`Failed to format attachment part for AI: ${(e as Error).message}`);
          }
        }
      }
      contents.push(prompt);

      const response = await this.aiClient.models.generateContent({
        model: this.modelName,
        contents,
        config: {
          responseMimeType: 'application/json',
        },
      });

      const parsed = JSON.parse(response.text?.trim() || '[]');
      return {
        bulletPoints:
          Array.isArray(parsed) && parsed.length > 0
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
    const rawDesc = (customDescription || '').toUpperCase().trim();
    const isOther = (industry || 'OTHER').toUpperCase().trim() === 'OTHER';
    const key = isOther && rawDesc ? rawDesc : (industry || 'OTHER').toUpperCase().trim();

    // 1. E-COMMERCE, D2C & RETAIL BRANDS
    if (key.includes('ECOMMERCE') || key.includes('RETAIL') || key.includes('COMMERCE')) {
      return {
        industry: 'ECOMMERCE',
        pods: [
          {
            name: 'WISMO & Carrier Exceptions',
            category: 'WISMO',
            description: 'Where is my order tracking, carrier delays, stuck shipments, lost parcels',
            recommendedSeats: 3,
          },
          {
            name: 'Returns, Exchanges & Damaged Claims',
            category: 'RETURNS',
            description: 'RMA return labels, defective products, sizing exchanges, customer refunds',
            recommendedSeats: 2,
          },
          {
            name: 'Checkout, Payments & Promotions',
            category: 'PROMOTIONS',
            description: 'Failed checkout, coupon code errors, payment gateways, tax exemption',
            recommendedSeats: 2,
          },
          {
            name: 'VIP Concierge & High-LTV Buyers',
            category: 'VIP',
            description: 'Priority white-glove support, instant replacement warranties, loyalty perks',
            recommendedSeats: 1,
          },
          {
            name: 'Merchant Onboarding & Catalog Compliance',
            category: 'MERCHANT',
            description: 'Marketplace seller accounts, catalog listings, policy violations, payout holds',
            recommendedSeats: 2,
          },
          {
            name: 'Product Quality & Brand Protection',
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
            name: 'Linehaul & Transit Hub Exceptions',
            category: 'LINEHAUL',
            description: 'Interstate sorting hub bottlenecks, highway fleet breakdowns, damaged manifests',
            recommendedSeats: 3,
          },
          {
            name: 'Last-Mile & Delivery Route Exceptions',
            category: 'LAST_MILE',
            description: 'Driver failed delivery attempts, locked gates, incorrect addresses, sameday rerouting',
            recommendedSeats: 2,
          },
          {
            name: 'Freight Damage & Insurance Claims',
            category: 'CLAIMS',
            description: 'Broken seal investigations, transit damage BAP, cargo insurance settlements',
            recommendedSeats: 2,
          },
          {
            name: 'B2B Shipper Accounts & COD Settlement',
            category: 'COD_ACCOUNTS',
            description: 'Driver cash-on-delivery reconciliation, enterprise shipper billing, weight disputes',
            recommendedSeats: 1,
          },
          {
            name: 'Fleet Dispatch & Special Handling',
            category: 'DISPATCH',
            description: 'Palletized heavy freight, cold-chain temperature monitoring, urgent sameday dispatch',
            recommendedSeats: 2,
          },
          {
            name: 'Courier Misconduct & Driver Operations',
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
            name: 'ACH, Wire & Real-Time Transfer Disputes',
            category: 'TRANSFERS',
            description: 'ACH clearing delays, failed wire transfers, routing errors, manual ledger reversals',
            recommendedSeats: 3,
          },
          {
            name: 'Biometric KYC & Account Security',
            category: 'KYC',
            description: 'SSN/Driver license verification, selfie liveness checks, 2FA lockouts, password resets',
            recommendedSeats: 2,
          },
          {
            name: 'Fraud, Scam & Chargeback Defense',
            category: 'FRAUD',
            description: 'Visa/Mastercard chargeback representment, unauthorized card activity, phishing freezes',
            recommendedSeats: 2,
          },
          {
            name: 'B2B Payment Gateway & Webhook',
            category: 'GATEWAY_API',
            description: 'Developer merchant API 5xx timeouts, webhook signature errors, daily batch settlements',
            recommendedSeats: 1,
          },
          {
            name: 'Digital Lending, BNPL & Collections',
            category: 'LENDING',
            description: 'Installment payment disputes, interest penalty adjustments, credit bureau reporting',
            recommendedSeats: 2,
          },
          {
            name: 'Treasury, Settlement & Clearing',
            category: 'TREASURY',
            description: 'Liquidity settlement, cross-border currency conversion, institutional bank reconciliation',
            recommendedSeats: 1,
          },
        ],
      };
    }

    // 4. B2B SAAS & TECH ENTERPRISE
    if (
      key === 'SAAS' ||
      key.includes('SOFTWARE') ||
      (key.includes('TECH') &&
        !key.includes('EDTECH') &&
        !key.includes('FINTECH') &&
        !key.includes('PROPTECH') &&
        !key.includes('MEDTECH'))
    ) {
      return {
        industry: 'SAAS',
        pods: [
          {
            name: 'Tier-1 User Access & Admin Onboarding',
            category: 'TIER_1',
            description: 'User invitations, RBAC role permissions, password resets, basic platform guidance',
            recommendedSeats: 3,
          },
          {
            name: 'Tier-2 API, Webhooks & Developer Interop',
            category: 'TIER_2',
            description: 'REST API 5xx errors, webhook retry limits, payload validation, SDK client libraries',
            recommendedSeats: 2,
          },
          {
            name: 'Tier-3 Application Bug & Engineering Escalations',
            category: 'TIER_3',
            description: 'Core platform bugs, database corruption, software regression, engineering tickets',
            recommendedSeats: 2,
          },
          {
            name: 'Enterprise Security, SAML SSO & SCIM',
            category: 'SECURITY',
            description: 'Okta/Azure AD SSO setup, SCIM directory sync, SOC2 audit logs, privacy compliance',
            recommendedSeats: 1,
          },
          {
            name: 'Subscription Invoicing, Sales Tax & Procurement',
            category: 'BILLING',
            description: 'Annual enterprise PO billing, tax receipts, credit card updates, seat licensing add-ons',
            recommendedSeats: 2,
          },
          {
            name: 'P0/P1 Downtime & SLA Escalations',
            category: 'SLA_INCIDENT',
            description: 'Critical system outage, contractual SLA breaches, executive incident notifications',
            recommendedSeats: 1,
          },
        ],
      };
    }

    // 5. HEALTHCARE, TELEMEDICINE & MEDTECH
    if (
      key.includes('HEALTH') ||
      key.includes('MEDIS') ||
      key.includes('DOKTER') ||
      key.includes('KLINIK') ||
      key.includes('RUMAH_SAKIT') ||
      key.includes('DENTAL')
    ) {
      return {
        industry: 'HEALTHCARE',
        pods: [
          {
            name: 'Urgent Triage & Clinical Escalations',
            category: 'TRIAGE',
            description: 'Emergency patient symptoms, immediate ambulance/ER hospital rerouting, urgent hotlines',
            recommendedSeats: 3,
          },
          {
            name: 'Doctor Appointments & Telehealth Video',
            category: 'APPOINTMENTS',
            description: 'Physician scheduling, video room technical glitches, doctor delay notifications',
            recommendedSeats: 2,
          },
          {
            name: 'Digital Prescriptions & Pharmacy Delivery',
            category: 'PHARMACY',
            description: 'Electronic Rx verification, partner pharmacy stockouts, sterile medicine dispatch',
            recommendedSeats: 2,
          },
          {
            name: 'Health Insurance Claims & Prior Auth',
            category: 'INSURANCE',
            description: 'Cashless insurance guarantee letters, prior authorization appeals, deductible reviews',
            recommendedSeats: 2,
          },
          {
            name: 'Electronic Health Records & Patient Privacy',
            category: 'RECORDS',
            description: 'HIPAA consent, encrypted lab test results, official doctor medical summary letters',
            recommendedSeats: 1,
          },
          {
            name: 'Chronic Care & Patient Follow-up',
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
            name: 'Tenant Emergency Maintenance & Repairs',
            category: 'MAINTENANCE',
            description: 'Burst plumbing, HVAC/heating failure, emergency lockouts, electrical hazards',
            recommendedSeats: 3,
          },
          {
            name: 'Lease Agreements, Move-in & Key Handover',
            category: 'LEASING',
            description: 'Lease renewals, move-in inspection reports, digital key codes, tenant onboarding',
            recommendedSeats: 2,
          },
          {
            name: 'Rent Collection & Security Deposit Disputes',
            category: 'RENT_DEPOSIT',
            description: 'Monthly rent payments, security deposit refund disputes, ledger accounting',
            recommendedSeats: 2,
          },
          {
            name: 'HOA Compliance, Noise & Parking Violations',
            category: 'HOA_COMPLIANCE',
            description: 'Neighbor noise complaints, pet permit violations, resident parking disputes',
            recommendedSeats: 1,
          },
          {
            name: 'Property Amenities & Building Facilities',
            category: 'AMENITIES',
            description: 'Gym/pool access codes, package locker malfunctions, elevator maintenance requests',
            recommendedSeats: 1,
          },
          {
            name: 'Landlord Relations & Vendor Work Orders',
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
            name: 'Flight Rescheduling & Airline Disruptions',
            category: 'FLIGHTS',
            description: 'Involuntary airline schedule changes, weather cancellations, name corrections, baggage',
            recommendedSeats: 3,
          },
          {
            name: 'Hotel Bookings & Property Disputes',
            category: 'HOTELS',
            description: 'Overbooked rooms upon arrival, property quality disputes, deposit returns, early check-in',
            recommendedSeats: 2,
          },
          {
            name: 'Trip Disruptions & 24/7 Emergency Assistance',
            category: 'EMERGENCY',
            description: 'Blizzard ground stops, natural disaster evacuations, lost passports abroad, emergency hotline',
            recommendedSeats: 2,
          },
          {
            name: 'Corporate Travel & MICE Group Bookings',
            category: 'CORPORATE_TRAVEL',
            description: 'Group bookings over 10 guests, corporate negotiated rates, business travel invoicing',
            recommendedSeats: 1,
          },
          {
            name: 'Rental Car & Airport Ground Transport',
            category: 'GROUND_TRANSPORT',
            description: 'Airport shuttles, rental vehicle pickup delays, toll pass billing, drop-off disputes',
            recommendedSeats: 1,
          },
          {
            name: 'Travel Insurance & Cancellation Claims',
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
            name: 'Account Security, 2FA Recovery & Stolen Items',
            category: 'ACCOUNT_SECURITY',
            description: 'Compromised gamer accounts, 2FA recovery, stolen high-value inventory items',
            recommendedSeats: 3,
          },
          {
            name: 'In-Game Purchases & Virtual Currency Refund',
            category: 'PURCHASES',
            description: 'Microtransaction payment failures, unauthorized minor purchases, battle pass claims',
            recommendedSeats: 2,
          },
          {
            name: 'Player Toxicity, Cheating & Ban Appeals',
            category: 'BAN_APPEALS',
            description: 'Anti-cheat ban appeals, voice/chat harassment reports, code of conduct enforcement',
            recommendedSeats: 2,
          },
          {
            name: 'Server Latency, Bugs & Game Client Crashes',
            category: 'TECH_BUGS',
            description: 'High ping latency, matchmaking disconnects, patch update client crashes, quest bugs',
            recommendedSeats: 2,
          },
          {
            name: 'Guilds, Clan Support & Community Events',
            category: 'COMMUNITY',
            description: 'Guild leader transfers, community tournament support, special in-game drop events',
            recommendedSeats: 1,
          },
          {
            name: 'Esports Tournaments & Anti-Cheat Disputes',
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
            name: 'Network Outage & Area Downtime Escalations',
            category: 'OUTAGE',
            description: 'Neighborhood fiber cuts, mass service outages, core network routing failures',
            recommendedSeats: 3,
          },
          {
            name: 'Field Technician On-Site Dispatch',
            category: 'FIELD_TECH',
            description: 'New line installations, technician truck roll scheduling, drop wire physical repairs',
            recommendedSeats: 2,
          },
          {
            name: 'Modem/Router Hardware & Wi-Fi Diagnostics',
            category: 'HARDWARE',
            description: 'Lightning-damaged router swaps, Wi-Fi mesh configuration, optical signal diagnostics',
            recommendedSeats: 2,
          },
          {
            name: 'Billing Invoices & Promotional Rate Expirations',
            category: 'TELECOM_BILLING',
            description: 'Post-promo bill increase disputes, equipment rental charges, service cancellation fees',
            recommendedSeats: 2,
          },
          {
            name: 'SIM Card, eSIM & Mobile Number Porting',
            category: 'MOBILE_PORTING',
            description: 'Carrier number porting requests, eSIM activation QR issues, roaming data blocks',
            recommendedSeats: 1,
          },
          {
            name: 'Enterprise Dedicated Fiber & SLA Leased Lines',
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
            name: 'Roadside Assistance & Emergency Towing',
            category: 'ROADSIDE',
            description: 'Flat tire dispatch, dead battery jumpstarts, highway towing, emergency vehicle lockout',
            recommendedSeats: 3,
          },
          {
            name: 'EV Charging Station & App Billing Issues',
            category: 'EV_CHARGING',
            description: 'Charging station connector failures, session billing errors, RFID card authentication',
            recommendedSeats: 2,
          },
          {
            name: 'Vehicle Warranty, Recall & Maintenance Booking',
            category: 'WARRANTY',
            description: 'Factory safety recalls, powertrain warranty claims, scheduled dealership services',
            recommendedSeats: 2,
          },
          {
            name: 'Car Rental Bookings, Toll Charges & Damage Claims',
            category: 'RENTAL_CLAIMS',
            description: 'Electronic toll tag disputes, post-trip damage claims, vehicle security deposit returns',
            recommendedSeats: 2,
          },
          {
            name: 'Fleet Telematics & Commercial Vehicle Logistics',
            category: 'FLEET',
            description: 'Commercial fleet ELD compliance, telematics GPS tracking errors, driver safety scorecards',
            recommendedSeats: 1,
          },
          {
            name: 'Auto Insurance Claims & Accident Reports',
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
            name: 'Tax Filing Deadlines & IRS Document Collection',
            category: 'TAX_FILING',
            description: 'W-2 / 1099 tax document intake, IRS deadline tracking, extension request filings',
            recommendedSeats: 3,
          },
          {
            name: 'Client Retainer Onboarding & Scope Agreements',
            category: 'RETAINER_ENGAGEMENT',
            description: 'Engagement letters, client retainer agreements, scope of work clarifications',
            recommendedSeats: 2,
          },
          {
            name: 'Attorney & Consultant Consultation Scheduling',
            category: 'CONSULTATION',
            description: 'Partner attorney appointments, expert witness bookings, confidential prep sessions',
            recommendedSeats: 2,
          },
          {
            name: 'Secure Document Vault & Compliance Audit',
            category: 'DOCUMENT_VAULT',
            description: 'Encrypted document delivery, client privilege compliance, financial audit workpapers',
            recommendedSeats: 2,
          },
          {
            name: 'Billing Invoices, Trust Accounting & Retainers',
            category: 'IOLTA_BILLING',
            description: 'IOLTA trust account accounting, hourly legal invoices, credit card retainer refills',
            recommendedSeats: 1,
          },
          {
            name: 'Corporate Entity Formation & Legal Filings',
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
      key.includes('LEARNING') ||
      key.includes('AKADEMI') ||
      key.includes('BOOTCAMP') ||
      key.includes('BIMBEL')
    ) {
      return {
        industry: 'EDTECH',
        pods: [
          {
            name: 'LMS Platform & Virtual Classroom',
            category: 'LMS',
            description: 'Live webinar stream buffering, Safe Exam Browser issues, assignment upload errors',
            recommendedSeats: 3,
          },
          {
            name: 'Tuition Payments, Financial Aid & Billing',
            category: 'TUITION',
            description: 'Tuition installment plans, scholarship disbursements, financial graduation clearances',
            recommendedSeats: 2,
          },
          {
            name: 'Academic Advising & Tutor Support',
            category: 'TUTORING',
            description: 'Curriculum pathway planning, 1-on-1 mentor appointments, thesis advisor escalations',
            recommendedSeats: 2,
          },
          {
            name: 'Student Certification & Degree Verification',
            category: 'CREDENTIALS',
            description: 'Digital degree verification, course completion certificates, transcript requests',
            recommendedSeats: 2,
          },
          {
            name: 'Admissions, Placement & Enrollment Counseling',
            category: 'ADMISSIONS',
            description: 'Application intake, placement test technical support, international student I-20 queries',
            recommendedSeats: 1,
          },
          {
            name: 'Exam Integrity & Proctoring Support',
            category: 'PROCTORING',
            description: 'Remote webcam proctoring lockouts, room scan verification, identity match appeals',
            recommendedSeats: 1,
          },
        ],
        defaultServices: [
          'LMS Platform & Virtual Classrooms',
          'Tuition Payments, Aid & Billing',
          'Academic Advising & Tutor Support',
          'Certification & Degree Verification',
          'Admissions, Placement & Counseling',
          'Exam Integrity & Proctoring Support',
        ],
      };
    }

    // 13. CUSTOM / GENERAL (OTHER)
    const cleanCustom = (customDescription || '').trim();
    const customLabel = cleanCustom
      ? ` (${cleanCustom.slice(0, 20).trim()})`
      : '';
    const otherPods = [
      {
        name: cleanCustom ? `${cleanCustom.slice(0, 32).trim()} Operations Pod` : 'Frontline Customer Operations Pod',
        category: 'OPERATIONS',
        description: cleanCustom
          ? `Dedicated operational intake and frontline servicing for ${cleanCustom}`
          : 'Frontline customer orders, general inquiries, immediate ticket intake',
        recommendedSeats: 3,
        service: cleanCustom ? `${cleanCustom.slice(0, 36).trim()} Operations` : 'Frontline Operations & Ticket Triage',
      },
      {
        name: 'Billing, Invoicing & Payment Verification',
        category: 'BILLING',
        description: 'Payment verification, invoice receipts, bank wire reconciliation, refunds',
        recommendedSeats: 2,
        service: 'Billing, Invoicing & Payment Verification',
      },
      {
        name: 'Product Quality & Replacement Warranty',
        category: 'QUALITY',
        description: 'Product defects, replacement unit dispatches, warranty service requests',
        recommendedSeats: 2,
        service: 'Product Quality & Replacement Warranty',
      },
      {
        name: 'Technical & Application Support',
        category: 'TECH_SUPPORT',
        description: 'Software login issues, hardware diagnostics, account settings troubleshooting',
        recommendedSeats: 2,
        service: 'Technical & Application Support',
      },
      {
        name: 'Account Security & Profile Management',
        category: 'SECURITY',
        description: 'Password resets, 2FA authorization, profile data updates, access permissions',
        recommendedSeats: 1,
        service: 'Account Security & Profile Management',
      },
      {
        name: 'Executive & High-Priority SLA Escalations',
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
