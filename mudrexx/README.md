# MUDREXX — Central Backend

Hono + Cloudflare Workers + D1. One backend, three portals, no bypasses.

This service was built greenfield in this repository. It is the single central
backend for MUDREXX: public users, the Admin portal and the Chief Control Portal
all authenticate against the same identity table, the same session store and the
same RBAC layer.

---

## 1. Architecture

```
                MUDREXX (Hono Worker)
                         │
        ┌────────────────┼────────────────┐
        ▼                ▼                ▼
   PUBLIC USER      ADMIN PORTAL     CHIEF PORTAL
        │                │                │
        └────────────────┼────────────────┘
                         ▼
                 AUTHENTICATION (§4)
                         ▼
                     RBAC (§22)
                         ▼
              ROUTE → MIDDLEWARE → VALIDATION
                         ▼
                     SERVICE (§43)
                         ▼
                   REPOSITORY (§44)
                         ▼
                    D1 DATABASE (§8)
                         ▼
                  AUDIT / EVENTS (§38)
```

**Roles** (§22): `SUPER_ADMIN` (Chief Admin) > `ADMIN` > `USER`; `DEMO_VIEWER` is
separate and read-only. The Chief is **not** a subordinate of Admin — an Admin
hitting any `/api/chief/*` route receives `403`.

**Layering** (§43): routes stay thin. Every route is
`middleware → zod validation → role check → service → repository → D1`. Business
logic never lives in a route handler, and SQL never lives outside a repository.

---

## 2. Route surface

### Public
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | service health + config presence (no values) |
| GET | `/api/health/db` | D1 reachability, table/row counts only |
| GET | `/api/portal` | portal configuration from the DB (§40) |
| GET | `/api/packages` | packages + pricing |
| GET | `/api/packages/quote` | price quote with add-ons |

### Auth (§5)
| Method | Path | Roles accepted |
|---|---|---|
| POST | `/api/auth/register` | (public) creates `USER` |
| POST | `/api/auth/login` | `USER`, `DEMO_VIEWER` |
| POST | `/api/auth/admin/login` | `ADMIN` |
| POST | `/api/auth/super-admin/login` | `SUPER_ADMIN` |
| POST | `/api/auth/logout` | session |
| GET | `/api/auth/me` | session |
| POST | `/api/auth/password/change` | session |
| POST | `/api/auth/password/reset-request` | (public) |
| POST | `/api/auth/password/reset` | one-time token |
| POST | `/api/auth/recovery/redeem` | (public) §21 |
| POST | `/api/auth/demo` | provisions the read-only demo account |

### Admin (`/api/admin/*` — `ADMIN`, `SUPER_ADMIN`)
`POST /register` (public), `POST /payments/submit` (public, pre-login §13),
`/dashboard`, `/profile`, `/users`, `/users/search` (§35), `/payments`,
`/packages`, `/packages/quote`.

### Chief (`/api/chief/*` — `SUPER_ADMIN` only, §23)
`/dashboard`, `/admins` (+`search`, `approve`, `reject`, `block`, `unblock`,
`package`, `reset-device`, `DELETE`), `/users`, `/payments` (+`verify`,
`reject`, `request-info`), `/packages` (+`PUT`, market rates),
`/security/sessions` (+`revoke`), `/security/login-history`, `/security/audit`,
`/password-resets` (+`approve`/`reject`), `/settings`, `/recovery/mint`,
`/recovery/rotate`, `/ai/providers`, `/whatsapp/providers`.

### Domain
`/api/crm/*` (contacts, import, lists, leads, routing), `/api/destinations/*`
(Telegram/webhook + routing rules), `/api/tasks/*` (+`bulk/plan`,
`bulk/assign`), `/api/ai/*` (chat, stream, skills, actions, usage),
`/api/whatsapp/*` (templates, campaigns, queue, send, analytics),
`/api/webhooks/whatsapp`.

