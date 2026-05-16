import { buildGraphClient, withRetry } from '../services/graphService';
import { connection } from '../models/connection';
import { connectorSchema } from '../references/schema';

async function ensureConnection(): Promise<void> {
  const client = buildGraphClient();
  try {
    await client.api(`/external/connections/${connection.connectionId}`).get();
    console.log(`Connection '${connection.connectionId}' exists.`);
  } catch (e: any) {
    if (e.statusCode === 404) {
      console.log(`Creating connection '${connection.connectionId}'...`);
      await withRetry(() => client.api('/external/connections').post({
        id: connection.connectionId,
        name: connection.connectionName,
        description: connection.connectionDescription,
      }));
    } else {
      throw e;
    }
  }
}

async function registerSchema(): Promise<void> {
  const client = buildGraphClient();
  console.log(`Registering schema for '${connection.connectionId}' (this can take up to 10 minutes)...`);
  await withRetry(() => client
    .api(`/external/connections/${connection.connectionId}/schema`)
    .header('Prefer', 'respond-async')
    .patch(connectorSchema));
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

async function main(): Promise<void> {
  await ensureConnection();
  await registerSchema();
  console.log('Provision complete.');
}

main().catch((e) => { console.error(e); process.exit(1); });
