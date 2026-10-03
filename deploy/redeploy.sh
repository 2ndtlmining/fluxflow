#!/usr/bin/env bash
# One command to launch or update FluxFlow with Docker Compose. Run from anywhere:
#   deploy/redeploy.sh
#
#   1. preflight: docker compose, .env with ADMIN_TOKEN, clean checkout
#   2. git pull --ff-only
#   3. back up the database from the running container (SQLite online backup, safe
#      while ingestion writes); the first launch has nothing to back up
#   4. build an image tagged with the git SHA, then up -d
#   5. wait for the Docker healthcheck
#   6. /api/health must report this SHA, so the new build is what is answering
#
# The database lives on the `fluxflow-data` volume and is never touched by a rebuild.
# Every build keeps its own `fluxflow:<sha>` image, so rolling back is one command (printed
# at the end).
#
# Knobs:
#   SKIP_PULL=1       deploy the checkout as it is (no git pull)
#   SKIP_BACKUP=1     the volume exists but no container is running to back up from
#   BACKUP_KEEP=3     backups kept in the volume, under /app/data/backups
#   BACKUP_DIR=path   also copy each backup to this host directory
#   HEALTH_TIMEOUT=900  seconds; the first launch is healthy only after its first batch
#   ALLOW_DIRTY=1     deploy with uncommitted changes (the SHA then won't match the code)
set -euo pipefail

# Git Bash on Windows rewrites arguments that look like paths (/app/data -> C:/Program
# Files/Git/app/data) before docker sees them. No effect anywhere else.
export MSYS_NO_PATHCONV=1

cd "$(dirname "$0")/.."

SERVICE=fluxflow
VOLUME=fluxflow-data
HEALTH_TIMEOUT=${HEALTH_TIMEOUT:-900}
BACKUP_KEEP=${BACKUP_KEEP:-3}
POLL_SECONDS=${POLL_SECONDS:-10}

log() { printf '[redeploy] %s\n' "$*"; }
die() { printf '[redeploy] ERROR: %s\n' "$*" >&2; exit 1; }

# A value from .env, quotes stripped.
env_value() { sed -n "s/^$1=[\"']\{0,1\}\([^\"']*\)[\"']\{0,1\}[[:space:]]*$/\1/p" .env | tail -n 1; }

# ── 1. Preflight ─────────────────────────────────────────────────────────
docker compose version >/dev/null 2>&1 || die "docker compose (v2) is not available"

[ -f .env ] || die ".env is missing. Create it with: cp .env.example.compose .env  (then set ADMIN_TOKEN)"

token=${ADMIN_TOKEN:-$(env_value ADMIN_TOKEN)}
[ -n "$token" ] || die "ADMIN_TOKEN is empty in .env. Generate one with: openssl rand -hex 32"
[ "${#token}" -ge 32 ] || die "ADMIN_TOKEN must be at least 32 characters (production refuses to boot otherwise)"

git rev-parse --git-dir >/dev/null 2>&1 || die "$(pwd) is not a git checkout"
if [ "${ALLOW_DIRTY:-0}" != "1" ]; then
    git diff --quiet && git diff --cached --quiet \
        || die "the checkout has local changes; the deployed SHA would not be the code that runs (ALLOW_DIRTY=1 to override)"
fi

# ── 2. Pull ──────────────────────────────────────────────────────────────
if [ "${SKIP_PULL:-0}" = "1" ]; then
    log "SKIP_PULL=1: deploying the checkout as it is"
else
    git pull --ff-only
fi
sha=$(git rev-parse --short HEAD)
log "deploying ${sha}"

# The image currently running, for the rollback hint.
previous=""
cid=$(docker compose ps -q --status running "$SERVICE" 2>/dev/null || true)
if [ -n "$cid" ]; then
    previous=$(docker inspect -f '{{.Config.Image}}' "$cid" 2>/dev/null || true)
fi

