import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { ToolPaths } from './tools';

export interface RawConnectorOptions {
  projectDir: string;
  connectorId: string;
  connectorName: string;
  connectorDescription: string;
  agentName: string;
  agentInstructions: string;
  tenantId?: string;
  clientId?: string;
  useManagedIdentity?: boolean;
  aclMode: 'everyone' | 'everyoneExceptGuests' | 'none';
  dataset: string;
  rawItemsJsonl: string;
  tools: ToolPaths;
}

export interface RawItemBuildResult {
  output: string;
  itemCount: number;
  filesProcessed: number;
}

interface ExternalItem {
  id: string;
  acl: Array<{ accessType: 'grant'; type: 'everyone' | 'everyoneExceptGuests'; value: string }>;
  properties: Record<string, unknown>;
  content: { type: 'text'; value: string };
}

const RAW_SCHEMA = {
  baseType: 'microsoft.graph.externalItem',
  properties: [
    { name: 'title', type: 'String', isSearchable: true, isQueryable: true, isRetrievable: true, labels: ['title'] },
    { name: 'url', type: 'String', isQueryable: true, isRetrievable: true, labels: ['url'] },
    { name: 'iconUrl', type: 'String', isRetrievable: true, labels: ['iconUrl'] },
    { name: 'sourceFile', type: 'String', isSearchable: true, isQueryable: true, isRetrievable: true },
    { name: 'sourceRow', type: 'Int64', isQueryable: true, isRetrievable: true },
    { name: 'rawJson', type: 'String', isSearchable: true, isRetrievable: true },
    { name: 'rawText', type: 'String', isSearchable: true, isRetrievable: true },
  ],
} as const;

const RAW_EXTENSIONS = new Set(['csv', 'tsv', 'json', 'jsonl', 'txt', 'md']);

export async function writeRawItemsFromDataset(
  datasetPath: string,
  outputJsonl: string,
  aclMode: 'everyone' | 'everyoneExceptGuests' | 'none',
  extensions?: string[],
): Promise<RawItemBuildResult> {
  const files = discoverRawFiles(datasetPath, extensions);
  fs.mkdirSync(path.dirname(outputJsonl), { recursive: true });
  const outputFd = fs.openSync(outputJsonl, 'w');

  let itemCount = 0;
  try {
    for (const file of files) {
      const ext = normalizeExtension(path.extname(file));
      const relativePath = relativeDatasetPath(datasetPath, file);
      const append = (item: ExternalItem): void => {
        fs.writeSync(outputFd, `${JSON.stringify(item)}\n`, undefined, 'utf-8');
        itemCount++;
      };

      if (ext === 'csv' || ext === 'tsv') {
        const delimiter = ext === 'tsv' ? '\t' : ',';
        const rows = parseDelimitedFile(file, delimiter);
        const header = rows[0] || [];
        for (let i = 1; i < rows.length; i++) {
          const record: Record<string, unknown> = {};
          for (let c = 0; c < header.length; c++) record[header[c] || `column_${c + 1}`] = rows[i]?.[c] ?? '';
          append(toRawExternalItem(record, relativePath, i, aclMode));
        }
      } else if (ext === 'json') {
        for (const { record, row } of readJsonRecords(file)) append(toRawExternalItem(record, relativePath, row, aclMode));
      } else if (ext === 'jsonl') {
        for await (const { record, row } of readJsonlRecords(file)) append(toRawExternalItem(record, relativePath, row, aclMode));
      } else {
        const text = stripBom(fs.readFileSync(file, 'utf-8'));
        append(toRawExternalItem({ text }, relativePath, 1, aclMode));
      }
    }
  } finally {
    fs.closeSync(outputFd);
  }

  return { output: outputJsonl, itemCount, filesProcessed: files.length };
}

