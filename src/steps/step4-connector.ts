import * as fs from 'fs';
import * as path from 'path';
import { JobConfig, JobRecord, StepRecord } from '../types';
import { runProcess } from '../run';
import { fileHash, dirHash } from '../jobs';
import { isCached, stepInputsHash, RunStepOptions } from '../orchestrator';
import { newStepRecord, startStep, finishStep, writeStepStatus } from './step-utils';
import { renderTree } from '../templating';
import { ToolPaths } from '../tools';

export function buildDefaultInstructions(config: JobConfig): string {
  const desc = config.connectorDescription || config.description;
  return `You are an AI assistant for ${config.connectorName}.

Your primary knowledge source is the ${config.connectorName} connector, which contains: ${desc}

Guidelines:
- Always search the ${config.connectorName} connector for relevant information before answering.
- Include citation links so users can navigate to the source content.
- When reporting counts or aggregates, note that results may be a subset and should not be treated as exact totals.
- If asked about specific items by ID, use exact match search.
- Prefer the most recently modified items when recency matters.
- Always provide helpful, accurate answers based on the connector data.
- Preserve exact source values for identifiers, titles, summaries, phone numbers, fax numbers, addresses, dates, taxonomy codes, byte counts, record counts, and URLs. Do not reformat punctuation, hyphens, casing, ZIP/postal codes, or numeric digit groups when the connector returns an exact value.
- When a user asks for a full record, full details, or registry details, include the exact connector title and summary before summarizing the remaining fields.
- When listing contact or address fields, quote the exact connector string as returned, then optionally add a normalized explanation only after the exact value.`;
}

/**
 * Renders the connector project template tree and writes all agent package files.
 * Exported for testing (does not run npm install/build).
 */
