import { Client } from '@microsoft/microsoft-graph-client';
import { ClientSecretCredential, ManagedIdentityCredential, TokenCredential } from '@azure/identity';
import 'isomorphic-fetch';
import * as fs from 'fs';
import * as path from 'path';

let localSettingsLoaded = false;

export function buildCredential(): TokenCredential {
  loadLocalSettingsEnv();
  const useMi = (process.env.USE_MANAGED_IDENTITY || 'false').toLowerCase() === 'true';
  if (useMi) {
    const clientId = process.env.CLIENT_ID;
    return clientId ? new ManagedIdentityCredential({ clientId }) : new ManagedIdentityCredential();
  }
  const tenantId = required('TENANT_ID');
  const clientId = required('CLIENT_ID');
  const clientSecret = required('CLIENT_SECRET');
  return new ClientSecretCredential(tenantId, clientId, clientSecret);
}

function required(name: string): string {
  const v = process.env[name];
  if (!v || isTemplatePlaceholder(v)) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function loadLocalSettingsEnv(): void {
  if (localSettingsLoaded) return;
  localSettingsLoaded = true;

  loadLocalSettingsFile();
  loadEnvFile(path.resolve(process.cwd(), '.env.local'));
  loadEnvFile(path.resolve(process.cwd(), '.env.local.user'));
}

function loadLocalSettingsFile(): void {
  const settingsPath = path.resolve(process.cwd(), 'local.settings.json');
  if (!fs.existsSync(settingsPath)) return;

  const raw = fs.readFileSync(settingsPath, 'utf-8');
  let parsed: { Values?: Record<string, unknown> };
  try {
    parsed = JSON.parse(raw) as { Values?: Record<string, unknown> };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new Error(`Invalid local.settings.json: ${message}`);
  }

  for (const [key, value] of Object.entries(parsed.Values || {})) {
    setLocalEnv(key, value);
  }
}

function loadEnvFile(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, 'utf-8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    setLocalEnv(trimmed.slice(0, eq).trim(), trimmed.slice(eq + 1).trim());
  }
}

function setLocalEnv(key: string, value: unknown): void {
  if (process.env[key] || typeof value !== 'string' || value === '' || isTemplatePlaceholder(value)) return;
  process.env[key] = unquote(value);
}

function unquote(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function isTemplatePlaceholder(value: string): boolean {
  return /^\{\{[^{}]+\}\}$/.test(value.trim());
}

export function buildGraphClient(): Client {
  const credential = buildCredential();
  return Client.initWithMiddleware({
    debugLogging: false,
    authProvider: {
      getAccessToken: async () => {
        const token = await credential.getToken('https://graph.microsoft.com/.default');
        if (!token) throw new Error('Failed to acquire access token');
        return token.token;
      },
    },
  });
}

export async function withRetry<T>(fn: () => Promise<T>, opts: { attempts?: number; baseDelayMs?: number } = {}): Promise<T> {
  const attempts = opts.attempts ?? 8;
  const baseDelay = opts.baseDelayMs ?? 2000;
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i++) {
    try { return await fn(); }
    catch (e: any) {
      lastErr = e;
      const status = e?.statusCode || e?.status;
      const retryable =
        status === 404 ||
        status === 408 ||
        status === 429 ||
        status === 500 ||
        status === 502 ||
        status === 503 ||
        status === 504 ||
        status === undefined;
      if (!retryable || i === attempts) throw e;
      const retryAfter = Number(e?.headers?.['retry-after']) || 0;
      const delay = retryAfter > 0 ? retryAfter * 1000 : Math.min(60_000, baseDelay * Math.pow(2, i - 1));
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}
