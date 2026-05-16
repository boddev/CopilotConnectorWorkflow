import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import { JobRecord, StepName, StepRecord, ALL_STEPS } from './types';
import { saveJob, objectHash } from './jobs';
import { resolveTools, ToolPaths } from './tools';
import { runStep1Evalgen } from './steps/step1-evalgen';
import { runStep2Enhance } from './steps/step2-enhance';
import { runStep3Schema } from './steps/step3-schema';
import { runStep4Connector } from './steps/step4-connector';
import { runStep5Deploy } from './steps/step5-deploy';
import { runStep6M365Eval } from './steps/step6-m365eval';

export interface RunStepOptions {
  job: JobRecord;
  tools: ToolPaths;
  emitter?: EventEmitter;
  force?: boolean;
}

export interface RunPipelineOptions {
  job: JobRecord;
  tools?: ToolPaths;
  emitter?: EventEmitter;
  /** Force every step regardless of cached outputs. */
  forceAll?: boolean;
  /** Force specific steps. */
  forceSteps?: StepName[];
  /** Start at this step (run from N onward). */
  startAt?: StepName;
  /** Stop after this step. */
  stopAfter?: StepName;
}

const STEP_RUNNERS: Record<StepName, (o: RunStepOptions) => Promise<StepRecord>> = {
  evalgen: runStep1Evalgen,
  enhance: runStep2Enhance,
  schema: runStep3Schema,
  connector: runStep4Connector,
  deploy: runStep5Deploy,
  m365eval: runStep6M365Eval,
};

export async function runPipeline(opts: RunPipelineOptions): Promise<JobRecord> {
  const tools = opts.tools || resolveTools();
  const { job, emitter } = opts;
  const forceSet = new Set(opts.forceSteps || []);

  const steps = pipelineSequence(job);
  const startIdx = opts.startAt ? steps.indexOf(opts.startAt) : 0;
  const stopIdx = opts.stopAfter ? steps.indexOf(opts.stopAfter) : steps.length - 1;
  job.status = 'running';
  saveJob(job);

  for (let i = startIdx; i <= stopIdx; i++) {
    const name = steps[i];
    const force = !!opts.forceAll || forceSet.has(name);
    emitter?.emit('log', { label: 'orchestrator', text: `\n=== Step ${name}${force ? ' (force)' : ''} ===\n` });
    try {
      const rec = await STEP_RUNNERS[name]({ job, tools, emitter, force });
      job.steps[name] = rec;
      saveJob(job);
      if (rec.status === 'failed') {
        job.status = 'failed';
        saveJob(job);
        emitter?.emit('log', { label: 'orchestrator', text: `Step ${name} failed: ${rec.errorMessage || ''}\n` });
        return job;
      }
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      job.steps[name] = {
        ...job.steps[name],
        status: 'failed',
        errorMessage: err,
        endedAt: new Date().toISOString(),
      };
      job.status = 'failed';
      saveJob(job);
      emitter?.emit('log', { label: 'orchestrator', text: `Step ${name} threw: ${err}\n` });
      return job;
    }
  }

  // Pipeline done. Any later steps stay 'pending'; mark whole job done if all required steps succeeded.
  const requiredDone = steps.every((s) => {
    const st = job.steps[s].status;
    return st === 'done' || st === 'skipped';
  });
  job.status = requiredDone ? 'done' : 'failed';
  saveJob(job);
  emitter?.emit('log', { label: 'orchestrator', text: `\n=== Pipeline ${job.status} ===\n` });
  return job;
}

function pipelineSequence(job: JobRecord): StepName[] {
  // m365eval is optional and only included when requested AND mode == provision.
  const base: StepName[] = ['evalgen', 'enhance', 'schema', 'connector', 'deploy'];
  if (job.config.runM365Eval && job.config.mode === 'provision') base.push('m365eval');
  return base;
}

/** Helper used by step runners to decide cache-hit. */
export function isCached(
  prevHash: string | undefined,
  newHash: string,
  outputs: Record<string, string> | undefined,
  outputDir: string,
): boolean {
  if (!prevHash || prevHash !== newHash) return false;
  if (!outputs) return false;
  for (const rel of Object.keys(outputs)) {
    const p = path.join(outputDir, rel);
    if (!fs.existsSync(p)) return false;
  }
  return true;
}

export function stepInputsHash(parts: unknown[]): string {
  return objectHash(parts);
}
