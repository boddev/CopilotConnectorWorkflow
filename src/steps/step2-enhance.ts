import * as fs from 'fs';
import * as path from 'path';
import { StepRecord } from '../types';
import { runProcess, splitInvocation } from '../run';
import { fileHash, dirHash } from '../jobs';
import { isCached, stepInputsHash, RunStepOptions } from '../orchestrator';
import { newStepRecord, startStep, finishStep, writeStepStatus } from './step-utils';

/** Step 2: run the data-enhancer python script against dataset + eval sidecar. */
export async function runStep2Enhance(opts: RunStepOptions): Promise<StepRecord> {
  const { job, tools, emitter, force } = opts;
  const rec = newStepRecord('enhance');
  const stepDir = path.join(job.workspace, '02-enhance');
  fs.mkdirSync(stepDir, { recursive: true });
  const logFile = path.join(stepDir, 'step.log');

  if (!fs.existsSync(tools.dataEnhancer)) {
    finishStep(rec, 'failed', `data-enhancer not found at ${tools.dataEnhancer}`);
    writeStepStatus(stepDir, rec); return rec;
  }

  const evalSidecar = path.join(job.workspace, '01-evalgen', 'eval.evalgen.json');
  if (!fs.existsSync(evalSidecar)) {
    finishStep(rec, 'failed', `missing eval sidecar from step 1: ${evalSidecar}`);
    writeStepStatus(stepDir, rec); return rec;
  }

  const inputs = {
    dataset: job.config.dataset,
    datasetHash: dirHash(job.config.dataset),
    evalSidecarHash: fileHash(evalSidecar),
    aclMode: job.config.aclMode,
    enhancerHash: fileHash(tools.dataEnhancer),
  };
  const inputsHash = stepInputsHash([inputs]);
  rec.inputsHash = inputsHash;

  const prev = job.steps.enhance;
  if (!force && isCached(prev.inputsHash, inputsHash, prev.outputs, job.workspace)) {
    startStep(rec); finishStep(rec, 'skipped');
    rec.outputs = prev.outputs;
    rec.diagnostics?.push('cache hit: inputs unchanged and outputs present');
    writeStepStatus(stepDir, rec); return rec;
  }

  startStep(rec);
  const [pyCmd, pyPrefix] = splitInvocation(tools.python);
  const args = [
    ...pyPrefix,
    tools.dataEnhancer,
    '--dataset', job.config.dataset,
    '--eval', evalSidecar,
    '--output', stepDir,
    '--acl-mode', job.config.aclMode,
  ];
  const result = await runProcess({
    cmd: pyCmd,
    args,
    cwd: path.dirname(tools.dataEnhancer),
    logFile,
    emitter,
    label: 'enhance',
  });
  rec.exitCode = result.exitCode;
  if (!result.ok) {
    finishStep(rec, 'failed', `data-enhancer exit ${result.exitCode}`);
    writeStepStatus(stepDir, rec); return rec;
  }
  const expected = [
    'enhanced-items.jsonl',
    'enhanced-records.csv',
    'schema-suggestion.json',
    'enhancement-report.json',
    'unmatched-eval-items.json',
  ];
  const missing = expected.filter((n) => !fs.existsSync(path.join(stepDir, n)));
  if (missing.length > 0) {
    finishStep(rec, 'failed', `data-enhancer missing outputs: ${missing.join(', ')}`);
    writeStepStatus(stepDir, rec); return rec;
  }
  rec.outputs = {};
  for (const name of expected) {
    rec.outputs[`02-enhance/${name}`] = fileHash(path.join(stepDir, name));
  }
  rec.artifacts = expected.map((n) => path.join(stepDir, n));
  finishStep(rec, 'done');
  writeStepStatus(stepDir, rec);
  return rec;
}
