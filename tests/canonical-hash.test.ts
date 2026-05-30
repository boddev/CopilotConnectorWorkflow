import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { hashDataset, hashEvalSetItems, hashEvalSetFile } from '../src/canonical-hash';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ccw-canonical-'));
}

describe('hashDataset', () => {
  it('is stable across calls for the same dataset folder', () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, 'a.csv'), 'id,name\n1,Alpha\n');
    fs.writeFileSync(path.join(root, 'b.csv'), 'id,name\n2,Bravo\n');
    const first = hashDataset(root);
    const second = hashDataset(root);
    expect(first.hash).toBe(second.hash);
    expect(first.files).toHaveLength(2);
  });

  it('differs when a source file changes', () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, 'a.csv'), 'id,name\n1,Alpha\n');
    const before = hashDataset(root).hash;
    fs.writeFileSync(path.join(root, 'a.csv'), 'id,name\n1,Alpha2\n');
    const after = hashDataset(root).hash;
    expect(before).not.toBe(after);
  });

  it('ignores excluded folders (evalset, workspace, node_modules, .git, leading underscore)', () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, 'a.csv'), 'x\n1\n');
    const before = hashDataset(root).hash;
    fs.mkdirSync(path.join(root, 'evalset'));
    fs.writeFileSync(path.join(root, 'evalset', 'eval.csv'), 'y\n2\n');
    fs.mkdirSync(path.join(root, 'workspace'));
    fs.writeFileSync(path.join(root, 'workspace', 'job.json'), '{}');
    fs.mkdirSync(path.join(root, '_staged'));
    fs.writeFileSync(path.join(root, '_staged', 'tmp.csv'), 'z\n3\n');
    const after = hashDataset(root).hash;
    expect(after).toBe(before);
  });

  it('respects the extensions filter', () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, 'a.csv'), 'x\n');
    fs.writeFileSync(path.join(root, 'b.json'), '{}');
    const csvOnly = hashDataset(root, ['csv']);
    expect(csvOnly.files.map((f) => f.relativePath)).toEqual(['a.csv']);
  });

  it('hashes a single file dataset', () => {
    const root = tempDir();
    const file = path.join(root, 'a.csv');
    fs.writeFileSync(file, 'x\n');
    const result = hashDataset(file);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].relativePath).toBe('a.csv');
  });
});

describe('hashEvalSetItems', () => {
  it('returns the same hash regardless of input item order', () => {
    const items = [
      { id: 'b', prompt: 'second', expected_answer: '2', assertions: [], supporting_facts: [], category: 'x', difficulty: 'easy' },
      { id: 'a', prompt: 'first', expected_answer: '1', assertions: [{ value: 'foo' }], supporting_facts: ['a=1'], category: 'x', difficulty: 'easy' },
    ];
    const reversed = [...items].reverse();
    expect(hashEvalSetItems(items).hash).toBe(hashEvalSetItems(reversed).hash);
  });

  it('differs when assertion text changes', () => {
    const before = hashEvalSetItems([{ id: 'a', prompt: 'p', expected_answer: 'e', assertions: [{ value: 'foo' }], supporting_facts: [], category: '', difficulty: '' }]);
    const after = hashEvalSetItems([{ id: 'a', prompt: 'p', expected_answer: 'e', assertions: [{ value: 'bar' }], supporting_facts: [], category: '', difficulty: '' }]);
    expect(before.hash).not.toBe(after.hash);
  });

  it('ignores generation metadata fields', () => {
    const without = hashEvalSetItems([{ id: 'a', prompt: 'p', expected_answer: 'e', assertions: [], supporting_facts: [], category: '', difficulty: '' }]);
    const withExtra = hashEvalSetItems([{ id: 'a', prompt: 'p', expected_answer: 'e', assertions: [], supporting_facts: [], category: '', difficulty: '', generated_at: '2026-05-28T10:00:00Z', source_location: 'foo' }]);
    expect(without.hash).toBe(withExtra.hash);
  });

  it('reads from a JSON sidecar', () => {
    const dir = tempDir();
    const file = path.join(dir, 'eval.evalgen.json');
    fs.writeFileSync(file, JSON.stringify({
      generated_at: '2026-05-28T10:00:00Z',
      items: [
        { id: 'a', prompt: 'first', expected_answer: '1', assertions: [], supporting_facts: [], category: '', difficulty: '' },
      ],
    }));
    const result = hashEvalSetFile(file);
    expect(result.itemCount).toBe(1);
    expect(result.hash).toMatch(/^sha256:/);
  });
});
