import { buildGraphClient, withRetry } from '../services/graphService';
import { connection } from '../models/connection';
import { defaultDataSource } from '../custom/dataSource';

const CONCURRENCY = 4;

async function ingestAll(): Promise<void> {
  const client = buildGraphClient();
  const source = defaultDataSource();
  let count = 0;
  let failed = 0;
  const inflight = new Set<Promise<void>>();
  for await (const item of source.fetchItems()) {
    const work: Promise<void> = (async () => {
      try {
        await withRetry(() => client
          .api(`/external/connections/${connection.connectionId}/items/${encodeURIComponent(item.id)}`)
          .put({
            '@odata.type': '#microsoft.graph.externalConnectors.externalItem',
            acl: item.acl,
            properties: item.properties,
            content: item.content,
          }));
        count++;
        if (count % 50 === 0) console.log(`Ingested ${count} items...`);
      } catch (e: any) {
        failed++;
        console.error(`Item ${item.id} failed: ${e.message || e}`);
      }
    })();
    inflight.add(work);
    work.finally(() => inflight.delete(work));
    if (inflight.size >= CONCURRENCY) await Promise.race(inflight);
  }
  await Promise.all(inflight);
  console.log(`Ingestion complete: ${count} ok, ${failed} failed.`);
  if (failed > 0) process.exit(1);
}

ingestAll().catch((e) => { console.error(e); process.exit(1); });
