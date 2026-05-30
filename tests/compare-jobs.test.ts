import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runCompare } from '../src/compare-jobs';
import { workspaceRoot, saveJob } from '../src/jobs';
import { JobRecord, ScoredReport, JudgeProvider } from '../src/types';

function uniqueId(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function makeScoredReport(overrides: Partial<ScoredReport>): ScoredReport {
  return {
    jobId: overrides.jobId || 'job',
    noEnhance: overrides.noEnhance ?? false,
    judgeProvider: overrides.judgeProvider || 'github-copilot',
    promptCount: overrides.promptCount ?? 3,
    validPromptCount: overrides.validPromptCount ?? 3,
    deterministicScore: overrides.deterministicScore || {
      average: 70, passCount: 2, partialCount: 1, failCount: 0, byCategory: {},
    },
    semanticScore: overrides.semanticScore || {
      average: 75, byDimension: { relevance: 80, correctness: 70 },
    },
    citationRate: overrides.citationRate ?? 0.66,
    retryCount: overrides.retryCount ?? 0,
    rateLimitCount: overrides.rateLimitCount ?? 0,
    items: overrides.items || [
      {
        id: 'q1', prompt: 'one', expected: '1', actual: 'one',
        deterministic: { score: 100, status: 'pass', assertionsPassed: 1, assertionsTotal: 1, factsPassed: 0, factsTotal: 0 },
        semantic: { score: 85 },
      },
      {
        id: 'q2', prompt: 'two', expected: '2', actual: 'two',
        deterministic: { score: 50, status: 'partial', assertionsPassed: 1, assertionsTotal: 2, factsPassed: 0, factsTotal: 0 },
        semantic: { score: 60 },
      },
      {
        id: 'q3', prompt: 'three', expected: '3', actual: 'three',
        deterministic: { score: 100, status: 'pass', assertionsPassed: 1, assertionsTotal: 1, factsPassed: 0, factsTotal: 0 },
        semantic: { score: 80 },
      },
    ],
  };
}

function makeFakeJob(opts: {
  id: string;
  noEnhance: boolean;
  mode?: 'build' | 'provision';
  datasetHash?: string;
  evalSetHash?: string;
  scoredReport?: ScoredReport;
}): JobRecord {
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
      description: 'fixture dataset for compare tests',
      count: 10,
      connectorId: opts.id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 20) + 'conn',
      connectorName: `Fixture ${opts.id}`,
      deployTarget: 'azure-functions',
      mode: opts.mode || 'provision',
      aclMode: 'everyone',
      noEnhance: opts.noEnhance,
    },
    steps: {} as JobRecord['steps'],
  };
  saveJob(job);
  if (opts.scoredReport) {
    const dir = path.join(workspace, '06-score');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'agent-response-scores.json'), JSON.stringify(opts.scoredReport, null, 2));
  }
  return job;
}

function cleanupJob(jobId: string): void {
  const workspace = path.join(workspaceRoot(), jobId);
  fs.rmSync(workspace, { recursive: true, force: true });
}

