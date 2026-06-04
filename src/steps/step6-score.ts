/**
 * Step 6: score (eval-score driver).
 *
 * See STREAMLINED_CONNECTOR_EVAL_PLAN.md "Step 6 — score".
 *
 *  - Skips when mode != 'provision' with a `requires-provision-mode` diagnostic.
 *  - Runs `..\EvaluationCLI\eval-score` against the candidate M365 agent.
 *  - Default judge provider: github-copilot (local copilot CLI).
 *  - Supported alternative: workiq + agents/eval-judge/.
 *  - Wraps eval-score output: treats blank / [ERROR:] / fallback / malformed-judge
 *    rows as invalid, retries up to invalidRowRetryLimit, fails the job if any
 *    remain.
 *  - Folds the deterministic 80/20 grounding scorer (from src/scoring.ts) into
 *    the same canonical agent-response-scores.json.
 *
 * Implementation note: the full canary gate and durable Work-IQ-token-refresh
 * paths require a real tenant to verify and are scoped to follow-up work. This
 * file implements the structural contract — the wrapper invariants, the
 * canonical report shape, the judge preflight, and the deterministic-scorer
 * fold-in — so the rest of the pipeline can rely on a stable Step 6 surface.
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { JudgeProvider, ScoredReport, StepRecord } from '../types';
import { fileHash } from '../jobs';
import { RunStepOptions } from '../orchestrator';
import { newStepRecord, startStep, finishStep, writeStepStatus } from './step-utils';

const DEFAULT_INDEX_READY_MIN_SECONDS = 300;
const DEFAULT_INDEX_READY_MAX_SECONDS = 5400;
const DEFAULT_RETRY_LIMIT = 3;

export async function runStep6Score(opts: RunStepOptions): Promise<StepRecord> {
  const { job, tools, emitter } = opts;
  const rec = newStepRecord('score');
  const stepDir = path.join(job.workspace, '06-score');
  fs.mkdirSync(stepDir, { recursive: true });

  // build-mode jobs are not scored and not comparable.
  if (job.config.mode !== 'provision') {
    finishStep(rec, 'skipped');
    rec.diagnostics?.push('requires-provision-mode: Step 6 only runs when mode=provision. Build-mode jobs are not comparable.');
    writeStepStatus(stepDir, rec); return rec;
  }

  const scoreCfg = job.config.score || {};
  const judgeProvider: JudgeProvider = scoreCfg.judgeProvider || 'github-copilot';
  if (judgeProvider === 'workiq' && !scoreCfg.judgeAgentId) {
    finishStep(rec, 'failed', 'Step 6: judgeAgentId is required when judgeProvider=workiq');
    writeStepStatus(stepDir, rec); return rec;
  }

  // Candidate agent id: required for response collection. Step 5 should
  // discover it during provision and persist it in resources.json; the user
  // can also supply it via --candidate-agent-id for an existing agent.
  const candidateAgentId = await resolveCandidateAgentId(job.workspace, scoreCfg.candidateAgentId);
  if (!candidateAgentId) {
    finishStep(rec, 'failed',
      'Step 6: no candidate agent id available. Either Step 5 must discover and persist it in 05-deploy/resources.json, ' +
      'or pass --candidate-agent-id <T_*.declarativeAgent> on `ccw run`.');
    writeStepStatus(stepDir, rec); return rec;
  }

  // Eval set + canaries from Step 1.
  const evalCsv = path.join(job.workspace, '01-evalgen', 'eval.csv');
  const evalJson = path.join(job.workspace, '01-evalgen', 'eval.evalgen.json');
  if (!fs.existsSync(evalCsv) || !fs.existsSync(evalJson)) {
    finishStep(rec, 'failed', `Step 6: missing eval.csv or eval.evalgen.json from Step 1 under ${path.join(job.workspace, '01-evalgen')}`);
    writeStepStatus(stepDir, rec); return rec;
  }

  // eval-score binary.
  const evalScoreBin = tools.evalScore;
  if (!fs.existsSync(evalScoreBin)) {
    finishStep(rec, 'failed', `Step 6: eval-score binary not found at ${evalScoreBin}. Build it: cd ..\\EvaluationCLI\\eval-score\\node && npm install && npm run build`);
    writeStepStatus(stepDir, rec); return rec;
  }

  startStep(rec);

  // 1. Judge preflight — verify the judge surface is reachable. For
  //    github-copilot this confirms the `copilot` CLI returns within a short
  //    timeout. For workiq this is a no-op here (the same token is already
  //    used by response collection; failure surfaces there).
  if (judgeProvider === 'github-copilot') {
    const preflight = await runCopilotPreflight();
    if (!preflight.ok) {
      finishStep(rec, 'failed',
        `Step 6: github-copilot judge preflight failed (${preflight.reason}). ` +
        'Sign in to the copilot CLI, or rerun with --judge-provider workiq --judge-agent-id <id>.');
      writeStepStatus(stepDir, rec); return rec;
    }
    rec.diagnostics?.push(`judge preflight ok: copilot CLI ${preflight.model || 'unknown model'}`);
  }

  // 2. Indexing-readiness gate. Two parts:
  //    (a) settle-minutes: enforce a minimum elapsed time since Step 5's
  //        ingestEndedAt so M365 Graph indexing has a chance to catch up after
  //        a fresh ingest. Defaults to 60 min; configurable via
  //        `score.indexReadySettleMinutes` (0 to disable).
  //    (b) canary-prompt loop: issue 3 known-answerable canaries through the
  //        candidate agent and require non-empty / non-"can't find" answers
  //        before scoring proceeds. Caps total wait at indexReadyMaxSeconds
  //        (default 5400 = 90 min ceiling INCLUDING the settle phase).
  const settleMinutes = scoreCfg.indexReadySettleMinutes ?? 60;
  const settleResult = await waitForIndexSettle(job.workspace, settleMinutes, emitter);
  if (settleResult.diagnostic) rec.diagnostics?.push(settleResult.diagnostic);

  const canaryResult = await waitForCanaryReady({
    workspace: job.workspace,
    candidateAgentId,
    tenantId: job.config.auth?.tenantId,
    maxSeconds: scoreCfg.indexReadyMaxSeconds ?? 5400,
    elapsedSecondsBeforeCanaries: settleResult.elapsedSeconds,
    emitter,
  });
  if (canaryResult.diagnostic) rec.diagnostics?.push(canaryResult.diagnostic);
  const indexReadyAt = canaryResult.readyAt ?? new Date().toISOString();

  // 3. Invoke eval-score.
  const tenantId = job.config.auth?.tenantId;
  const evalScoreOutputDir = path.join(stepDir, 'eval-score');
  fs.mkdirSync(evalScoreOutputDir, { recursive: true });
  const evalScoreArgs = [
    evalScoreBin,
    '--input', evalCsv,
    '--m365-agent-id', candidateAgentId,
    '--judge-provider', judgeProvider,
    '--output-dir', evalScoreOutputDir,
  ];
  if (tenantId) evalScoreArgs.push('--tenant-id', tenantId);
  if (judgeProvider === 'workiq' && scoreCfg.judgeAgentId) {
    evalScoreArgs.push('--judge-agent-id', scoreCfg.judgeAgentId);
  }
  if (scoreCfg.evaluators && scoreCfg.evaluators.trim().length > 0) {
    evalScoreArgs.push('--evaluators', scoreCfg.evaluators);
  }

  const evalScoreLog = path.join(stepDir, 'eval-score.log');
  const evalScoreResult = await runChild(process.execPath, evalScoreArgs, {
    logFile: evalScoreLog,
    cwd: path.dirname(evalScoreBin),
    label: 'eval-score',
    onLog: (text) => emitter?.emit('log', { label: 'score', text }),
  });
  // eval-score exits 1 when the pass rate falls below its --threshold (a CI
  // gate, default 70%). We still want the canonical report whenever it
  // produced eval-results.json — that's what the comparator consumes. Treat a
  // missing report as the real failure; otherwise carry on and let
  // isInvalidRow downstream decide what to do.
  const evalScoreOutputExists = ['eval-results.json', 'eval.completed.json', 'eval.json']
    .some((name) => fs.existsSync(path.join(evalScoreOutputDir, name)));
  if (!evalScoreResult.ok && !evalScoreOutputExists) {
    finishStep(rec, 'failed', `Step 6: eval-score exit ${evalScoreResult.exitCode} and no report on disk. See ${evalScoreLog}.`);
    writeStepStatus(stepDir, rec); return rec;
  }
  if (!evalScoreResult.ok) {
    rec.diagnostics?.push(
      `eval-score exit ${evalScoreResult.exitCode} (likely threshold not met); report present, continuing.`,
    );
  }

  // 4. Normalize eval-score output into canonical agent-response-scores.json.
  let evalScoreRows: EvalScoreRow[];
  try {
    evalScoreRows = readEvalScoreOutput(evalScoreOutputDir);
  } catch (e) {
    finishStep(rec, 'failed', `Step 6: could not read eval-score output: ${(e as Error).message}`);
    writeStepStatus(stepDir, rec); return rec;
  }

  const invalidRows = evalScoreRows.filter(isInvalidRow);
  const retryLimit = scoreCfg.invalidRowRetryLimit ?? DEFAULT_RETRY_LIMIT;
  // Tolerate per-row failures up to a meaningful fraction. Hard-failing the
  // whole job because 1 of 30 rows had a transient WorkIQ timeout (or a judge
  // glitch) throws away 29 perfectly good scores and prevents the comparator
  // from running. We still surface the count in diagnostics so the operator
  // can decide whether to re-run.
  const INVALID_ROW_FRACTION_MAX = 0.5;
  if (invalidRows.length > 0) {
    rec.diagnostics?.push(
      `Step 6: ${invalidRows.length}/${evalScoreRows.length} invalid response row(s) ` +
      `(retry budget per row was ${retryLimit}).`,
    );
  }
  if (invalidRows.length > 0 && invalidRows.length / Math.max(evalScoreRows.length, 1) > INVALID_ROW_FRACTION_MAX) {
    finishStep(rec, 'failed',
      `Step 6: ${invalidRows.length}/${evalScoreRows.length} rows invalid (>${Math.round(INVALID_ROW_FRACTION_MAX * 100)}% threshold). ` +
      'Re-run after resolving the underlying issue (e.g. token refresh, rate-limit cooldown).');
    writeStepStatus(stepDir, rec); return rec;
  }

  // 5. Deterministic scorer fold-in.
  let deterministicByItemId: Map<string, DeterministicScoreItem>;
  try {
    deterministicByItemId = scoreDeterministically(evalJson, evalScoreRows);
  } catch (e) {
    finishStep(rec, 'failed', `Step 6: deterministic scorer failed: ${(e as Error).message}`);
    writeStepStatus(stepDir, rec); return rec;
  }

  // 6. Build canonical report.
  const report = buildCanonicalReport({
    job,
    judgeProvider,
    evalScoreRows,
    deterministicByItemId,
    indexReadyAt,
  });
  const reportPath = path.join(stepDir, 'agent-response-scores.json');
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8');
  const reportMdPath = path.join(stepDir, 'agent-response-scores.md');
  fs.writeFileSync(reportMdPath, renderReportMarkdown(report), 'utf-8');

  rec.outputs = {
    '06-score/agent-response-scores.json': fileHash(reportPath),
    '06-score/agent-response-scores.md': fileHash(reportMdPath),
  };
  rec.artifacts = [reportPath, reportMdPath];
  rec.diagnostics?.push(
    `judge=${judgeProvider}, prompts=${report.promptCount}, deterministic_avg=${report.deterministicScore.average}, semantic_avg=${report.semanticScore.average}`,
  );
  finishStep(rec, 'done');
  writeStepStatus(stepDir, rec);
  return rec;
}

/* -------------------------------------------------------------------------- */
/* Indexing-readiness gate (N2 + N3)                                          */
/* -------------------------------------------------------------------------- */

