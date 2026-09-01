# MUDREXX — Chief Control Portal (frontend + Vercel functions)

The SUPER_ADMIN web UI for MUDREXX. Vite + React + TypeScript, plus two Vercel
function groups:

| Path | Runtime | Purpose |
|---|---|---|
| `api/[...path].ts` | edge | Same-origin proxy to the MUDREXX Worker |
| `api/cp/*.ts` | node | Control-plane data in DynamoDB (`ruflo-cp`) |

MUDREXX's own data (users, admins, payments, audit) stays in Cloudflare D1
behind the Worker — see [`../DEPLOYMENT.md`](../DEPLOYMENT.md). DynamoDB holds
only control-plane data that has no home in D1.

## Why the API is proxied instead of called directly

The MUDREXX session cookie is `HttpOnly` **and `SameSite=Strict`**
([`../src/routes/session-cookie.ts`](../src/routes/session-cookie.ts)).

A browser will not attach a `SameSite=Strict` cookie to a *cross-site* request.
If the portal at `portal.vercel.app` called `mudrexx-backend.workers.dev`
directly, login would appear to work and **every following request would 401** —
CORS cannot fix this, because the cookie is never sent at all.

So everything stays first-party to the Vercel domain:

```
browser → https://<portal>.vercel.app/api/...   (same origin, cookie sent)
             ├── /api/cp/*  → node function → DynamoDB (OIDC, no static keys)
             └── /api/*     → edge function → https://<worker>.workers.dev/api/...
```

`/api/cp/*` wins over the `/api/[...path]` catch-all because Vercel orders
static path segments ahead of dynamic ones.

## Deploying to Vercel

> **Root Directory must be `mudrexx/portal`.** It is not the repository root.
> The functions resolve their dependencies (`@aws-sdk/*`) from this package's
> `package.json`; pointed at the repo root they would build without the SDK
> installed and fail at runtime.

| Setting | Value |
|---|---|
| Root Directory | `mudrexx/portal` |
| Framework Preset | Vite (auto-detected) |
| Build / Output | from [`vercel.json`](./vercel.json) — leave overrides off |

### Environment variables

| Variable | Required | Value | Set by |
|---|---|---|---|
| `MUDREXX_API_ORIGIN` | yes | `https://mudrexx-backend.<subdomain>.workers.dev` — origin only, no trailing slash, no `/api` | you |
| `AWS_ROLE_ARN` | for `/api/cp/*` | `arn:aws:iam::<account>:role/Vercel/access-ruflo-cp` | AWS integration |
| `AWS_REGION` | for `/api/cp/*` | `us-east-1` | AWS integration |
| `DYNAMODB_TABLE_NAME` | for `/api/cp/*` | `ruflo-cp` | AWS integration |
| `DYNAMODB_TABLE_PARTITION_KEY` | no (default `PK`) | must match the table's real key name | AWS integration |
| `DYNAMODB_TABLE_SORT_KEY` | no (default `SK`) | must match the table's real key name | AWS integration |

Missing configuration never produces a blank screen: the portal loads and the
affected endpoint returns `503 NOT_CONFIGURED` naming the variable.

### AWS access uses OIDC, not keys

There is no AWS access key anywhere in this repo or its environment. Vercel
mints a short-lived OIDC token; `@vercel/oidc-aws-credentials-provider`
exchanges it via `sts:AssumeRoleWithWebIdentity` for temporary credentials on
`AWS_ROLE_ARN`. This requires **OIDC enabled** in the Vercel project (Settings →
Security) and a role trust policy naming this project. If the exchange fails,
`/api/cp/health` reports `OIDC_FAILED` rather than a generic 500.

The role should be scoped to `dynamodb:Query`, `dynamodb:PutItem` and
`dynamodb:DeleteItem` on the `ruflo-cp` table — nothing else is used.

> **Check the partition key name.** The integration reported
> `DYNAMODB_TABLE_PARTITION_KEY="US"`, which is an unusual attribute name and
> may be a typo for `PK`. The code reads whatever the variable says, so it is
> correct either way, but if the value does not match the table's real schema
> every call fails with `ValidationException` — surfaced here as
> `SCHEMA_MISMATCH`. `/api/cp/health` echoes the resolved key names so you can
> compare them against the table in one glance.

## Verifying a deployment

