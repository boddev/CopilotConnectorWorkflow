import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { spawnSync } from 'child_process';
import { StepRecord, DeployTarget } from '../types';
import { fileHash, dirHash } from '../jobs';
import { isCached, stepInputsHash, RunStepOptions } from '../orchestrator';
import { newStepRecord, startStep, finishStep, writeStepStatus } from './step-utils';
import { renderFileToDir, renderString, renderTree } from '../templating';
import { runProcess } from '../run';

/** Step 5: render deploy artifacts; in provision mode also run the tenant-side lifecycle. */
export async function runStep5Deploy(opts: RunStepOptions): Promise<StepRecord> {
  const { job, tools, emitter, force } = opts;
  const rec = newStepRecord('deploy');
  const stepDir = path.join(job.workspace, '05-deploy');
  fs.mkdirSync(stepDir, { recursive: true });

  const projectDir = path.join(job.workspace, '04-connector', 'connector');
  if (!fs.existsSync(projectDir)) {
    finishStep(rec, 'failed', `connector project not found at ${projectDir}; run step 4 first`);
    writeStepStatus(stepDir, rec); return rec;
  }

  const target: DeployTarget = job.config.deployTarget;
  const templatesDeployRoot = path.join(tools.templatesRoot, 'deploy');
  const inputs = { target, projectHash: dirHash(projectDir), templatesHash: dirHash(templatesDeployRoot), connectorId: job.config.connectorId, mode: job.config.mode };
  const inputsHash = stepInputsHash([inputs]);
  rec.inputsHash = inputsHash;
  const prev = job.steps.deploy;
  // In provision mode we never cache-hit; the tenant-side lifecycle must run
  // (idempotently) every pipeline pass so the discovered agent id is fresh.
  if (job.config.mode === 'build' && !force && isCached(prev.inputsHash, inputsHash, prev.outputs, job.workspace)) {
    startStep(rec); finishStep(rec, 'skipped');
    rec.outputs = prev.outputs;
    rec.diagnostics?.push('cache hit (build mode)');
    writeStepStatus(stepDir, rec); return rec;
  }
  startStep(rec);

  const deployRoot = path.join(projectDir, 'deploy');
  fs.mkdirSync(deployRoot, { recursive: true });

  const values: Record<string, string> = {
    connectorId: job.config.connectorId,
    connectorName: job.config.connectorName,
    aclMode: job.config.aclMode,
    tenantId: job.config.auth?.tenantId || '',
    clientId: job.config.auth?.clientId || '',
  };

  const outputs: Record<string, string> = {};
  const artifacts: string[] = [];

  if (target === 'azure-functions' || target === 'both') {
    const dest = path.join(deployRoot, 'azure-functions');
    fs.mkdirSync(dest, { recursive: true });
    renderTree(path.join(templatesDeployRoot, 'azure-functions'), dest, values);
    artifacts.push(dest);
    for (const f of fs.readdirSync(dest)) {
      const abs = path.join(dest, f);
      const rel = path.relative(job.workspace, abs).replace(/\\/g, '/');
      outputs[rel] = fileHash(abs);
    }
  }
  if (target === 'azure-container-apps' || target === 'both') {
    const dest = path.join(deployRoot, 'azure-container-apps');
    fs.mkdirSync(dest, { recursive: true });
    renderTree(path.join(templatesDeployRoot, 'azure-container-apps'), dest, values);
    artifacts.push(dest);
    for (const f of fs.readdirSync(dest)) {
      const abs = path.join(dest, f);
      const rel = path.relative(job.workspace, abs).replace(/\\/g, '/');
      outputs[rel] = fileHash(abs);
    }
  }

  // Render the deploy README
  const deployMdSrc = path.join(templatesDeployRoot, 'deploy.md.hbs');
  if (fs.existsSync(deployMdSrc)) {
    const md = renderString(fs.readFileSync(deployMdSrc, 'utf-8'), values);
    const out = path.join(deployRoot, 'README.md');
    fs.writeFileSync(out, md, 'utf-8');
    outputs[path.relative(job.workspace, out).replace(/\\/g, '/')] = fileHash(out);
    artifacts.push(out);
  }

  rec.diagnostics?.push(`deploy target: ${target}`);

  // build mode: artifact-only; mark not comparable.
  if (job.config.mode !== 'provision') {
    rec.diagnostics?.push('build mode: tenant-side lifecycle skipped; job is not comparable');
    rec.outputs = outputs;
    rec.artifacts = artifacts;
    finishStep(rec, 'done');
    writeStepStatus(stepDir, rec);
    return rec;
  }

  // provision mode: run the tenant-side lifecycle.
  const lifecycleLog = path.join(stepDir, 'lifecycle.log');
  const lifecycleResources: {
    connectionId?: string;
    schemaRegisteredAt?: string;
    ingestStartedAt?: string;
    ingestEndedAt?: string;
    itemsIngested?: number;
    appId?: string;
    agentId?: string;
    publishedAt?: string;
  } = {};

  const env = buildProvisionEnv(job.config.auth);
  if (!env) {
    finishStep(rec, 'failed',
      'Step 5: provision mode requires auth.tenantId, auth.clientId, and either useManagedIdentity or clientSecretEnvVar.');
    writeStepStatus(stepDir, rec); return rec;
  }
  const secretVar = job.config.auth?.clientSecretEnvVar;
  if (secretVar && !process.env[secretVar]) {
    finishStep(rec, 'failed', `Step 5: environment variable ${secretVar} is not set (used for Graph client secret).`);
    writeStepStatus(stepDir, rec); return rec;
  }

  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

  // 1. Provision: external connection + schema register + poll.
  const provision = await runProcess({
    cmd: npmCmd, args: ['run', 'provision'], cwd: projectDir, env, emitter, label: 'provision', logFile: lifecycleLog,
  });
  if (!provision.ok) {
    finishStep(rec, 'failed', `Step 5: 'npm run provision' exit ${provision.exitCode}; see ${lifecycleLog}`);
    writeStepStatus(stepDir, rec); return rec;
  }
  lifecycleResources.connectionId = job.config.connectorId;
  lifecycleResources.schemaRegisteredAt = new Date().toISOString();

  // 2. Ingest seed items. Run twice (idempotent PUTs) to pick up any items
  //    dropped on the first pass due to transient throttling / SDK JSON-parse
  //    errors on throttle responses. Empirically the second pass at the same
  //    concurrency recovers nearly all dropped items because the throttle
  //    window has elapsed and the SDK retries are seeded with fresh tokens.
  lifecycleResources.ingestStartedAt = new Date().toISOString();
  const ingest = await runProcess({
    cmd: npmCmd, args: ['run', 'ingest'], cwd: projectDir, env, emitter, label: 'ingest', logFile: lifecycleLog,
  });
  lifecycleResources.ingestEndedAt = new Date().toISOString();
  if (!ingest.ok) {
    rec.diagnostics?.push(`first ingest pass exit ${ingest.exitCode} — items dropped; auto-retry pass scheduled.`);
  } else {
    rec.diagnostics?.push('first ingest pass succeeded; auto-retry pass scheduled for any straggling items.');
  }
  // Pass 2: always run (idempotent). The CONCURRENCY=4 default keeps this
  // cheap relative to the first pass for the small subset of failing items.
  const ingestRetry = await runProcess({
    cmd: npmCmd, args: ['run', 'ingest'], cwd: projectDir, env, emitter, label: 'ingest-retry', logFile: lifecycleLog,
  });
  lifecycleResources.ingestEndedAt = new Date().toISOString();
  if (!ingestRetry.ok && !ingest.ok) {
    finishStep(rec, 'failed',
      `Step 5: both ingest passes failed (first exit ${ingest.exitCode}, retry exit ${ingestRetry.exitCode}); see ${lifecycleLog}`);
    writeStepStatus(stepDir, rec); return rec;
  }
  if (!ingestRetry.ok) {
    rec.diagnostics?.push(`ingest-retry pass exit ${ingestRetry.exitCode}; some items may still be missing — see ${lifecycleLog}`);
  } else {
    rec.diagnostics?.push('ingest-retry pass completed cleanly.');
  }
  const itemsJsonl = path.join(projectDir, 'data', 'enhanced-items.jsonl');
  if (fs.existsSync(itemsJsonl)) {
    lifecycleResources.itemsIngested = fs.readFileSync(itemsJsonl, 'utf-8').split('\n').filter((l) => l.trim().length > 0).length;
  }

  // 3. Agent install/publish/discover. When `score.candidateAgentId` is set in
  //    config, trust it as-is. Otherwise try the Microsoft 365 Agents Toolkit
  //    CLI (`atk install --file-path appPackage.zip`) which is a soft dep —
  //    publishing is automated if `atk` is on PATH AND the operator is signed
  //    in via `atk auth login m365`. Fall back to the manual-step marker if
  //    `atk` is unavailable or publish fails.
  const candidateFromConfig = job.config.score?.candidateAgentId;
  if (target === 'local') {
    // Local test target: the goal is to create the external connection and
    // upload (ingest) data so the connector can be exercised locally — exactly
    // like running the CLI repeatedly against a tenant. No Azure deploy
    // artifacts are rendered (the azure-* branches above are skipped) and the
    // M365 agent is not published; Step 6 scoring is out of scope for local.
    rec.diagnostics?.push('deploy target: local — connector provisioned and data ingested; Azure deploy artifacts and agent publish skipped (local test mode)');
  } else if (candidateFromConfig) {
    lifecycleResources.agentId = candidateFromConfig;
    lifecycleResources.publishedAt = new Date().toISOString();
    rec.diagnostics?.push(`using pre-existing candidate agent id from config: ${candidateFromConfig}`);
  } else if (job.config.score?.skipAgentPublish) {
    rec.diagnostics?.push('score.skipAgentPublish=true: agent install skipped; supply --candidate-agent-id before Step 6');
  } else {
    const publishResult = await tryAutoPublishAgent({
      projectDir,
      logFile: lifecycleLog,
      diagnostics: rec.diagnostics || [],
    });
    if (publishResult.agentId) {
      lifecycleResources.agentId = publishResult.agentId;
      lifecycleResources.appId = publishResult.titleId;
      lifecycleResources.publishedAt = new Date().toISOString();
      rec.diagnostics?.push(`auto-published agent via Agents Toolkit: ${publishResult.agentId}`);
    } else {
      rec.diagnostics?.push(
        `agent auto-publish skipped (${publishResult.reason}); publish the appPackage/ via ` +
        `'atk install --file-path appPackage.zip' or Agents Toolkit UI, then rerun with ` +
        `--candidate-agent-id <T_*.declarativeAgent>, or set score.candidateAgentId in the job config.`,
      );
    }
  }

  const resourcesPath = path.join(stepDir, 'resources.json');
  fs.writeFileSync(resourcesPath, `${JSON.stringify(lifecycleResources, null, 2)}\n`, 'utf-8');
  outputs[path.relative(job.workspace, resourcesPath).replace(/\\/g, '/')] = fileHash(resourcesPath);
  artifacts.push(resourcesPath);
  rec.diagnostics?.push(`connection=${lifecycleResources.connectionId} items=${lifecycleResources.itemsIngested ?? '?'} agent=${lifecycleResources.agentId ?? '(manual)'}`);

  rec.outputs = outputs;
  rec.artifacts = artifacts;
  finishStep(rec, 'done');
  writeStepStatus(stepDir, rec);
  return rec;
}