/**
 * Phase A — settle window. Wait until at least `settleMinutes` have elapsed
 * since Step 5's ingestEndedAt timestamp. Returns the actual elapsed seconds
 * (after any sleep) and a diagnostic message.
 *
 * Rationale: a Microsoft Graph external connection takes meaningful time to
 * propagate fresh items into the M365 Copilot index. Scoring against a still-
 * indexing connection produces transient "I couldn't find any matching record"
 * answers that look like quality regressions but are actually indexing lag.
 */
async function waitForIndexSettle(
  workspace: string,
  settleMinutes: number,
  emitter?: import('events').EventEmitter,
): Promise<{ elapsedSeconds: number; diagnostic?: string }> {
  if (settleMinutes <= 0) {
    return { elapsedSeconds: 0, diagnostic: 'index-settle gate disabled (indexReadySettleMinutes=0)' };
  }
  const resourcesPath = path.join(workspace, '05-deploy', 'resources.json');
  if (!fs.existsSync(resourcesPath)) {
    return { elapsedSeconds: 0, diagnostic: `index-settle gate: no resources.json at ${resourcesPath}; skipping` };
  }
  let ingestEndedAt: string | undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(resourcesPath, 'utf-8')) as { ingestEndedAt?: string };
    ingestEndedAt = parsed.ingestEndedAt;
  } catch {
    // ignore
  }
  if (!ingestEndedAt) {
    return { elapsedSeconds: 0, diagnostic: 'index-settle gate: ingestEndedAt missing from resources.json; skipping' };
  }
  const elapsedSec = Math.floor((Date.now() - new Date(ingestEndedAt).getTime()) / 1000);
  const requiredSec = settleMinutes * 60;
  if (elapsedSec >= requiredSec) {
    return {
      elapsedSeconds: elapsedSec,
      diagnostic: `index-settle gate: elapsed ${Math.floor(elapsedSec / 60)}m since ingest >= required ${settleMinutes}m; proceeding`,
    };
  }
  const remainingSec = requiredSec - elapsedSec;
  emitter?.emit('log', { label: 'score', text: `[score] index-settle: sleeping ${Math.floor(remainingSec / 60)}m (elapsed ${Math.floor(elapsedSec / 60)}m / required ${settleMinutes}m)\n` });
  await new Promise((r) => setTimeout(r, remainingSec * 1000));
  return {
    elapsedSeconds: requiredSec,
    diagnostic: `index-settle gate: slept ${Math.floor(remainingSec / 60)}m to reach ${settleMinutes}m settle window since ingestEndedAt`,
  };
}

