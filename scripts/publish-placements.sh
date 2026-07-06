#!/bin/bash
# Публикация placements по включённым смарт-процессам из data/settings.json
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export DATA_DIR="${DATA_DIR:-${ROOT}/data}"

if [ -z "${VIBE_KEY:-}" ] && [ -z "${VIBE_API_KEY:-}" ]; then
  echo "Set VIBE_KEY environment variable"
  exit 1
fi

node "${ROOT}/scripts/sync-placements.js"
