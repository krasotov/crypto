#!/bin/bash
set -euo pipefail

SERVER_ID="${SERVER_ID:-c2e8615d-7e4c-410c-b06d-ef1ad5b207e3}"
APP_ID="${APP_ID:-761fdd2e-a613-4276-bdc7-87e07df05445}"

if [ -z "${VIBE_KEY:-}" ]; then
  echo "Set VIBE_KEY environment variable"
  exit 1
fi

ROOT="$(cd "$(dirname "$0")" && pwd)"
ARCHIVE="/tmp/sign-stamp-deploy.tar.gz"

COPYFILE_DISABLE=1 tar -czf "$ARCHIVE" \
  --exclude=node_modules \
  --exclude=.git \
  --exclude=data \
  -C "$ROOT" .

echo "Uploading source snapshot..."
curl -s -X POST "https://vibecode.bitrix24.tech/v1/apps/${APP_ID}/sources" \
  -H "X-Api-Key: $VIBE_KEY" \
  -H "Content-Type: application/gzip" \
  -H "X-Filename: sign-stamp.tar.gz" \
  --data-binary @"$ARCHIVE" | python3 -m json.tool

echo "Deploying..."
export CONTENT_B64=$(base64 < "$ARCHIVE" | tr -d '\n')
export VIBE_KEY
python3 - <<PY
import json, os
payload = {
  "source": {"content": os.environ["CONTENT_B64"]},
  "runtime": "node20",
  "install": "mkdir -p /var/lib/sign-stamp-data && cd /opt/app && npm install --production",
  "start": "cd /opt/app && node server.js",
  "port": 3000,
  "env": {
    "NODE_ENV": "production",
    "VIBE_API_KEY": os.environ["VIBE_KEY"],
    "APP_ID": os.environ.get("APP_ID", "761fdd2e-a613-4276-bdc7-87e07df05445"),
    "DATA_DIR": "/var/lib/sign-stamp-data",
    "BITRIX_PORTAL": "admsp.bitrix24.ru",
    "DISK_STORAGE_ID": "3"
  }
}
with open("/tmp/deploy-payload.json", "w") as f:
    json.dump(payload, f)
PY

curl -s -X POST "https://vibecode.bitrix24.tech/v1/infra/servers/${SERVER_ID}/deploy?stream=false" \
  -H "X-Api-Key: $VIBE_KEY" \
  -H "Content-Type: application/json" \
  --data-binary @/tmp/deploy-payload.json | python3 -m json.tool

echo "Done."