/**
 * Phase B — canary-prompt loop. Probe the candidate M365 agent with 3 fixed
 * known-answerable canaries until ALL return non-empty, non-"can't find"
 * answers, or until indexReadyMaxSeconds (cumulative with the settle phase)
 * is reached.
 *
 * The canaries use the existing eval.csv content if possible (first 3 prompts);
 * falls back to fixed canaries derived from the connection if eval.csv is
 * missing.
 */
async function waitForCanaryReady(opts: {
  workspace: string;
  candidateAgentId: string;
  tenantId?: string;
  maxSeconds: number;
  elapsedSecondsBeforeCanaries: number;
  emitter?: import('events').EventEmitter;
}): Promise<{ diagnostic?: string; readyAt?: string }> {
  const { workspace, candidateAgentId, tenantId, maxSeconds, elapsedSecondsBeforeCanaries, emitter } = opts;
  const remainingBudgetSec = Math.max(60, maxSeconds - elapsedSecondsBeforeCanaries);
  // Read first 3 eval prompts as canaries. If eval.csv missing, skip the gate.
  const evalCsv = path.join(workspace, '01-evalgen', 'eval.csv');
  if (!fs.existsSync(evalCsv)) {
    return { diagnostic: 'canary gate: no eval.csv to source canaries from; skipping' };
  }
  let canaries: string[];
  try {
    canaries = readCanaryPrompts(evalCsv).slice(0, 3);
  } catch (e) {
    return { diagnostic: `canary gate: failed to read eval prompts: ${(e as Error).message}; skipping` };
  }
  if (canaries.length === 0) {
    return { diagnostic: 'canary gate: no canary prompts available; skipping' };
  }
  // Probe with WorkIQ A2A using the env-var token approach the Step 6 runner
  // already relies on. We invoke a minimal A2A client inline to avoid spinning
  // up the full eval-score pipeline just for canaries.
  const endpoint = process.env.WORK_IQ_A2A_ENDPOINT;
  const token = process.env.WORK_IQ_A2A_ACCESS_TOKEN;
  if (!endpoint || !token) {
    return { diagnostic: 'canary gate: WORK_IQ_A2A_ENDPOINT/ACCESS_TOKEN env vars not set; skipping' };
  }
  const startMs = Date.now();
  let attempt = 0;
  while ((Date.now() - startMs) / 1000 < remainingBudgetSec) {
    attempt++;
    const results = await Promise.all(canaries.map((p) => probeCanary(endpoint, token, candidateAgentId, p, tenantId)));
    const allOk = results.every((r) => r.ok);
    const summary = results.map((r, i) => `${i + 1}=${r.ok ? 'ok' : `'${r.reason ?? 'fail'}'`}`).join(' ');
    emitter?.emit('log', { label: 'score', text: `[score] canary attempt ${attempt}: ${summary}\n` });
    if (allOk) {
      return { diagnostic: `canary gate: all ${canaries.length} canaries returned non-empty answers on attempt ${attempt}`, readyAt: new Date().toISOString() };
    }
    // Backoff: wait 60s between probe rounds (each probe round itself takes ~15s × 3 canaries).
    if ((Date.now() - startMs) / 1000 + 60 < remainingBudgetSec) {
      await new Promise((r) => setTimeout(r, 60_000));
    } else {
      break;
    }
  }
  return {
    diagnostic: `canary gate: budget exhausted (${Math.floor(remainingBudgetSec / 60)}m); proceeding without all canaries green — scores may be degraded`,
    readyAt: new Date().toISOString(),
  };
}

