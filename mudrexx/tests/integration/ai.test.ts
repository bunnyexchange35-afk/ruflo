import { beforeEach, describe, expect, it } from 'vitest';
import { freshDatabase } from '../helpers/db';
import { api, login, seedActiveAdmin, seedChief, seedUser, testContainer } from '../helpers/factory';
import { seedSkills } from '../../src/services/ai/skills';
import { PackageService } from '../../src/services/package-service';

/**
 * §26-§30 AI platform.
 *
 * The platform must NEVER fabricate an AI response: with no provider key
 * configured, a chat request fails with PROVIDER_NOT_CONFIGURED.
 */
describe('AI platform (§26-§30)', () => {
  beforeEach(async () => {
    await freshDatabase();
  });

  it('reports provider configuration honestly (§27)', async () => {
    const admin = await seedActiveAdmin();
    const token = (await login('admin', admin.email, admin.password)).body.data!.token;
    const res = await api<{ name: string; configured: boolean }[]>('/api/ai/providers', { token });

    expect(res.status).toBe(200);
    const providers = res.body.data ?? [];
    expect(providers.map((p) => p.name)).toContain('openai');
    expect(providers.map((p) => p.name)).toContain('anthropic');
    expect(providers.every((p) => p.configured === false)).toBe(true);
  });

  it('fails closed with no LLM provider configured — no fake answer (§26)', async () => {
    const admin = await seedActiveAdmin();
    const token = (await login('admin', admin.email, admin.password)).body.data!.token;

    const res = await api('/api/ai/chat', {
      method: 'POST',
      token,
      body: { message: 'Give me a summary of my leads' },
    });

    expect(res.status).toBe(503);
    expect(res.body.success).toBe(false);
    expect(res.body.error?.code).toBe('PROVIDER_NOT_CONFIGURED');
  });

  it('loads skills dynamically from the database (§28)', async () => {
    const admin = await seedActiveAdmin();
    const token = (await login('admin', admin.email, admin.password)).body.data!.token;

    const before = await api<unknown[]>('/api/ai/skills', { token });
    expect((before.body.data ?? []).length).toBe(0);

    await seedSkills(testContainer());

    const after = await api<{ code: string; category: string }[]>('/api/ai/skills', { token });
    const codes = (after.body.data ?? []).map((s) => s.code);
    expect(codes).toContain('fullstack-developer');
    expect(codes).toContain('crm-copilot');
    expect(codes).toContain('data-analyst');
    expect(codes).toContain('ux-designer');
    expect((after.body.data ?? []).length).toBeGreaterThanOrEqual(18);
  });

  it('requires confirmation for AI write actions (§30)', async () => {
    const admin = await seedActiveAdmin();
    const token = (await login('admin', admin.email, admin.password)).body.data!.token;

    // Simulate a write action proposed by the model.
    const proposal = await testContainer().toolCalls.propose({
      conversationId: null,
      actorUserId: admin.user.id,
      tool: 'create_task',
      args: { title: 'AI proposed follow-up' },
      sideEffect: 'WRITE',
      requiresConfirmation: true,
    });

    const pending = await api<{ id: string; status: string }[]>('/api/ai/actions', { token });
    expect((pending.body.data ?? []).map((a) => a.id)).toContain(proposal.id);

    // Nothing has been written yet.
    const tasksBefore = await testContainer().tasks.list({
      ownerAdminId: admin.user.id,
      limit: 100,
      offset: 0,
    });
    expect(tasksBefore.rows.some((t) => t.title === 'AI proposed follow-up')).toBe(false);

    // Reject one proposal: nothing is written.
    const toReject = await testContainer().toolCalls.propose({
      conversationId: null,
      actorUserId: admin.user.id,
      tool: 'create_task',
      args: { title: 'AI proposed - rejected' },
      sideEffect: 'WRITE',
      requiresConfirmation: true,
    });
    const rejected = await api(`/api/ai/actions/${toReject.id}/reject`, { method: 'POST', token });
    expect(rejected.status).toBe(200);
    expect((rejected.body.data as { status: string }).status).toBe('REJECTED');
    expect(
      (await testContainer().tasks.list({ ownerAdminId: admin.user.id, limit: 100, offset: 0 })).rows.some(
        (t) => t.title === 'AI proposed - rejected',
      ),
    ).toBe(false);

    // Approve the other: the write executes.
    const approved = await api(`/api/ai/actions/${proposal.id}/approve`, { method: 'POST', token });
    expect(approved.status).toBe(200);
    expect((approved.body.data as { status: string }).status).toBe('EXECUTED');

    const tasksAfter = await testContainer().tasks.list({
      ownerAdminId: admin.user.id,
      limit: 100,
      offset: 0,
    });
    expect(tasksAfter.rows.some((t) => t.title === 'AI proposed follow-up')).toBe(true);
  });

  it('refuses an AI tool that exceeds the caller role (§29)', async () => {
    const user = await seedUser('USER');
    const token = (await login('user', user.email, user.password)).body.data!.token;

    // create_lead is ADMIN-only; a USER must not be able to execute it.
    const proposal = await testContainer().toolCalls.propose({
      conversationId: null,
      actorUserId: user.user.id,
      tool: 'create_lead',
      args: { name: 'Nope', phone: '+919900000999' },
      sideEffect: 'WRITE',
      requiresConfirmation: true,
    });

    const res = await api(`/api/ai/actions/${proposal.id}/approve`, { method: 'POST', token });
    expect(res.status).toBe(403);

    const after = await testContainer().toolCalls.findById(proposal.id);
    expect(after?.status).toBe('FAILED');
  });

  it('blocks a demo account from executing AI tool actions (§29, §39)', async () => {
    const demo = await seedUser('DEMO_VIEWER', { isDemo: true, password: 'DemoPass-12345' });
    const token = (await login('user', demo.email, demo.password)).body.data!.token;

    const proposal = await testContainer().toolCalls.propose({
      conversationId: null,
      actorUserId: demo.user.id,
      tool: 'create_task',
      args: { title: 'demo write' },
      sideEffect: 'WRITE',
      requiresConfirmation: true,
    });

    const res = await api(`/api/ai/actions/${proposal.id}/approve`, { method: 'POST', token });
    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('DEMO_READ_ONLY');
  });

  it('does not let one user resolve another user action (§29)', async () => {
    const admin = await seedActiveAdmin();
    const other = await seedActiveAdmin();
    const otherToken = (await login('admin', other.email, other.password)).body.data!.token;

    const proposal = await testContainer().toolCalls.propose({
      conversationId: null,
      actorUserId: admin.user.id,
      tool: 'create_task',
      args: { title: 'owned by admin' },
      sideEffect: 'WRITE',
      requiresConfirmation: true,
    });

    const res = await api(`/api/ai/actions/${proposal.id}/approve`, {
      method: 'POST',
      token: otherToken,
    });
    expect(res.status).toBe(403);
  });

  it('enforces the package AI quota server-side (§15, §26)', async () => {
    const admin = await seedActiveAdmin();

    // A package with a 100-token AI allowance.
    await new PackageService(testContainer()).ensureDefaults();
    const packages = await testContainer().packages.list();
    const pkg = packages[0];
    await testContainer().users.update(admin.user.id, { package_id: pkg.id });
    await testContainer().packages.update(pkg.id, { limits: { aiUsage: 100 } });

    // Re-read the account so the assigned package is in scope.
    const refreshed = (await testContainer().users.findById(admin.user.id))!;
    expect(refreshed.package_id).toBe(pkg.id);

    const limits = await new PackageService(testContainer()).limitsFor(refreshed);
    expect(limits.aiUsage).toBe(100);

    // Under the cap → allowed.
    await expect(
      new PackageService(testContainer()).enforceLimit(refreshed, 'aiUsage', 40),
    ).resolves.toBeUndefined();

    // At/over the cap → refused. This is the server-side gate the AI layer uses.
    await expect(
      new PackageService(testContainer()).enforceLimit(refreshed, 'aiUsage', 100),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // With no LLM provider configured the HTTP layer still fails closed first.
    const token = (await login('admin', admin.email, admin.password)).body.data!.token;
    const res = await api('/api/ai/chat', { method: 'POST', token, body: { message: 'hello' } });
    expect(res.status).toBe(503);
    expect(res.body.error?.code).toBe('PROVIDER_NOT_CONFIGURED');
  });

  it('exposes the AI surface to the Chief as well (§23)', async () => {
    const chief = await seedChief({ password: 'ChiefPass-12345' });
    const token = (await login('chief', chief.email, chief.password)).body.data!.token;
    const res = await api('/api/ai/providers', { token });
    expect(res.status).toBe(200);
  });
});
