// Persistent & Lockable Google Apps Script Web App Configuration
// Persisted across localStorage, IndexedDB, server/Vercel /api/gas-config, and shareable locked URLs.

import { loadPersistedGasConfigIdb, savePersistedGasConfigIdb } from './indexedDb.ts';

const GAS_URL_KEY = 'presensi_gas_webapp_url_v1';
const GAS_TOKEN_KEY = 'presensi_gas_secret_token_v1';
const GAS_LOCKED_KEY = 'presensi_gas_config_locked_v1';
const GAS_CHANGE_EVENT = 'presensi:gas-config-changed';

export interface GasConfigState {
  url: string;
  token: string;
  locked: boolean;
  fromEnv: boolean;
  fromServer: boolean;
}

let serverSyncedFlag = false;
let hydrationPromise: Promise<boolean> | null = null;

function getEnvDefaults(): { url: string; token: string } {
  const env = (typeof import.meta !== 'undefined' && (import.meta as any).env) || {};
  return {
    url: String(env.VITE_APPS_SCRIPT_URL || '').trim(),
    token: String(env.VITE_APPS_SCRIPT_TOKEN || '').trim(),
  };
}

export function getGasConfig(): GasConfigState {
  const envDefaults = getEnvDefaults();
  if (typeof window === 'undefined') {
    return {
      url: envDefaults.url,
      token: envDefaults.token,
      locked: Boolean(envDefaults.url && envDefaults.token),
      fromEnv: Boolean(envDefaults.url && envDefaults.token),
      fromServer: false,
    };
  }

  const storedUrl = String(localStorage.getItem(GAS_URL_KEY) || '').trim();
  const storedToken = String(localStorage.getItem(GAS_TOKEN_KEY) || '').trim();
  const storedLocked = localStorage.getItem(GAS_LOCKED_KEY) === '1';

  const url = storedUrl || envDefaults.url;
  const token = storedToken || envDefaults.token;
  const fromEnv = !storedUrl && !storedToken && Boolean(envDefaults.url && envDefaults.token);

  return {
    url,
    token,
    locked: storedLocked || (fromEnv && Boolean(url && token)),
    fromEnv,
    fromServer: serverSyncedFlag,
  };
}

export function isGasConfigured(): boolean {
  const cfg = getGasConfig();
  return Boolean(cfg.url && cfg.token && isValidAppsScriptUrl(cfg.url));
}

export function isValidAppsScriptUrl(url: string): boolean {
  const trimmed = url.trim();
  return /^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec(\?.*)?$/i.test(trimmed);
}

function applyLocalConfig(url: string, token: string, locked: boolean): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(GAS_URL_KEY, url);
  localStorage.setItem(GAS_TOKEN_KEY, token);
  localStorage.setItem(GAS_LOCKED_KEY, locked ? '1' : '0');
  void savePersistedGasConfigIdb({ url, token, locked });
  window.dispatchEvent(new CustomEvent(GAS_CHANGE_EVENT));
}

export async function pushGasConfigToServer(url: string, token: string): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  try {
    const res = await fetch('/api/gas-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, token, locked: true }),
    });
    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      if (data?.persisted) {
        serverSyncedFlag = true;
        window.dispatchEvent(new CustomEvent(GAS_CHANGE_EVENT));
        return true;
      }
    }
  } catch {
    // Ignore when static hosting does not handle POST
  }
  return false;
}

export function saveAndLockGasConfig(url: string, token: string): { ok: boolean; error?: string } {
  const cleanUrl = url.trim();
  const cleanToken = token.trim();

  if (!cleanUrl) {
    return { ok: false, error: 'URL Web App Google Apps Script wajib diisi.' };
  }
  if (!isValidAppsScriptUrl(cleanUrl)) {
    return {
      ok: false,
      error: 'Format URL harus berupa Web App Google Apps Script yang valid (https://script.google.com/macros/s/.../exec).',
    };
  }
  if (!cleanToken || cleanToken.length < 4) {
    return { ok: false, error: 'Token rahasia wajib diisi (minimal 4 karakter).' };
  }

  applyLocalConfig(cleanUrl, cleanToken, true);
  void pushGasConfigToServer(cleanUrl, cleanToken);
  return { ok: true };
}

export function unlockGasConfig(): void {
  if (typeof window !== 'undefined') {
    localStorage.setItem(GAS_LOCKED_KEY, '0');
    const cfg = getGasConfig();
    if (cfg.url && cfg.token) {
      void savePersistedGasConfigIdb({ url: cfg.url, token: cfg.token, locked: false });
    }
    window.dispatchEvent(new CustomEvent(GAS_CHANGE_EVENT));
  }
}

