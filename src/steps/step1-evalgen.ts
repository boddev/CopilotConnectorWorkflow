import * as fs from 'fs';
import * as path from 'path';
import { StepRecord } from '../types';
import { runProcess } from '../run';
import { fileHash, dirHash, objectHash, ensureEvalSetHash, jobDir, loadJob } from '../jobs';
import { isCached, stepInputsHash } from '../orchestrator';
import { newStepRecord, startStep, finishStep, writeStepStatus } from './step-utils';
import type { RunStepOptions } from '../orchestrator';
import { prepareDatasetForWorkflow } from '../dataset-normalization';

/**
 * Resolve the source folder for --reuse-eval-from <jobId> or --eval-set <path>.
 * Returns undefined if neither is set.
 */
function resolveEvalSetSource(job: import('../types').JobRecord): { sourceDir: string; sourceLabel: string } | undefined {
  if (job.config.reuseEvalFromJobId) {
    const src = path.join(jobDir(job.config.reuseEvalFromJobId), '01-evalgen');
    if (!fs.existsSync(src)) {
      throw new Error(`--reuse-eval-from job not found or has no 01-evalgen folder: ${job.config.reuseEvalFromJobId}`);
    }
    return { sourceDir: src, sourceLabel: `job ${job.config.reuseEvalFromJobId}` };
  }
  if (job.config.evalSetPath) {
    const src = path.resolve(job.config.evalSetPath);
    if (!fs.existsSync(src)) {
      throw new Error(`--eval-set path not found: ${src}`);
    }
    return { sourceDir: src, sourceLabel: src };
  }
  return undefined;
}