export function renderRawConnectorProject(options: RawConnectorOptions): void {
  fs.rmSync(options.projectDir, { recursive: true, force: true });
  fs.mkdirSync(options.projectDir, { recursive: true });

  writeJson(path.join(options.projectDir, 'package.json'), {
    name: options.connectorId,
    version: '0.1.0',
    private: true,
    description: options.connectorDescription,
    scripts: {
      build: 'tsc',
      provision: 'node dist/src/scripts/provision.js',
      ingest: 'node dist/src/scripts/ingest.js',
      deprovision: 'node dist/src/scripts/deprovision.js',
    },
    dependencies: {
      '@azure/identity': '^4.4.1',
      '@microsoft/microsoft-graph-client': '^3.0.7',
      'isomorphic-fetch': '^3.0.0',
    },
    devDependencies: {
      '@types/node': '^20.14.0',
      typescript: '^5.5.0',
    },
  });
  copyTemplateFile(options.tools, 'tsconfig.json', path.join(options.projectDir, 'tsconfig.json'));

  writeJson(path.join(options.projectDir, 'local.settings.json'), {
    IsEncrypted: false,
    Values: {
      TENANT_ID: options.tenantId || '',
      CLIENT_ID: options.clientId || '',
      CLIENT_SECRET: '',
      USE_MANAGED_IDENTITY: String(!!options.useManagedIdentity),
      CONNECTION_ID: options.connectorId,
      CONNECTION_NAME: options.connectorName,
      CONNECTION_DESCRIPTION: options.connectorDescription,
      DATA_SOURCE_PATH: './data/raw-items.jsonl',
      ACL_MODE: options.aclMode,
      INGEST_CONCURRENCY: '16',
    },
  });
  fs.writeFileSync(
    path.join(options.projectDir, '.env.local.user'),
    `# Secrets - do NOT commit this file\nTENANT_ID=${options.tenantId || ''}\nCLIENT_ID=${options.clientId || ''}\nCLIENT_SECRET=\n`,
    'utf-8',
  );

  const dataDir = path.join(options.projectDir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.copyFileSync(options.rawItemsJsonl, path.join(dataDir, 'raw-items.jsonl'));

  const srcDir = path.join(options.projectDir, 'src');
  fs.mkdirSync(path.join(srcDir, 'models'), { recursive: true });
  fs.mkdirSync(path.join(srcDir, 'references'), { recursive: true });
  fs.mkdirSync(path.join(srcDir, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(srcDir, 'services'), { recursive: true });

  fs.writeFileSync(path.join(srcDir, 'models', 'connection.ts'), connectionTs(options), 'utf-8');
  fs.writeFileSync(path.join(srcDir, 'references', 'schema.ts'), schemaTs(), 'utf-8');
  fs.writeFileSync(path.join(srcDir, 'scripts', 'provision.ts'), provisionTs(), 'utf-8');
  fs.writeFileSync(path.join(srcDir, 'scripts', 'ingest.ts'), ingestTs(), 'utf-8');
  copyTemplateFile(options.tools, path.join('src', 'scripts', 'deprovision.ts'), path.join(srcDir, 'scripts', 'deprovision.ts'));
  copyTemplateFile(options.tools, path.join('src', 'services', 'graphService.ts'), path.join(srcDir, 'services', 'graphService.ts'));

  writeAppPackage(options);
  fs.writeFileSync(path.join(options.projectDir, 'README.md'), rawReadme(options), 'utf-8');
}

function discoverRawFiles(datasetPath: string, extensions?: string[]): string[] {
  const resolved = path.resolve(datasetPath);
  const extFilter = extensions && extensions.length > 0
    ? new Set(extensions.map(normalizeExtension).filter((ext) => RAW_EXTENSIONS.has(ext)))
    : RAW_EXTENSIONS;
  const files: string[] = [];
  const include = (filePath: string): void => {
    if (path.relative(resolved, filePath).split(path.sep).includes('evalset')) return;
    const ext = normalizeExtension(path.extname(filePath));
    if (extFilter.has(ext)) files.push(filePath);
  };
  const stat = fs.statSync(resolved);
  if (stat.isFile()) include(resolved);
  else {
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile()) include(full);
      }
    };
    walk(resolved);
  }
  return files.sort();
}

function parseDelimitedFile(filePath: string, delimiter: string): string[][] {
  return stripBom(fs.readFileSync(filePath, 'utf-8'))
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => parseDelimitedLine(line, delimiter));
}

function parseDelimitedLine(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cell += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === delimiter && !inQuotes) {
      cells.push(cell);
      cell = '';
    } else {
      cell += ch;
    }
  }
  cells.push(cell);
  return cells;
}

function readJsonRecords(filePath: string): Array<{ record: Record<string, unknown>; row: number }> {
  const content = stripBom(fs.readFileSync(filePath, 'utf-8'));
  try {
    const parsed = JSON.parse(content) as unknown;
    const records = Array.isArray(parsed) ? parsed : [parsed];
    return records.map((record, index) => ({ record: asRecord(record), row: index + 1 }));
  } catch {
    return content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line, index) => ({ record: asRecord(JSON.parse(line) as unknown), row: index + 1 }));
  }
}

async function* readJsonlRecords(filePath: string): AsyncIterable<{ record: Record<string, unknown>; row: number }> {
  const input = fs.createReadStream(filePath, { encoding: 'utf-8' });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let row = 0;
  for await (const line of lines) {
    const trimmed = stripBom(line).trim();
    if (!trimmed) continue;
    row++;
    yield { record: asRecord(JSON.parse(trimmed) as unknown), row };
  }
}

