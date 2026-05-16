import * as fs from 'fs';
import * as path from 'path';
import { StepRecord } from '../types';

/** Write the structured per-step status JSON alongside artifacts. */
export function writeStepStatus(stepDir: string, rec: StepRecord): void {
  fs.mkdirSync(stepDir, { recursive: true });
  fs.writeFileSync(path.join(stepDir, 'step-status.json'), JSON.stringify(rec, null, 2), 'utf-8');
}

export function newStepRecord(name: StepRecord['name']): StepRecord {
  return { name, status: 'pending', diagnostics: [], outputs: {} };
}

export function startStep(rec: StepRecord): void {
  rec.status = 'running';
  rec.startedAt = new Date().toISOString();
}

export function finishStep(rec: StepRecord, status: 'done' | 'failed' | 'skipped', err?: string): void {
  rec.status = status;
  rec.endedAt = new Date().toISOString();
  if (err) rec.errorMessage = err;
}

export function relativizeOutputs(
  jobWorkspace: string,
  files: string[],
): { rel: string; abs: string }[] {
  return files.map((abs) => ({ rel: path.relative(jobWorkspace, abs).replace(/\\/g, '/'), abs }));
}