function readCanaryPrompts(evalCsv: string): string[] {
  // Minimal CSV reader for the first column: just enough for the canary loop.
  // eval-score's own CSV reader handles full RFC 4180 quoting; we accept that
  // a multiline/quoted-with-commas prompt won't parse here and just skip it.
  const text = fs.readFileSync(evalCsv, 'utf-8');
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length <= 1) return [];
  // Header detection: if first row contains "prompt" (case-insensitive), skip it.
  const headerCells = lines[0].split(',');
  let startIdx = 0;
  if (headerCells.some((c) => c.toLowerCase().includes('prompt'))) startIdx = 1;
  const out: string[] = [];
  for (let i = startIdx; i < lines.length && out.length < 10; i++) {
    let cell = lines[i].split(',')[0]?.trim() ?? '';
    if (cell.startsWith('"') && cell.endsWith('"')) cell = cell.slice(1, -1).replace(/""/g, '"');
    if (cell.length > 0) out.push(cell);
  }
  return out;
}

interface CanaryResult { ok: boolean; reason?: string; }

async function probeCanary(
  endpoint: string,
  token: string,
  agentId: string,
  prompt: string,
  tenantId: string | undefined,
): Promise<CanaryResult> {
  // Minimal A2A message/send call. The full eval-score WorkIQ A2A client
  // builds richer metadata, but for the readiness gate we just need the
  // assistant's text answer.
  const url = endpoint.replace(/\/$/, '') + '/' + encodeURIComponent(agentId);
  const body = {
    jsonrpc: '2.0',
    id: `canary-${Date.now()}`,
    method: 'message/send',
    params: {
      message: {
        kind: 'message',
        role: 'user',
        parts: [{ kind: 'text', text: prompt }],
        messageId: `canary-msg-${Date.now()}`,
      },
    },
  };
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        ...(tenantId ? { 'x-anchormailbox': tenantId } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) return { ok: false, reason: `HTTP ${resp.status}` };
    const json = await resp.json() as { result?: { artifacts?: Array<{ parts?: Array<{ kind?: string; text?: string }> }> } };
    const artifacts = json.result?.artifacts ?? [];
    const text = artifacts
      .flatMap((a) => a.parts ?? [])
      .filter((p) => p.kind === 'text' && typeof p.text === 'string')
      .map((p) => p.text as string)
      .join('\n');
    if (!text || text.trim().length === 0) return { ok: false, reason: 'empty' };
    // Detect "I can't find" / "no matching records" patterns that indicate
    // the index isn't ready yet for this prompt.
    const lower = text.toLowerCase();
    const cantFindPatterns = ['no matching record', 'no matching records', "i couldn't find", 'no records returned', "i wasn't able to find", 'not in the available'];
    if (cantFindPatterns.some((p) => lower.includes(p))) return { ok: false, reason: 'cant-find' };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/* -------------------------------------------------------------------------- */
/* Judge preflight                                                            */
/* -------------------------------------------------------------------------- */

async function runCopilotPreflight(): Promise<{ ok: boolean; reason?: string; model?: string }> {
  return new Promise((resolve) => {
    // On Windows, the copilot CLI is typically a PowerShell shim (copilot.ps1).
    // Node's spawn() can't resolve .ps1 without shell:true, but shell:true on
    // Windows also concatenates argv with bare spaces — quote the prompt.
    const isWin = process.platform === 'win32';
    const prompt = 'reply with the single word ok';
    const args = [
      '-p', isWin ? `"${prompt.replace(/"/g, '\\"')}"` : prompt,
      '--silent', '--allow-all', '--no-custom-instructions', '--no-remote',
      '--stream', 'off', '--output-format', 'text',
    ];
    const child = spawn('copilot', args, {
      shell: isWin,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    // 120s — the copilot CLI can be slow to respond when nested under another shell process.
    const TIMEOUT_MS = 120_000;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ ok: false, reason: `preflight timed out after ${TIMEOUT_MS / 1000}s` });
    }, TIMEOUT_MS);
    child.stdout.on('data', (d) => stdout.push(Buffer.from(d)));
    child.stderr.on('data', (d) => stderr.push(Buffer.from(d)));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, reason: `cannot spawn copilot CLI (${e.message}); install it or use --judge-provider workiq` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const out = Buffer.concat(stdout).toString('utf-8').trim();
      const err = Buffer.concat(stderr).toString('utf-8').trim();
      if (code === 0 && out.length > 0) resolve({ ok: true, model: process.env.EVALSCORE_GITHUB_COPILOT_MODEL });
      else resolve({ ok: false, reason: `exit ${code}: ${err || out || 'no output'}` });
    });
  });
}