Sign in, open **Control plane**, and read the AWS connection panel. Or curl it
with a Chief session cookie:

```bash
curl -s https://<portal>.vercel.app/api/cp/health -b 'mudrexx_session=…'
```

| Code | Meaning |
|---|---|
| `ok` | Role assumed and the table answered |
| `NOT_CONFIGURED` | An environment variable is missing |
| `OIDC_FAILED` | OIDC off, or the trust policy rejects this project/environment |
| `ACCESS_DENIED` | Role assumed, but the IAM policy forbids the action |
| `TABLE_NOT_FOUND` | Wrong `DYNAMODB_TABLE_NAME` or wrong `AWS_REGION` |
| `SCHEMA_MISMATCH` | Key-name variables do not match the table |

## Control-plane data model

Single-table design, newest-first reads with one Query and no scan:

```
PK  NOTE#<entityType>:<entityId>      e.g. NOTE#admin:usr_123
SK  <ISO-8601 createdAt>#<suffix>     e.g. 2026-09-01T08:15:00.000Z#f3a9c1d2
```

| Route | Method | Notes |
|---|---|---|
| `/api/cp/health` | GET | Zero-item Query; reads and writes nothing |
| `/api/cp/notes?entity=…` | GET | Newest first, `limit` 1–100 (default 50) |
| `/api/cp/notes` | POST | `{ entity, body }`; author taken from the session |
| `/api/cp/notes?entity=…&sk=…` | DELETE | Deletes one note |

### Authorization

These functions run outside the Worker, so they cannot read D1 — and they never
trust the browser. Each request is verified by replaying the caller's own cookie
against the Worker's `/api/auth/me`; anything other than a live `SUPER_ADMIN`
session is refused. Identity has exactly one source of truth, and note
attribution comes from that response, never from the request body.

## Local development

```bash
# terminal 1 — backend (local D1, no Cloudflare account needed)
cd mudrexx
cp .dev.vars.example .dev.vars          # fill in RECOVERY_SECRET
CHIEF_EMAIL=chief@example.com \
CHIEF_PASSWORD='ChangeMe#12345' \
  node scripts/seed.mjs --local          # creates the first SUPER_ADMIN
npx wrangler dev --port 8787 --local

# terminal 2 — portal
cd mudrexx/portal
npm install
npm run dev                              # http://localhost:5173
```

Vite proxies `/api` to `http://127.0.0.1:8787` (override with
`MUDREXX_API_ORIGIN`).

**`/api/cp/*` does not work under `npm run dev`** — Vite proxies it to the
Worker, which correctly answers `404 NOT_FOUND` because those routes are Vercel
functions, not Worker routes. To exercise them locally use `vercel dev`, which
runs the functions; AWS access additionally needs `vercel env pull` for a
`VERCEL_OIDC_TOKEN`.

## Scripts

| Command | Does |
|---|---|
| `npm run dev` | Dev server with the `/api` proxy |
| `npm run build` | Typecheck (app + server) then `vite build` → `dist/` |
| `npm run typecheck` | Both TypeScript projects |
| `npm test` | Node test runner over `server/__tests__` |
| `npm run preview` | Serve the built `dist/` |

## Tested

`npm test` covers what can be verified without AWS credentials — the
authorization boundary (no cookie, unknown session, authenticated-but-ADMIN,
unreachable Worker, cookie forwarding), configuration handling including the
`PK`/`SK` fallbacks, and the AWS error translation table.

The DynamoDB calls themselves are **not** covered: they need credentials that
only exist inside a Vercel deployment via OIDC. `/api/cp/health` is the
first-run check for that.

## Portal pages

| Page | Backing endpoints |
|---|---|
| Dashboard | `GET /chief/dashboard` |
| Admins | `GET /chief/admins`, `POST /chief/admins/:id/{approve,reject,block,unblock}` |
| Payments | `GET /chief/payments?status=`, `POST /chief/payments/:id/{verify,reject}` |
| Security | `GET /chief/security/{sessions,audit}`, `POST /chief/security/sessions/:id/revoke` |
| Control plane | `GET /cp/health`, `GET|POST|DELETE /cp/notes` |

Sign-in posts to `POST /api/auth/super-admin/login`, which only accepts
`SUPER_ADMIN`. The portal declares the role it serves; the database decides.
