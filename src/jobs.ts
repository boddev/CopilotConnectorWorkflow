import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { JobRecord, JobConfig, StepName, StepRecord, ALL_STEPS } from './types';

const WORKSPACE_ROOT = path.resolve(__dirname, '..', 'workspace', 'jobs');

export function workspaceRoot(): string {
  if (!fs.existsSync(WORKSPACE_ROOT)) fs.mkdirSync(WORKSPACE_ROOT, { recursive: true });
  return WORKSPACE_ROOT;
}

export function newJobId(): string {
  const t = new Date();
  const stamp = `${t.getFullYear()}${pad(t.getMonth() + 1)}${pad(t.getDate())}-${pad(t.getHours())}${pad(t.getMinutes())}${pad(t.getSeconds())}`;
  const suffix = crypto.randomBytes(3).toString('hex');
  return `${stamp}-${suffix}`;
}

function pad(n: number): string { return n < 10 ? `0${n}` : String(n); }

export function jobDir(jobId: string): string {
  return path.join(workspaceRoot(), jobId);
}

export function createJob(config: JobConfig): JobRecord {
  validateConfig(config);
  const id = newJobId();
  const dir = jobDir(id);
  fs.mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  const steps = {} as Record<StepName, StepRecord>;
  for (const name of ALL_STEPS) steps[name] = { name, status: 'pending' };
  const job: JobRecord = {
    id,
    createdAt: now,
    updatedAt: now,
    status: 'pending',
    config,
    steps,
    workspace: dir,
  };
  saveJob(job);
  return job;
}

export function saveJob(job: JobRecord): void {
  job.updatedAt = new Date().toISOString();
  const file = path.join(job.workspace, 'job.json');
  fs.writeFileSync(file, JSON.stringify(job, null, 2), 'utf-8');
}

export function loadJob(jobId: string): JobRecord | undefined {
  const file = path.join(jobDir(jobId), 'job.json');
  if (!fs.existsSync(file)) return undefined;
  return JSON.parse(fs.readFileSync(file, 'utf-8')) as JobRecord;
}

export function listJobs(): JobRecord[] {
  const root = workspaceRoot();
  if (!fs.existsSync(root)) return [];
  const out: JobRecord[] = [];
  for (const id of fs.readdirSync(root)) {
    const j = loadJob(id);
    if (j) out.push(j);
  }
  out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return out;
}

export function validateConfig(c: JobConfig): void {
  if (!c.dataset) throw new Error('dataset is required');
  if (!fs.existsSync(c.dataset)) throw new Error(`dataset not found: ${c.dataset}`);
  if (!c.description || c.description.length < 10) throw new Error('description must be at least 10 characters');
  if (!c.count || c.count < 5 || c.count > 50) throw new Error('count must be 5-50');
  if (!c.connectorId || !/^[a-zA-Z0-9]{3,128}$/.test(c.connectorId)) {
    throw new Error('connectorId must be 3-128 alphanumeric characters (no symbols)');
  }
  if (!c.connectorName) throw new Error('connectorName is required');
  if (c.mode === 'provision') {
    if (!c.auth?.tenantId) throw new Error('provision mode requires auth.tenantId');
    if (!c.auth?.clientId) throw new Error('provision mode requires auth.clientId');
    if (!c.auth.useManagedIdentity && !c.auth.clientSecretEnvVar) {
      throw new Error('provision mode requires either useManagedIdentity=true or clientSecretEnvVar');
    }
  }
}

/** Stable hash of a file's contents (sha256, hex, first 16 chars). */
export function fileHash(file: string): string {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return '';
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(file));
  return h.digest('hex').slice(0, 16);
}

/** Recursive directory hash; aggregates relative path + file hash. */
export function dirHash(dir: string): string {
  if (!fs.existsSync(dir)) return '';
  if (fs.statSync(dir).isFile()) return fileHash(dir);
  const h = crypto.createHash('sha256');
  const walk = (d: string, rel: string) => {
    const entries = fs.readdirSync(d).sort();
    for (const name of entries) {
      const p = path.join(d, name);
      const r = rel ? `${rel}/${name}` : name;
      const stat = fs.statSync(p);
      if (stat.isDirectory()) walk(p, r);
      else { h.update(r); h.update(':'); h.update(fileHash(p)); h.update('\n'); }
    }
  };
  walk(dir, '');
  return h.digest('hex').slice(0, 16);
}

export function objectHash(obj: unknown): string {
  const h = crypto.createHash('sha256');
  h.update(JSON.stringify(obj, Object.keys(obj as object).sort()));
  return h.digest('hex').slice(0, 16);
}
