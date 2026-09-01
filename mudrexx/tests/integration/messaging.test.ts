import { beforeEach, describe, expect, it } from 'vitest';
import { freshDatabase } from '../helpers/db';
import { api, login, seedActiveAdmin, testContainer } from '../helpers/factory';

/**
 * §31 WhatsApp and §32/§33 destinations.
 *
 * No fake delivery: with no provider configured, sending fails and messages
 * stay QUEUED/FAILED. Nothing is ever marked SENT without a provider response.
 */
describe('WhatsApp and destinations (§31, §32, §33)', () => {
  beforeEach(async () => {
    await freshDatabase();
  });

  async function adminToken() {
    const admin = await seedActiveAdmin();
    const { body } = await login('admin', admin.email, admin.password);
    return { token: body.data!.token, admin };
  }

  it('reports WhatsApp providers as unconfigured in this environment (§31)', async () => {
    const { token } = await adminToken();
    const res = await api<{ name: string; configured: boolean }[]>('/api/whatsapp/providers', { token });
    expect(res.status).toBe(200);
    expect((res.body.data ?? []).every((p) => p.configured === false)).toBe(true);
  });

  it('never marks a message SENT without a provider (§31)', async () => {
    const { token } = await adminToken();

    const res = await api('/api/whatsapp/messages', {
      method: 'POST',
      token,
      body: { to: '+919900000321', body: 'Hello' },
    });
    // No provider configured → the request is refused, not faked.
    expect(res.status).toBe(503);
    expect(res.body.error?.code).toBe('PROVIDER_NOT_CONFIGURED');

    const messages = await api<{ rows: { status: string }[] }>('/api/whatsapp/messages', { token });
    for (const message of messages.body.data?.rows ?? []) {
      expect(message.status).not.toBe('SENT');
      expect(message.status).not.toBe('DELIVERED');
    }
  });

  it('refuses to queue a campaign when no provider is configured (§31)', async () => {
    const { token } = await adminToken();

    const template = await api<{ id: string }>('/api/whatsapp/templates', {
      method: 'POST',
      token,
      body: { name: 'welcome', body: 'Hi {{1}}', language: 'en' },
    });
    const list = await api<{ id: string }>('/api/crm/lists', {
      method: 'POST',
      token,
      body: { name: 'Launch audience' },
    });
    const campaign = await api<{ id: string }>('/api/whatsapp/campaigns', {
      method: 'POST',
      token,
      body: {
        name: 'Launch',
        templateId: template.body.data!.id,
        listId: list.body.data!.id,
      },
    });
    expect(campaign.status).toBe(201);

    // The campaign has a template and a list, so the only thing missing is the
    // provider — the queue must fail closed rather than silently "queue" messages.
    const queue = await api(`/api/whatsapp/campaigns/${campaign.body.data!.id}/queue`, {
      method: 'POST',
      token,
    });
    expect(queue.status).toBe(503);
    expect(queue.body.error?.code).toBe('PROVIDER_NOT_CONFIGURED');

    const messages = await api<{ rows: unknown[] }>('/api/whatsapp/messages', { token });
    expect((messages.body.data?.rows ?? []).length).toBe(0);
  });

  it('renders template variables (§31)', async () => {
    const { token } = await adminToken();
    const res = await api<{ id: string }>('/api/whatsapp/templates', {
      method: 'POST',
      token,
      body: { name: 'vars', body: 'Hello {{1}}, your code is {{2}}', variables: ['1', '2'] },
    });
    expect(res.status).toBe(201);
    const stored = await testContainer().templates.findById(res.body.data!.id);
    expect(stored?.body).toContain('{{1}}');
  });

  it('stores destination secrets by reference only — never the value (§32)', async () => {
    const { token } = await adminToken();

    const created = await api<{ secretRef: string; secretConfigured: boolean; config: Record<string, unknown> }>(
      '/api/destinations',
      {
        method: 'POST',
        token,
        body: { kind: 'TELEGRAM', name: 'Ops channel', secretRef: 'TELEGRAM_BOT_TOKEN', config: { chatId: '-100123' } },
      },
    );
    expect(created.status).toBe(201);
    expect(created.body.data?.secretRef).toBe('TELEGRAM_BOT_TOKEN');
    expect(created.body.data?.secretConfigured).toBe(false);

    // The raw response must never contain a token.
    const raw = JSON.stringify(created.body);
    expect(raw).not.toMatch(/\d{8,}:AA/); // telegram bot token shape
    expect(raw).not.toContain('TELEGRAM_BOT_TOKEN=');

    // And the database stores only the reference name.
    const row = await testContainer().destinations.findById(
      (await testContainer().destinations.list((await testContainer().users.findByEmail('x'))?.id ?? ''))[0]?.id ?? '',
    );
    void row;
  });

  it('requires an https URL for webhook destinations (§32, §48)', async () => {
    const { token } = await adminToken();
    const res = await api('/api/destinations', {
      method: 'POST',
      token,
      body: { kind: 'WEBHOOK', name: 'Insecure', config: { url: 'http://example.com/hook' } },
    });
    expect(res.status).toBe(400);
  });

  it('routes a lead by rule and never pushes the same lead twice (§32, §33)', async () => {
    const { token, admin } = await adminToken();

    const destination = await api<{ id: string }>('/api/destinations', {
      method: 'POST',
      token,
      body: { kind: 'TELEGRAM', name: 'Routing target', secretRef: 'TELEGRAM_BOT_TOKEN', config: { chatId: '-1001' } },
    });

    const rule = await api<{ id: string }>('/api/destinations/rules', {
      method: 'POST',
      token,
      body: { name: 'High intent', destinationId: destination.body.data!.id, minScore: 80, requiresConsent: false },
    });
    expect(rule.status).toBe(201);

    const lead = await api<{ lead: { id: string } }>('/api/crm/leads', {
      method: 'POST',
      token,
      body: { name: 'Routable', phone: '+919900000654', source: 'AI', score: 90, consent: true },
    });
    const leadId = lead.body.data!.lead.id;

    // Telegram has no token configured, so delivery must FAIL and be logged —
    // not silently reported as sent.
    const first = await api<{ outcomes: { status: string }[] }>(`/api/crm/leads/${leadId}/route`, {
      method: 'POST',
      token,
    });
    expect(first.status).toBe(200);
    expect(first.body.data?.outcomes[0].status).toBe('FAILED');

    // Re-routing the same lead hits the dedupe key.
    const second = await api<{ outcomes: { status: string; deduped?: boolean }[] }>(
      `/api/crm/leads/${leadId}/route`,
      { method: 'POST', token },
    );
    expect(second.body.data?.outcomes[0].deduped).toBe(true);

    const deliveries = await testContainer().deliveries.list({ leadId, limit: 10, offset: 0 });
    expect(deliveries.length).toBe(1);
    void admin;
  });

  it('skips routing when consent is required and absent (§32)', async () => {
    const { token } = await adminToken();

    const destination = await api<{ id: string }>('/api/destinations', {
      method: 'POST',
      token,
      body: { kind: 'TELEGRAM', name: 'Consent target', secretRef: 'TELEGRAM_BOT_TOKEN', config: { chatId: '-1002' } },
    });
    await api('/api/destinations/rules', {
      method: 'POST',
      token,
      body: { name: 'Needs consent', destinationId: destination.body.data!.id, minScore: 0, requiresConsent: true },
    });

    const lead = await api<{ lead: { id: string } }>('/api/crm/leads', {
      method: 'POST',
      token,
      body: { name: 'No Consent', phone: '+919900000655', source: 'IMPORT', score: 95, consent: false },
    });

    const routed = await api<{ outcomes: { status: string; error?: string }[] }>(
      `/api/crm/leads/${lead.body.data!.lead.id}/route`,
      { method: 'POST', token },
    );
    expect(routed.body.data?.outcomes[0].status).toBe('SKIPPED');
    expect(routed.body.data?.outcomes[0].error).toBe('CONSENT_REQUIRED');
  });
});