export function lockGasConfig(): void {
  if (typeof window !== 'undefined') {
    const cfg = getGasConfig();
    if (cfg.url && cfg.token) {
      localStorage.setItem(GAS_LOCKED_KEY, '1');
      void savePersistedGasConfigIdb({ url: cfg.url, token: cfg.token, locked: true });
      window.dispatchEvent(new CustomEvent(GAS_CHANGE_EVENT));
    }
  }
}

function tryConsumeUrlBootstrapConfig(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    let encoded = '';
    const hash = window.location.hash || '';
    const hashMatch = hash.match(/cfg=([^&]+)/);
    if (hashMatch && hashMatch[1]) {
      encoded = decodeURIComponent(hashMatch[1]);
    } else {
      const searchParams = new URLSearchParams(window.location.search);
      const qVal = searchParams.get('cfg');
      if (qVal) encoded = qVal;
    }

    if (!encoded) return false;

    const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const pad = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
    const jsonStr = decodeURIComponent(escape(atob(normalized + pad)));
    const parsed = JSON.parse(jsonStr) as { u?: string; t?: string };

    if (parsed?.u && parsed?.t && isValidAppsScriptUrl(parsed.u)) {
      applyLocalConfig(String(parsed.u).trim(), String(parsed.t).trim(), true);
      // Clean sensitive bootstrap fragment from address bar immediately
      const cleanUrl = window.location.pathname + window.location.search.replace(/([?&])cfg=[^&]*(&|$)/, (_, p1, p2) => (p2 ? p1 : '')).replace(/[?&]$/, '');
      window.history.replaceState(null, '', cleanUrl || '/');
      return true;
    }
  } catch {
    // Ignore malformed bootstrap token
  }
  return false;
}

export function buildShareableLockedConfigUrl(): string | null {
  if (typeof window === 'undefined') return null;
  const cfg = getGasConfig();
  if (!cfg.url || !cfg.token || !isValidAppsScriptUrl(cfg.url)) return null;
  try {
    const payload = JSON.stringify({ u: cfg.url, t: cfg.token });
    const b64 = btoa(unescape(encodeURIComponent(payload)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    return `${window.location.origin}/#cfg=${encodeURIComponent(b64)}`;
  } catch {
    return null;
  }
}

export async function hydrateGasConfig(): Promise<boolean> {
  if (typeof window === 'undefined') return isGasConfigured();

  if (tryConsumeUrlBootstrapConfig()) {
    return true;
  }

  if (hydrationPromise) return hydrationPromise;

  hydrationPromise = (async () => {
    // 1. Restore from IndexedDB mirror if localStorage is empty
    if (!isGasConfigured()) {
      const idbCfg = await loadPersistedGasConfigIdb();
      if (idbCfg?.url && idbCfg?.token && isValidAppsScriptUrl(idbCfg.url)) {
        applyLocalConfig(idbCfg.url, idbCfg.token, idbCfg.locked !== false);
      }
    }

    // 2. Fetch shared global config from /api/gas-config (Node server.ts or Vercel serverless/env)
    try {
      const res = await fetch('/api/gas-config', { method: 'GET', cache: 'no-store' });
      if (res.ok) {
        const data = await res.json().catch(() => null);
        if (data?.configured && data?.url && data?.token && isValidAppsScriptUrl(String(data.url))) {
          serverSyncedFlag = true;
          const current = getGasConfig();
          if (!current.url || !current.token || current.fromEnv) {
            applyLocalConfig(String(data.url).trim(), String(data.token).trim(), true);
          } else {
            window.dispatchEvent(new CustomEvent(GAS_CHANGE_EVENT));
          }
          return true;
        }
      }
    } catch {
      // Ignore network errors on offline startup
    }

    return isGasConfigured();
  })();

  try {
    return await hydrationPromise;
  } finally {
    hydrationPromise = null;
  }
}

export function getMissingFrontendConfigKeys(): string[] {
  const cfg = getGasConfig();
  const missing: string[] = [];
  if (!cfg.url || !isValidAppsScriptUrl(cfg.url)) missing.push('APPS_SCRIPT_WEBAPP_URL');
  if (!cfg.token) missing.push('APPS_SCRIPT_TOKEN');
  return missing;
}

export function subscribeGasConfigChange(cb: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const handler = () => cb();
  const storageHandler = (e: StorageEvent) => {
    if (e.key === GAS_URL_KEY || e.key === GAS_TOKEN_KEY || e.key === GAS_LOCKED_KEY) {
      cb();
    }
  };
  window.addEventListener(GAS_CHANGE_EVENT, handler);
  window.addEventListener('storage', storageHandler);
  return () => {
    window.removeEventListener(GAS_CHANGE_EVENT, handler);
    window.removeEventListener('storage', storageHandler);
  };
}