function buildProvisionEnv(auth: import('../types').AuthConfig | undefined): NodeJS.ProcessEnv | undefined {
  if (!auth?.tenantId || !auth.clientId) return undefined;
  if (!auth.useManagedIdentity && !auth.clientSecretEnvVar) return undefined;
  const secret = auth.clientSecretEnvVar ? process.env[auth.clientSecretEnvVar] || '' : '';
  return {
    TENANT_ID: auth.tenantId,
    CLIENT_ID: auth.clientId,
    CLIENT_SECRET: secret,
    USE_MANAGED_IDENTITY: String(!!auth.useManagedIdentity),
  };
}

/* -------------------------------------------------------------------------- */
/* Agents Toolkit auto-publish (soft dependency)                              */
/* -------------------------------------------------------------------------- */

interface PublishResult {
  agentId?: string;
  titleId?: string;
  reason?: string;
}

/**
 * Try to publish the rendered appPackage via the Microsoft 365 Agents Toolkit
 * CLI (`atk install`). Returns the declarative agent id discoverable by Step 6,
 * or an explanation when the soft dependency is unavailable. Failures are NOT
 * fatal — Step 5 still records the manual-step marker so the operator can
 * publish out-of-band and rerun with --candidate-agent-id.
 */
async function tryAutoPublishAgent(opts: {
  projectDir: string;
  logFile: string;
  diagnostics: string[];
}): Promise<PublishResult> {
  // Node 20+ requires shell:true on Windows to spawn .cmd/.bat shims (otherwise
  // EINVAL). atk on Windows is atk.cmd; using shell:true with quoted args is
  // the right pattern.
  const isWin = process.platform === 'win32';
  const atkCmd = isWin ? 'atk.cmd' : 'atk';
  // Probe atk presence cheaply (--version). spawnSync returns error/non-zero
  // status if not installed; we degrade gracefully in either case.
  const probe = spawnSync(atkCmd, ['--version'], { shell: isWin, encoding: 'utf-8' });
  if (probe.error || probe.status !== 0) {
    return { reason: `atk CLI not available on PATH (${probe.error?.message || `exit ${probe.status}`})` };
  }
  const appPkgDir = path.join(opts.projectDir, 'appPackage');
  if (!fs.existsSync(appPkgDir)) {
    return { reason: `appPackage directory not found at ${appPkgDir}` };
  }

  const zipPath = path.join(opts.projectDir, 'appPackage.zip');
  try {
    writeStoreZip(appPkgDir, zipPath);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { reason: `failed to zip appPackage: ${msg}` };
  }
  appendLog(opts.logFile, `\n[atk install] zipped appPackage → ${zipPath} (${fs.statSync(zipPath).size} bytes)\n`);

  // Invoke atk install. Capture stdout+stderr to extract the TitleId.
  // Quote zipPath because shell:true on Windows splits on whitespace.
  const quotedZip = isWin ? `"${zipPath}"` : zipPath;
  const install = spawnSync(atkCmd, ['install', '--file-path', quotedZip], {
    shell: isWin,
    encoding: 'utf-8',
    cwd: opts.projectDir,
  });
  const stdout = install.stdout || '';
  const stderr = install.stderr || '';
  appendLog(opts.logFile, `\n[atk install] stdout:\n${stdout}\n[atk install] stderr:\n${stderr}\n`);
  if (install.status !== 0) {
    return { reason: `atk install exit ${install.status}; see lifecycle log` };
  }
  // Parse TitleId from output. The TitleId line looks like:
  //   "TitleId: T_2c68f7c8-d8db-b80e-fdbc-a95b30ee..."
  // The match is intentionally tolerant of surrounding decoration.
  const all = `${stdout}\n${stderr}`;
  const m = all.match(/T_[0-9a-fA-F-]{8,}/);
  if (!m) {
    return { reason: 'atk install succeeded but TitleId not found in output' };
  }
  const titleId = m[0];
  // M365 declarative agent IDs use `<TitleId>.declarativeAgent` for A2A.
  return { agentId: `${titleId}.declarativeAgent`, titleId };
}

