import * as fs from 'fs';
import * as path from 'path';
import { StepRecord, M365Evaluator } from '../types';
import { runProcess } from '../run';
import { fileHash } from '../jobs';
import { RunStepOptions } from '../orchestrator';
import { newStepRecord, startStep, finishStep, writeStepStatus } from './step-utils';
import { M365_EVAL_MIN_NODE, checkNodeMinimum } from '../tools';

const DEFAULT_EVALUATORS: M365Evaluator[] = ['Relevance', 'Coherence', 'Groundedness', 'Citations'];

/**
 * Step 6 (optional): score the eval set against M365 Copilot using
 * @microsoft/m365-copilot-eval.
 *
 * Flow:
 *   a) Run EvaluationCLI/scripts/convert-evalgen-to-m365-copilot-eval.ps1 to
 *      produce m365-evals.json from eval.csv + eval.evalgen.json.
 *   b) Optionally run `npx -y @microsoft/m365-copilot-eval@<version> accept-eula`
 *      if acceptEula is set (required on first use).
 *   c) Run `npx -y @microsoft/m365-copilot-eval@<version> --prompts-file ...
 *      --output ... --env <env> --concurrency N --log-level <lvl>
 *      --m365-agent-id <agentId>`.
 *
 * Requires:
 *   - Node.js ≥ 22.21.1 (m365-copilot-eval requirement).
 *   - An M365 agent ID (this evaluates a Copilot agent, not just a connector;
 *     the connector ID is embedded as prompt context for grounding).
 *
 * Only runs when mode == 'provision' AND runM365Eval == true.
 */
