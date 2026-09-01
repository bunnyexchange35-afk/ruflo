import type { Env } from '../../types';
import { AppError } from '../../http/errors';

/**
 * §27 LLM provider layer.
 *
 * Real providers only. If a provider has no server-side key it is reported as
 * NOT CONFIGURED and the call fails — the platform never fabricates a response
 * and never falls back to canned text.
 */

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
}

export interface LlmToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LlmChatRequest {
  messages: LlmMessage[];
  model?: string;
  maxTokens?: number;
  temperature?: number;
  tools?: LlmToolSpec[];
}

export interface LlmToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface LlmChatResponse {
  content: string;
  provider: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  toolCalls: LlmToolCall[];
}

export interface LlmStreamChunk {
  delta: string;
  done: boolean;
  provider?: string;
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
}

export interface LlmProvider {
  readonly name: string;
  isConfigured(env: Env): boolean;
  chat(req: LlmChatRequest, env: Env): Promise<LlmChatResponse>;
  stream(req: LlmChatRequest, env: Env): AsyncGenerator<LlmStreamChunk>;
}

/* --------------------------- shared helpers ---------------------------- */

function parseJsonSseLine(line: string): unknown | null {
  if (!line.startsWith('data:')) return null;
  const payload = line.slice(5).trim();
  if (!payload || payload === '[DONE]') return null;
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

function extractToolCallsFromText(text: string): LlmToolCall[] {
  // Fallback protocol for models without native function calling:
  // ```tool\n{"tool":"search_leads","args":{...}}\n```
  const matches = text.matchAll(/```tool\s*(\{[\s\S]*?\})\s*```/g);
  const calls: LlmToolCall[] = [];
  let i = 0;
  for (const m of matches) {
    try {
      const parsed = JSON.parse(m[1]) as { tool?: string; args?: Record<string, unknown> };
      if (parsed.tool) {
        calls.push({ id: `call_${i++}`, name: parsed.tool, args: parsed.args ?? {} });
      }
    } catch {
      /* ignore malformed tool blocks */
    }
  }
  return calls;
}

/* ------------------------------ OpenAI -------------------------------- */

class OpenAICompatibleProvider implements LlmProvider {
  constructor(
    readonly name: string,
    private readonly opts: {
      baseUrl: (env: Env) => string;
      apiKey: (env: Env) => string | undefined;
      defaultModel: (env: Env) => string;
    },
  ) {}

  isConfigured(env: Env): boolean {
    return Boolean(this.opts.apiKey(env));
  }

  private headers(env: Env): Record<string, string> {
    return {
      'content-type': 'application/json',
      authorization: `Bearer ${this.opts.apiKey(env)}`,
    };
  }

  async chat(req: LlmChatRequest, env: Env): Promise<LlmChatResponse> {
    if (!this.isConfigured(env)) throw this.notConfigured();
    const model = req.model || this.opts.defaultModel(env);
    const body: Record<string, unknown> = {
      model,
      messages: req.messages,
      max_tokens: req.maxTokens ?? 1024,
      temperature: req.temperature ?? 0.2,
    };
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    }

    const res = await fetch(`${this.opts.baseUrl(env)}/chat/completions`, {
      method: 'POST',
      headers: this.headers(env),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new AppError('PROVIDER_ERROR', `${this.name} returned ${res.status}`, {
        provider: this.name,
        status: res.status,
      });
    }
    const json = (await res.json()) as {
      choices?: {
        message?: {
          content?: string | null;
          tool_calls?: { id: string; function: { name: string; arguments: string } }[];
        };
      }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const choice = json.choices?.[0];
    const toolCalls: LlmToolCall[] = (choice?.message?.tool_calls ?? []).map((tc) => {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.function.arguments || '{}');
      } catch {
        args = {};
      }
      return { id: tc.id, name: tc.function.name, args };
    });
    const content = choice?.message?.content ?? '';
    return {
      content,
      provider: this.name,
      model,
      tokensIn: json.usage?.prompt_tokens ?? 0,
      tokensOut: json.usage?.completion_tokens ?? 0,
      toolCalls: toolCalls.length ? toolCalls : extractToolCallsFromText(content),
    };
  }

  async *stream(req: LlmChatRequest, env: Env): AsyncGenerator<LlmStreamChunk> {
    if (!this.isConfigured(env)) throw this.notConfigured();
    const model = req.model || this.opts.defaultModel(env);
    const res = await fetch(`${this.opts.baseUrl(env)}/chat/completions`, {
      method: 'POST',
      headers: this.headers(env),
      body: JSON.stringify({
        model,
        messages: req.messages,
        max_tokens: req.maxTokens ?? 1024,
        temperature: req.temperature ?? 0.2,
        stream: true,
      }),
    });
    if (!res.ok || !res.body) {
      throw new AppError('PROVIDER_ERROR', `${this.name} stream failed with ${res.status}`, {
        provider: this.name,
        status: res.status,
      });
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let tokensIn = 0;
    let tokensOut = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const json = parseJsonSseLine(line) as
          | { choices?: { delta?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } }
          | null;
        if (!json) continue;
        if (json.usage) {
          tokensIn = json.usage.prompt_tokens ?? tokensIn;
          tokensOut = json.usage.completion_tokens ?? tokensOut;
        }
        const delta = json.choices?.[0]?.delta?.content ?? '';
        if (delta) yield { delta, done: false, provider: this.name, model };
      }
    }
    yield { delta: '', done: true, provider: this.name, model, tokensIn, tokensOut };
  }

  private notConfigured(): AppError {
    return new AppError(
      'PROVIDER_NOT_CONFIGURED',
      `LLM provider "${this.name}" is not configured. Set the provider API key as a Worker secret.`,
      { provider: this.name },
    );
  }
}

