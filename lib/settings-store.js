import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

const DEFAULT_SETTINGS = {
  smartProcesses: {},
};

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

export function loadSettings() {
  ensureDir();
  if (!fs.existsSync(SETTINGS_FILE)) {
    return structuredClone(DEFAULT_SETTINGS);
  }
  try {
    const raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
    return { ...structuredClone(DEFAULT_SETTINGS), ...JSON.parse(raw) };
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

export function saveSettings(settings) {
  ensureDir();
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8');
}

export function getProcessConfig(entityTypeId) {
  const settings = loadSettings();
  return settings.smartProcesses[String(entityTypeId)] || null;
}

export function setProcessConfig(entityTypeId, config) {
  const settings = loadSettings();
  settings.smartProcesses[String(entityTypeId)] = config;
  saveSettings(settings);
  return config;
}

export function getEnabledEntityTypeIds() {
  const settings = loadSettings();
  return Object.entries(settings.smartProcesses)
    .filter(([, cfg]) => cfg?.enabled)
    .map(([id]) => Number(id));
}