function toRawExternalItem(
  record: Record<string, unknown>,
  relativePath: string,
  row: number,
  aclMode: 'everyone' | 'everyoneExceptGuests' | 'none',
): ExternalItem {
  const rawJson = JSON.stringify(record);
  const title = firstString(record, ['title', 'name', 'primaryName', 'organization', 'country', 'id'])
    || `${relativePath} row ${row}`;
  const rawText = Object.entries(record)
    .map(([key, value]) => `${key}: ${stringifyValue(value)}`)
    .join('\n');
  return {
    id: stableId(`${relativePath}\u001f${row}\u001f${rawJson}`),
    acl: aclMode === 'none' ? [] : [{ accessType: 'grant', type: aclMode, value: aclMode }],
    properties: {
      title,
      url: `file:///raw/${relativePath.replace(/\\/g, '/')}${row ? `#row-${row}` : ''}`,
      iconUrl: 'https://res.cdn.office.net/assets/mail/file-icon/png/generic_16x16.png',
      sourceFile: relativePath.replace(/\\/g, '/'),
      sourceRow: row,
      rawJson,
      rawText,
    },
    content: { type: 'text', value: rawText || rawJson },
  };
}

function writeAppPackage(options: RawConnectorOptions): void {
  const appPkg = path.join(options.projectDir, 'appPackage');
  fs.mkdirSync(appPkg, { recursive: true });
  copyTemplateFile(options.tools, path.join('appPackage', 'icon-color.png'), path.join(appPkg, 'icon-color.png'));
  copyTemplateFile(options.tools, path.join('appPackage', 'icon-outline.png'), path.join(appPkg, 'icon-outline.png'));
  writeJson(path.join(appPkg, 'manifest.json'), {
    '$schema': 'https://developer.microsoft.com/json-schemas/teams/v1.23/MicrosoftTeams.schema.json',
    manifestVersion: '1.23',
    version: '1.0.0',
    id: '${{TEAMS_APP_ID}}',
    developer: {
      name: options.connectorName,
      websiteUrl: 'https://example.com',
      privacyUrl: 'https://example.com/privacy',
      termsOfUseUrl: 'https://example.com/terms',
    },
    name: { short: options.agentName, full: options.agentName },
    description: {
      short: options.connectorDescription.slice(0, 80),
      full: options.connectorDescription,
    },
    icons: { color: 'icon-color.png', outline: 'icon-outline.png' },
    accentColor: '#FFFFFF',
    copilotAgents: { declarativeAgents: [{ id: 'declarativeAgent', file: 'declarativeAgent.json' }] },
  });
  writeJson(path.join(appPkg, 'declarativeAgent.json'), {
    '$schema': 'https://developer.microsoft.com/json-schemas/copilot/declarative-agent/v1.0/schema.json',
    version: 'v1.0',
    name: options.agentName,
    description: options.connectorDescription,
    instructions: "$[file('instruction.txt')]",
    capabilities: [{ name: 'GraphConnectors', connections: [{ connection_id: options.connectorId }] }],
    conversation_starters: [
      { title: `Search ${options.connectorName}`, text: `What information is available in ${options.connectorName}?` },
      { title: 'Browse raw records', text: `Show examples of raw records from ${options.connectorName}` },
    ],
  });
  fs.writeFileSync(path.join(appPkg, 'instruction.txt'), options.agentInstructions, 'utf-8');
}

function connectionTs(options: RawConnectorOptions): string {
  return `export const connection = {
  connectionId: ${JSON.stringify(options.connectorId)},
  connectionName: ${JSON.stringify(options.connectorName)},
  connectionDescription: ${JSON.stringify(options.connectorDescription)},
  aclMode: ${JSON.stringify(options.aclMode)} as const,
};
`;
}

function schemaTs(): string {
  return `export const connectorSchema = ${JSON.stringify(RAW_SCHEMA, null, 2)} as const;
export type ConnectorSchema = typeof connectorSchema;
`;
}