/* ------------------------------ Anthropic ------------------------------ */

class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic';

  isConfigured(env: Env): boolean {
    return Boolean(env.ANTHROPIC_API_KEY);
  }

  async chat(req: LlmChatRequest, env: Env): Promise<LlmChatResponse> {
    if (!this.isConfigured(env)) throw this.notConfigured();
    const model = req.model || env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';
    const system = req.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');
    const messages = req.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role, content: m.content }));

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY as string,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        system: system || undefined,
        messages,
        max_tokens: req.maxTokens ?? 1024,
      }),
    });
    if (!res.ok) {
      throw new AppError('PROVIDER_ERROR', `anthropic returned ${res.status}`, { status: res.status });
    }
    const json = (await res.json()) as {
      content?: { type: string; text?: string }[];
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const content = (json.content ?? [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('');
    return {
      content,
      provider: this.name,
      model,
      tokensIn: json.usage?.input_tokens ?? 0,
      tokensOut: json.usage?.output_tokens ?? 0,
      toolCalls: extractToolCallsFromText(content),
    };
  }

  async *stream(req: LlmChatRequest, env: Env): AsyncGenerator<LlmStreamChunk> {
    if (!this.isConfigured(env)) throw this.notConfigured();
    const model = req.model || env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';
    const system = req.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');
    const messages = req.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role, content: m.content }));

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY as string,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ model, system: system || undefined, messages, max_tokens: req.maxTokens ?? 1024, stream: true }),
    });
    if (!res.ok || !res.body) {
      throw new AppError('PROVIDER_ERROR', `anthropic stream failed with ${res.status}`, { status: res.status });
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const json = parseJsonSseLine(line) as
          | { type?: string; delta?: { type?: string; text?: string } }
          | null;
        if (!json) continue;
        if (json.type === 'content_block_delta' && json.delta?.type === 'text_delta') {
          yield { delta: json.delta.text ?? '', done: false, provider: this.name, model };
        }
      }
    }
    yield { delta: '', done: true, provider: this.name, model };
  }

  private notConfigured(): AppError {
    return new AppError(
      'PROVIDER_NOT_CONFIGURED',
      'LLM provider "anthropic" is not configured. Set ANTHROPIC_API_KEY as a Worker secret.',
      { provider: this.name },
    );
  }
}

/* ------------------------------- Google -------------------------------- */

class GoogleProvider implements LlmProvider {
  readonly name = 'google';

  isConfigured(env: Env): boolean {
    return Boolean(env.GOOGLE_API_KEY);
  }

