import { SELF } from 'cloudflare:test';
import { describe, expect, it, beforeAll } from 'vitest';
import { freshDatabase, initSchema } from './helpers/db';

describe('worker bootstrap', () => {
  beforeAll(async () => {
    await freshDatabase();
  });

  it('serves /api/health', async () => {
    const res = await SELF.fetch('https://example.com/api/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: { status: string } };
    expect(body.success).toBe(true);
    expect(body.data.status).toBe('ok');
  });
});
