import { buildGraphClient, withRetry } from '../services/graphService';
import { connection } from '../models/connection';
import { defaultDataSource } from '../custom/dataSource';

// Default to 4 concurrent in-flight PUTs. Higher values (16+) frequently
// trigger Microsoft Graph external-connector throttling that the SDK reports
// as JSON parse errors at request positions 2400-2600 — the SDK is trying to
// JSON.parse a non-JSON 503/throttle body. At concurrency=4 we see ~99%+
// ingest success on a 50k-row CSV; at 16 we saw ~90%. Operators with extra
// tenant throughput headroom can raise this via INGEST_CONCURRENCY.
const CONCURRENCY = Number(process.env.INGEST_CONCURRENCY || '4');

async function ingestAll(): Promise<void> {
  console.log(`Ingest concurrency: ${CONCURRENCY} (override via INGEST_CONCURRENCY env var).`);
  const client = buildGraphClient();
  const source = defaultDataSource();
  let count = 0;
  let failed = 0;
  const inflight = new Set<Promise<void>>();

  for await (const item of source.fetchItems()) {
    const work: Promise<void> = (async () => {
      try {
        await withRetry(() =>
          client
            .api(`/external/connections/${connection.connectionId}/items/${encodeURIComponent(item.id)}`)
            .put({
              '@odata.type': '#microsoft.graph.externalConnectors.externalItem',
              acl: item.acl,
              properties: item.properties,
              content: item.content,
            })
        );
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
  console.log(`Ingestion complete: ${count} ok, ${failed} ingest-failed.`);
  if (failed > 0) process.exit(1);
}

ingestAll().catch((e) => { console.error(e); process.exit(1); });
