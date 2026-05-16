import { app, InvocationContext, Timer } from '@azure/functions';
import { buildGraphClient, withRetry } from '../services/graphService';
import { connection } from '../models/connection';
import { defaultDataSource } from '../custom/dataSource';

/** Timer-triggered full crawl. Default: daily at 02:00 UTC. */
app.timer('crawlTimer', {
  schedule: '0 0 2 * * *',
  handler: async (_t: Timer, ctx: InvocationContext) => {
    ctx.log(`Crawl starting for connection '${connection.connectionId}'.`);
    const client = buildGraphClient();
    const source = defaultDataSource();
    let count = 0;
    for await (const item of source.fetchItems()) {
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
      } catch (e: any) {
        ctx.error(`Item ${item.id} failed: ${e.message || e}`);
      }
    }
    ctx.log(`Crawl complete. Ingested ${count} items.`);
  },
});

/** HTTP-triggered crawl (manual). */
app.http('crawlHttp', {
  methods: ['POST'],
  authLevel: 'function',
  handler: async (_req, ctx) => {
    ctx.log('Manual crawl invoked.');
    const client = buildGraphClient();
    const source = defaultDataSource();
    let count = 0;
    for await (const item of source.fetchItems()) {
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
      } catch (e: any) {
        ctx.error(`Item ${item.id} failed: ${e.message || e}`);
      }
    }
    return { status: 200, jsonBody: { ingested: count } };
  },
});
