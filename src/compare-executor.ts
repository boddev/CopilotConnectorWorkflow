import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import { ComparePlan, CompareRunState, compareRunDir, compareStatePath } from './compare';
import { createJob, fileHash, saveJob } from './jobs';
import { runPipeline } from './orchestrator';
import { runProcess } from './run';
import { resolveTools } from './tools';
import { JobConfig } from './types';
import { renderRawConnectorProject, writeRawItemsFromDataset } from './raw-connector';
import { buildDefaultInstructions } from './steps/step4-connector';
import { scoreResponseSet } from './scoring';
import { buildTargetEvalSet } from './evalset-builder';

export interface CompareExecutionResult {
  state: CompareRunState;
  reportPath: string;
}

interface DatasetExecutionSummary {
  slug: string;
  status: 'done' | 'failed' | 'blocked';
  enhancedJobId?: string;
  enhancedProject?: string;
  rawProject?: string;
  evalSet?: string;
  itemCounts?: { raw: number };
  diagnostics: string[];
}

export async function executeCompareRun(
  state: CompareRunState,
  emitter?: EventEmitter,
): Promise<CompareExecutionResult> {
  const runRoot = compareRunDir(state.id);
  const tools = resolveTools();
  state.status = 'running';
  writeState(state);

  const summaries: DatasetExecutionSummary[] = [];
  for (const plan of state.plans) {
    const summary = await executeDatasetPlan(plan, runRoot, tools, emitter);
    summaries.push(summary);
    if (summary.status === 'failed') state.status = 'failed';
    if (summary.status === 'blocked' && state.status !== 'failed') state.status = 'blocked';
    writeState(state);
  }
  if (state.status === 'running') state.status = 'done';
  writeState(state);

  const reportPath = path.join(runRoot, 'compare-run-report.md');
  fs.writeFileSync(reportPath, renderRunReport(state, summaries), 'utf-8');
  fs.writeFileSync(path.join(runRoot, 'compare-run-summary.json'), `${JSON.stringify({ state, summaries }, null, 2)}\n`, 'utf-8');
  return { state, reportPath };
}

