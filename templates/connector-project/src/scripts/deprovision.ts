import { buildGraphClient, withRetry } from '../services/graphService';
import { connection } from '../models/connection';

async function main(): Promise<void> {
  const client = buildGraphClient();
  console.log(`Deleting connection '${connection.connectionId}'...`);
  await withRetry(() => client.api(`/external/connections/${connection.connectionId}`).delete());
  console.log('Deleted.');
}

main().catch((e) => { console.error(e); process.exit(1); });
