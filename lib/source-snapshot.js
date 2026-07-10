import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const VIBE_API = process.env.VIBE_API_URL || 'https://vibecode.bitrix24.tech';
const DEFAULT_APP_ID = '761fdd2e-a613-4276-bdc7-87e07df05445';

function getAppRoot() {
  return process.env.APP_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
}

export async function uploadSourceSnapshot(apiKey, appId = process.env.APP_ID || DEFAULT_APP_ID) {
  if (!apiKey) {
    throw new Error('VIBE_API_KEY не настроен');
  }

  const root = getAppRoot();
  const archive = path.join('/tmp', `sign-stamp-sources-${Date.now()}.tar.gz`);

  try {
    await execFileAsync('tar', [
      '-czf',
      archive,
      '--exclude=node_modules',
      '--exclude=.git',
      '--exclude=data',
      '--exclude=backups',
      '-C',
      root,
      '.',
    ], { env: { ...process.env, COPYFILE_DISABLE: '1' } });

    const buffer = fs.readFileSync(archive);
    const res = await fetch(`${VIBE_API}/v1/apps/${appId}/sources`, {
      method: 'POST',
      headers: {
        'X-Api-Key': apiKey,
        'Content-Type': 'application/gzip',
        'X-Filename': 'sign-stamp.tar.gz',
      },
      body: buffer,
    });

    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.success === false) {
      throw new Error(json.error?.message || `Upload snapshot failed: ${res.status}`);
    }

    return json.data || json;
  } finally {
    if (fs.existsSync(archive)) {
      fs.unlinkSync(archive);
    }
  }
}
