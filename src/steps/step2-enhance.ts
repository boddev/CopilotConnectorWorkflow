import * as fs from 'fs';
import * as path from 'path';
import { StepRecord } from '../types';
import { runProcess } from '../run';
import { fileHash, dirHash } from '../jobs';
import { isCached, stepInputsHash, RunStepOptions } from '../orchestrator';
import { newStepRecord, startStep, finishStep, writeStepStatus } from './step-utils';
import { prepareDatasetForWorkflow } from '../dataset-normalization';
import { runIdentityTransform } from '../identity-transform';

/** Step 2: enhance the dataset, or run the no-enhance identity transform. */
export async function runStep2Enhance(opts: RunStepOptions): Promise<StepRecord> {
  const { job, tools, emitter, force } = opts;
  const rec = newStepRecord('enhance');
  const stepDir = path.join(job.workspace, '02-enhance');
  fs.mkdirSync(stepDir, { recursive: true });
  const logFile = path.join(stepDir, 'step.log');

  // --no-enhance: run the identity-but-shape-aware transform.
  if (job.config.noEnhance) {
    return runNoEnhanceBranch(opts, rec, stepDir);
  }

  if (!fs.existsSync(tools.dataEnhancer)) {
    finishStep(rec, 'failed',
      `data-enhancer not found at ${tools.dataEnhancer} — build the workflow first: npm run build`);
    writeStepStatus(stepDir, rec); return rec;
  }

  const evalSidecar = path.join(job.workspace, '01-evalgen', 'eval.evalgen.json');
  if (!fs.existsSync(evalSidecar)) {
    finishStep(rec, 'failed', `missing eval sidecar from step 1: ${evalSidecar}`);
    writeStepStatus(stepDir, rec); return rec;
  }

  const preparedDataset = prepareDatasetForWorkflow(job.config.dataset, job.workspace, job.config.extensions);
  rec.diagnostics?.push(...preparedDataset.diagnostics);

  const inputs = {
    dataset: job.config.dataset,
    datasetHash: dirHash(job.config.dataset),
    preparedDataset: preparedDataset.dataset,
    preparedExtensions: preparedDataset.extensions || [],
    evalSidecarHash: fileHash(evalSidecar),
    aclMode: job.config.aclMode,
    extensions: job.config.extensions || [],
    urlPrefix: job.config.urlPrefix || '',
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
  const args = [
    tools.dataEnhancer,
    '--dataset', preparedDataset.dataset,
    '--eval', evalSidecar,
    '--output', stepDir,
    '--acl-mode', job.config.aclMode,
  ];
  if (preparedDataset.extensions && preparedDataset.extensions.length > 0) {
    args.push('--extensions', preparedDataset.extensions.join(','));
  }
  if (job.config.urlPrefix) {
    args.push('--url-prefix', job.config.urlPrefix);
  }
  const result = await runProcess({
    cmd: process.execPath,
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

/**
 * --no-enhance branch: identity-but-shape-aware transform. Emits the same two
 * downstream files (enhanced-items.jsonl and schema-suggestion.json) so Steps
 * 3-6 don't know the difference.
 */
async function runNoEnhanceBranch(
  opts: RunStepOptions,
  rec: StepRecord,
  stepDir: string,
): Promise<StepRecord> {
  const { job, force } = opts;
  const inputs = {
    dataset: job.config.dataset,
    datasetHash: dirHash(job.config.dataset),
    aclMode: job.config.aclMode,
    extensions: job.config.extensions || [],
    urlPrefix: job.config.urlPrefix || '',
    noEnhance: true,
  };
  const inputsHash = stepInputsHash([inputs]);
  rec.inputsHash = inputsHash;

  const prev = job.steps.enhance;
  if (!force && isCached(prev.inputsHash, inputsHash, prev.outputs, job.workspace)) {
    startStep(rec); finishStep(rec, 'skipped');
    rec.outputs = prev.outputs;
    rec.diagnostics?.push('cache hit (--no-enhance): inputs unchanged and outputs present');
    writeStepStatus(stepDir, rec); return rec;
  }

  startStep(rec);
  rec.diagnostics?.push('--no-enhance: running identity-but-shape-aware transform');
  try {
    const result = await runIdentityTransform({
      dataset: job.config.dataset,
      outputDir: stepDir,
      aclMode: job.config.aclMode,
      extensions: job.config.extensions,
      urlPrefix: job.config.urlPrefix,
    });
    rec.diagnostics?.push(
      `wrote ${result.itemCount} item(s) and ${result.schemaPropertyCount} schema property(ies)`,
      `metadataProvenance: title=${result.metadataProvenance.titleFromSource} url=${result.metadataProvenance.urlFromSource} icon=${result.metadataProvenance.iconUrlFromSource}`,
    );
  } catch (e) {
    finishStep(rec, 'failed', e instanceof Error ? e.message : String(e));
    writeStepStatus(stepDir, rec); return rec;
  }

  const expected = ['enhanced-items.jsonl', 'schema-suggestion.json', 'identity-transform-report.json'];
  const missing = expected.filter((n) => !fs.existsSync(path.join(stepDir, n)));
  if (missing.length > 0) {
    finishStep(rec, 'failed', `--no-enhance branch missing outputs: ${missing.join(', ')}`);
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