### Route precedence (§6, §7, §54)
API namespaces are mounted **before** any wildcard. Unmatched `/api/*` paths
return JSON `404`; only non-API paths reach the browser fallback. This is
covered by `tests/integration/routes.test.ts`, which asserts that no `/api/`
path ever returns HTML.

---

## 3. Security decisions

| Requirement | Implementation |
|---|---|
| No auth bypass (§1) | Every login hits D1, verifies PBKDF2-SHA256 (210k iterations), then checks the **stored** role. A role sent by the client is ignored. |
| Password storage (§20) | `PBKDF2-SHA256$210000$salt$hash`. bcrypt/argon2 are unavailable in the Workers runtime. No plaintext, ever. |
| Session token (§17) | 32 random bytes; only its SHA-256 is stored. Cookie is `HttpOnly` + `SameSite` + `Secure`. |
| Device identity (§17) | SHA-256 of UA + platform + language. **IP is recorded but never used as the device.** |
| One admin = one session (§17) | Login revokes the admin's other sessions; a login from an unregistered device is refused with `DEVICE_BOUND_ELSEWHERE` until a Chief resets it. |
| Emergency recovery (§21) | No master password, no hidden route, no auto-login. A one-time, time-limited, rate-limited, audited, rotatable code minted with a **server-side secret**; redeeming forces a password reset, invalidates sessions and issues **no session**. |
| Chief provisioning | Only via `scripts/seed.mjs` (CLI). Nothing in the deployed Worker can create a `SUPER_ADMIN`. |
| Payment self-approval (§14) | `PaymentService.transition` refuses when the actor owns the payment. |
| Demo (§39) | `DEMO_VIEWER` blocked from every mutation by middleware, and its data is isolated by `owner_admin_id`. |
| Package limits (§15) | Enforced server-side in `PackageService.enforceLimit` / `assertFeature`. |
| Secrets (§45) | Never in source, never in responses. Destinations store a secret **name**, not a value. |
| Error contract (§47) | All errors are JSON `{success:false,error:{code,message}}`; stack traces are suppressed in production. |
| Rate limiting (§49) | D1-backed fixed window per IP per bucket (login, register, reset, AI, bulk messaging, webhooks, recovery). |

### No fake data, no fake AI, no fake delivery (§1)
- LLM: with no provider key configured, `/api/ai/chat` returns `503 PROVIDER_NOT_CONFIGURED`. It never invents an answer.
- WhatsApp: with no provider configured, sending returns `503`. Messages are never marked `SENT` without a provider response or webhook.
- Telegram/webhook: delivery failures are recorded as `FAILED` with the error, never as `SENT`.

---

## 4. Database (§8)

40 tables, one versioned migration: `migrations/0001_init.sql`.

Identity (`users`, `admin_profiles`), access (`sessions`, `devices`,
`login_history`, `password_resets`, `password_history`,
`recovery_challenges`), commercial (`packages`, `package_prices`,
`package_addons`, `market_rates`, `payments`, `orders`, `wallets`,
`wallet_ledger`), CRM (`crm_contacts`, `crm_lists`, `crm_list_members`,
`leads`, `lead_activities`), `tasks`, WhatsApp (`whatsapp_templates`,
`whatsapp_campaigns`, `whatsapp_messages`), destinations
(`destinations`, `routing_rules`, `deliveries`), AI (`ai_conversations`,
`ai_messages`, `ai_tool_calls`, `ai_usage`, `ai_skills`), cross-cutting
(`audit_log`, `settings`, `rate_limits`, `webhook_events`,
`support_tickets`, `invoices`, `documents`).

**Human IDs (§11, §12)** are 2–5 digit numbers allocated server-side
(`src/lib/ids.ts`) with a UNIQUE constraint. The internal primary key stays a
UUID and is never used as the human-facing ID.

---

## 5. Setup