/** Step 1: run eval-gen against the dataset and produce eval.csv + .evalgen.json. */
export async function runStep1Evalgen(opts: RunStepOptions): Promise<StepRecord> {
  const { job, tools, emitter, force } = opts;
  const rec = newStepRecord('evalgen');
  const stepDir = path.join(job.workspace, '01-evalgen');
  fs.mkdirSync(stepDir, { recursive: true });
  const outputCsv = path.join(stepDir, 'eval.csv');
  const outputJson = path.join(stepDir, 'eval.evalgen.json');
  const outputReview = path.join(stepDir, 'eval-review.md');
  const logFile = path.join(stepDir, 'step.log');

  // --reuse-eval-from <jobId> / --eval-set <path>: copy the eval set verbatim
  // instead of running eval-gen. The plan's "Pairing two runs" recipe.
  const reuseSource = resolveEvalSetSource(job);
  if (reuseSource) {
    startStep(rec);
    const srcCsv = path.join(reuseSource.sourceDir, 'eval.csv');
    const srcJson = path.join(reuseSource.sourceDir, 'eval.evalgen.json');
    const srcReview = path.join(reuseSource.sourceDir, 'eval-review.md');
    if (!fs.existsSync(srcCsv) || !fs.existsSync(srcJson)) {
      finishStep(rec, 'failed', `eval-set source missing eval.csv or eval.evalgen.json: ${reuseSource.sourceDir}`);
      writeStepStatus(stepDir, rec); return rec;
    }
    fs.copyFileSync(srcCsv, outputCsv);
    fs.copyFileSync(srcJson, outputJson);
    if (fs.existsSync(srcReview)) fs.copyFileSync(srcReview, outputReview);
    rec.outputs = {
      '01-evalgen/eval.csv': fileHash(outputCsv),
      '01-evalgen/eval.evalgen.json': fileHash(outputJson),
    };
    if (fs.existsSync(outputReview)) rec.outputs['01-evalgen/eval-review.md'] = fileHash(outputReview);
    rec.artifacts = Object.keys(rec.outputs).map((r) => path.join(job.workspace, r));
    rec.diagnostics?.push(`reused eval set from ${reuseSource.sourceLabel}`);
    ensureEvalSetHash(job);
    if (job.config.reuseEvalFromJobId) {
      const sourceJob = loadJob(job.config.reuseEvalFromJobId);
      if (sourceJob?.evalSetHash && job.evalSetHash !== sourceJob.evalSetHash) {
        finishStep(rec, 'failed',
          `eval-set hash mismatch after copy: source=${sourceJob.evalSetHash} new=${job.evalSetHash}`);
        writeStepStatus(stepDir, rec); return rec;
      }
    }
    finishStep(rec, 'done');
    writeStepStatus(stepDir, rec); return rec;
  }

  if (!fs.existsSync(tools.evalGen)) {
    finishStep(rec, 'failed', `eval-gen not built. Expected ${tools.evalGen}. Build it: cd ..\\EvaluationCLI\\eval-gen && npm install && npm run build`);
    writeStepStatus(stepDir, rec); return rec;
  }

  const preparedDataset = prepareDatasetForWorkflow(job.config.dataset, job.workspace, job.config.extensions);
  rec.diagnostics?.push(...preparedDataset.diagnostics);

  const inputs = {
    dataset: job.config.dataset,
    datasetHash: dirHash(job.config.dataset),
    preparedDataset: preparedDataset.dataset,
    preparedExtensions: preparedDataset.extensions || [],
    description: job.config.description,
    count: job.config.count,
    extensions: job.config.extensions || [],
    evalGenHash: fileHash(tools.evalGen),
  };
  const inputsHash = stepInputsHash([inputs]);
  rec.inputsHash = inputsHash;

  const prev = job.steps.evalgen;
  if (!force && isCached(prev.inputsHash, inputsHash, prev.outputs, job.workspace)) {
    startStep(rec); finishStep(rec, 'skipped');
    rec.outputs = prev.outputs;
    rec.artifacts = [outputCsv, outputJson, outputReview].filter((p) => fs.existsSync(p));
    rec.diagnostics?.push('cache hit: inputs unchanged and outputs present');
    ensureEvalSetHash(job);
    writeStepStatus(stepDir, rec); return rec;
  }

  startStep(rec);
  const args = [
    tools.evalGen,
    '--file', preparedDataset.dataset,
    '--description', job.config.description,
    '--count', String(job.config.count),
    '--output', outputCsv,
  ];
  if (preparedDataset.extensions && preparedDataset.extensions.length > 0) {
    args.push('--extensions', preparedDataset.extensions.join(','));
  }
  const result = await runProcess({
    cmd: process.execPath,  // node
    args,
    cwd: path.dirname(tools.evalGen),
    logFile,
    emitter,
    label: 'evalgen',
  });
  rec.exitCode = result.exitCode;
  if (!result.ok) {
    finishStep(rec, 'failed', `eval-gen exit ${result.exitCode}`);
    writeStepStatus(stepDir, rec); return rec;
  }

  // eval-gen writes <output>.csv, <output>.evalgen.json, <output>-review.md. Verify.
  const evalgenJson = outputCsv.replace(/\.csv$/, '.evalgen.json');
  const reviewMd = outputCsv.replace(/\.csv$/, '-review.md');
  // Move/normalize names so downstream steps can rely on fixed filenames
  if (fs.existsSync(evalgenJson) && evalgenJson !== outputJson) fs.renameSync(evalgenJson, outputJson);
  if (fs.existsSync(reviewMd) && reviewMd !== outputReview) fs.renameSync(reviewMd, outputReview);

  if (!fs.existsSync(outputCsv) || !fs.existsSync(outputJson)) {
    finishStep(rec, 'failed', 'eval-gen produced no eval.csv or eval.evalgen.json');
    writeStepStatus(stepDir, rec); return rec;
  }

  rec.outputs = {
    '01-evalgen/eval.csv': fileHash(outputCsv),
    '01-evalgen/eval.evalgen.json': fileHash(outputJson),
  };
  if (fs.existsSync(outputReview)) rec.outputs['01-evalgen/eval-review.md'] = fileHash(outputReview);
  rec.artifacts = Object.keys(rec.outputs).map((r) => path.join(job.workspace, r));
  ensureEvalSetHash(job);
  finishStep(rec, 'done');
  writeStepStatus(stepDir, rec);
  return rec;
}
