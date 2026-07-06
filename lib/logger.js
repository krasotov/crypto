const MAX_ENTRIES = 300;
const entries = [];

function formatBytes(n) {
  if (n == null || Number.isNaN(n)) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function push(entry) {
  const row = {
    ts: new Date().toISOString(),
    ...entry,
  };
  entries.push(row);
  if (entries.length > MAX_ENTRIES) entries.shift();
  const prefix = `[sign-stamp:${row.scope || 'app'}]`;
  const msg = row.message || row.event || '';
  const meta = { ...row };
  delete meta.scope;
  delete meta.message;
  delete meta.event;
  delete meta.level;
  console.log(prefix, msg, Object.keys(meta).length ? JSON.stringify(meta) : '');
}

export function createLogger(scope) {
  return {
    debug(event, meta = {}) { push({ level: 'debug', scope, event, ...meta }); },
    info(event, meta = {}) { push({ level: 'info', scope, event, ...meta }); },
    warn(event, meta = {}) { push({ level: 'warn', scope, event, ...meta }); },
    error(event, meta = {}) { push({ level: 'error', scope, event, ...meta }); },
  };
}

export function getRecentLogs(limit = 100) {
  return entries.slice(-limit);
}

export function estimateJsonSize(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return null;
  }
}

export function base64ByteLength(b64 = '') {
  if (!b64) return 0;
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - padding;
}

export { formatBytes };
