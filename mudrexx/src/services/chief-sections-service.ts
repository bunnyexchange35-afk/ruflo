import type { Container } from '../container';
import { AiService } from './ai/orchestrator';

/**
 * §23 CHIEF CONTROL PORTAL — two-part structure.
 *
 * The Chief Control Portal is divided into two clearly separated parts, so the
 * Super Admin always knows which system they are looking at:
 *
 *   MUDREXX — the business platform: identities, admins, payments, packages
 *             and the CRM (contacts, leads, tasks, campaigns, messaging).
 *
 *   RUFLO   — the AI / agent orchestration layer: LLM providers, AI
 *             conversations, the skill catalogue, agent tool calls awaiting
 *             approval (§30) and token/cost usage.
 *
 * Every number below is a COUNT read from a real table. Nothing here is
 * estimated, sampled or fabricated (§1), and no provider key is ever returned —
 * providers are reported as name + configured boolean only (§45).
 */

export const CHIEF_SECTION_IDS = ['ruflo', 'mudrexx'] as const;
export type ChiefSectionId = (typeof CHIEF_SECTION_IDS)[number];

export interface ChiefSectionInfo {
  id: ChiefSectionId;
  name: string;
  description: string;
  /** Chief routes that belong to this part of the portal. */
  routes: string[];
}

export const CHIEF_SECTIONS: Record<ChiefSectionId, ChiefSectionInfo> = {
  ruflo: {
    id: 'ruflo',
    name: 'RUFLO',
    description: 'AI and agent orchestration: LLM providers, conversations, skills, agent tool approvals and usage.',
    routes: ['/api/chief/sections/ruflo', '/api/chief/ai/providers'],
  },
  mudrexx: {
    id: 'mudrexx',
    name: 'MUDREXX',
    description: 'Business platform: admins, users, payments, packages, security and the CRM.',
    routes: [
      '/api/chief/sections/mudrexx',
      '/api/chief/admins',
      '/api/chief/users',
      '/api/chief/payments',
      '/api/chief/packages',
      '/api/chief/security/sessions',
    ],
  },
};

export class ChiefSectionsService {
  constructor(private readonly c: Container) {}

  /** The two parts of the Chief Control Portal, without loading any metrics. */
  list(): ChiefSectionInfo[] {
    return CHIEF_SECTION_IDS.map((id) => CHIEF_SECTIONS[id]);
  }

  /**
   * MUDREXX part — the business platform.
   * Counts come straight from the CRM/commercial tables.
   */
  async mudrexx() {
    const [users, admins, payments, activeSessions, contacts, leads, tasks, campaigns, waMessages] =
      await Promise.all([
        this.c.db.count(`SELECT COUNT(*) AS c FROM users WHERE role = 'USER'`),
        this.c.db.count(`SELECT COUNT(*) AS c FROM users WHERE role = 'ADMIN'`),
        this.c.db.count(`SELECT COUNT(*) AS c FROM payments`),
        this.c.sessions.countActive(),
        this.c.db.count(`SELECT COUNT(*) AS c FROM crm_contacts`),
        this.c.db.count(`SELECT COUNT(*) AS c FROM leads`),
        this.c.db.count(`SELECT COUNT(*) AS c FROM tasks`),
        this.c.db.count(`SELECT COUNT(*) AS c FROM whatsapp_campaigns`),
        this.c.db.count(`SELECT COUNT(*) AS c FROM whatsapp_messages`),
      ]);

    // Admin approval is tracked by `approval_status` (the Chief's approve
    // endpoint sets it to APPROVED), not by the generic account `status`.
    const pendingAdmins = await this.c.db.count(
      `SELECT COUNT(*) AS c FROM users WHERE role = 'ADMIN' AND approval_status = 'PENDING'`,
    );
    const pendingPayments = await this.c.db.count(
      `SELECT COUNT(*) AS c FROM payments WHERE status = 'SUBMITTED'`,
    );

    return {
      ...CHIEF_SECTIONS.mudrexx,
      counts: {
        users,
        admins,
        activeSessions,
        payments,
        contacts,
        leads,
        tasks,
        campaigns,
        whatsappMessages: waMessages,
      },
      pending: {
        adminApprovals: pendingAdmins,
        paymentVerifications: pendingPayments,
      },
    };
  }

  /**
   * RUFLO part — the AI / agent orchestration layer.
   * `providers` reports presence only; an API key is never returned (§45).
   */
  async ruflo() {
    const ai = new AiService(this.c);
    const providers = ai.providerStatus();

    const [conversations, messages, skills, activeSkills, toolCalls] = await Promise.all([
      this.c.db.count(`SELECT COUNT(*) AS c FROM ai_conversations`),
      this.c.db.count(`SELECT COUNT(*) AS c FROM ai_messages`),
      this.c.db.count(`SELECT COUNT(*) AS c FROM ai_skills`),
      this.c.db.count(`SELECT COUNT(*) AS c FROM ai_skills WHERE is_active = 1`),
      this.c.db.count(`SELECT COUNT(*) AS c FROM ai_tool_calls`),
    ]);

    const pendingApprovals = await this.c.db.count(
      `SELECT COUNT(*) AS c FROM ai_tool_calls WHERE status = 'PROPOSED'`,
    );

    // Platform-wide token/cost totals. COALESCE keeps an empty table at 0
    // rather than null, so the section never reports a fake or missing value.
    const usage = (await this.c.db.one<{
      tokens_in: number;
      tokens_out: number;
      cost_micros: number;
      calls: number;
    }>(
      `SELECT COALESCE(SUM(tokens_in), 0)   AS tokens_in,
              COALESCE(SUM(tokens_out), 0)  AS tokens_out,
              COALESCE(SUM(cost_micros), 0) AS cost_micros,
              COUNT(*)                      AS calls
         FROM ai_usage`,
    )) ?? { tokens_in: 0, tokens_out: 0, cost_micros: 0, calls: 0 };

    return {
      ...CHIEF_SECTIONS.ruflo,
      providers,
      counts: {
        providersConfigured: providers.filter((p) => p.configured).length,
        conversations,
        messages,
        skills,
        activeSkills,
        toolCalls,
      },
      pending: {
        toolApprovals: pendingApprovals,
      },
      usage: {
        calls: usage.calls,
        tokensIn: usage.tokens_in,
        tokensOut: usage.tokens_out,
        costMicros: usage.cost_micros,
      },
    };
  }

  /** Both parts, for the Chief dashboard. */
  async overview() {
    const [ruflo, mudrexx] = await Promise.all([this.ruflo(), this.mudrexx()]);
    return { ruflo, mudrexx };
  }
}
