import { Client } from '@microsoft/microsoft-graph-client';
import { ClientSecretCredential, ManagedIdentityCredential, TokenCredential } from '@azure/identity';
import 'isomorphic-fetch';

export function buildCredential(): TokenCredential {
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
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
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
  const attempts = opts.attempts ?? 5;
  const baseDelay = opts.baseDelayMs ?? 1000;
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i++) {
    try { return await fn(); }
    catch (e: any) {
      lastErr = e;
      const status = e?.statusCode || e?.status;
      const retryable = status === 429 || status === 503 || status === 504 || status === undefined;
      if (!retryable || i === attempts) throw e;
      const retryAfter = Number(e?.headers?.['retry-after']) || 0;
      const delay = retryAfter > 0 ? retryAfter * 1000 : baseDelay * Math.pow(2, i - 1);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}