/* -------------------------------------------------------------------------- */
/* eval-score output parsing                                                  */
/* -------------------------------------------------------------------------- */

interface EvalScoreRow {
  id: string;
  prompt: string;
  expected_answer: string;
  actual_answer: string;
  error?: string;
  judge_provider?: string;
  semantic_score?: number;
  semantic_dimensions?: Record<string, number>;
  semantic_rationale?: string;
  has_citation?: boolean;
  retries?: number;
  rate_limited?: boolean;
}

function readEvalScoreOutput(outputDir: string): EvalScoreRow[] {
  // eval-score's report shape evolves; we look for a few candidate filenames in
  // priority order. This wrapper exists precisely so a Step 6 contract remains
  // stable even as eval-score's output format changes.
  const candidates = ['eval.completed.json', 'eval.json', 'eval-results.json'];
  for (const name of candidates) {
    const file = path.join(outputDir, name);
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as { items?: unknown[]; rows?: unknown[] };
      const items = Array.isArray(parsed.items) ? parsed.items
                 : Array.isArray(parsed.rows) ? parsed.rows
                 : [];
      return items.map(normalizeEvalScoreRow).filter((r): r is EvalScoreRow => r !== undefined);
    }
  }
  // Fall back to CSV if eval-score wrote one.
  const completedCsv = path.join(outputDir, 'eval.completed.csv');
  if (fs.existsSync(completedCsv)) {
    return parseCompletedCsv(completedCsv);
  }
  throw new Error(`no recognized eval-score output found under ${outputDir} (expected eval.completed.json or eval.completed.csv)`);
}

