import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { _test, prepareDatasetForWorkflow } from '../src/dataset-normalization';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ccw-normalize-'));
}

describe('prepareDatasetForWorkflow', () => {
  it('converts newline-delimited .json files to staged CSV files', () => {
    const root = tempDir();
    const dataset = path.join(root, 'dataset');
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(path.join(dataset, 'seed'), { recursive: true });
    fs.writeFileSync(
      path.join(dataset, 'seed', 'companies.json'),
      [
        JSON.stringify({ duns: '001', primaryName: 'Contoso, Inc.', active: true }),
        JSON.stringify({ duns: '002', primaryName: 'Fabrikam', yearlyRevenue: '1B-4.9B' }),
      ].join('\n'),
      'utf-8',
    );

    const prepared = prepareDatasetForWorkflow(dataset, workspace, ['json']);
    const csvPath = path.join(prepared.dataset, 'seed', 'companies.csv');

    expect(prepared.dataset).toBe(path.join(workspace, '00-normalized-dataset'));
    expect(prepared.extensions).toEqual(['csv']);
    expect(fs.existsSync(csvPath)).toBe(true);
    expect(fs.readFileSync(csvPath, 'utf-8')).toContain('"Contoso, Inc."');
    expect(prepared.diagnostics[0]).toContain('normalized 1 .json JSONL file');
  });

  it('leaves valid JSON documents untouched', () => {
    const root = tempDir();
    const dataset = path.join(root, 'dataset');
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(dataset, { recursive: true });
    fs.writeFileSync(path.join(dataset, 'records.json'), JSON.stringify([{ id: '1' }]), 'utf-8');

    const prepared = prepareDatasetForWorkflow(dataset, workspace, ['json']);

    expect(prepared.dataset).toBe(dataset);
    expect(prepared.extensions).toEqual(['json']);
    expect(prepared.diagnostics).toEqual([]);
  });
});

describe('isJsonLinesFile', () => {
  it('detects only multi-line JSON object records', () => {
    const root = tempDir();
    const jsonl = path.join(root, 'records.json');
    const json = path.join(root, 'array.json');
    fs.writeFileSync(jsonl, '{"id":"1"}\n{"id":"2"}\n', 'utf-8');
    fs.writeFileSync(json, '[{"id":"1"},{"id":"2"}]', 'utf-8');

    expect(_test.isJsonLinesFile(jsonl)).toBe(true);
    expect(_test.isJsonLinesFile(json)).toBe(false);
  });
});
