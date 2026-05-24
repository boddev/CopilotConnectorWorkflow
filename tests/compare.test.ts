import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createCompareBatchRun, createCompareDatasetRun } from '../src/compare';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ccw-compare-'));
}

function cleanupCompareRun(id: string): void {
  fs.rmSync(path.resolve(__dirname, '..', 'workspace', 'compare-runs', id), { recursive: true, force: true });
}

describe('compare dry-run planning', () => {
  it('writes deterministic enhanced and RAW plan state for one dataset', () => {
    const root = tempDir();
    const dataset = path.join(root, 'dataset');
    fs.mkdirSync(dataset, { recursive: true });
    fs.writeFileSync(path.join(dataset, 'records.csv'), 'id,name\n1,Contoso\n', 'utf-8');

    const configPath = path.join(root, 'compare.json');
    fs.writeFileSync(configPath, JSON.stringify({
      slug: 'sample-data',
      dataset,
      description: 'Sample company dataset for comparison planning.',
      connectorPrefix: 'ccwsample',
      displayName: 'CCW Sample',
    }), 'utf-8');

    const state = createCompareDatasetRun(configPath, true);
    try {
      expect(state.kind).toBe('compare-dataset');
      expect(state.status).toBe('dry-run');
      expect(state.plans).toHaveLength(1);
      expect(state.plans[0].enhanced.connectorId).toBe('ccwsample');
      expect(state.plans[0].raw.connectorId).toBe('ccwsampleraw');
      expect(state.plans[0].semanticJudge).toBe('m365-copilot');

      const statePath = path.resolve(__dirname, '..', 'workspace', 'compare-runs', state.id, 'compare-state.json');
      expect(fs.existsSync(statePath)).toBe(true);
    } finally {
      cleanupCompareRun(state.id);
    }
  });

  it('applies batch defaults to dataset plans', () => {
    const root = tempDir();
    const dataset = path.join(root, 'dataset');
    fs.mkdirSync(dataset, { recursive: true });
    fs.writeFileSync(path.join(dataset, 'records.csv'), 'id,name\n1,Contoso\n', 'utf-8');

    const manifestPath = path.join(root, 'batch.json');
    fs.writeFileSync(manifestPath, JSON.stringify({
      tenantId: 'tenant-1',
      authProfile: 'workiq-profile',
      evalQuestionTarget: 75,
      semanticJudge: 'github-copilot',
      datasets: [{
        slug: 'sample-batch',
        dataset,
        description: 'Sample company dataset for batch comparison planning.',
        connectorPrefix: 'ccwbatch',
        displayName: 'CCW Batch',
      }],
    }), 'utf-8');

    const state = createCompareBatchRun(manifestPath, true);
    try {
      expect(state.kind).toBe('compare-batch');
      expect(state.plans[0].tenantId).toBe('tenant-1');
      expect(state.plans[0].authProfile).toBe('workiq-profile');
      expect(state.plans[0].evalQuestionTarget).toBe(75);
      expect(state.plans[0].semanticJudge).toBe('github-copilot');
    } finally {
      cleanupCompareRun(state.id);
    }
  });
});