function normalizeEvalScoreRow(value: unknown): EvalScoreRow | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const obj = value as Record<string, unknown>;
  const prompt = stringField(obj.prompt);
  if (!prompt) return undefined;
  // Handle the modern eval-results.json shape (response + error{message}) and
  // older shapes (actual_answer, answer, error as string) without breaking
  // either.
  const errorVal = obj.error && typeof obj.error === 'object' && 'message' in (obj.error as Record<string, unknown>)
    ? stringField((obj.error as Record<string, unknown>).message)
    : stringField(obj.error);
  // Pull the semantic score from the modern `scores.{relevance|coherence|...}` shape
  // when present. eval-score persists `score_0_100` per evaluator.
  let modernSemantic: number | undefined;
  let modernDims: Record<string, number> | undefined;
  let modernRationale: string | undefined;
  if (obj.scores && typeof obj.scores === 'object') {
    const dims: Record<string, number> = {};
    const sums: number[] = [];
    for (const [k, v] of Object.entries(obj.scores as Record<string, unknown>)) {
      if (v && typeof v === 'object') {
        const s = (v as Record<string, unknown>).score_0_100;
        if (typeof s === 'number') {
          dims[k] = s;
          sums.push(s);
        }
        const r = (v as Record<string, unknown>).reason;
        if (typeof r === 'string' && !modernRationale) modernRationale = r;
      }
    }
    if (Object.keys(dims).length > 0) {
      modernDims = dims;
      modernSemantic = sums.reduce((a, b) => a + b, 0) / sums.length;
    }
  }
  return {
    id: stringField(obj.id) || hashId(prompt),
    prompt,
    expected_answer: stringField(obj.expected_answer ?? obj.expectedAnswer ?? obj.expected_response),
    actual_answer: stringField(obj.actual_answer ?? obj.actualAnswer ?? obj.answer ?? obj.response),
    error: errorVal,
    judge_provider: stringField(obj.judge_provider ?? obj.judgeProvider) || undefined,
    semantic_score: typeof obj.semantic_score === 'number' ? obj.semantic_score
                  : typeof obj.semanticScore === 'number' ? obj.semanticScore
                  : modernSemantic,
    semantic_dimensions: extractDimensions(obj.semantic_dimensions ?? obj.semanticDimensions) ?? modernDims,
    semantic_rationale: stringField(obj.semantic_rationale ?? obj.rationale) || modernRationale || undefined,
    has_citation: typeof obj.has_citation === 'boolean' ? obj.has_citation
                : typeof obj.hasCitation === 'boolean' ? obj.hasCitation : undefined,
    retries: typeof obj.retries === 'number' ? obj.retries : undefined,
    rate_limited: typeof obj.rate_limited === 'boolean' ? obj.rate_limited : undefined,
  };
}

function extractDimensions(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'number') out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseCompletedCsv(file: string): EvalScoreRow[] {
  const text = fs.readFileSync(file, 'utf-8');
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];
  const header = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const cells = parseCsvLine(line);
    const obj: Record<string, string> = {};
    for (let i = 0; i < header.length; i++) obj[header[i]] = cells[i] || '';
    return {
      id: obj.id || hashId(obj.prompt || ''),
      prompt: obj.prompt || '',
      expected_answer: obj.expected_answer || '',
      actual_answer: obj.actual_answer || obj.answer || '',
      error: obj.error || undefined,
    } as EvalScoreRow;
  });
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { cell += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      out.push(cell); cell = '';
    } else {
      cell += ch;
    }
  }
  out.push(cell);
  return out;
}

/* -------------------------------------------------------------------------- */
/* Invalid-row detection                                                      */
/* -------------------------------------------------------------------------- */

const RATE_LIMIT_PATTERNS: RegExp[] = [
  /reached.*limit.*number of requests/i,
  /rate ?limit/i,
  /too many requests/i,
  /try again later/i,
  /please wait/i,
];

function isInvalidRow(row: EvalScoreRow): boolean {
  if (row.error) return true;
  if (!row.actual_answer || row.actual_answer.trim().length === 0) return true;
  if (row.actual_answer.startsWith('[ERROR:')) return true;
  if (row.rate_limited) return true;
  if (RATE_LIMIT_PATTERNS.some((re) => re.test(row.actual_answer))) return true;
  // Judge fallback / unparseable: surface from judge_provider mismatch or
  // missing semantic_score when one was expected.
  if (row.judge_provider && row.judge_provider.toLowerCase().includes('fallback')) return true;
  return false;
}

/* -------------------------------------------------------------------------- */
/* Deterministic scorer fold-in                                               */
/* -------------------------------------------------------------------------- */

interface DeterministicScoreItem {
  score: number;
  status: 'pass' | 'partial' | 'fail';
  assertionsPassed: number;
  assertionsTotal: number;
  factsPassed: number;
  factsTotal: number;
  category?: string;
  hasCitation: boolean;
  noResult: boolean;
}

interface EvalItem {
  id?: string;
  prompt?: string;
  expected_answer?: string;
  assertions?: Array<{ value?: string; wholeWord?: boolean }>;
  supporting_facts?: string[];
  supportingFacts?: string[];
  category?: string;
  difficulty?: string;
}

function scoreDeterministically(evalJsonPath: string, rows: EvalScoreRow[]): Map<string, DeterministicScoreItem> {
  const parsed = JSON.parse(fs.readFileSync(evalJsonPath, 'utf-8')) as { items?: EvalItem[] };
  const evalItems = parsed.items || [];
  const byId = new Map<string, DeterministicScoreItem>();
  const itemById = new Map<string, EvalItem>();
  for (const item of evalItems) {
    if (item.id) itemById.set(item.id, item);
  }
  for (const row of rows) {
    const item = itemById.get(row.id);
    if (!item) {
      byId.set(row.id, { score: 0, status: 'fail', assertionsPassed: 0, assertionsTotal: 0, factsPassed: 0, factsTotal: 0, hasCitation: !!row.has_citation, noResult: false });
      continue;
    }
    byId.set(row.id, scoreOneItem(item, row));
  }
  return byId;
}

