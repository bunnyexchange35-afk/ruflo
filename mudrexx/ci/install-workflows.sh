#!/usr/bin/env bash
#
# Install the parked MUDREXX GitHub Actions workflows.
#
# Why this script exists
# ----------------------
# mudrexx-deploy.yml and mudrexx-rollback.yml live in mudrexx/ci/github-workflows/
# instead of .github/workflows/, so GitHub never runs them. They cannot be moved
# by the coding agent: the GitHub App it authenticates as does not hold the
# `workflows` permission, and GitHub rejects the change on BOTH paths it could
# take (verified 2026-09-01):
#
#   git push        -> ! [remote rejected] refusing to allow a GitHub App to
#                        create or update workflow `.github/workflows/mudrexx-deploy.yml`
#                        without `workflows` permission
#   REST Git API    -> 403 Resource not accessible by integration
#
# Run this yourself, from a clone authenticated as a HUMAN (or any identity that
# may write workflow files), and the pipeline goes live.
#
# Usage
# -----
#   bash mudrexx/ci/install-workflows.sh            # move + commit, then show the push command
#   bash mudrexx/ci/install-workflows.sh --push     # move + commit + push to the current branch
#
set -euo pipefail

DO_PUSH=0
[[ "${1:-}" == "--push" ]] && DO_PUSH=1

# Always operate from the repository root, wherever the script was invoked from.
REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

SRC="mudrexx/ci/github-workflows"
DEST=".github/workflows"
FILES=(mudrexx-deploy.yml mudrexx-rollback.yml)

info() { printf '  %s\n' "$*"; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }

echo "==> Installing MUDREXX workflows into ${DEST}/"

# --- Preconditions ----------------------------------------------------------
if [[ -z "$(git status --porcelain)" ]]; then
  :
else
  die "working tree is not clean. Commit or stash your changes first, so this move lands as its own reviewable commit."
fi

# Idempotency: if the files are already installed there is nothing to do.
ALREADY=1
for f in "${FILES[@]}"; do
  [[ -f "${DEST}/${f}" ]] || ALREADY=0
done
if [[ "$ALREADY" == "1" ]]; then
  echo "==> Already installed - ${DEST}/ already contains both workflows. Nothing to do."
  exit 0
fi

for f in "${FILES[@]}"; do
  [[ -f "${SRC}/${f}" ]] || die "expected ${SRC}/${f} but it is missing. Has it already been moved or renamed?"
done
mkdir -p "$DEST"

# --- Move -------------------------------------------------------------------
for f in "${FILES[@]}"; do
  git mv "${SRC}/${f}" "${DEST}/${f}"
  info "moved ${f}"
done

# The parking README only documents the workaround, so it goes away with it.
if [[ -f "${SRC}/README.md" ]]; then
  git rm -q "${SRC}/README.md"
  info "removed ${SRC}/README.md (parking note no longer applies)"
fi
# Drop the directory if git left it empty.
rmdir "$SRC" 2>/dev/null || true

# --- Commit -----------------------------------------------------------------
git commit -q -m "ci(mudrexx): activate Cloudflare deploy + rollback workflows

Move the parked workflow files from mudrexx/ci/github-workflows/ into
.github/workflows/ so GitHub Actions actually runs them. The YAML is
unmodified; mudrexx/DEPLOYMENT.md and mudrexx/README.md already document
both files at their .github/workflows/ paths.

Removes the now-obsolete parking README."

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
echo "==> Committed $(git rev-parse --short HEAD) on ${BRANCH}"

# --- Push -------------------------------------------------------------------
if [[ "$DO_PUSH" == "1" ]]; then
  echo "==> Pushing to origin ${BRANCH}"
  if git push origin "$BRANCH"; then
    echo "==> Done. The deploy pipeline is live; check the Actions tab."
  else
    cat >&2 <<'MSG'

The push was rejected. If the message mentions the `workflows` permission,
the credential you pushed with also lacks it. Push with a personal account,
or re-authorise the GitHub App with the `workflows` permission, then run:

    git push origin HEAD

The commit is already made locally, so nothing is lost.
MSG
    exit 1
  fi
else
  cat <<MSG

==> Commit created but NOT pushed. Publish it with:

      git push origin ${BRANCH}

    Required secrets are listed in mudrexx/DEPLOYMENT.md - set them before
    the first run from main, or the deploy job will fail.
MSG
fi
