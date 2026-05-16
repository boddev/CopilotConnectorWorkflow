import * as fs from 'fs';
import * as path from 'path';
import { StepRecord } from '../types';
import { runProcess } from '../run';
import { fileHash, dirHash } from '../jobs';
import { isCached, stepInputsHash, RunStepOptions } from '../orchestrator';
import { newStepRecord, startStep, finishStep, writeStepStatus } from './step-utils';
import { renderTree } from '../templating';

/**
 * Step 4: render the connector project from templates/, copy schema + items into it,
 * run `npm install` + `npm run build` to verify it compiles.
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
    },
    schemaTsHash: fileHash(schemaTs),
    schemaJsonHash: fileHash(schemaJson),
    itemsHash: fileHash(itemsJsonl),
    templatesHash: dirHash(templatesDir),
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

  // 1. Clean previous render
  for (const name of fs.readdirSync(projectDir)) {
    fs.rmSync(path.join(projectDir, name), { recursive: true, force: true });
  }

  // 2. Render template tree
  const values: Record<string, string> = {
    connectorId: inputs.config.connectorId,
    connectorName: inputs.config.connectorName,
    connectorDescription: inputs.config.connectorDescription,
    aclMode: inputs.config.aclMode,
    tenantId: inputs.config.tenantId,
    clientId: inputs.config.clientId,
    useManagedIdentity: String(inputs.config.useManagedIdentity),
  };
  renderTree(templatesDir, projectDir, values);

  // 3. Drop schema.ts into src/references
  const refDir = path.join(projectDir, 'src', 'references');
  fs.mkdirSync(refDir, { recursive: true });
  fs.copyFileSync(schemaTs, path.join(refDir, 'schema.ts'));
  fs.copyFileSync(schemaJson, path.join(refDir, 'connector-schema.json'));

  // 4. Drop enhanced-items.jsonl into data/
  const dataDir = path.join(projectDir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.copyFileSync(itemsJsonl, path.join(dataDir, 'enhanced-items.jsonl'));

  // 5. npm install
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

  // 6. npm run build
  const build = await runProcess({
    cmd: npmCmd, args: ['run', 'build'],
    cwd: projectDir, logFile, emitter, label: 'tsc',
  });
  if (!build.ok) {
    finishStep(rec, 'failed', `npm run build exit ${build.exitCode}`);
    writeStepStatus(stepDir, rec); return rec;
  }

  rec.outputs = {
    '04-connector/connector/package.json': fileHash(path.join(projectDir, 'package.json')),
    '04-connector/connector/src/references/schema.ts': fileHash(path.join(refDir, 'schema.ts')),
    '04-connector/connector/data/enhanced-items.jsonl': fileHash(path.join(dataDir, 'enhanced-items.jsonl')),
  };
  rec.artifacts = [projectDir];
  rec.diagnostics?.push(`connector project rendered at ${projectDir}`);
  finishStep(rec, 'done');
  writeStepStatus(stepDir, rec);
  return rec;
}
