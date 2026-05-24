import { buildGraphClient, withRetry } from '../services/graphService';
import { connection } from '../models/connection';
import { connectorSchema } from '../references/schema';

type GraphSchemaPayload = {
  baseType: string;
  properties: Array<Record<string, unknown>>;
};

// Import urlToItemResolver if it has been uncommented in connection.ts.
// This enables link unfurling in Teams/Copilot when users share source URLs.
// To activate, uncomment and configure `urlToItemResolver` in src/models/connection.ts.
let urlToItemResolvers: object[] | undefined;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require('../models/connection') as { urlToItemResolver?: object };
  if (mod.urlToItemResolver) urlToItemResolvers = [mod.urlToItemResolver];
} catch {
  // No urlToItemResolver defined — skip activitySettings
}

async function ensureConnection(): Promise<void> {
  const client = buildGraphClient();
  try {
    await client.api(`/external/connections/${connection.connectionId}`).get();
    console.log(`Connection '${connection.connectionId}' exists.`);
  } catch (e: any) {
    if (e.statusCode === 404) {
      console.log(`Creating connection '${connection.connectionId}'...`);
      const payload: Record<string, unknown> = {
        id: connection.connectionId,
        name: connection.connectionName,
        description: connection.connectionDescription,
      };
      if (urlToItemResolvers) {
        payload.activitySettings = { urlToItemResolvers };
      }
      await withRetry(() => client.api('/external/connections').post(payload));
    } else {
      throw e;
    }
  }
}

async function registerSchema(): Promise<void> {
  const client = buildGraphClient();
  const graphSchema = toGraphSchemaPayload(connectorSchema as unknown as GraphSchemaPayload);
  console.log(`Registering schema for '${connection.connectionId}' (this can take up to 10 minutes)...`);
  await withRetry(() => client
    .api(`/external/connections/${connection.connectionId}/schema`)
    .header('Prefer', 'respond-async')
    .patch(graphSchema));
  console.log('Schema registration submitted. Polling for completion...');

  const deadline = Date.now() + 15 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 15_000));
    try {
      const schema = await client.api(`/external/connections/${connection.connectionId}/schema`).get();
      if (schema && Array.isArray(schema.properties) && schema.properties.length > 0) {
        console.log('Schema registered.');
        return;
      }
    } catch {
      // Continue polling; provisioning state can briefly 404.
    }
    process.stdout.write('.');
  }
  throw new Error('Schema registration timed out after 15 minutes.');
}

function toGraphSchemaPayload(schema: GraphSchemaPayload): GraphSchemaPayload {
  return {
    baseType: schema.baseType,
    properties: schema.properties.map(({ aliases, ...property }) => property),
  };
}

async function main(): Promise<void> {
  await ensureConnection();
  await registerSchema();
  console.log('Provision complete.');
}

main().catch((e) => { console.error(e); process.exit(1); });
