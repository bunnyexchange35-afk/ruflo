import type { Env } from '../../types';
import { AppError } from '../../http/errors';

/**
 * §31 WhatsApp provider layer.
 *
 * Delivery is only ever reported as sent when a provider actually accepts the
 * message and returns an id. When no provider is configured the call fails with
 * PROVIDER_NOT_CONFIGURED — it never pretends to deliver.
 */

export interface SendTextInput {
  to: string;
  body: string;
}

export interface SendResult {
  status: 'SENT' | 'FAILED';
  provider: string;
  providerMessageId?: string;
  error?: string;
}

export interface WhatsAppProvider {
  readonly name: string;
  isConfigured(env: Env): boolean;
  sendText(input: SendTextInput, env: Env): Promise<SendResult>;
}

class MetaCloudProvider implements WhatsAppProvider {
  readonly name = 'meta_cloud_api';

  isConfigured(env: Env): boolean {
    return Boolean(env.WHATSAPP_ACCESS_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID);
  }

  async sendText(input: SendTextInput, env: Env): Promise<SendResult> {
    if (!this.isConfigured(env)) throw this.notConfigured();
    const version = env.WHATSAPP_API_VERSION || 'v21.0';
    const res = await fetch(
      `https://graph.facebook.com/${version}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: input.to,
          type: 'text',
          text: { preview_url: false, body: input.body },
        }),
      },
    );
    const json = (await res.json().catch(() => ({}))) as {
      messages?: { id?: string }[];
      error?: { message?: string };
    };
    if (!res.ok) {
      return {
        status: 'FAILED',
        provider: this.name,
        error: json.error?.message ?? `HTTP ${res.status}`,
      };
    }
    return {
      status: 'SENT',
      provider: this.name,
      providerMessageId: json.messages?.[0]?.id,
    };
  }

  private notConfigured(): AppError {
    return new AppError(
      'PROVIDER_NOT_CONFIGURED',
      'WhatsApp is not configured. Set WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID as Worker secrets.',
      { provider: this.name },
    );
  }
}

class TwilioProvider implements WhatsAppProvider {
  readonly name = 'twilio';

  isConfigured(env: Env): boolean {
    return Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_WHATSAPP_FROM);
  }

  async sendText(input: SendTextInput, env: Env): Promise<SendResult> {
    if (!this.isConfigured(env)) throw this.notConfigured();
    const url = `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`;
    const body = new URLSearchParams({
      To: `whatsapp:${input.to}`,
      From: `whatsapp:${env.TWILIO_WHATSAPP_FROM}`,
      Body: input.body,
    });
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Basic ${btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`)}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body,
    });
    const json = (await res.json().catch(() => ({}))) as { sid?: string; message?: string };
    if (!res.ok) {
      return { status: 'FAILED', provider: this.name, error: json.message ?? `HTTP ${res.status}` };
    }
    return { status: 'SENT', provider: this.name, providerMessageId: json.sid };
  }

  private notConfigured(): AppError {
    return new AppError(
      'PROVIDER_NOT_CONFIGURED',
      'WhatsApp (Twilio) is not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_WHATSAPP_FROM as Worker secrets.',
      { provider: this.name },
    );
  }
}

export const WHATSAPP_PROVIDERS: Record<string, WhatsAppProvider> = {
  meta_cloud_api: new MetaCloudProvider(),
  twilio: new TwilioProvider(),
};

export function resolveWhatsAppProvider(env: Env): WhatsAppProvider {
  const configured = env.WHATSAPP_PROVIDER?.trim();
  if (configured) {
    const provider = WHATSAPP_PROVIDERS[configured];
    if (!provider) {
      throw new AppError('PROVIDER_NOT_CONFIGURED', `Unknown WhatsApp provider "${configured}".`, {
        provider: configured,
      });
    }
    return provider;
  }
  for (const provider of Object.values(WHATSAPP_PROVIDERS)) {
    if (provider.isConfigured(env)) return provider;
  }
  throw new AppError(
    'PROVIDER_NOT_CONFIGURED',
    'No WhatsApp provider is configured. Set the provider credentials as Worker secrets.',
    {},
  );
}

export function whatsAppStatus(env: Env) {
  return Object.values(WHATSAPP_PROVIDERS).map((p) => ({
    name: p.name,
    configured: p.isConfigured(env),
  }));
}
