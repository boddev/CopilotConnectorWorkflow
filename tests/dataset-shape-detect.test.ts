import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { detectDatasetShape, _test } from '../src/dataset-shape-detect';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ccw-shape-detect-'));
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
}

describe('detectDatasetShape', () => {
  it('classifies single-schema JSONL with prose fields as identity', () => {
    const root = tempDir();
    const lines: string[] = [];
    for (let i = 0; i < 20; i++) {
      lines.push(JSON.stringify({
        id: `NCT${String(i).padStart(5, '0')}`,
        title: `Phase ${(i % 3) + 1} study of ExampleDrug${i} in advanced disease`,
        summary: `This is an open-label single-arm clinical trial enrolling adult patients with advanced solid tumors. The primary endpoint is overall response rate at 24 weeks. Secondary endpoints include progression-free survival, overall survival, and safety profile evaluation across multiple cohorts.`,
        recordType: 'Interventional',
        lastModified: '2024-03-15',
      }));
    }
    writeFile(path.join(root, 'trials.jsonl'), lines.join('\n'));

    const result = detectDatasetShape(root);
    expect(result.recommendation).toBe('identity');
    expect(result.distinctSchemas).toBe(1);
    expect(result.dominantSchemaShare).toBe(1);
    expect(result.textRichFields.length).toBeGreaterThanOrEqual(1);
    expect(result.textRichFields.some((f) => f.field === 'summary')).toBe(true);
  });

  it('classifies mixed CSV+JSON datasets as enhance', () => {
    const root = tempDir();
    // CSV file: tabular crop yields
    const csvLines = ['country,year,wheat_yield,corn_yield'];
    for (let i = 0; i < 30; i++) {
      csvLines.push(`Country${i},${1990 + (i % 30)},${1.2 + i * 0.1},${3.4 + i * 0.05}`);
    }
    writeFile(path.join(root, 'yields.csv'), csvLines.join('\n'));
    // JSON file: nested narrative records (different schema)
    const jsonRecords = [];
    for (let i = 0; i < 30; i++) {
      jsonRecords.push(JSON.stringify({
        region: `Region${i}`,
        category: 'soil',
        sample_id: `S${i}`,
        notes: 'sample notes',
      }));
    }
    writeFile(path.join(root, 'soil.jsonl'), jsonRecords.join('\n'));

    const result = detectDatasetShape(root);
    expect(result.recommendation).toBe('enhance');
    expect(result.distinctSchemas).toBe(2);
    expect(result.dominantSchemaShare).toBeLessThan(0.9);
  });

  it('classifies single-schema numeric tabular as tie (not identity)', () => {
    const root = tempDir();
    const csvLines = ['country,year,electricity_demand,fossil_share,renewable_share'];
    for (let i = 0; i < 50; i++) {
      csvLines.push(`Country${i},${1990 + (i % 30)},${100 + i},${0.5 + i * 0.01},${0.5 - i * 0.01}`);
    }
    writeFile(path.join(root, 'energy.csv'), csvLines.join('\n'));

    const result = detectDatasetShape(root);
    // Single schema, but no text-rich fields → tie (no auto-flip).
    expect(result.distinctSchemas).toBe(1);
    expect(result.textRichFields.length).toBe(0);
    expect(result.recommendation).toBe('tie');
  });

  it('handles empty dataset folders without throwing', () => {
    const root = tempDir();
    const result = detectDatasetShape(root);
    expect(result.recommendation).toBe('enhance');
    expect(result.recordsSampled).toBe(0);
  });
});

describe('isProseValue', () => {
  const { isProseValue } = _test;
  it('accepts long natural-language sentences', () => {
    const v = 'This study evaluates the safety and efficacy of a novel investigational treatment in adult patients with advanced solid tumors who have progressed on standard care.';
    expect(isProseValue(v)).toBe(true);
  });

  it('rejects short values', () => {
    expect(isProseValue('Active recruiting status')).toBe(false);
  });

  it('rejects URLs', () => {
    const v = 'https://example.com/very/long/url/path/that/exceeds/80/characters/in/total/length/here';
    expect(isProseValue(v)).toBe(false);
  });

  it('rejects GUIDs', () => {
    const v = '12345678-1234-1234-1234-123456789012';
    expect(isProseValue(v)).toBe(false);
  });

  it('rejects JSON blobs', () => {
    const v = '{"key": "value", "nested": {"a": 1, "b": 2, "items": [1, 2, 3, 4, 5]}}';
    expect(isProseValue(v)).toBe(false);
  });

  it('rejects values without whitespace', () => {
    const v = 'a'.repeat(150);
    expect(isProseValue(v)).toBe(false);
  });

  it('rejects digit-heavy values like serialized arrays', () => {
    const v = '1.23 4.56 7.89 10.11 12.13 14.15 16.17 18.19 20.21 22.23 24.25 26.27';
    expect(isProseValue(v)).toBe(false);
  });
});
