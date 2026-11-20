#!/usr/bin/env bash
# Build and (re)start Industry Intel on the VPS. Run from the repo root as root.
# Used as repos.industry-intel.deploy.command by the deploy skill.
set -euo pipefail
cd "$(dirname "$0")/.."

SLUG=industry-intel
PORT=8070
HEALTH="http://127.0.0.1:${PORT}/industry-intel/api/health"

npm ci --no-audit --no-fund
BASE_PATH=/industry-intel npm run build

install -m 0644 deploy/${SLUG}.service /etc/systemd/system/${SLUG}.service
systemctl daemon-reload
systemctl enable ${SLUG}.service >/dev/null
systemctl restart ${SLUG}.service

for _ in $(seq 1 30); do
  if body=$(curl -fsS --max-time 5 "$HEALTH" 2>/dev/null); then
    echo "health: $body"
    exit 0
  fi
  sleep 2
done
echo "health check failed: $HEALTH" >&2
journalctl -u ${SLUG}.service -n 40 --no-pager >&2 || true
exit 1