function provisionTs(): string {
  return `import { buildGraphClient, withRetry } from '../services/graphService';
import { connection } from '../models/connection';
import { connectorSchema } from '../references/schema';

async function ensureConnection(): Promise<void> {
  const client = buildGraphClient();
  try {
    await client.api(\`/external/connections/\${connection.connectionId}\`).get();
    console.log(\`Connection '\${connection.connectionId}' exists.\`);
  } catch (e: any) {
    if (e.statusCode !== 404) throw e;
    await withRetry(() => client.api('/external/connections').post({
      id: connection.connectionId,
      name: connection.connectionName,
      description: connection.connectionDescription,
    }));
  }
}

async function registerSchema(): Promise<void> {
  const client = buildGraphClient();
  await withRetry(() => client
    .api(\`/external/connections/\${connection.connectionId}/schema\`)
    .header('Prefer', 'respond-async')
    .patch(connectorSchema));
  const deadline = Date.now() + 15 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 15_000));
    try {
      const schema = await client.api(\`/external/connections/\${connection.connectionId}/schema\`).get();
      if (schema && Array.isArray(schema.properties) && schema.properties.length > 0) return;
    } catch {
      // Schema registration can briefly 404 while Graph applies it.
    }
    process.stdout.write('.');
  }
  throw new Error('Schema registration timed out after 15 minutes.');
}

async function main(): Promise<void> {
  await ensureConnection();
  await registerSchema();
  console.log('RAW provision complete.');
}

main().catch((e) => { console.error(e); process.exit(1); });
`;
}

function ingestTs(): string {
  return `import * as fs from 'fs';
import * as path from 'path';
import { buildGraphClient, withRetry } from '../services/graphService';
import { connection } from '../models/connection';

const CONCURRENCY = Number(process.env.INGEST_CONCURRENCY || '16');

interface ExternalItem {
  id: string;
  acl: unknown[];
  properties: Record<string, unknown>;
  content: { type: 'text'; value: string };
}

async function* readItems(): AsyncIterable<ExternalItem> {
  const dataPath = process.env.DATA_SOURCE_PATH || './data/raw-items.jsonl';
  const resolved = path.isAbsolute(dataPath) ? dataPath : path.resolve(process.cwd(), dataPath);
  const fd = fs.openSync(resolved, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let carry = '';
  try {
    while (true) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      const text = carry + buffer.subarray(0, bytesRead).toString('utf-8');
      const lines = text.split(/\\r?\\n/);
      carry = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) yield JSON.parse(trimmed) as ExternalItem;
      }
    }
    const trimmed = carry.trim();
    if (trimmed) yield JSON.parse(trimmed) as ExternalItem;
  } finally {
    fs.closeSync(fd);
  }
}

async function ingestAll(): Promise<void> {
  const client = buildGraphClient();
  const inflight = new Set<Promise<void>>();
  let count = 0;
  let failed = 0;
  for await (const item of readItems()) {
    const work = (async (): Promise<void> => {
      try {
        await withRetry(() => client
          .api(\`/external/connections/\${connection.connectionId}/items/\${encodeURIComponent(item.id)}\`)
          .put({
            '@odata.type': '#microsoft.graph.externalConnectors.externalItem',
            acl: item.acl,
            properties: item.properties,
            content: item.content,
          }));
        count++;
        if (count % 50 === 0) console.log(\`Ingested \${count} RAW items...\`);
      } catch (e: any) {
        failed++;
        console.error(\`RAW item \${item.id} failed: \${e.message || e}\`);
      }
    })();
    inflight.add(work);
    work.finally(() => inflight.delete(work));
    if (inflight.size >= CONCURRENCY) await Promise.race(inflight);
  }
  await Promise.all(inflight);
  console.log(\`RAW ingestion complete: \${count} ok, \${failed} failed.\`);
  if (failed > 0) process.exit(1);
}

ingestAll().catch((e) => { console.error(e); process.exit(1); });
`;
}

function rawReadme(options: RawConnectorOptions): string {
  return `# ${options.connectorName}

RAW baseline Microsoft Graph connector generated by CopilotConnectorWorkflow.

This connector intentionally ingests unenhanced source records as generic raw JSON/text fields for enhanced-vs-RAW comparison runs.

| Property | Value |
|---|---|
| Connection ID | \`${options.connectorId}\` |
| ACL mode | \`${options.aclMode}\` |
| Data source | \`data/raw-items.jsonl\` |

Run \`npm install && npm run build\`, then \`npm run provision && npm run ingest\` after setting Graph app credentials in \`local.settings.json\` or \`.env.local.user\`.
`;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Expected object record, got ${JSON.stringify(value)}`);
  }
  return value as Record<string, unknown>;
}

function firstString(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
}

function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function stableId(value: string): string {
  return `raw-${crypto.createHash('sha256').update(value, 'utf-8').digest('hex').slice(0, 28)}`;
}

function relativeDatasetPath(datasetPath: string, filePath: string): string {
  const resolved = path.resolve(datasetPath);
  const stat = fs.statSync(resolved);
  return stat.isFile() ? path.basename(filePath) : path.relative(resolved, filePath);
}

function normalizeExtension(value: string): string {
  return value.toLowerCase().replace(/^\./, '');
}

function stripBom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

function copyTemplateFile(tools: ToolPaths, relative: string, dest: string): void {
  const source = path.join(tools.templatesRoot, 'connector-project', relative);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(source, dest);
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

