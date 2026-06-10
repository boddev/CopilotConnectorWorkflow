import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';
import * as path from 'path';
import { createApp } from '../src/server';
import { workspaceRoot, saveJob } from '../src/jobs';
import { JobRecord, ScoredReport } from '../src/types';

const app = createApp();

function uniqueId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function seedJob(opts: {
  id: string;
  mode?: 'build' | 'provision';
  noEnhance?: boolean;
  scoreStatus?: 'pending' | 'done' | 'skipped' | 'failed' | 'running';
}): JobRecord {
  const workspace = path.join(workspaceRoot(), opts.id);
  fs.mkdirSync(workspace, { recursive: true });
  const now = new Date().toISOString();
  const job: JobRecord = {
    id: opts.id,
    createdAt: now,
    updatedAt: now,
    status: 'done',
    workspace,
    config: {
      dataset: workspace,
      description: 'fixture dataset for server tests',
      count: 10,
      connectorId: opts.id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 20) + 'conn',
      connectorName: `Fixture ${opts.id}`,
      deployTarget: 'azure-functions',
      mode: opts.mode || 'provision',
      aclMode: 'everyone',
      noEnhance: opts.noEnhance,
    },
    steps: {
      evalgen: { name: 'evalgen', status: 'done' },
      enhance: { name: 'enhance', status: 'done' },
      schema: { name: 'schema', status: 'done' },
      connector: { name: 'connector', status: 'done' },
      deploy: { name: 'deploy', status: 'done' },
      score: { name: 'score', status: opts.scoreStatus || 'done' },
    } as JobRecord['steps'],
  };
  saveJob(job);
  return job;
}

function cleanup(jobId: string): void {
  const workspace = path.join(workspaceRoot(), jobId);
  fs.rmSync(workspace, { recursive: true, force: true });
}

describe('GET /api/jobs filters', () => {
  const idDoneProvision = uniqueId('foundsa');
  const idSkippedProvision = uniqueId('foundsb');
  const idBuild = uniqueId('foundsc');
  beforeAll(() => {
    seedJob({ id: idDoneProvision, mode: 'provision', scoreStatus: 'done' });
    seedJob({ id: idSkippedProvision, mode: 'provision', scoreStatus: 'skipped' });
    seedJob({ id: idBuild, mode: 'build', scoreStatus: 'skipped' });
  });
  afterAll(() => {
    cleanup(idDoneProvision); cleanup(idSkippedProvision); cleanup(idBuild);
  });

  it('returns all seeded jobs without filters', async () => {
    const res = await request(app).get('/api/jobs?limit=1000');
    expect(res.status).toBe(200);
    const ids: string[] = res.body.map((j: JobRecord) => j.id);
    for (const id of [idDoneProvision, idSkippedProvision, idBuild]) expect(ids).toContain(id);
  });

  it('?scored=true filters to score=done jobs', async () => {
    const res = await request(app).get('/api/jobs?scored=true&limit=1000');
    const ids: string[] = res.body.map((j: JobRecord) => j.id);
    expect(ids).toContain(idDoneProvision);
    expect(ids).not.toContain(idSkippedProvision);
    expect(ids).not.toContain(idBuild);
  });

  it('?provisionOnly=true filters out build-mode jobs', async () => {
    const res = await request(app).get('/api/jobs?provisionOnly=true&limit=1000');
    const ids: string[] = res.body.map((j: JobRecord) => j.id);
    expect(ids).not.toContain(idBuild);
    expect(ids).toContain(idDoneProvision);
  });

  it('?limit caps the response', async () => {
    const res = await request(app).get('/api/jobs?limit=1');
    expect(res.body.length).toBeLessThanOrEqual(1);
  });
});