export function renderConnectorProject(
  job: JobRecord,
  tools: ToolPaths,
  projectDir: string,
  schemaTs: string,
  schemaJson: string,
  itemsJsonl: string,
): void {
  const agentName = job.config.agentName || `${job.config.connectorName} Assistant`;
  const agentInstructions = job.config.agentInstructions || buildDefaultInstructions(job.config);
  const connectorDescription = job.config.connectorDescription || job.config.description;

  const urlToItemResolverBlock = job.config.urlPrefix
    ? `export const urlToItemResolver = {
  urlMatchInfo: {
    baseUrls: ['${job.config.urlPrefix}'],
    urlPattern: '${job.config.urlPrefix}/(?<itemId>[^/?#]+)',
  },
  itemId: '{itemId}',
};`
    : `// urlToItemResolver is not configured.
// Set --url-prefix when running \`ccw run\` to activate URL unfurling.
// Example:
//   export const urlToItemResolver = {
//     urlMatchInfo: {
//       baseUrls: ['https://YOUR_SOURCE_DOMAIN.example.com'],
//       urlPattern: 'https://YOUR_SOURCE_DOMAIN.example.com/(?<itemId>[^/?#]+)',
//     },
//     itemId: '{itemId}',
//   };`;

  const values: Record<string, string> = {
    connectorId: job.config.connectorId,
    connectorName: job.config.connectorName,
    connectorDescription,
    aclMode: job.config.aclMode,
    tenantId: job.config.auth?.tenantId || '',
    clientId: job.config.auth?.clientId || '',
    useManagedIdentity: String(!!job.config.auth?.useManagedIdentity),
    agentName,
    agentInstructionsEscaped: JSON.stringify(agentInstructions).slice(1, -1),
    urlPrefix: job.config.urlPrefix || '',
    urlToItemResolverBlock,
  };

  const templatesDir = path.join(tools.templatesRoot, 'connector-project');
  renderTree(templatesDir, projectDir, values);

  // Build appPackage files programmatically to avoid JSON injection from user-supplied strings
  const appPkgDir = path.join(projectDir, 'appPackage');
  fs.mkdirSync(appPkgDir, { recursive: true });

  const manifest = {
    '$schema': 'https://developer.microsoft.com/json-schemas/teams/v1.23/MicrosoftTeams.schema.json',
    manifestVersion: '1.23',
    version: '1.0.0',
    id: '${{TEAMS_APP_ID}}',
    developer: {
      name: job.config.connectorName,
      websiteUrl: 'https://example.com',
      privacyUrl: 'https://example.com/privacy',
      termsOfUseUrl: 'https://example.com/terms',
    },
    name: { short: agentName, full: agentName },
    description: {
      short: connectorDescription.slice(0, 80),
      full: connectorDescription,
    },
    icons: { color: 'icon-color.png', outline: 'icon-outline.png' },
    accentColor: '#FFFFFF',
    copilotAgents: {
      declarativeAgents: [{ id: 'declarativeAgent', file: 'declarativeAgent.json' }],
    },
  };
  fs.writeFileSync(path.join(appPkgDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');

  const declarativeAgent = {
    '$schema': 'https://developer.microsoft.com/json-schemas/copilot/declarative-agent/v1.0/schema.json',
    version: 'v1.0',
    name: agentName,
    description: connectorDescription,
    instructions: "$[file('instruction.txt')]",
    capabilities: [{
      name: 'GraphConnectors',
      connections: [{ connection_id: job.config.connectorId }],
    }],
    conversation_starters: [
      { title: `Search ${job.config.connectorName}`, text: `What information is available in ${job.config.connectorName}?` },
      { title: 'Browse topics', text: `What topics are covered in ${job.config.connectorName}?` },
      { title: 'Recent items', text: `Show me the most recently updated items in ${job.config.connectorName}` },
    ],
  };
  fs.writeFileSync(path.join(appPkgDir, 'declarativeAgent.json'), JSON.stringify(declarativeAgent, null, 2), 'utf-8');

  fs.writeFileSync(path.join(appPkgDir, 'instruction.txt'), agentInstructions, 'utf-8');

  // Drop schema.ts into src/references
  const refDir = path.join(projectDir, 'src', 'references');
  fs.mkdirSync(refDir, { recursive: true });
  fs.copyFileSync(schemaTs, path.join(refDir, 'schema.ts'));
  fs.copyFileSync(schemaJson, path.join(refDir, 'connector-schema.json'));

  // Drop enhanced-items.jsonl into data/
  const dataDir = path.join(projectDir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.copyFileSync(itemsJsonl, path.join(dataDir, 'enhanced-items.jsonl'));

  // Bundle the TypeScript batch enhancer from CopilotConnectorSkill into the connector
  // so data can be re-enhanced from within the project without external dependencies.
  const customDir = path.join(projectDir, 'src', 'custom');
  fs.mkdirSync(customDir, { recursive: true });
  if (tools.tsDataEnhancer && fs.existsSync(tools.tsDataEnhancer)) {
    fs.copyFileSync(tools.tsDataEnhancer, path.join(customDir, 'batchEnhancer.ts'));
  }

  // Generate refresh-data.ts script for re-running batch enhancement from the connector
  const scriptsDir = path.join(projectDir, 'src', 'scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });
  const refreshDataTs = generateRefreshDataScript(job.config.aclMode);
  fs.writeFileSync(path.join(scriptsDir, 'refresh-data.ts'), refreshDataTs, 'utf-8');
}

/**
 * Generates the refresh-data.ts script that re-runs batch enhancement
 * against a new dataset, updating data/enhanced-items.jsonl in place.
 *
 * Uses the bundled batchEnhancer.ts (from CopilotConnectorSkill) via direct
 * TypeScript import — no external dependencies or subprocess needed.
 */
function generateRefreshDataScript(defaultAclMode: string): string {
  return `// src/scripts/refresh-data.ts
// Re-run batch enhancement against a new/updated dataset.
//
// Usage:
//   npm run build && node dist/src/scripts/refresh-data.js \\
//     --dataset <path-to-dataset> \\
//     --output ./data \\
//     [--eval <path-to-eval-sidecar.json>] \\
//     [--acl-mode everyone|everyoneExceptGuests|none]
//
// The command regenerates data/enhanced-items.jsonl and data/schema-suggestion.json.
// After running, restart ingestion (npm run ingest) to push the new items to Graph.

import * as path from 'path';
import { main } from '../custom/batchEnhancer';

// Merge default --output and --acl-mode into argv if not already provided
const argv = process.argv.slice(2);
if (!argv.includes('--output')) {
  argv.push('--output', path.resolve(__dirname, '..', '..', 'data'));
}
if (!argv.includes('--acl-mode')) {
  argv.push('--acl-mode', process.env.ACL_MODE || '${defaultAclMode}');
}

process.exit(main(argv));
`;
}

/**
 * Step 4: render the connector project from templates/, copy schema + items into it,
 * run \`npm install\` + \`npm run build\` to verify it compiles.
 */
export async function runStep4Connector(opts: RunStepOptions): Promise<StepRecord> {
  const { job, tools, emitter, force } = opts;
  const rec = newStepRecord('connector');
  const stepDir = path.join(job.workspace, '04-connector');
  const projectDir = path.join(stepDir, 'connector');
  fs.mkdirSync(projectDir, { recursive: true });
  const logFile = path.join(stepDir, 'step.log');

  const schemaTs = path.join(job.workspace, '03-schema', 'schema.ts');
  const schemaJson = path.join(job.workspace, '03-schema', 'connector-schema.json');
  const itemsJsonl = path.join(job.workspace, '02-enhance', 'enhanced-items.jsonl');
  for (const f of [schemaTs, schemaJson, itemsJsonl]) {
    if (!fs.existsSync(f)) {
      finishStep(rec, 'failed', `missing input: ${f}`);
      writeStepStatus(stepDir, rec); return rec;
    }
  }

  const agentName = job.config.agentName || `${job.config.connectorName} Assistant`;
  const agentInstructions = job.config.agentInstructions || buildDefaultInstructions(job.config);
  const templatesDir = path.join(tools.templatesRoot, 'connector-project');
  const inputs = {
    config: {
      connectorId: job.config.connectorId,
      connectorName: job.config.connectorName,
      connectorDescription: job.config.connectorDescription || job.config.description,
      aclMode: job.config.aclMode,
      tenantId: job.config.auth?.tenantId || '',
      clientId: job.config.auth?.clientId || '',
      useManagedIdentity: !!job.config.auth?.useManagedIdentity,
      agentName,
      agentInstructions,
    },
    schemaTsHash: fileHash(schemaTs),
    schemaJsonHash: fileHash(schemaJson),
    itemsHash: fileHash(itemsJsonl),
    templatesHash: dirHash(templatesDir),
    tsEnhancerHash: tools.tsDataEnhancer && fs.existsSync(tools.tsDataEnhancer)
      ? fileHash(tools.tsDataEnhancer)
      : 'none',
  };
  const inputsHash = stepInputsHash([inputs]);
  rec.inputsHash = inputsHash;

  const prev = job.steps.connector;
  if (!force && isCached(prev.inputsHash, inputsHash, prev.outputs, job.workspace)) {
    startStep(rec); finishStep(rec, 'skipped');
    rec.outputs = prev.outputs;
    rec.diagnostics?.push('cache hit');
    writeStepStatus(stepDir, rec); return rec;
  }
  startStep(rec);

  // Clean previous render
  for (const name of fs.readdirSync(projectDir)) {
    fs.rmSync(path.join(projectDir, name), { recursive: true, force: true });
  }

  renderConnectorProject(job, tools, projectDir, schemaTs, schemaJson, itemsJsonl);

  // npm install
  emitter?.emit('log', { label: 'connector', text: '\nRunning npm install (this can take a minute)...\n' });
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const install = await runProcess({
    cmd: npmCmd, args: ['install', '--no-audit', '--no-fund', '--loglevel=error'],
    cwd: projectDir, logFile, emitter, label: 'npm install',
  });
  if (!install.ok) {
    finishStep(rec, 'failed', `npm install exit ${install.exitCode}`);
    writeStepStatus(stepDir, rec); return rec;
  }

  // npm run build
  const build = await runProcess({
    cmd: npmCmd, args: ['run', 'build'],
    cwd: projectDir, logFile, emitter, label: 'tsc',
  });
  if (!build.ok) {
    finishStep(rec, 'failed', `npm run build exit ${build.exitCode}`);
    writeStepStatus(stepDir, rec); return rec;
  }

  const refDir = path.join(projectDir, 'src', 'references');
  const dataDir = path.join(projectDir, 'data');
  const appPkgDir = path.join(projectDir, 'appPackage');
  const batchEnhancerDest = path.join(projectDir, 'src', 'custom', 'batchEnhancer.ts');
  const refreshDataDest = path.join(projectDir, 'src', 'scripts', 'refresh-data.ts');
  rec.outputs = {
    '04-connector/connector/package.json': fileHash(path.join(projectDir, 'package.json')),
    '04-connector/connector/src/references/schema.ts': fileHash(path.join(refDir, 'schema.ts')),
    '04-connector/connector/data/enhanced-items.jsonl': fileHash(path.join(dataDir, 'enhanced-items.jsonl')),
    '04-connector/connector/appPackage/manifest.json': fileHash(path.join(appPkgDir, 'manifest.json')),
    '04-connector/connector/appPackage/declarativeAgent.json': fileHash(path.join(appPkgDir, 'declarativeAgent.json')),
    '04-connector/connector/appPackage/instruction.txt': fileHash(path.join(appPkgDir, 'instruction.txt')),
    '04-connector/connector/src/custom/enhancer.ts': fileHash(path.join(projectDir, 'src', 'custom', 'enhancer.ts')),
    '04-connector/connector/src/scripts/refresh-data.ts': fileHash(refreshDataDest),
    '04-connector/connector/teamsapp.yml': fileHash(path.join(projectDir, 'teamsapp.yml')),
  };
  if (fs.existsSync(batchEnhancerDest)) {
    rec.outputs['04-connector/connector/src/custom/batchEnhancer.ts'] = fileHash(batchEnhancerDest);
  }
  rec.artifacts = [projectDir];
  rec.diagnostics?.push(`connector project rendered at ${projectDir}`);
  finishStep(rec, 'done');
  writeStepStatus(stepDir, rec);
  return rec;
}