  async chat(req: LlmChatRequest, env: Env): Promise<LlmChatResponse> {
    if (!this.isConfigured(env)) throw this.notConfigured();
    const model = req.model || env.GOOGLE_MODEL || 'gemini-2.0-flash';
    const contents = req.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }));
    const systemInstruction = req.messages.find((m) => m.role === 'system')?.content;

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GOOGLE_API_KEY}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          contents,
          systemInstruction: systemInstruction ? { parts: [{ text: systemInstruction }] } : undefined,
        }),
      },
    );
    if (!res.ok) throw new AppError('PROVIDER_ERROR', `google returned ${res.status}`, { status: res.status });
    const json = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    };
    const content = (json.candidates?.[0]?.content?.parts ?? [])
      .map((p) => p.text ?? '')
      .join('');
    return {
      content,
      provider: this.name,
      model,
      tokensIn: json.usageMetadata?.promptTokenCount ?? 0,
      tokensOut: json.usageMetadata?.candidatesTokenCount ?? 0,
      toolCalls: extractToolCallsFromText(content),
    };
  }

  async *stream(req: LlmChatRequest, env: Env): AsyncGenerator<LlmStreamChunk> {
    const result = await this.chat(req, env);
    yield { delta: result.content, done: false, provider: this.name, model: result.model };
    yield {
      delta: '',
      done: true,
      provider: this.name,
      model: result.model,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
    };
  }

  private notConfigured(): AppError {
    return new AppError(
      'PROVIDER_NOT_CONFIGURED',
      'LLM provider "google" is not configured. Set GOOGLE_API_KEY as a Worker secret.',
      { provider: this.name },
    );
  }
}

/* ------------------------------ Providers ------------------------------ */

export const PROVIDERS: Record<string, LlmProvider> = {
  openai: new OpenAICompatibleProvider('openai', {
    baseUrl: (env) => env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    apiKey: (env) => env.OPENAI_API_KEY,
    defaultModel: (env) => env.OPENAI_MODEL || 'gpt-4o-mini',
  }),
  openrouter: new OpenAICompatibleProvider('openrouter', {
    baseUrl: () => 'https://openrouter.ai/api/v1',
    apiKey: (env) => env.OPENROUTER_API_KEY,
    defaultModel: (env) => env.OPENROUTER_MODEL || 'openai/gpt-4o-mini',
  }),
  ollama: new OpenAICompatibleProvider('ollama', {
    baseUrl: (env) => `${env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434'}/v1`,
    // Ollama needs no key; configured when a base URL is present.
    apiKey: (env) => (env.OLLAMA_BASE_URL ? 'ollama' : undefined),
    defaultModel: (env) => env.OLLAMA_MODEL || 'llama3.1',
  }),
  anthropic: new AnthropicProvider(),
  google: new GoogleProvider(),
};

export const DEFAULT_PROVIDER_ORDER = ['openai', 'anthropic', 'openrouter', 'google', 'ollama'];

/**
 * §27 provider fallback: tries the configured providers in order and returns
 * the first real response. If none are configured the caller gets a clear
 * PROVIDER_NOT_CONFIGURED error — never a synthetic answer.
 */
export class LlmRouter {
  constructor(private readonly env: Env) {}

  order(): string[] {
    const preferred = this.env.LLM_DEFAULT_PROVIDER?.trim();
    const configured = this.env.LLM_PROVIDER_ORDER?.split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    const base = configured?.length ? configured : DEFAULT_PROVIDER_ORDER;
    return preferred ? [preferred, ...base.filter((p) => p !== preferred)] : base;
  }

  available(): { name: string; configured: boolean }[] {
    return this.order()
      .filter((name, idx, arr) => arr.indexOf(name) === idx)
      .map((name) => {
        const provider = PROVIDERS[name];
        return { name, configured: provider ? provider.isConfigured(this.env) : false };
      });
  }

  async chat(req: LlmChatRequest): Promise<LlmChatResponse> {
    const errors: { provider: string; message: string }[] = [];
    for (const name of this.order()) {
      const provider = PROVIDERS[name];
      if (!provider || !provider.isConfigured(this.env)) continue;
      try {
        return await provider.chat(req, this.env);
      } catch (err) {
        errors.push({ provider: name, message: (err as Error).message });
      }
    }
    throw new AppError(
      'PROVIDER_NOT_CONFIGURED',
      'No configured LLM provider could serve this request. Configure an API key as a Worker secret.',
      { tried: errors },
    );
  }

  async *stream(req: LlmChatRequest): AsyncGenerator<LlmStreamChunk> {
    for (const name of this.order()) {
      const provider = PROVIDERS[name];
      if (!provider || !provider.isConfigured(this.env)) continue;
      try {
        yield* provider.stream(req, this.env);
        return;
      } catch {
        continue;
      }
    }
    throw new AppError(
      'PROVIDER_NOT_CONFIGURED',
      'No configured LLM provider could stream this request.',
      {},
    );
  }
}