function appendLog(file: string, text: string): void {
  try { fs.appendFileSync(file, text, 'utf-8'); } catch { /* best-effort */ }
}

/* -------------------------------------------------------------------------- */
/* Minimal ZIP writer (STORE mode only, no deps)                              */
/* -------------------------------------------------------------------------- */

/**
 * Write a ZIP archive containing every file in `srcDir` (one level deep) to
 * `destZip`. Uses STORE (no compression) entries — appPackage contents are
 * tiny (manifest.json, declarativeAgent.json, instruction.txt, PNG icons)
 * so compression buys almost nothing and adds a deflate dependency surface.
 * Avoids adding a third-party zip library to keep the deps footprint minimal.
 *
 * Exported for tests; not part of the Step 5 stable surface.
 */
export function writeStoreZip(srcDir: string, destZip: string): void {
  const files = fs.readdirSync(srcDir, { withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => d.name)
    .filter((n) => n !== 'appPackage.zip');

  interface CDEntry {
    name: string;
    crc32: number;
    size: number;
    offset: number;
  }
  const cdEntries: CDEntry[] = [];
  const chunks: Buffer[] = [];
  let offset = 0;

  for (const name of files) {
    const data = fs.readFileSync(path.join(srcDir, name));
    const crc = crc32(data);
    const nameBuf = Buffer.from(name, 'utf-8');
    // Local file header
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);   // signature
    lfh.writeUInt16LE(20, 4);           // version needed
    lfh.writeUInt16LE(0, 6);            // flags
    lfh.writeUInt16LE(0, 8);            // method=STORE
    lfh.writeUInt16LE(0, 10);           // mod time
    lfh.writeUInt16LE(0, 12);           // mod date
    lfh.writeUInt32LE(crc, 14);         // crc-32
    lfh.writeUInt32LE(data.length, 18); // compressed size
    lfh.writeUInt32LE(data.length, 22); // uncompressed size
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);           // extra length
    chunks.push(lfh, nameBuf, data);
    cdEntries.push({ name, crc32: crc, size: data.length, offset });
    offset += lfh.length + nameBuf.length + data.length;
  }

  const cdStart = offset;
  for (const e of cdEntries) {
    const nameBuf = Buffer.from(e.name, 'utf-8');
    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);   // central dir signature
    cdh.writeUInt16LE(20, 4);           // version made by
    cdh.writeUInt16LE(20, 6);           // version needed
    cdh.writeUInt16LE(0, 8);            // flags
    cdh.writeUInt16LE(0, 10);           // method
    cdh.writeUInt16LE(0, 12);           // mod time
    cdh.writeUInt16LE(0, 14);           // mod date
    cdh.writeUInt32LE(e.crc32, 16);
    cdh.writeUInt32LE(e.size, 20);
    cdh.writeUInt32LE(e.size, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt16LE(0, 30);           // extra
    cdh.writeUInt16LE(0, 32);           // comment
    cdh.writeUInt16LE(0, 34);           // disk #
    cdh.writeUInt16LE(0, 36);           // internal attrs
    cdh.writeUInt32LE(0, 38);           // external attrs
    cdh.writeUInt32LE(e.offset, 42);    // local header offset
    chunks.push(cdh, nameBuf);
    offset += cdh.length + nameBuf.length;
  }

  const cdSize = offset - cdStart;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(cdEntries.length, 8);
  eocd.writeUInt16LE(cdEntries.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(0, 20);            // comment length
  chunks.push(eocd);

  fs.writeFileSync(destZip, Buffer.concat(chunks));
  // `zlib` import is used here only to share the well-known CRC32 table
  // initialization pattern; the actual computation is inlined in crc32().
  void zlib;
}

let crc32Table: Uint32Array | undefined;
function crc32(buf: Buffer): number {
  if (!crc32Table) {
    crc32Table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) {
        c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      }
      crc32Table[i] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = (crc32Table[(c ^ buf[i]) & 0xff] ^ (c >>> 8)) >>> 0;
  }
  return (c ^ 0xffffffff) >>> 0;
}