```bash
cd mudrexx
npm install

# 1. Point wrangler.jsonc `database_id` at the real D1 database
#    (npx wrangler d1 list). Local dev uses a simulated local D1 — NOT production.
npx wrangler d1 create mudrexx_db

# 2. Apply migrations
npm run db:migrate:local     # or: npm run db:migrate:remote

# 3. Provision the first Chief Admin (the only supported way)
CHIEF_EMAIL=you@example.com CHIEF_PASSWORD='…' node scripts/seed.mjs --local
#   or --remote

# 4. Set secrets (see .dev.vars.example)
npx wrangler secret put RECOVERY_SECRET
npx wrangler secret put OPENAI_API_KEY

# 5. Develop / deploy
npm run dev
npm run deploy
```

After deploy, as Chief: `POST /api/ai/skills/seed`, then `POST /api/auth/demo`.

> **Destructive migrations:** `scripts/seed.mjs` and the npm scripts only apply
> additive migrations. Nothing here drops tables or deletes users (§58).

### Automatic deployment

Pushes to `main` deploy to Cloudflare automatically through
`.github/workflows/mudrexx-deploy.yml`:

```
BUILD → TYPECHECK → TEST → DATABASE/SCHEMA CHECK → CLOUDFLARE DEPLOY
      → HEALTH CHECK → READ-ONLY SMOKE TEST → DEPLOYMENT RESULT
```

Feature branches and pull requests run build + test only. See
**[DEPLOYMENT.md](./DEPLOYMENT.md)** for the required GitHub secrets, the
development/staging/production separation, the migration safety gate and the
rollback procedure.

---

## 6. Testing

Tests run inside the **real Workers runtime (workerd)** against a **real D1**,
via `@cloudflare/vitest-pool-workers`.

```bash
npm test                 # 103 tests
npm run test:unit        # 19 pure unit tests
npm run test:integration # 84 integration tests
npm run typecheck
```

| Suite | Covers |
|---|---|
| `auth` | §53 register → login → me → logout → old session rejected; wrong password; account lock; portal/role separation; admin gating; human-ID format |
| `routes` | §54 `/api/auth/super-admin/login` never reaches a generic handler; `/api/chief/dashboard` never returns HTML; every unmatched `/api/*` is JSON |
| `rbac` | §22/§57 401/403 matrix for USER, ADMIN, CHIEF, DEMO |
| `session-device` | §17/§18 single session, device binding, Chief reset, expiry, history, IP-is-not-a-device |
| `admin-payments` | §12/§13/§14 full lifecycle over HTTP; self-approval refusal; invalid transitions |
| `crm-tasks` | §24 canonical lead dedupe, CSV import report, package limits, task dedupe, bulk plan/assign |
| `ai` | §26-§30 fail-closed provider, skills, write-action confirmation, tool RBAC, quota |
| `messaging` | §31/§32 no fake delivery, secret-by-reference, consent gating, no duplicate pushes |
| `platform` | §10/§15/§16/§38/§39/§40 packages, market rates, settings, audit, demo isolation, health |
| `recovery` | §21 secret required, one-time, audited, rate-limited, rotatable, no auto-login |
| `primitives` | hashing, IDs, CSV, phone, date ranges, error contract |

### Production smoke test (§59)
```bash
CHIEF_EMAIL=… CHIEF_PASSWORD=… node scripts/smoke.mjs \
  --base-url https://mudrexx-backend.<subdomain>.workers.dev
```
26 numbered steps (31 assertions). Exit code 0 only when everything passes.

---

## 7. Known gaps (honest status)

- **Frontend**: this repository contains the backend only. The Worker serves a
  browser fallback and a full JSON API; a frontend build can be attached with the
  `ASSETS` binding (see `src/index.ts`). Every screen listed in §46 must call
  these endpoints — no mock responses exist server-side.
- **Deployment**: not performed. No Cloudflare credentials are present in this
  environment, and `wrangler.jsonc` still carries a placeholder `database_id`.
  §58/§59 remain **NOT VERIFIED** until a Worker is deployed with real secrets.
- **LLM / WhatsApp / Telegram**: fully wired but inactive until provider secrets
  are set. They fail closed rather than faking.
