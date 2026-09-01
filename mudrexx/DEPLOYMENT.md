# MUDREXX — automatic Cloudflare build & deployment

This document describes the deployment pipeline for the MUDREXX backend
(`mudrexx/` — Hono + Cloudflare Workers + D1).

```
CODE PUSH
   ↓
BUILD            npm ci + tsc --noEmit + wrangler dry-run bundle
   ↓
TYPECHECK        (same step — the build IS the typecheck: tsc --noEmit)
   ↓
TEST             vitest run — 103 tests in the real workerd runtime with D1
   ↓
DATABASE/SCHEMA  detect → validate (non-destructive) → apply if approved → verify
   ↓
CLOUDFLARE DEPLOY  npx wrangler deploy   (existing wrangler.jsonc, nothing invented)
   ↓
PRODUCTION HEALTH CHECK   GET /api/health, GET /api/health/db
   ↓
SMOKE TEST       read-only auth / CRM / AI verification
   ↓
DEPLOYMENT RESULT  BUILD / TEST / DATABASE / DEPLOYMENT / HEALTH / CRM / AI / AUTH
```

If **any** step fails, the pipeline stops and the deployment is reported
**FAILED**. Nothing is ever reported as "deployed successfully" unless the
Cloudflare deployment *and* the post-deployment verification actually
succeeded.

---

## 1. Workflows

| File | Trigger | What it does |
|---|---|---|
| `.github/workflows/mudrexx-deploy.yml` | push to any branch, PRs to `main`, manual | build + test + validate everywhere; deploy **only** from `main` or a manual dispatch |
| `.github/workflows/mudrexx-rollback.yml` | manual only | `wrangler rollback` to a previous version + health re-check |

### Deployment rule (§13)

| Ref | Build | Test | Validate | Deploy |
|---|---|---|---|---|
| `main` | ✅ | ✅ | ✅ | ✅ production |
| pull request → `main` | ✅ | ✅ | ✅ | ❌ |
| feature branch | ✅ | ✅ | ✅ | ❌ |
| manual dispatch | ✅ | ✅ | ✅ | ✅ chosen environment |

The deploy job is bound to a **GitHub Environment** (`production` /
`staging`). Add required reviewers to that environment to make "approved push"
literal — GitHub will hold the deploy until a reviewer approves it, and the
Cloudflare secrets are only exposed to that job.

---

## 2. Required configuration

### 2.1 Before the first deploy — provision D1

`wrangler.jsonc` ships with a placeholder D1 id. **The pipeline deliberately
refuses to deploy until it is replaced**, so a deploy can never silently target
the wrong (or no) database:

```
[FAIL] D1 "DB" (mudrexx_db): database_id is a real provisioned id
       — still the placeholder id — run `npx wrangler d1 list` ...
```

```bash
cd mudrexx
npx wrangler d1 create mudrexx_db            # production
npx wrangler d1 create mudrexx_db_staging    # staging
npx wrangler d1 list                         # copy the uuids
```

Paste each `database_id` into the matching block in `wrangler.jsonc`. A D1
database id is an **identifier, not a credential** — it is safe to commit.

Then apply the schema once:

```bash
npx wrangler d1 migrations apply mudrexx_db --remote
```

### 2.2 GitHub Actions secrets

Set these on the **environment** (`Settings → Environments → production →
Secrets`), not as plain repository secrets, so staging and production stay
separated.

| Secret | Required | Purpose |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | ✅ | Wrangler auth. Scopes: *Workers Scripts: Edit*, *D1: Edit*, *Account Settings: Read* |
| `CLOUDFLARE_ACCOUNT_ID` | ✅ | Target Cloudflare account |
| `RECOVERY_SECRET`, `RECOVERY_ROTATION_ID` | recommended | §21 emergency recovery |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `OPENROUTER_API_KEY` / `GOOGLE_API_KEY` | at least one | LLM providers |
| `WHATSAPP_*`, `TWILIO_*` | optional | WhatsApp provider |
| `TELEGRAM_BOT_TOKEN`, `WEBHOOK_DELIVERY_SECRET` | optional | Destinations |
| `SMOKE_USER_EMAIL` / `SMOKE_USER_PASSWORD` | optional | auth smoke (see §5) |
| `SMOKE_ADMIN_EMAIL` / `SMOKE_ADMIN_PASSWORD` | optional | auth + CRM smoke |
| `SMOKE_CHIEF_EMAIL` / `SMOKE_CHIEF_PASSWORD` | optional | Chief auth smoke |