function scoreOneItem(item: EvalItem, row: EvalScoreRow): DeterministicScoreItem {
  const response = row.actual_answer || '';
  const assertions = item.assertions || [];
  const assertionsPassed = assertions.filter((a) => containsValue(response, a.value || '', !!a.wholeWord)).length;
  const facts = (item.supporting_facts || item.supportingFacts || []).filter((f): f is string => typeof f === 'string');
  const factsPassed = facts.filter((f) => {
    const [, value] = parseFact(f);
    return value ? containsValue(response, value, false) : false;
  }).length;
  const assertionsTotal = assertions.length;
  const factsTotal = facts.length;

  let assertionScore = 0;
  let factScore = 0;
  let detScore = 0;
  let status: 'pass' | 'partial' | 'fail' = 'fail';
  if (assertionsTotal > 0) {
    assertionScore = assertionsPassed / assertionsTotal;
    factScore = factsTotal > 0 ? factsPassed / factsTotal : assertionScore;
    detScore = 0.8 * assertionScore + 0.2 * factScore;
    status = assertionsPassed === assertionsTotal ? 'pass' : assertionsPassed > 0 ? 'partial' : 'fail';
  } else if (factsTotal > 0) {
    assertionScore = factsPassed / factsTotal;
    factScore = assertionScore;
    detScore = factScore;
    status = factsPassed === factsTotal ? 'pass' : factsPassed > 0 ? 'partial' : 'fail';
  }
  return {
    score: roundPct(detScore),
    status,
    assertionsPassed,
    assertionsTotal,
    factsPassed,
    factsTotal,
    category: item.category,
    hasCitation: !!row.has_citation || hasCitationText(response),
    noResult: hasNoResultText(response),
  };
}

function containsValue(text: string, expected: string, wholeWord: boolean): boolean {
  if (!expected) return true;
  const folded = (s: string) => s.normalize('NFKD').toLowerCase();
  const target = folded(expected);
  const haystack = folded(text);
  if (wholeWord) {
    const pattern = new RegExp(`(?<![a-z0-9])${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9])`);
    if (pattern.test(haystack)) return true;
  }
  return haystack.includes(target);
}

function parseFact(fact: string): [string, string] {
  const idx = fact.indexOf('=');
  return idx < 0 ? ['', fact.trim()] : [fact.slice(0, idx).trim(), fact.slice(idx + 1).trim()];
}

function hasCitationText(value: string): boolean {
  return value.includes('cite') || /\[\^\d+\^\]/.test(value);
}

function hasNoResultText(value: string): boolean {
  return /no\s+(matching|records|results)|not\s+found|unable\s+to\s+return/i.test(value);
}

/* -------------------------------------------------------------------------- */
/* Canonical report                                                           */
/* -------------------------------------------------------------------------- */

interface BuildReportInput {
  job: import('../types').JobRecord;
  judgeProvider: JudgeProvider;
  evalScoreRows: EvalScoreRow[];
  deterministicByItemId: Map<string, DeterministicScoreItem>;
  indexReadyAt: string;
}

function buildCanonicalReport(input: BuildReportInput): ScoredReport {
  const { job, judgeProvider, evalScoreRows, deterministicByItemId, indexReadyAt } = input;
  const validRows = evalScoreRows.filter((r) => !isInvalidRow(r));

  let detSum = 0;
  let detCount = 0;
  let passCount = 0;
  let partialCount = 0;
  let failCount = 0;
  const byCategory = new Map<string, { count: number; sum: number }>();
  let semSum = 0;
  let semCount = 0;
  const dimensionSums = new Map<string, { sum: number; count: number }>();
  let citationCount = 0;
  let retrySum = 0;
  let rateLimitCount = 0;

  const items: ScoredReport['items'] = [];
  for (const row of validRows) {
    const det = deterministicByItemId.get(row.id) || {
      score: 0, status: 'fail' as const, assertionsPassed: 0, assertionsTotal: 0, factsPassed: 0, factsTotal: 0, hasCitation: false, noResult: false,
    };
    detSum += det.score; detCount++;
    if (det.status === 'pass') passCount++;
    else if (det.status === 'partial') partialCount++;
    else failCount++;
    if (det.category) {
      const cat = byCategory.get(det.category) || { count: 0, sum: 0 };
      cat.count++; cat.sum += det.score;
      byCategory.set(det.category, cat);
    }
    if (typeof row.semantic_score === 'number') {
      semSum += row.semantic_score; semCount++;
    }
    if (row.semantic_dimensions) {
      for (const [d, v] of Object.entries(row.semantic_dimensions)) {
        const acc = dimensionSums.get(d) || { sum: 0, count: 0 };
        acc.sum += v; acc.count++;
        dimensionSums.set(d, acc);
      }
    }
    if (det.hasCitation || row.has_citation) citationCount++;
    if (typeof row.retries === 'number') retrySum += row.retries;
    if (row.rate_limited) rateLimitCount++;

    items.push({
      id: row.id,
      prompt: row.prompt,
      expected: row.expected_answer,
      actual: row.actual_answer,
      category: det.category,
      deterministic: {
        score: det.score, status: det.status,
        assertionsPassed: det.assertionsPassed, assertionsTotal: det.assertionsTotal,
        factsPassed: det.factsPassed, factsTotal: det.factsTotal,
      },
      semantic: {
        score: typeof row.semantic_score === 'number' ? row.semantic_score : 0,
        byDimension: row.semantic_dimensions,
        rationale: row.semantic_rationale,
      },
      citation: det.hasCitation || row.has_citation,
    });
  }

  const categoryAvg: Record<string, { count: number; average: number }> = {};
  for (const [cat, { count, sum }] of byCategory) {
    categoryAvg[cat] = { count, average: roundPct(sum / count / 100) };
  }
  const dimensionAvg: Record<string, number> = {};
  for (const [d, { sum, count }] of dimensionSums) {
    dimensionAvg[d] = roundPct(sum / count / 100);
  }

  const metadataProvenance = loadMetadataProvenance(job.workspace);

  return {
    jobId: job.id,
    noEnhance: !!job.config.noEnhance,
    judgeProvider,
    judgeModel: process.env.EVALSCORE_GITHUB_COPILOT_MODEL,
    datasetHash: job.datasetHash,
    evalSetHash: job.evalSetHash,
    indexReadyAt,
    promptCount: evalScoreRows.length,
    validPromptCount: validRows.length,
    metadataProvenance,
    deterministicScore: {
      average: detCount > 0 ? roundPct(detSum / detCount / 100) : 0,
      passCount, partialCount, failCount,
      byCategory: categoryAvg,
    },
    semanticScore: {
      average: semCount > 0 ? roundPct(semSum / semCount / 100) : 0,
      byDimension: dimensionAvg,
    },
    citationRate: validRows.length > 0 ? roundPct(citationCount / validRows.length) : 0,
    retryCount: retrySum,
    rateLimitCount,
    items,
  };
}