export async function runStep6M365Eval(opts: RunStepOptions): Promise<StepRecord> {
  const { job, tools, emitter } = opts;
  const rec = newStepRecord('m365eval');
  const stepDir = path.join(job.workspace, '06-m365eval');
  fs.mkdirSync(stepDir, { recursive: true });
  const logFile = path.join(stepDir, 'step.log');

  // Eligibility checks
  if (!job.config.runM365Eval) {
    finishStep(rec, 'skipped');
    rec.diagnostics?.push('runM365Eval=false; skipping');
    writeStepStatus(stepDir, rec); return rec;
  }
  if (job.config.mode !== 'provision') {
    finishStep(rec, 'skipped');
    rec.diagnostics?.push('mode is build; m365 eval requires provision mode (and ingestion must have completed)');
    writeStepStatus(stepDir, rec); return rec;
  }
  const cfg = job.config.m365Eval || {};
  if (!cfg.agentId) {
    finishStep(rec, 'failed', `m365Eval.agentId is required. @microsoft/m365-copilot-eval targets an M365 *agent*, not the connector ID. Provide --m365-agent-id.`);
    writeStepStatus(stepDir, rec); return rec;
  }
  const nodeCheck = checkNodeMinimum(M365_EVAL_MIN_NODE);
  if (!nodeCheck.ok) {
    finishStep(rec, 'failed', `@microsoft/m365-copilot-eval requires Node.js >= ${M365_EVAL_MIN_NODE}; current is ${nodeCheck.current}. Install a newer Node and re-run.`);
    writeStepStatus(stepDir, rec); return rec;
  }
  if (!fs.existsSync(tools.evalGenToM365Convert)) {
    finishStep(rec, 'failed', `convert script not found: ${tools.evalGenToM365Convert}`);
    writeStepStatus(stepDir, rec); return rec;
  }
  const evalCsv = path.join(job.workspace, '01-evalgen', 'eval.csv');
  const sidecar = path.join(job.workspace, '01-evalgen', 'eval.evalgen.json');
  if (!fs.existsSync(evalCsv) || !fs.existsSync(sidecar)) {
    finishStep(rec, 'failed', `missing eval set or sidecar from step 1`);
    writeStepStatus(stepDir, rec); return rec;
  }
  if (cfg.systemPromptFile && !fs.existsSync(cfg.systemPromptFile)) {
    finishStep(rec, 'failed', `systemPromptFile not found: ${cfg.systemPromptFile}`);
    writeStepStatus(stepDir, rec); return rec;
  }

  startStep(rec);

  // 1. Convert EvalGen output -> m365-copilot-eval JSON
  const m365InputJson = path.join(stepDir, 'm365-evals.json');
  const evaluators = (cfg.evaluators && cfg.evaluators.length > 0) ? cfg.evaluators : DEFAULT_EVALUATORS;
  // PowerShell `-File` mode does not tokenize arrays. Invoke via `-Command` and
  // construct an explicit PowerShell expression so [string[]] params parse correctly.
  const psSingleQuote = (s: string) => s.replace(/'/g, "''");
  const psEvaluators = evaluators.map((e) => `'${psSingleQuote(e)}'`).join(',');
  const psArgs: string[] = [
    `-InputCsv '${psSingleQuote(evalCsv)}'`,
    `-SidecarPath '${psSingleQuote(sidecar)}'`,
    `-OutputPath '${psSingleQuote(m365InputJson)}'`,
    `-Name '${psSingleQuote(`${job.config.connectorName} eval set`)}'`,
    `-Description '${psSingleQuote(job.config.connectorDescription || job.config.description)}'`,
    `-ConnectorId '${psSingleQuote(job.config.connectorId)}'`,
    `-M365AgentId '${psSingleQuote(cfg.agentId)}'`,
    `-DefaultEvaluator @(${psEvaluators})`,
  ];
  if (cfg.systemPromptFile) {
    psArgs.push(`-SystemPromptFile '${psSingleQuote(cfg.systemPromptFile)}'`);
  }
  const psCommand = `& '${psSingleQuote(tools.evalGenToM365Convert)}' ${psArgs.join(' ')}; exit $LASTEXITCODE`;

  const convert = await runProcess({
    cmd: 'powershell.exe',
    args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psCommand],
    cwd: stepDir, logFile, emitter, label: 'convert',
  });
  if (!convert.ok) {
    finishStep(rec, 'failed', `convert script exit ${convert.exitCode}`);
    writeStepStatus(stepDir, rec); return rec;
  }
  if (!fs.existsSync(m365InputJson)) {
    finishStep(rec, 'failed', `convert succeeded but ${m365InputJson} was not produced`);
    writeStepStatus(stepDir, rec); return rec;
  }

  // 2. Optionally accept EULA
  const pkgVer = cfg.packageVersion || 'latest';
  const pkgRef = `@microsoft/m365-copilot-eval@${pkgVer}`;
  if (cfg.acceptEula) {
    const eula = await runProcess({
      cmd: 'npx',
      args: ['-y', pkgRef, 'accept-eula'],
      cwd: stepDir, logFile, emitter, label: 'runevals eula',
      shell: true, // npx is a .cmd on Windows
    });
    if (!eula.ok) {
      finishStep(rec, 'failed', `accept-eula exit ${eula.exitCode}`);
      writeStepStatus(stepDir, rec); return rec;
    }
  }

  // 3. Run runevals
  const resultJson = path.join(stepDir, 'm365-eval-results.json');
  const runArgs = [
    '-y', pkgRef,
    '--prompts-file', m365InputJson,
    '--output', resultJson,
    '--env', cfg.environment || 'local',
    '--concurrency', String(cfg.concurrency || 1),
    '--log-level', cfg.logLevel || 'info',
    '--m365-agent-id', cfg.agentId,
  ];
  const run = await runProcess({
    cmd: 'npx',
    args: runArgs,
    cwd: stepDir, logFile, emitter, label: 'runevals',
    shell: true,
  });
  rec.exitCode = run.exitCode;
  if (!run.ok) {
    finishStep(rec, 'failed', `runevals exit ${run.exitCode}. Check that you accepted the EULA (re-run with acceptEula=true) and that the agent ID is correct.`);
    writeStepStatus(stepDir, rec); return rec;
  }

  // 4. Collect outputs
  const outputs: Record<string, string> = {};
  for (const f of fs.readdirSync(stepDir)) {
    if (f === 'step.log' || f === 'step-status.json') continue;
    outputs[`06-m365eval/${f}`] = fileHash(path.join(stepDir, f));
  }
  rec.outputs = outputs;
  rec.artifacts = Object.keys(outputs).map((r) => path.join(job.workspace, r));
  rec.diagnostics?.push(`evaluators: ${evaluators.join(', ')}`);
  rec.diagnostics?.push(`agentId: ${cfg.agentId}`);
  finishStep(rec, 'done');
  writeStepStatus(stepDir, rec);
  return rec;
}
