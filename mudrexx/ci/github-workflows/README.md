# GitHub Actions workflows — pending installation

These two workflow files could **not** be committed to `.github/workflows/`
directly: the GitHub App used to push this branch does not hold the `workflows`
permission, so GitHub rejects any push that creates or updates a file under
`.github/workflows/`:

```
! [remote rejected] refusing to allow a GitHub App to create or update
  workflow `.github/workflows/mudrexx-deploy.yml` without `workflows` permission
```

They are parked here so nothing is lost. **Until they are moved, the automatic
Cloudflare deployment pipeline is NOT active** — GitHub only runs workflows that
live in `.github/workflows/`.

## Installing them

Either re-authorise the GitHub connection with the `workflows` permission and
let the agent push them, or move them yourself in one command:

```bash
git mv mudrexx/ci/github-workflows/mudrexx-deploy.yml   .github/workflows/
git mv mudrexx/ci/github-workflows/mudrexx-rollback.yml .github/workflows/
git rm mudrexx/ci/github-workflows/README.md
git commit -m "ci(mudrexx): activate Cloudflare deploy + rollback workflows"
git push
```

The files are unmodified and ready to run as-is.

## What they do

| File | Trigger | Purpose |
|---|---|---|
| `mudrexx-deploy.yml` | push to any branch, PRs to `main`, manual | build + typecheck + test + config/migration validation everywhere; Cloudflare deploy, health check, read-only smoke and the deployment report **only** from `main` or a manual dispatch |
| `mudrexx-rollback.yml` | manual only | `wrangler rollback` to a previous version, then re-run the health check. Never touches the database. |

See [`../../DEPLOYMENT.md`](../../DEPLOYMENT.md) for the required secrets,
environment separation, the migration safety gate and the rollback procedure.