async function executeDatasetPlan(
  plan: ComparePlan,
  runRoot: string,
  tools: ReturnType<typeof resolveTools>,
  emitter?: EventEmitter,
): Promise<DatasetExecutionSummary> {
  const diagnostics: string[] = [];
  const datasetRoot = path.join(runRoot, plan.slug);
  fs.mkdirSync(datasetRoot, { recursive: true });

  const evalSeed = await buildEvalSeed(plan, datasetRoot, diagnostics);
  const enhancedConfig: JobConfig = {
    dataset: plan.dataset,
    description: plan.description,
    count: Math.max(5, Math.min(50, plan.evalQuestionTarget)),
    extensions: plan.extensions,
    connectorId: plan.enhanced.connectorId,
    connectorName: plan.enhanced.connectorName,
    connectorDescription: plan.description,
    deployTarget: 'azure-functions',
    mode: plan.mode,
    aclMode: 'everyone',
    auth: plan.mode === 'provision' ? {
      tenantId: plan.tenantId,
      clientId: plan.clientId,
      clientSecretEnvVar: plan.clientSecretEnvVar,
      useManagedIdentity: plan.useManagedIdentity,
    } : undefined,
    agentName: plan.enhanced.agentName,
  };

  let job;
  try {
    job = createJob(enhancedConfig);
  } catch (e) {
    return fail(plan, e, diagnostics);
  }

  if (evalSeed) {
    const evalDir = path.join(job.workspace, '01-evalgen');
    fs.mkdirSync(evalDir, { recursive: true });
    fs.copyFileSync(evalSeed.csv, path.join(evalDir, 'eval.csv'));
    fs.copyFileSync(evalSeed.json, path.join(evalDir, 'eval.evalgen.json'));
    if (evalSeed.review) fs.copyFileSync(evalSeed.review, path.join(evalDir, 'eval-review.md'));
    job.steps.evalgen = {
      name: 'evalgen',
      status: 'done',
      outputs: {
        '01-evalgen/eval.csv': fileHash(path.join(evalDir, 'eval.csv')),
        '01-evalgen/eval.evalgen.json': fileHash(path.join(evalDir, 'eval.evalgen.json')),
      },
      artifacts: [path.join(evalDir, 'eval.csv'), path.join(evalDir, 'eval.evalgen.json')],
      diagnostics: [`used precomputed eval set from ${evalSeed.root}`],
    };
    saveJob(job);
  }

  const pipelineResult = await runPipeline({
    job,
    tools,
    emitter,
    startAt: evalSeed ? 'enhance' : undefined,
  });
  if (pipelineResult.status !== 'done') {
    return {
      slug: plan.slug,
      status: 'failed',
      enhancedJobId: job.id,
      diagnostics: diagnostics.concat(`enhanced pipeline failed; see ${job.workspace}`),
    };
  }

  const rawItems = path.join(datasetRoot, 'raw-items.jsonl');
  const rawBuild = await writeRawItemsFromDataset(plan.dataset, rawItems, 'everyone', plan.extensions);
  diagnostics.push(`built ${rawBuild.itemCount} RAW item(s) from ${rawBuild.filesProcessed} source file(s)`);

  const rawProject = path.join(job.workspace, '04-connector', 'connector-raw');
  const rawDescription = `RAW baseline for ${plan.enhanced.connectorName}. Source records are ingested without data enhancement for comparison against the enhanced connector.`;
  renderRawConnectorProject({
    projectDir: rawProject,
    connectorId: plan.raw.connectorId,
    connectorName: plan.raw.connectorName,
    connectorDescription: rawDescription,
    agentName: plan.raw.agentName,
    agentInstructions: buildDefaultInstructions({
      ...enhancedConfig,
      connectorId: plan.raw.connectorId,
      connectorName: plan.raw.connectorName,
      connectorDescription: rawDescription,
    }),
    tenantId: plan.tenantId,
    clientId: plan.clientId,
    useManagedIdentity: plan.useManagedIdentity,
    aclMode: 'everyone',
    dataset: plan.dataset,
    rawItemsJsonl: rawItems,
    tools,
  });

  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const rawLog = path.join(rawProject, 'raw-build.log');
  let result = await runProcess({
    cmd: npmCmd,
    args: ['install', '--no-audit', '--no-fund', '--loglevel=error'],
    cwd: rawProject,
    logFile: rawLog,
    emitter,
    label: `${plan.slug}:raw install`,
  });
  if (!result.ok) {
    return { slug: plan.slug, status: 'failed', enhancedJobId: job.id, rawProject, diagnostics: diagnostics.concat('RAW npm install failed') };
  }
  result = await runProcess({
    cmd: npmCmd,
    args: ['run', 'build'],
    cwd: rawProject,
    logFile: rawLog,
    emitter,
    label: `${plan.slug}:raw build`,
  });
  if (!result.ok) {
    return { slug: plan.slug, status: 'failed', enhancedJobId: job.id, rawProject, diagnostics: diagnostics.concat('RAW npm run build failed') };
  }

  if (plan.mode === 'provision') {
    const provision = await provisionAndIngest(plan, job.workspace, rawProject, emitter);
    diagnostics.push(...provision.diagnostics);
    if (!provision.ok) {
      return {
        slug: plan.slug,
        status: 'blocked',
        enhancedJobId: job.id,
        enhancedProject: path.join(job.workspace, '04-connector', 'connector'),
        rawProject,
        evalSet: path.join(job.workspace, '01-evalgen', 'eval.evalgen.json'),
        itemCounts: { raw: rawBuild.itemCount },
        diagnostics,
      };
    }
  }

  maybeScore(plan, job.workspace, datasetRoot, diagnostics);

  return {
    slug: plan.slug,
    status: 'done',
    enhancedJobId: job.id,
    enhancedProject: path.join(job.workspace, '04-connector', 'connector'),
    rawProject,
    evalSet: path.join(job.workspace, '01-evalgen', 'eval.evalgen.json'),
    itemCounts: { raw: rawBuild.itemCount },
    diagnostics,
  };
}

async function provisionAndIngest(
  plan: ComparePlan,
  workspace: string,
  rawProject: string,
  emitter?: EventEmitter,
): Promise<{ ok: boolean; diagnostics: string[] }> {
  const diagnostics: string[] = [];
  if (!plan.tenantId || !plan.clientId || (!plan.useManagedIdentity && !plan.clientSecretEnvVar)) {
    return {
      ok: false,
      diagnostics: ['provision mode requires tenantId, clientId, and clientSecretEnvVar unless useManagedIdentity is true'],
    };
  }
  const secret = plan.clientSecretEnvVar ? process.env[plan.clientSecretEnvVar] : undefined;
  if (!plan.useManagedIdentity && !secret) {
    return { ok: false, diagnostics: [`environment variable ${plan.clientSecretEnvVar} is not set for Graph client secret`] };
  }
  const env = {
    TENANT_ID: plan.tenantId,
    CLIENT_ID: plan.clientId,
    CLIENT_SECRET: secret || '',
    USE_MANAGED_IDENTITY: String(!!plan.useManagedIdentity),
  };
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  for (const [label, cwd] of [
    ['enhanced', path.join(workspace, '04-connector', 'connector')],
    ['raw', rawProject],
  ] as const) {
    for (const script of ['provision', 'ingest']) {
      const result = await runProcess({
        cmd: npmCmd,
        args: ['run', script],
        cwd,
        env,
        logFile: path.join(cwd, `${script}.log`),
        emitter,
        label: `${plan.slug}:${label}:${script}`,
      });
      diagnostics.push(`${label} ${script}: exit ${result.exitCode}`);
      if (!result.ok) return { ok: false, diagnostics };
    }
  }
  return { ok: true, diagnostics };
}

