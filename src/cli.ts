#!/usr/bin/env node

import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import { createJob, loadJob, listJobs } from './jobs';
import { runPipeline } from './orchestrator';
import { resolveTools, probeTools } from './tools';
import { JobConfig, RunMode, DeployTarget, StepName, ALL_STEPS, M365Evaluator } from './types';
import { createCompareBatchRun, createCompareDatasetRun, formatCompareState } from './compare';
import { executeCompareRun } from './compare-executor';

interface ParsedArgs {
  cmd: string;
  flags: Record<string, string>;
  booleans: Record<string, boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const cmd = argv[0] || 'help';
  const flags: Record<string, string> = {};
  const booleans: Record<string, boolean> = {};
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { flags[key] = next; i++; }
    else booleans[key] = true;
  }
  return { cmd, flags, booleans };
}

function usage(): string {
  return `CopilotConnectorWorkflow CLI

Commands:
  run         Create + run a new pipeline end-to-end
  resume      Resume an existing job (re-runs incomplete steps)
  status      Show job status
  list        List all jobs
  tools       Show detected tool paths and health
  compare-dataset
              Validate and plan one enhanced-vs-RAW comparison run
  compare-batch
              Validate and plan a batch enhanced-vs-RAW comparison run
  help        Show this message

Options for 'run':
  --dataset <path>              Path to dataset folder/file (required)
  --description <text>          Natural-language description for eval-gen (required)
  --count <n>                   Eval prompts to generate (5-50, default 30)
  --extensions <csv>            File extensions to include (e.g. csv,json)
  --connector-id <id>           3-128 alphanumeric chars (required)
  --connector-name <name>       Display name (required)
  --connector-description <s>   Richer connector description (optional)
  --deploy-target <target>      azure-functions | azure-container-apps | both (default azure-functions)
  --mode <mode>                 build | provision (default build)
  --acl-mode <mode>             everyone | everyoneExceptGuests | none (default everyone)
  --tenant-id <id>              (provision mode) Entra tenant ID
  --client-id <id>              (provision mode) Entra client ID
  --client-secret-env <name>    Env var holding client secret
  --use-managed-identity        Use managed identity instead of secret
  --run-m365-eval               Run optional Step 6 (@microsoft/m365-copilot-eval) after provision/ingest
  --m365-agent-id <id>          M365 agent ID (required for step 6; AGENT id, not connector id)
  --m365-system-prompt <path>   Optional system prompt markdown file
  --m365-evaluators <csv>       Evaluators (default: Relevance,Coherence,Groundedness,Citations)
  --m365-concurrency <n>        runevals --concurrency (default 1)
  --m365-environment <env>      runevals --env (default 'local')
  --m365-package-version <ver>  npx package version pin (default 'latest')
  --m365-log-level <lvl>        debug|info|warning|error (default 'info')
  --m365-accept-eula            Run 'runevals accept-eula' before evaluation
  --agent-name <name>           Declarative agent display name (default: "<connectorName> Assistant")
  --agent-instructions <text>   Declarative agent system instructions
  --agent-instructions-file <p> Read agent instructions from a file
  --url-prefix <url>            Base URL for source items (e.g. https://wiki.example.com); enables
                                URL unfurling in Teams/Copilot via urlToItemResolver
  --force                       Force-re-run all steps
  --force-step <name>           Force one step (repeatable: e.g. --force-step schema)
  --start-at <step>             Start at this step (evalgen|enhance|schema|connector|deploy|m365eval)
  --stop-after <step>           Stop after this step

Options for 'resume':
  --job <id>                    Job ID to resume (required)
  (plus --force, --force-step, --start-at, --stop-after as above)

Options for 'compare-dataset':
   --config <path>                Dataset comparison JSON config (required)
   --dry-run                      Validate config and write compare-state.json without external calls
   Without --dry-run, builds enhanced + RAW connector projects. If config mode is
   "provision", also provisions and ingests with the configured Graph app credentials.

Options for 'compare-batch':
   --manifest <path>              Batch manifest JSON with datasets[] (required)
   --dry-run                      Validate manifest and write compare-state.json without external calls
`;
}