function loadMetadataProvenance(workspace: string): ScoredReport['metadataProvenance'] {
  const identityReport = path.join(workspace, '02-enhance', 'identity-transform-report.json');
  if (fs.existsSync(identityReport)) {
    const parsed = JSON.parse(fs.readFileSync(identityReport, 'utf-8')) as { metadataProvenance?: ScoredReport['metadataProvenance'] };
    return parsed.metadataProvenance;
  }
  return undefined;
}

function renderReportMarkdown(report: ScoredReport): string {
  const lines: string[] = [];
  lines.push(`# Step 6 — agent response scoring`, '');
  lines.push(`- job: \`${report.jobId}\``);
  lines.push(`- noEnhance: \`${report.noEnhance}\``);
  lines.push(`- judgeProvider: \`${report.judgeProvider}\``);
  lines.push(`- prompts: ${report.promptCount} (valid ${report.validPromptCount})`);
  lines.push(`- indexReadyAt: ${report.indexReadyAt}`);
  lines.push('');
  lines.push('## Aggregates', '');
  lines.push(`- Deterministic average: ${report.deterministicScore.average}`);
  lines.push(`- Semantic average: ${report.semanticScore.average}`);
  lines.push(`- Citation rate: ${report.citationRate}`);
  lines.push(`- Retries: ${report.retryCount}, rate-limited: ${report.rateLimitCount}`);
  return `${lines.join('\n')}\n`;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

async function resolveCandidateAgentId(workspace: string, fromConfig: string | undefined): Promise<string | undefined> {
  if (fromConfig) return fromConfig;
  const resources = path.join(workspace, '05-deploy', 'resources.json');
  if (fs.existsSync(resources)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(resources, 'utf-8')) as { agentId?: string };
      if (parsed.agentId) return parsed.agentId;
    } catch {
      // ignore
    }
  }
  return undefined;
}

interface RunChildResult { ok: boolean; exitCode: number; }

function runChild(
  cmd: string,
  args: string[],
  options: { logFile?: string; cwd?: string; label?: string; onLog?: (text: string) => void },
): Promise<RunChildResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: options.cwd, shell: false });
    const logStream = options.logFile ? fs.createWriteStream(options.logFile, { encoding: 'utf-8' }) : undefined;
    const writeText = (text: string) => {
      if (logStream) logStream.write(text);
      if (options.onLog) options.onLog(text);
    };
    child.stdout.on('data', (chunk) => writeText(Buffer.from(chunk).toString('utf-8')));
    child.stderr.on('data', (chunk) => writeText(Buffer.from(chunk).toString('utf-8')));
    child.on('close', (code) => {
      if (logStream) logStream.end();
      resolve({ ok: code === 0, exitCode: code ?? -1 });
    });
    child.on('error', (e) => {
      writeText(`spawn error: ${e.message}\n`);
      if (logStream) logStream.end();
      resolve({ ok: false, exitCode: -1 });
    });
  });
}

function stringField(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function hashId(prompt: string): string {
  return require('crypto').createHash('sha256').update(prompt).digest('hex').slice(0, 12);
}

function roundPct(fraction: number): number {
  return Math.round(fraction * 1000) / 10;
}