**Nothing in this list is ever committed.** `mudrexx/.gitignore` excludes
`.dev.vars` and `.env*`, and `scripts/ci/check-config.mjs` fails the build if a
credential-shaped value appears in `wrangler.jsonc` `vars` (which are public) or
if `.dev.vars` is present in the checkout.

### 2.3 GitHub Actions variables (not secrets)

| Variable | Default | Purpose |
|---|---|---|
| `SYNC_WORKER_SECRETS` | unset | `true` → push the secrets above to the Worker with `wrangler secret bulk` on every deploy |
| `APPLY_MIGRATIONS` | unset | `true` → apply pending **non-destructive** migrations automatically |
| `SMOKE_REQUIRE_LLM` | `true` | `false` → an unconfigured LLM provider reports NOT AUTOMATED instead of FAIL |
| `SMOKE_ALLOW_WRITES` | `false` | `true` → allow the AI completion/streaming smoke, which writes a conversation row |
| `MUDREXX_PRODUCTION_URL` | unset | custom domain to verify instead of the `workers.dev` URL |
| `MUDREXX_STAGING_URL` | unset | same, for staging |

---

## 3. Environment separation (§6)

`wrangler.jsonc` defines three environments. The **top level is production**
(wrangler's default environment); `env.staging` and `env.development` are fully
separate deployments with their own Worker name, D1 database and secrets.

| Environment | Command | Worker | D1 |
|---|---|---|---|
| development | `npm run dev` | local miniflare | `mudrexx_db_dev` (`--local`) |
| staging | `npm run deploy:staging` | `mudrexx-backend-staging` | `mudrexx_db_staging` |
| production | `npm run deploy` | `mudrexx-backend` | `mudrexx_db` |

Two independent guards stop staging config reaching production:

1. **Before deploy** — `check-config.mjs --target production` asserts
   `vars.ENVIRONMENT === "production"` and that the bound D1 database name does
   not look like a staging/dev database.
2. **After deploy** — `health-check.mjs --expect-environment production` asserts
   the *live* Worker reports `environment: "production"`. If you accidentally
   shipped staging config, this fails and the deployment is marked FAILED.

---

## 4. Database & migrations (§4)

`scripts/ci/check-migrations.mjs` runs the four-phase gate:

1. **detect** — enumerate `migrations/*.sql` and ask D1 which are unapplied
   (`wrangler d1 migrations list --remote`).
2. **validate** — statically reject any migration containing
   `DROP DATABASE`, `DROP TABLE`, `DROP SCHEMA`, `DROP COLUMN`, `TRUNCATE`,
   an unqualified `DELETE FROM`, or `ALTER TABLE … RENAME TO`.
   Comments and string literals are stripped first, so documentation about
   these keywords does not trip the gate.
3. **apply** — *only* when `APPLY_MIGRATIONS=true` (variable) or the manual
   `apply_migrations` input is checked, *and* validation passed.
   Without that approval the stage reports `NOT AUTOMATED` and the deploy
   continues **without touching the schema**.
4. **verify** — re-list migrations and confirm nothing is pending.

> A destructive migration is never applied automatically. The pipeline fails
> and asks an operator to review and run it by hand.

---

## 5. Smoke tests — what is and is not automated

`scripts/ci/smoke-readonly.mjs` is **non-mutating by design**. It never
registers a user and never creates a lead, contact, task or campaign, so it
cannot pollute production with fake records (§9).

### AUTH (§8)

Always run, no credentials needed:

- unauthenticated `/api/auth/me` → 401 JSON
- invalid credentials → 401/403 and **no** session token (no auth bypass)

With optional `SMOKE_*` credentials it additionally verifies User, Admin and
Chief/Super-Admin login, that each session resolves with the **stored** role,
and RBAC separation (USER and ADMIN both get 403 from `/api/chief/*`).

**Real production passwords should not be put in GitHub Actions.** Either:

- create dedicated, least-privilege smoke accounts (recommended — a `USER` and,
  if you need CRM reads, a low-privilege `ADMIN`), rotated regularly; or
- leave the secrets unset. The stage then reports:

  ```
  AUTH   NOT AUTOMATED
  ```

  and you perform a controlled manual smoke test. It is never reported as PASS.

### CRM (§9)

Endpoints verified: dashboard, leads, contacts, lists, tasks, campaigns,
destinations.

- **With** admin/chief credentials → `GET` each endpoint, expect `200` + JSON.
- **Without** credentials → each endpoint must be reachable and return
  **JSON 401**, which proves the route exists *and* that auth is enforced. A
  `404` here means a route regression and fails the stage.

Either way, no records are created.

### AI (§10)

- LLM provider configuration is read from `/api/health`, which reports a
  **count** — never a key value.
- `/api/ai/providers` reachability.
- An AI completion writes a conversation row, so `/api/ai/chat` and
  `/api/ai/chat/stream` only run when `SMOKE_ALLOW_WRITES=true` (recommended on
  staging). Otherwise the stage reports `NOT AUTOMATED` for that check.
- Every detail string passes through a redaction filter (`redact()` in
  `scripts/ci/lib.mjs`) so an API key can never reach the logs.

---

## 6. Deployment result (§11, §14)

`scripts/ci/report.mjs` aggregates every stage file in `artifacts/` and prints:

```
========================================================
MUDREXX DEPLOYMENT RESULT — PRODUCTION
========================================================

BUILD        PASS
TEST         PASS
DATABASE     PASS
DEPLOYMENT   PASS
HEALTH       PASS
CRM          PASS
AI           PASS
AUTH         NOT AUTOMATED

--------------------------------------------------------
Commit:      <actual sha>
Worker:      mudrexx-backend
Version:     <actual wrangler version id>
URL:         https://...
Environment: production
--------------------------------------------------------

DEPLOYMENT RESULT: SUCCESS
```

The same table is written to the GitHub job summary, with an expandable
breakdown of every individual check, and uploaded as a build artifact.

Rules the reporter enforces:

- A stage that never ran is `NOT RUN` — **never** `PASS`.
- `NOT_AUTOMATED` is surfaced verbatim and never silently upgraded.
- `BUILD`, `TEST`, `DEPLOYMENT` and `HEALTH` must genuinely be `PASS` for the
  overall result to be `SUCCESS`; otherwise the job exits non-zero.

---

## 7. Rollback (§12)

Run the **MUDREXX Rollback** workflow (`Actions → MUDREXX Rollback → Run
workflow`):

1. It lists the deployed versions (`wrangler deployments list` /
   `wrangler versions list`) so you can identify the previous known-good one.
2. It calls Cloudflare's supported mechanism — `npx wrangler rollback
   [version-id]`. With no version id it rolls back to the previous version.
3. It re-runs the production health check against the rolled-back deployment
   and reports the real result.

**The rollback never touches the database.** A failed code deployment is fixed
by rolling the code back, not by mutating or dropping production data. If a
rollback would require a schema change, stop and handle it manually.

---

## 8. Running the pipeline locally

```bash
cd mudrexx
npm ci
npm run build           # typecheck
npm test                # 103 tests
npm run ci:config       # configuration guard (production)
npm run ci:migrations   # destructive-migration validation (offline)

# against a running worker
npm run dev &
npm run ci:health -- --base-url http://127.0.0.1:8787 --expect-environment production
npm run ci:smoke  -- --base-url http://127.0.0.1:8787 --out-dir artifacts
npm run ci:report -- --commit "$(git rev-parse HEAD)" --worker mudrexx-backend
```

`scripts/smoke.mjs` (the pre-existing, **mutating** end-to-end smoke) is still
available for staging or local verification. It creates users, payments, leads
and tasks, so do not point it at production.
