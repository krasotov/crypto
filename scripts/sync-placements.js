#!/usr/bin/env node
import { getEnabledEntityTypeIds } from '../lib/settings-store.js';
import { buildPlacementsPayload, publishPlacements } from '../lib/placements-sync.js';

const apiKey = process.env.VIBE_KEY || process.env.VIBE_API_KEY;
const appId = process.env.APP_ID || '761fdd2e-a613-4276-bdc7-87e07df05445';
const dryRun = process.argv.includes('--dry-run');

const entityTypeIds = getEnabledEntityTypeIds();
const payload = buildPlacementsPayload(entityTypeIds);

if (dryRun) {
  console.log(JSON.stringify({ dryRun: true, ...payload }, null, 2));
  process.exit(0);
}

if (!apiKey) {
  console.error('Set VIBE_KEY or VIBE_API_KEY');
  process.exit(1);
}

try {
  const result = await publishPlacements(apiKey, entityTypeIds, appId);
  console.log(JSON.stringify(result, null, 2));
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