async function buildEvalSeed(
  plan: ComparePlan,
  datasetRoot: string,
  diagnostics: string[],
): Promise<{ root: string; csv: string; json: string; review?: string } | undefined> {
  const evalRoot = plan.evalSetDir || path.join(plan.dataset, 'evalset');
  const seedDir = fs.existsSync(evalRoot) ? evalRoot : undefined;
  const seeded = path.join(datasetRoot, 'seed-evalset');
  const built = await buildTargetEvalSet({
    dataset: plan.dataset,
    description: plan.description,
    outputDir: seeded,
    targetCount: plan.evalQuestionTarget,
    seedDir,
    extensions: plan.extensions,
  });
  diagnostics.push(
    `using eval set with ${built.itemCount} prompt(s); seeded ${built.seedCount}, generated ${built.generatedCount}, target ${plan.evalQuestionTarget}`,
  );
  return { root: seedDir || plan.dataset, csv: built.csv, json: built.json, review: built.review };
}

function firstExisting(...pathsToCheck: string[]): string {
  return pathsToCheck.find((candidate) => fs.existsSync(candidate)) || pathsToCheck[0];
}

function maybeScore(plan: ComparePlan, workspace: string, datasetRoot: string, diagnostics: string[]): void {
  const responseRoot = path.join(datasetRoot, 'responses');
  const enhancedCsv = path.join(responseRoot, 'enhanced', 'eval.csv');
  const rawCsv = path.join(responseRoot, 'raw', 'eval.csv');
  if (!fs.existsSync(enhancedCsv) || !fs.existsSync(rawCsv)) {
    diagnostics.push('response scoring skipped: enhanced/raw response CSV files were not present');
    return;
  }
  scoreResponseSet(
    path.join(workspace, '01-evalgen', 'eval.evalgen.json'),
    [
      { key: 'enhanced', name: plan.enhanced.agentName, connectorId: plan.enhanced.connectorId, responseCsv: enhancedCsv },
      { key: 'raw', name: plan.raw.agentName, connectorId: plan.raw.connectorId, responseCsv: rawCsv },
    ],
    responseRoot,
  );
  diagnostics.push(`response scoring complete: ${path.join(responseRoot, 'agent-response-scores.md')}`);
}

function countEvalItems(evalgenJson: string): number {
  const parsed = JSON.parse(fs.readFileSync(evalgenJson, 'utf-8')) as { items?: unknown[] };
  return Array.isArray(parsed.items) ? parsed.items.length : 0;
}

function fail(plan: ComparePlan, error: unknown, diagnostics: string[]): DatasetExecutionSummary {
  const message = error instanceof Error ? error.message : String(error);
  return { slug: plan.slug, status: 'failed', diagnostics: diagnostics.concat(message) };
}

function renderRunReport(state: CompareRunState, summaries: DatasetExecutionSummary[]): string {
  const lines = [
    `# Compare run ${state.id}`,
    '',
    `Status: **${state.status}**`,
    '',
    '| Dataset | Status | Enhanced job | RAW items | Diagnostics |',
    '|---|---|---|---:|---|',
  ];
  for (const summary of summaries) {
    lines.push(
      `| ${summary.slug} | ${summary.status} | ${summary.enhancedJobId || ''} | ` +
      `${summary.itemCounts?.raw ?? ''} | ${summary.diagnostics.map(escapeCell).join('<br>')} |`,
    );
  }
  lines.push('');
  lines.push('## Artifacts');
  lines.push('');
  for (const summary of summaries) {
    lines.push(`- **${summary.slug}**`);
    if (summary.enhancedProject) lines.push(`  - Enhanced connector: \`${summary.enhancedProject}\``);
    if (summary.rawProject) lines.push(`  - RAW connector: \`${summary.rawProject}\``);
    if (summary.evalSet) lines.push(`  - EvalGen sidecar: \`${summary.evalSet}\``);
  }
  return `${lines.join('\n')}\n`;
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|');
}

function writeState(state: CompareRunState): void {
  state.updatedAt = new Date().toISOString();
  fs.writeFileSync(compareStatePath(state.id), `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
}