describe('POST /api/jobs validation', () => {
  it('rejects mutually exclusive eval-set source fields', async () => {
    const res = await request(app).post('/api/jobs').send({
      dataset: workspaceRoot(),
      description: 'test description long enough',
      count: 10,
      connectorId: 'validation1',
      connectorName: 'Validation 1',
      deployTarget: 'azure-functions',
      mode: 'build',
      aclMode: 'everyone',
      reuseEvalFromJobId: 'job-x',
      evalSetPath: 'C:\\nope',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/mutually exclusive/i);
  });

  it('rejects workiq judge provider without judgeAgentId', async () => {
    const res = await request(app).post('/api/jobs').send({
      dataset: workspaceRoot(),
      description: 'test description long enough',
      count: 10,
      connectorId: 'validation2',
      connectorName: 'Validation 2',
      deployTarget: 'azure-functions',
      mode: 'build',
      aclMode: 'everyone',
      score: { judgeProvider: 'workiq' },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/judgeAgentId/i);
  });

  it('rejects unknown judge provider value', async () => {
    const res = await request(app).post('/api/jobs').send({
      dataset: workspaceRoot(),
      description: 'test description long enough',
      count: 10,
      connectorId: 'validation3',
      connectorName: 'Validation 3',
      deployTarget: 'azure-functions',
      mode: 'build',
      aclMode: 'everyone',
      score: { judgeProvider: 'azure-openai' },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/judgeProvider must be one of/);
  });

  it('rejects evalSetPath that does not exist', async () => {
    const res = await request(app).post('/api/jobs').send({
      dataset: workspaceRoot(),
      description: 'test description long enough',
      count: 10,
      connectorId: 'validation4',
      connectorName: 'Validation 4',
      deployTarget: 'azure-functions',
      mode: 'build',
      aclMode: 'everyone',
      evalSetPath: 'C:\\definitely\\does\\not\\exist',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/evalSetPath does not exist/i);
  });

  it('accepts a { config, runtime } body shape and creates the job', async () => {
    const datasetDir = path.join(workspaceRoot(), uniqueId('dsroot'));
    fs.mkdirSync(datasetDir, { recursive: true });
    fs.writeFileSync(path.join(datasetDir, 'sample.csv'), 'id,name\n1,Alpha\n');
    try {
      const res = await request(app).post('/api/jobs').send({
        config: {
          dataset: datasetDir,
          description: 'a sufficiently long description for validation',
          count: 10,
          connectorId: 'runtimeshape',
          connectorName: 'Runtime Shape',
          deployTarget: 'azure-functions',
          mode: 'build',
          aclMode: 'everyone',
          noEnhance: true,
        },
        runtime: { forceAll: true, startAt: 'enhance', stopAfter: 'enhance' },
      });
      expect(res.status).toBe(200);
      expect(res.body.config.noEnhance).toBe(true);
      // Clean up the created job folder.
      fs.rmSync(res.body.workspace, { recursive: true, force: true });
    } finally {
      fs.rmSync(datasetDir, { recursive: true, force: true });
    }
  });

  it('auto-generates blank connector fields from the dataset folder', async () => {
    const datasetDir = path.join(workspaceRoot(), uniqueId('autoGenDs'));
    fs.mkdirSync(datasetDir, { recursive: true });
    fs.writeFileSync(path.join(datasetDir, 'sample.csv'), 'id,name\n1,Alpha\n');
    try {
      const res = await request(app).post('/api/jobs').send({
        config: {
          dataset: datasetDir,
          description: '',
          count: 10,
          connectorId: '',
          connectorName: '',
          deployTarget: 'azure-functions',
          mode: 'build',
          aclMode: 'everyone',
          noEnhance: true,
        },
        runtime: { forceAll: true, startAt: 'enhance', stopAfter: 'enhance' },
      });
      expect(res.status).toBe(200);
      expect(res.body.config.connectorId).toMatch(/^[a-zA-Z0-9]{3,128}$/);
      expect((res.body.config.connectorName || '').length).toBeGreaterThan(0);
      expect((res.body.config.description || '').length).toBeGreaterThanOrEqual(10);
      fs.rmSync(res.body.workspace, { recursive: true, force: true });
    } finally {
      fs.rmSync(datasetDir, { recursive: true, force: true });
    }
  });

  it('injects an in-app client secret into env without persisting it to job.json', async () => {
    const datasetDir = path.join(workspaceRoot(), uniqueId('secretDs'));
    fs.mkdirSync(datasetDir, { recursive: true });
    fs.writeFileSync(path.join(datasetDir, 'sample.csv'), 'id,name\n1,Alpha\n');
    try {
      const res = await request(app).post('/api/jobs').send({
        config: {
          dataset: datasetDir,
          description: 'a sufficiently long description for validation',
          count: 10,
          connectorId: 'secretshape',
          connectorName: 'Secret Shape',
          deployTarget: 'azure-functions',
          mode: 'build',
          aclMode: 'everyone',
          noEnhance: true,
        },
        secret: 'super-secret-value-123',
        runtime: { forceAll: true, startAt: 'enhance', stopAfter: 'enhance' },
      });
      expect(res.status).toBe(200);
      const envVar = res.body.config.auth?.clientSecretEnvVar;
      expect(envVar).toMatch(/^CCW_SECRET_/);
      expect(process.env[envVar]).toBe('super-secret-value-123');
      // The plaintext secret must never be written to the persisted job record.
      const persisted = fs.readFileSync(path.join(res.body.workspace, 'job.json'), 'utf-8');
      expect(persisted).not.toContain('super-secret-value-123');
      delete process.env[envVar];
      fs.rmSync(res.body.workspace, { recursive: true, force: true });
    } finally {
      fs.rmSync(datasetDir, { recursive: true, force: true });
    }
  });
});

describe('POST /api/auth-preflight', () => {
  it('runs the preflight (skipping all checks) and returns a structured result', async () => {
    const res = await request(app)
      .post('/api/auth-preflight')
      .send({ runGraph: false, runWorkIq: false, runEvalScoreA2A: false });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('checks');
    expect(Array.isArray(res.body.checks)).toBe(true);
    expect(res.body).toHaveProperty('passed');
  });
});

function seedScoredJob(opts: { id: string; noEnhance: boolean; datasetHash?: string; evalSetHash?: string }): JobRecord {
  const workspace = path.join(workspaceRoot(), opts.id);
  fs.mkdirSync(workspace, { recursive: true });
  const job: JobRecord = {
    id: opts.id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'done',
    workspace,
    datasetHash: opts.datasetHash ?? 'sha256:abc',
    evalSetHash: opts.evalSetHash ?? 'sha256:def',
    config: {
      dataset: workspace,
      description: 'fixture for compare endpoint tests',
      count: 10,
      connectorId: opts.id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 20) + 'cmp',
      connectorName: `Cmp ${opts.id}`,
      deployTarget: 'azure-functions',
      mode: 'provision',
      aclMode: 'everyone',
      noEnhance: opts.noEnhance,
    },
    steps: {
      evalgen: { name: 'evalgen', status: 'done' },
      enhance: { name: 'enhance', status: 'done' },
      schema: { name: 'schema', status: 'done' },
      connector: { name: 'connector', status: 'done' },
      deploy: { name: 'deploy', status: 'done' },
      score: { name: 'score', status: 'done' },
    } as JobRecord['steps'],
  };
  saveJob(job);
  const report: ScoredReport = {
    jobId: opts.id,
    noEnhance: opts.noEnhance,
    judgeProvider: 'github-copilot',
    promptCount: 1,
    validPromptCount: 1,
    deterministicScore: { average: opts.noEnhance ? 60 : 80, passCount: 1, partialCount: 0, failCount: 0, byCategory: {} },
    semanticScore: { average: opts.noEnhance ? 65 : 85, byDimension: { relevance: opts.noEnhance ? 70 : 90 } },
    citationRate: 0,
    retryCount: 0,
    rateLimitCount: 0,
    items: [
      {
        id: 'q1', prompt: 'one', expected: '1', actual: 'one',
        deterministic: { score: opts.noEnhance ? 60 : 80, status: 'pass', assertionsPassed: 1, assertionsTotal: 1, factsPassed: 0, factsTotal: 0 },
        semantic: { score: opts.noEnhance ? 65 : 85 },
      },
    ],
  };
  const dir = path.join(workspace, '06-score');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'agent-response-scores.json'), JSON.stringify(report, null, 2));
  return job;
}

describe('POST /api/compare + GET /api/compare/:reportId/file', () => {
  const enhId = uniqueId('cmpa');
  const rawId = uniqueId('cmpb');
  beforeAll(() => {
    seedScoredJob({ id: enhId, noEnhance: false });
    seedScoredJob({ id: rawId, noEnhance: true });
  });
  afterAll(() => {
    for (const id of [enhId, rawId]) {
      fs.rmSync(path.join(workspaceRoot(), id), { recursive: true, force: true });
    }
  });

  it('happy path: returns reportId and serves the rendered Markdown via the file route', async () => {
    const res = await request(app).post('/api/compare').send({ jobIdA: enhId, jobIdB: rawId });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ comparable: true, semanticComparable: true });
    expect(typeof res.body.reportId).toBe('string');
    expect(res.body.reportId.length).toBeGreaterThan(0);
    const file = await request(app).get(`/api/compare/${res.body.reportId}/file?path=comparison-report.md`);
    expect(file.status).toBe(200);
    expect(file.text).toMatch(/Comparison report/);
    const csv = await request(app).get(`/api/compare/${res.body.reportId}/file?path=score-matrix.csv`);
    expect(csv.status).toBe(200);
    expect(csv.text.split('\n')[0]).toContain('id,prompt,enhanced_deterministic');
  });

  it('returns 400 for missing jobIdA/jobIdB', async () => {
    const res = await request(app).post('/api/compare').send({ jobIdA: enhId });
    expect(res.status).toBe(400);
  });

  it('returns 4xx for unknown job id', async () => {
    const res = await request(app).post('/api/compare').send({ jobIdA: 'definitely-not-a-job', jobIdB: rawId });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('rejects path traversal in the file route', async () => {
    const post = await request(app).post('/api/compare').send({ jobIdA: enhId, jobIdB: rawId });
    expect(post.status).toBe(200);
    const traversal = await request(app).get(`/api/compare/${post.body.reportId}/file?path=..\\..\\package.json`);
    expect(traversal.status).toBe(400);
  });

  it('returns 404 for an unknown reportId', async () => {
    const file = await request(app).get('/api/compare/abc123/file?path=comparison-report.md');
    expect(file.status).toBe(404);
  });
});
