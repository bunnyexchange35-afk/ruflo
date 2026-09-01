# GitHub Actions workflows — pending installation

> **Status: still parked. The automatic Cloudflare deployment pipeline is NOT
> active.** GitHub only runs workflows that live in `.github/workflows/`.
> Re-verified 2026-09-01 — the blocker below is unchanged.

These two workflow files could **not** be committed to `.github/workflows/`
directly: the GitHub App used to push this branch does not hold the `workflows`
permission, so GitHub rejects any push that creates or updates a file under
`.github/workflows/`:

```
! [remote rejected] refusing to allow a GitHub App to create or update
  workflow `.github/workflows/mudrexx-deploy.yml` without `workflows` permission
```

They are parked here so nothing is lost. The files are unmodified and ready to
run as-is — both were re-validated as parseable YAML on 2026-09-01
(`mudrexx-deploy.yml`: jobs `build`, `test`, `validate`, `deploy`, `no-deploy`;
`mudrexx-rollback.yml`: job `rollback`).

## Why an agent cannot do this for you

Starting a fresh coding session does **not** help — every session authenticates
as the same GitHub App identity. Both routes that could install the files are
blocked by the same permission check:

| Route | Result |
|---|---|
| `git push` of a commit touching `.github/workflows/` | `remote rejected` — missing `workflows` permission |
| REST Git Data API (`/git/trees`, then update ref) | `403 Resource not accessible by integration` |

There is no agent-side workaround. A human, or a credential holding the
`workflows` permission, has to make the move.

## Installing them

**Option A — run the installer** (from a clone where you push as yourself):

```bash
bash mudrexx/ci/install-workflows.sh --push
```

It moves both files, deletes this README, commits, and pushes. It refuses to
run on a dirty working tree and is safe to re-run — if the workflows are
already installed it exits without doing anything.

**Option B — re-authorise, then ask the agent.** Reconnect GitHub in Arena
granting the `workflows` permission, and the agent can push the move itself.

**Option C — four commands by hand:**

```bash
git mv mudrexx/ci/github-workflows/mudrexx-deploy.yml   .github/workflows/
git mv mudrexx/ci/github-workflows/mudrexx-rollback.yml .github/workflows/
git rm mudrexx/ci/github-workflows/README.md
git commit -m "ci(mudrexx): activate Cloudflare deploy + rollback workflows"
```

Whichever route you take, set the required secrets **before** the first run from
`main` — otherwise the deploy job fails. They are listed in
[`../../DEPLOYMENT.md`](../../DEPLOYMENT.md).

## What they do

| File | Trigger | Purpose |
|---|---|---|
| `mudrexx-deploy.yml` | push to any branch, PRs to `main`, manual | build + typecheck + test + config/migration validation everywhere; Cloudflare deploy, health check, read-only smoke and the deployment report **only** from `main` or a manual dispatch |
| `mudrexx-rollback.yml` | manual only | `wrangler rollback` to a previous version, then re-run the health check. Never touches the database. |

See [`../../DEPLOYMENT.md`](../../DEPLOYMENT.md) for the required secrets,
environment separation, the migration safety gate and the rollback procedure.
