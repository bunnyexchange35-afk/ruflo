# MUDREXX — Chief Control Portal (frontend)

The SUPER_ADMIN web UI for the MUDREXX backend. Vite + React + TypeScript, no
runtime UI framework dependencies.

This is the app that Vercel deploys. The MUDREXX API itself stays on Cloudflare
Workers, where its D1 database lives — see [`../DEPLOYMENT.md`](../DEPLOYMENT.md).

## Why the API is proxied instead of called directly

The MUDREXX session cookie is `HttpOnly` **and `SameSite=Strict`**
([`../src/routes/session-cookie.ts`](../src/routes/session-cookie.ts)).

A browser will not attach a `SameSite=Strict` cookie to a *cross-site* request.
So if the portal at `portal.vercel.app` called `mudrexx-backend.workers.dev`
directly, login would appear to succeed and then **every following request would
401** — CORS cannot fix this, because the cookie is never sent in the first
place.

The fix is to keep everything first-party to the Vercel domain:

```
browser → https://<portal>.vercel.app/api/...   (same origin, cookie sent)
             └── Vercel edge function /api/[...path]
                    └── https://<worker>.workers.dev/api/...
```

`Set-Cookie` from the Worker comes back through the proxy and is scoped to the
Vercel domain. In local development the same shape is produced by the Vite dev
proxy, so dev and production behave identically.

## Deploying to Vercel

The repository root [`vercel.json`](../../vercel.json) already points Vercel at
this app, so the project's **Root Directory must stay the repository root** —
not `mudrexx/portal`, or the `/api` proxy function will not be deployed.

| Setting | Value |
|---|---|
| Root Directory | *(repository root)* |
| Framework Preset | Other |
| Build / Install / Output | taken from `vercel.json` — leave the overrides off |

Then set one environment variable:

| Variable | Example | Notes |
|---|---|---|
| `MUDREXX_API_ORIGIN` | `https://mudrexx-backend.<subdomain>.workers.dev` | Origin only — no trailing slash, no `/api`. |

Without it the portal loads and every API call returns a clear
`503 NOT_CONFIGURED` rather than a blank screen.

### After the first deploy

Add the Vercel domain to the Worker's `ALLOWED_ORIGINS` var. The proxy makes
requests same-origin so CORS is not strictly required, but setting it keeps the
Worker's allowlist honest if anything ever calls it directly.

## Local development

Two processes — the Worker on `:8787` and the portal on `:5173`:

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

## Scripts

| Command | Does |
|---|---|
| `npm run dev` | Dev server with the `/api` proxy |
| `npm run build` | `tsc --noEmit` then `vite build` → `dist/` |
| `npm run typecheck` | Type check only |
| `npm run preview` | Serve the built `dist/` |

## What the portal covers

Built against the live `/api/chief/*` contract:

| Page | Endpoints |
|---|---|
| Dashboard | `GET /chief/dashboard` — counts, recent admins, recent audit |
| Admins | `GET /chief/admins`, `POST /chief/admins/:id/{approve,reject,block,unblock}` |
| Payments | `GET /chief/payments?status=`, `POST /chief/payments/:id/{verify,reject}` |
| Security | `GET /chief/security/{sessions,audit}`, `POST /chief/security/sessions/:id/revoke` |

Sign-in posts to `POST /api/auth/super-admin/login`, which only accepts
`SUPER_ADMIN`. The portal declares the role it serves; the database decides.

The backend exposes considerably more (packages, settings, password resets,
recovery rotation, AI and WhatsApp providers). Those endpoints are live and
unused by this UI — it covers the core operational surface, not all 36 routes.