async function main(): Promise<void> {
  const { cmd, flags, booleans } = parseArgs(process.argv.slice(2));
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(usage()); process.exit(0);
  }
  if (cmd === 'tools') {
    const status = probeTools();
    for (const t of status) {
      console.log(`${t.ok ? '✓' : '✗'} ${t.name.padEnd(28)} ${t.path}${t.note ? `\n     ${t.note}` : ''}`);
    }
    process.exit(status.every((t) => t.ok) ? 0 : 1);
  }
  if (cmd === 'list') {
    const jobs = listJobs();
    for (const j of jobs) {
      const steps = Object.values(j.steps).map((s) => `${s.name}=${s.status}`).join(' ');
      console.log(`${j.id}  ${j.status}  ${steps}`);
    }
    process.exit(0);
  }
  if (cmd === 'status') {
    const id = flags.job || flags.id;
    if (!id) { console.error('--job <id> required'); process.exit(2); }
    const j = loadJob(id);
    if (!j) { console.error(`job not found: ${id}`); process.exit(2); }
    console.log(JSON.stringify(j, null, 2));
    process.exit(0);
  }
  if (cmd === 'compare-dataset') {
    const config = flags.config;
    if (!config) { console.error('--config <path> required'); process.exit(2); }
    const state = createCompareDatasetRun(config, !!booleans['dry-run']);
    console.log(formatCompareState(state));
    if (!booleans['dry-run']) {
      const emitter = new EventEmitter();
      emitter.on('log', (e: { label?: string; text: string }) => process.stdout.write(e.text));
      const result = await executeCompareRun(state, emitter);
      console.log(`\nCompare execution ${result.state.status}. Report: ${result.reportPath}`);
      process.exit(result.state.status === 'done' ? 0 : 1);
    }
    process.exit(0);
  }
  if (cmd === 'compare-batch') {
    const manifest = flags.manifest;
    if (!manifest) { console.error('--manifest <path> required'); process.exit(2); }
    const state = createCompareBatchRun(manifest, !!booleans['dry-run']);
    console.log(formatCompareState(state));
    if (!booleans['dry-run']) {
      const emitter = new EventEmitter();
      emitter.on('log', (e: { label?: string; text: string }) => process.stdout.write(e.text));
      const result = await executeCompareRun(state, emitter);
      console.log(`\nCompare execution ${result.state.status}. Report: ${result.reportPath}`);
      process.exit(result.state.status === 'done' ? 0 : 1);
    }
    process.exit(0);
  }
  if (cmd === 'run' || cmd === 'resume') {
    let job;
    if (cmd === 'run') {
      const cfg = buildConfigFromFlags(flags, booleans);
      job = createJob(cfg);
      console.log(`Created job ${job.id} at ${job.workspace}`);
    } else {
      const id = flags.job;
      if (!id) { console.error('--job <id> required for resume'); process.exit(2); }
      const loaded = loadJob(id);
      if (!loaded) { console.error(`job not found: ${id}`); process.exit(2); }
      job = loaded;
      console.log(`Resuming job ${job.id}`);
    }
    const emitter = new EventEmitter();
    emitter.on('log', (e: { label?: string; text: string }) => process.stdout.write(e.text));
    const forceSteps = collectMulti(flags, 'force-step') as StepName[];
    const startAt = flags['start-at'] as StepName | undefined;
    const stopAfter = flags['stop-after'] as StepName | undefined;
    if (startAt && !ALL_STEPS.includes(startAt)) { console.error(`invalid --start-at: ${startAt}`); process.exit(2); }
    if (stopAfter && !ALL_STEPS.includes(stopAfter)) { console.error(`invalid --stop-after: ${stopAfter}`); process.exit(2); }
    const result = await runPipeline({
      job, emitter,
      forceAll: !!booleans.force,
      forceSteps,
      startAt, stopAfter,
    });
    process.exit(result.status === 'done' ? 0 : 1);
  }
  console.error(`Unknown command: ${cmd}`);
  console.log(usage());
  process.exit(2);
}

function buildConfigFromFlags(flags: Record<string, string>, booleans: Record<string, boolean>): JobConfig {
  const required = (k: string) => {
    const v = flags[k];
    if (!v) throw new Error(`--${k} is required`);
    return v;
  };
  const mode = (flags.mode || 'build') as RunMode;
  const deployTarget = (flags['deploy-target'] || 'azure-functions') as DeployTarget;
  const runM365Eval = !!booleans['run-m365-eval'];
  const cfg: JobConfig = {
    dataset: path.resolve(required('dataset')),
    description: required('description'),
    count: Math.min(50, Math.max(5, Number(flags.count || '30'))),
    extensions: flags.extensions ? flags.extensions.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
    connectorId: required('connector-id'),
    connectorName: required('connector-name'),
    connectorDescription: flags['connector-description'],
    deployTarget,
    mode,
    aclMode: (flags['acl-mode'] || 'everyone') as JobConfig['aclMode'],
    runM365Eval,
  };
  if (mode === 'provision') {
    cfg.auth = {
      tenantId: required('tenant-id'),
      clientId: required('client-id'),
      clientSecretEnvVar: flags['client-secret-env'],
      useManagedIdentity: !!booleans['use-managed-identity'],
    };
  }
  if (runM365Eval) {
    if (!flags['m365-agent-id']) {
      throw new Error('--m365-agent-id is required when --run-m365-eval is set');
    }
    const evals = flags['m365-evaluators']
      ? flags['m365-evaluators'].split(',').map((s) => s.trim()).filter(Boolean) as M365Evaluator[]
      : undefined;
    cfg.m365Eval = {
      agentId: flags['m365-agent-id'],
      systemPromptFile: flags['m365-system-prompt'] ? path.resolve(flags['m365-system-prompt']) : undefined,
      evaluators: evals,
      concurrency: flags['m365-concurrency'] ? Number(flags['m365-concurrency']) : undefined,
      environment: flags['m365-environment'],
      packageVersion: flags['m365-package-version'],
      logLevel: (flags['m365-log-level'] as 'debug' | 'info' | 'warning' | 'error') || undefined,
      acceptEula: !!booleans['m365-accept-eula'],
    };
  }
  if (flags['agent-name']) cfg.agentName = flags['agent-name'];
  if (flags['agent-instructions']) cfg.agentInstructions = flags['agent-instructions'];
  if (flags['agent-instructions-file']) {
    cfg.agentInstructions = fs.readFileSync(path.resolve(flags['agent-instructions-file']), 'utf-8');
  }
  if (flags['url-prefix']) cfg.urlPrefix = flags['url-prefix'];
  return cfg;
}

function collectMulti(flags: Record<string, string>, name: string): string[] {
  // Simple parser only keeps last; for repeatable flags accept comma-separated.
  if (!flags[name]) return [];
  return flags[name].split(',').map((s) => s.trim()).filter(Boolean);
}

main().catch((e) => {
  console.error(e?.stack || e?.message || e);
  process.exit(1);
});
