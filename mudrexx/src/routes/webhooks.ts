import { Hono } from 'hono';
import type { AppEnv } from '../app-types';
import { AppError, ok } from '../http/errors';
import { rateLimit } from '../middleware/rate-limit';
import { RATE_LIMITS } from '../config';
import { WhatsAppService } from '../services/whatsapp/service';

/**
 * /api/webhooks/* — inbound provider callbacks.
 *
 * Payloads are recorded and, when a signing secret is configured, verified
 * before they are trusted. Status transitions are applied only from a real
 * provider event.
 */
export const webhooks = new Hono<AppEnv>();

webhooks.use('*', rateLimit({ bucket: 'webhook', ...RATE_LIMITS.WEBHOOK }));

/** Meta Cloud API verification handshake. */
webhooks.get('/whatsapp', async (c) => {
  const mode = c.req.query('hub.mode');
  const token = c.req.query('hub.verify_token');
  const challenge = c.req.query('hub.challenge');

  const expected = c.env.WHATSAPP_WEBHOOK_SECRET;
  if (mode === 'subscribe' && expected && token === expected && challenge) {
    return new Response(challenge, { status: 200 });
  }
  throw new AppError('UNAUTHORIZED', 'Webhook verification failed.');
});

webhooks.post('/whatsapp', async (c) => {
  const container = c.get('container');
  const secret = c.env.WHATSAPP_WEBHOOK_SECRET;
  const raw = await c.req.text();

  let signatureOk = false;
  if (secret) {
    const header = c.req.header('x-hub-signature-256') ?? '';
    const expected = `sha256=${await hmacHex(secret, raw)}`;
    signatureOk = header.length > 0 && timingSafeEqualStrings(header, expected);
    if (!signatureOk) {
      await container.webhookEvents.record({
        provider: 'whatsapp',
        eventType: 'signature_failed',
        payload: { bytes: raw.length },
        signatureOk: false,
      });
      throw new AppError('UNAUTHORIZED', 'Webhook signature verification failed.');
    }
  } else {
    // Without a signing secret the event is recorded but not trusted.
    signatureOk = false;
  }

  let payload: unknown = {};
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new AppError('VALIDATION_ERROR', 'Malformed webhook payload.');
  }

  const eventId = await container.webhookEvents.record({
    provider: 'whatsapp',
    eventType: 'status',
    payload,
    signatureOk,
  });

  const service = new WhatsAppService(container);
  const applied = await applyStatuses(payload, service);

  await container.webhookEvents.markProcessed(eventId);
  return ok(c, { received: true, verified: signatureOk, applied });
});

interface MetaStatusPayload {
  entry?: {
    changes?: {
      value?: {
        statuses?: { id?: string; status?: string; errors?: { message?: string }[] }[];
      };
    }[];
  }[];
}

async function applyStatuses(payload: unknown, service: WhatsAppService): Promise<number> {
  const body = payload as MetaStatusPayload;
  const statuses = body.entry?.[0]?.changes?.[0]?.value?.statuses ?? [];
  let applied = 0;

  for (const status of statuses) {
    if (!status.id) continue;
    const mapped = mapStatus(status.status ?? '');
    if (!mapped) continue;
    await service.applyStatusUpdate(
      status.id,
      mapped,
      status.errors?.[0]?.message,
    );
    applied += 1;
  }
  return applied;
}

function mapStatus(status: string) {
  switch (status) {
    case 'sent':
      return 'SENT' as const;
    case 'delivered':
      return 'DELIVERED' as const;
    case 'read':
      return 'READ' as const;
    case 'failed':
      return 'FAILED' as const;
    case 'rejected':
      return 'REJECTED' as const;
    default:
      return null;
  }
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqualStrings(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