# ── 3. Backup ────────────────────────────────────────────────────────────
if [ -n "$cid" ]; then
    name="flux-flow-$(date -u +%Y%m%dT%H%M%SZ)-${previous##*:}.db"
    # better-sqlite3's backup() uses SQLite's online backup API: a consistent copy while
    # the service keeps writing, unlike copying the file and its WAL by hand.
    backup=$(docker compose exec -T "$SERVICE" node -e "
        const fs = require('fs');
        const Database = require('better-sqlite3');
        const src = process.env.DATABASE_PATH;
        if (!fs.existsSync(src)) { console.log(''); process.exit(0); }
        fs.mkdirSync('/app/data/backups', { recursive: true });
        const dest = '/app/data/backups/' + process.argv[1];
        const db = new Database(src, { readonly: true });
        db.backup(dest)
          .then(() => { db.close(); console.log(dest); })
          .catch((error) => { console.error(error.message); process.exit(1); });
    " "$name" </dev/null) || die "pre-deploy backup failed; nothing was changed"

    if [ -z "$backup" ]; then
        log "no database file yet; nothing to back up"
    else
        log "backed up to ${VOLUME}:${backup#/app/data/}"
        # Keep the newest BACKUP_KEEP; each is a full copy of the database.
        docker compose exec -T "$SERVICE" sh -c \
            "ls -1t /app/data/backups/flux-flow-*.db 2>/dev/null | tail -n +$((BACKUP_KEEP + 1)) | xargs -r rm -f" </dev/null
        if [ -n "${BACKUP_DIR:-}" ]; then
            mkdir -p "$BACKUP_DIR"
            docker compose cp "${SERVICE}:${backup}" "${BACKUP_DIR}/" \
                || die "copying the backup to ${BACKUP_DIR} failed; nothing was changed"
            log "copied to ${BACKUP_DIR}/$(basename "$backup")"
        fi
    fi
elif docker volume inspect "$VOLUME" >/dev/null 2>&1; then
    [ "${SKIP_BACKUP:-0}" = "1" ] \
        || die "volume ${VOLUME} holds data but no ${SERVICE} container is running to back it up from. Start it (docker compose up -d) or re-run with SKIP_BACKUP=1"
    log "SKIP_BACKUP=1: no pre-deploy backup"
else
    log "first launch: volume ${VOLUME} will be created"
fi

# ── 4. Build and start ───────────────────────────────────────────────────
export GIT_SHA="$sha"
docker compose build
docker compose up -d

# ── 5. Wait for healthy ──────────────────────────────────────────────────
cid=$(docker compose ps -q "$SERVICE" || true)
[ -n "$cid" ] || { docker compose logs --tail 50 "$SERVICE" >&2 || true; die "no ${SERVICE} container after up -d"; }

waited=0
while :; do
    status=$(docker inspect -f '{{.State.Health.Status}}' "$cid" 2>&1 || true)
    [ "$status" = healthy ] && break
    if [ "$waited" -ge "$HEALTH_TIMEOUT" ]; then
        docker compose logs --tail 50 "$SERVICE" >&2 || true
        [ -n "$previous" ] && log "roll back with: GIT_SHA=${previous##*:} docker compose up -d --no-build"
        die "container not healthy after ${HEALTH_TIMEOUT}s (last status: ${status})"
    fi
    sleep "$POLL_SECONDS"
    waited=$((waited + POLL_SECONDS))
done
log "healthy"

# ── 6. Verify ────────────────────────────────────────────────────────────
health=$(docker compose exec -T "$SERVICE" node -e \
    "fetch('http://127.0.0.1:3000/api/health').then(r=>r.text()).then(t=>console.log(t))" </dev/null) \
    || die "could not reach /api/health inside the container"
printf '%s' "$health" | grep -q "\"version\":\"${sha}\"" \
    || die "/api/health does not report ${sha}; another build is answering: ${health}"

printf '%s\n' "$health"
log "done: ${sha} is live on port $(env_value PORT | grep . || echo 3000)"
if [ -n "$previous" ] && [ "${previous##*:}" != "$sha" ]; then
    log "roll back with: GIT_SHA=${previous##*:} docker compose up -d --no-build"
fi
