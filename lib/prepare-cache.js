import crypto from 'crypto';

const TTL_MS = 30 * 60 * 1000;
const store = new Map();

export function putPrepare(entry) {
  const id = crypto.randomUUID();
  store.set(id, { ...entry, expiresAt: Date.now() + TTL_MS });
  return id;
}

export function getPrepare(id) {
  const entry = store.get(id);
  if (!entry || entry.expiresAt < Date.now()) {
    store.delete(id);
    return null;
  }
  return entry;
}

export function deletePrepare(id) {
  store.delete(id);
}

setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of store) {
    if (entry.expiresAt < now) store.delete(id);
  }
}, 5 * 60 * 1000).unref?.();