describe('runCompare', () => {
  it('produces a report when both jobs are valid and providers match', () => {
    const idA = uniqueId('ja');
    const idB = uniqueId('jb');
    const enhancedReport = makeScoredReport({ jobId: idA, noEnhance: false });
    const nonReport = makeScoredReport({
      jobId: idB, noEnhance: true,
      deterministicScore: { average: 50, passCount: 1, partialCount: 1, failCount: 1, byCategory: {} },
      semanticScore: { average: 55, byDimension: { relevance: 60, correctness: 50 } },
      citationRate: 0.33,
    });
    makeFakeJob({ id: idA, noEnhance: false, scoredReport: enhancedReport });
    makeFakeJob({ id: idB, noEnhance: true, scoredReport: nonReport });
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccw-cmp-'));
    try {
      const result = runCompare({ jobIdA: idA, jobIdB: idB, outputDir });
      expect(result.comparable).toBe(true);
      expect(result.semanticComparable).toBe(true);
      const reportJson = JSON.parse(fs.readFileSync(result.reportJsonPath, 'utf-8'));
      const deltas = reportJson.deltas;
      expect(deltas.deterministicAverageDelta).toBe(20);
      expect(deltas.semanticAverageDelta).toBe(20);
      expect(deltas.citationRateDelta).toBeCloseTo(0.3, 1);
      expect(deltas.semanticDimensionDeltas).toEqual({ relevance: 20, correctness: 20 });
      const md = fs.readFileSync(result.reportMdPath, 'utf-8');
      expect(md).toContain('Comparison report');
      expect(md).toContain('comparable: **true**');
      const matrix = fs.readFileSync(result.scoreMatrixPath, 'utf-8');
      expect(matrix.split('\n').filter(Boolean).length).toBe(1 + 3);  // header + 3 questions
    } finally {
      cleanupJob(idA); cleanupJob(idB);
    }
  });

  it('soft-degrades to deterministic-only when judge providers differ', () => {
    const idA = uniqueId('ja');
    const idB = uniqueId('jb');
    makeFakeJob({ id: idA, noEnhance: false, scoredReport: makeScoredReport({ jobId: idA, judgeProvider: 'github-copilot' }) });
    makeFakeJob({ id: idB, noEnhance: true, scoredReport: makeScoredReport({ jobId: idB, noEnhance: true, judgeProvider: 'workiq' as JudgeProvider }) });
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccw-cmp-'));
    try {
      const result = runCompare({ jobIdA: idA, jobIdB: idB, outputDir });
      expect(result.comparable).toBe(true);
      expect(result.semanticComparable).toBe(false);
      expect(result.diagnostics.some((d) => /judgeProvider differs/.test(d))).toBe(true);
      const reportJson = JSON.parse(fs.readFileSync(result.reportJsonPath, 'utf-8'));
      const deltas = reportJson.deltas;
      expect(deltas.deterministicAverageDelta).toBeDefined();
      expect(deltas.semanticAverageDelta).toBeUndefined();
    } finally {
      cleanupJob(idA); cleanupJob(idB);
    }
  });

  it('marks not comparable on datasetHash mismatch', () => {
    const idA = uniqueId('ja');
    const idB = uniqueId('jb');
    makeFakeJob({ id: idA, noEnhance: false, datasetHash: 'sha256:aaa', scoredReport: makeScoredReport({ jobId: idA }) });
    makeFakeJob({ id: idB, noEnhance: true, datasetHash: 'sha256:bbb', scoredReport: makeScoredReport({ jobId: idB, noEnhance: true }) });
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccw-cmp-'));
    try {
      const result = runCompare({ jobIdA: idA, jobIdB: idB, outputDir });
      expect(result.comparable).toBe(false);
      expect(result.diagnostics.some((d) => /datasetHash mismatch/.test(d))).toBe(true);
    } finally {
      cleanupJob(idA); cleanupJob(idB);
    }
  });

  it('refuses two enhanced jobs', () => {
    const idA = uniqueId('ja');
    const idB = uniqueId('jb');
    makeFakeJob({ id: idA, noEnhance: false });
    makeFakeJob({ id: idB, noEnhance: false });
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccw-cmp-'));
    try {
      expect(() => runCompare({ jobIdA: idA, jobIdB: idB, outputDir })).toThrow(/exactly one job with noEnhance=true/);
    } finally {
      cleanupJob(idA); cleanupJob(idB);
    }
  });

  it('refuses build-mode jobs', () => {
    const idA = uniqueId('ja');
    const idB = uniqueId('jb');
    makeFakeJob({ id: idA, noEnhance: false, mode: 'build' });
    makeFakeJob({ id: idB, noEnhance: true, mode: 'provision', scoredReport: makeScoredReport({ jobId: idB, noEnhance: true }) });
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccw-cmp-'));
    try {
      const result = runCompare({ jobIdA: idA, jobIdB: idB, outputDir });
      expect(result.comparable).toBe(false);
      expect(result.diagnostics.some((d) => /build mode/.test(d))).toBe(true);
    } finally {
      cleanupJob(idA); cleanupJob(idB);
    }
  });
});
