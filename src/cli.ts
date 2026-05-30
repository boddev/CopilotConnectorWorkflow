#!/usr/bin/env node

import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import { createJob, loadJob, listJobs } from './jobs';
import { runPipeline } from './orchestrator';
import { resolveTools, probeTools } from './tools';
import { JobConfig, RunMode, DeployTarget, StepName, ALL_STEPS, JudgeProvider } from './types';
import { runCompare } from './compare-jobs';
import { formatAuthPreflightResult, runAuthPreflight, shouldRunEvalScoreA2AFromEnv } from './auth-preflight';

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
  compare     Post-hoc compare two completed jobs (enhanced vs --no-enhance)
  status      Show job status
  list        List all jobs
  tools       Show detected tool paths and health
  auth        Validate Graph app credentials and seed WorkIQ/EvalScore auth
  help        Show this message

Removed in this version:
  compare-dataset, compare-batch — use 'ccw run --no-enhance --reuse-eval-from <id>' + 'ccw compare'.

Options for 'run':
  --dataset <path>              Path to dataset folder/file (required)
  --description <text>          Natural-language description for eval-gen (required)
  --count <n>                   Eval prompts to generate (5-50, default 30)
  --extensions <csv>            File extensions to include (e.g. csv,json)
  --connector-id <id>           3-128 alphanumeric chars (required)
  --connector-name <name>       Display name (required)
  --connector-description <s>   Richer connector description (optional)
  --deploy-target <target>      azure-functions | azure-container-apps | both (default azure-functions)
  --mode <mode>                 build | provision (default build). Step 6 only runs in provision mode.
  --no-enhance                  Skip Step 2 enrichment. Step 2 still infers a Graph schema
                                from the shape of the source data and emits 1:1 items.
  --reuse-eval-from <jobId>     Step 1 copies the eval set from this prior job instead of
                                generating a new one. Required to pair two runs for compare.
  --eval-set <path>             Step 1 copies the eval set from this folder (eval.csv +
                                eval.evalgen.json). Mutually exclusive with --reuse-eval-from.
  --judge-provider <provider>   Step 6 semantic judge: github-copilot (default) | workiq.
  --judge-agent-id <id>         Required when --judge-provider workiq is set; the eval-judge
                                declarative agent id (T_<guid>.declarativeAgent).
  --candidate-agent-id <id>     M365 candidate agent id (the agent under evaluation). When set,
                                Step 5 reuses it instead of discovering a freshly published agent.
  --skip-agent-publish          Skip auto-publishing the agent in Step 5 (via atk install); the
                                operator must publish out-of-band and resume with --candidate-agent-id.
  --evaluators <names>          Comma-separated evaluator names or "all" (Relevance, Coherence,
                                Groundedness, Similarity). Default: eval-score's "Relevance,Coherence".
  --acl-mode <mode>             everyone | everyoneExceptGuests | none (default everyone)
  --tenant-id <id>              (provision mode) Entra tenant ID
  --client-id <id>              (provision mode) Entra client ID
  --client-secret-env <name>    Env var holding client secret
  --use-managed-identity        Use managed identity instead of secret
  --agent-name <name>           Declarative agent display name (default: "<connectorName> Assistant")
  --agent-instructions <text>   Declarative agent system instructions
  --agent-instructions-file <p> Read agent instructions from a file
  --url-prefix <url>            Base URL for source items (e.g. https://wiki.example.com); enables
                                URL unfurling in Teams/Copilot via urlToItemResolver
  --force                       Force-re-run all steps
  --force-step <name>           Force one step (repeatable: e.g. --force-step schema)
  --start-at <step>             Start at this step (evalgen|enhance|schema|connector|deploy|score)
  --stop-after <step>           Stop after this step
  --auth-preflight              Validate auth before creating/running the job
  --skip-workiq-auth            With --auth-preflight, skip WorkIQ MCP auth seeding

Options for 'resume':
  --job <id>                    Job ID to resume (required)
  (plus --force, --force-step, --start-at, --stop-after as above)

Options for 'compare':
  --job <id>                    Job id (use twice; the two jobs must differ only by --no-enhance)
  --output <dir>                Output directory for comparison-report.{md,json} + score-matrix.csv

Options for 'auth':
  --tenant-id <id>              Entra tenant ID for Graph and delegated auth
  --client-id <id>              Graph connector app/client ID
  --client-secret-env <name>    Env var holding the Graph connector client secret
  --skip-graph                  Do not validate Graph client credentials
  --skip-workiq                 Do not start WorkIQ MCP auth preflight
  --eval-score-a2a              Seed EvalScore A2A MSAL device-code token cache
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
  if (cmd === 'auth') {
    const emitter = new EventEmitter();
    emitter.on('log', (e: { text: string }) => process.stderr.write(e.text));
    const result = await runAuthPreflight({
      tenantId: flags['tenant-id'],
      clientId: flags['client-id'],
      clientSecretEnvVar: flags['client-secret-env'],
      runGraph: !booleans['skip-graph'],
      runWorkIq: !booleans['skip-workiq'],
      runEvalScoreA2A: !!booleans['eval-score-a2a'] || shouldRunEvalScoreA2AFromEnv(),
    }, emitter);
    console.log(formatAuthPreflightResult(result));
    process.exit(result.passed ? 0 : 1);
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
  if (cmd === 'compare') {
    // --job <id> is allowed twice; collect both occurrences from raw argv.
    const argv = process.argv.slice(3); // after 'compare'
    const jobIds: string[] = [];
    let outputDir: string | undefined;
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === '--job' && argv[i + 1]) { jobIds.push(argv[++i]); }
      else if (a === '--output' && argv[i + 1]) { outputDir = argv[++i]; }
    }
    if (jobIds.length !== 2) { console.error('ccw compare requires --job <id> twice'); process.exit(2); }
    if (!outputDir) {
      outputDir = path.resolve('workspace', 'compare-reports', `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${jobIds[0]}-vs-${jobIds[1]}`);
    } else {
      outputDir = path.resolve(outputDir);
    }
    try {
      const result = runCompare({ jobIdA: jobIds[0], jobIdB: jobIds[1], outputDir });
      console.log(`Comparable: ${result.comparable}; semanticComparable: ${result.semanticComparable}`);
      console.log(`Report: ${result.reportMdPath}`);
      console.log(`Matrix: ${result.scoreMatrixPath}`);
      for (const d of result.diagnostics) console.log(`  - ${d}`);
      process.exit(result.comparable ? 0 : 1);
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(2);
    }
  }
  if (cmd === 'compare-dataset' || cmd === 'compare-batch') {
    console.error(
      `'${cmd}' was removed by STREAMLINED_CONNECTOR_EVAL_PLAN.md task 9.\n` +
      `Use 'ccw run --no-enhance --reuse-eval-from <enhancedJobId> ...' to create a paired non-enhanced run,\n` +
      `then 'ccw compare --job <enhancedJobId> --job <nonEnhancedJobId>' to diff them.`,
    );
    process.exit(2);
  }
  if (cmd === 'run' || cmd === 'resume') {
    let job;
    if (cmd === 'run') {
      const cfg = buildConfigFromFlags(flags, booleans);
      if (booleans['auth-preflight']) {
        const ok = await runAuthPreflightForConfig(cfg, flags, booleans);
        if (!ok) process.exit(1);
      }
      job = createJob(cfg);
      console.log(`Created job ${job.id} at ${job.workspace}`);
    } else {
      const id = flags.job;
      if (!id) { console.error('--job <id> required for resume'); process.exit(2); }
      const loaded = loadJob(id);
      if (!loaded) { console.error(`job not found: ${id}`); process.exit(2); }
      job = loaded;
      if (booleans['auth-preflight']) {
        const ok = await runAuthPreflightForConfig(job.config, flags, booleans);
        if (!ok) process.exit(1);
      }
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

async function runAuthPreflightForConfig(
  cfg: JobConfig,
  flags: Record<string, string>,
  booleans: Record<string, boolean>,
): Promise<boolean> {
  const emitter = new EventEmitter();
  emitter.on('log', (e: { text: string }) => process.stderr.write(e.text));
  const result = await runAuthPreflight({
    tenantId: cfg.auth?.tenantId,
    clientId: cfg.auth?.clientId,
    clientSecretEnvVar: cfg.auth?.clientSecretEnvVar,
    useManagedIdentity: cfg.auth?.useManagedIdentity,
    runGraph: cfg.mode === 'provision',
    runWorkIq: !booleans['skip-workiq-auth'],
    runEvalScoreA2A: shouldRunEvalScoreA2AFromEnv(),
  }, emitter);
  console.log(formatAuthPreflightResult(result));
  return result.passed;
}

function buildConfigFromFlags(flags: Record<string, string>, booleans: Record<string, boolean>): JobConfig {
  const required = (k: string) => {
    const v = flags[k];
    if (!v) throw new Error(`--${k} is required`);
    return v;
  };
  const mode = (flags.mode || 'build') as RunMode;
  const deployTarget = (flags['deploy-target'] || 'azure-functions') as DeployTarget;
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
  };
  if (mode === 'provision') {
    cfg.auth = {
      tenantId: required('tenant-id'),
      clientId: required('client-id'),
      clientSecretEnvVar: flags['client-secret-env'],
      useManagedIdentity: !!booleans['use-managed-identity'],
    };
  }
  if (flags['agent-name']) cfg.agentName = flags['agent-name'];
  if (flags['agent-instructions']) cfg.agentInstructions = flags['agent-instructions'];
  if (flags['agent-instructions-file']) {
    cfg.agentInstructions = fs.readFileSync(path.resolve(flags['agent-instructions-file']), 'utf-8');
  }
  if (flags['url-prefix']) cfg.urlPrefix = flags['url-prefix'];

  // Single-pipeline flags from STREAMLINED_CONNECTOR_EVAL_PLAN.md.
  if (booleans['no-enhance']) cfg.noEnhance = true;
  if (flags['reuse-eval-from'] && flags['eval-set']) {
    throw new Error('--reuse-eval-from and --eval-set are mutually exclusive');
  }
  if (flags['reuse-eval-from']) cfg.reuseEvalFromJobId = flags['reuse-eval-from'];
  if (flags['eval-set']) cfg.evalSetPath = path.resolve(flags['eval-set']);

  const judgeProviderFlag = flags['judge-provider'];
  if (judgeProviderFlag || flags['judge-agent-id'] || flags['candidate-agent-id'] || booleans['skip-agent-publish'] || flags['evaluators']) {
    const judgeProvider = (judgeProviderFlag || 'github-copilot') as JudgeProvider;
    if (judgeProvider !== 'github-copilot' && judgeProvider !== 'workiq') {
      throw new Error(`--judge-provider must be 'github-copilot' or 'workiq', got '${judgeProvider}'`);
    }
    if (judgeProvider === 'workiq' && !flags['judge-agent-id']) {
      throw new Error("--judge-agent-id is required when --judge-provider workiq is set");
    }
    cfg.score = {
      judgeProvider,
      judgeAgentId: flags['judge-agent-id'],
      candidateAgentId: flags['candidate-agent-id'],
      skipAgentPublish: booleans['skip-agent-publish'] || undefined,
      evaluators: flags['evaluators'],
    };
  }

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
