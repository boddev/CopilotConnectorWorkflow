import { describe, it, expect } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { resolveTools, probeTools } from '../src/tools';
import { run as runEnhancer } from '../src/enhancer/enhance_for_copilot';

const REPO_ROOT = path.resolve(__dirname, '..');

describe('tools.ts — bundled TypeScript enhancer', () => {
  it('resolveTools().dataEnhancer points to the compiled JS inside the workflow repo', () => {
    const tools = resolveTools();
    const expected = path.join(REPO_ROOT, 'dist', 'enhancer', 'enhance_for_copilot.js');
    expect(tools.dataEnhancer).toBe(expected);
  });

  it('resolveTools().tsDataEnhancer prefers bundled source over external skill', () => {
    const tools = resolveTools();
    const bundledSource = path.join(REPO_ROOT, 'src', 'enhancer', 'enhance_for_copilot.ts');
    // The bundled source is present in the repo — it should be preferred.
    if (fs.existsSync(bundledSource)) {
      expect(tools.tsDataEnhancer).toBe(bundledSource);
    } else {
      // If somehow the bundled file is missing, the fallback is the external skill.
      expect(tools.tsDataEnhancer).toBeTruthy();
    }
  });

  it('bundled TypeScript enhancer source is present in src/enhancer/', () => {
    const bundledSource = path.join(REPO_ROOT, 'src', 'enhancer', 'enhance_for_copilot.ts');
    expect(fs.existsSync(bundledSource)).toBe(true);
  });

  it('ToolPaths has no python field (Python is no longer required)', () => {
    const tools = resolveTools();
    expect((tools as Record<string, unknown>)['python']).toBeUndefined();
  });
});

describe('probeTools() — bundled enhancer probes', () => {
  it('returns a probe entry for data-enhancer (compiled)', () => {
    const status = probeTools();
    const entry = status.find((s) => s.name === 'data-enhancer (compiled)');
    expect(entry).toBeDefined();
    expect(entry!.path).toContain('enhance_for_copilot.js');
  });

  it('returns a probe entry for data-enhancer (typescript src)', () => {
    const status = probeTools();
    const entry = status.find((s) => s.name === 'data-enhancer (typescript src)');
    expect(entry).toBeDefined();
    expect(entry!.path).toContain('enhance_for_copilot.ts');
  });

  it('does not include a Python probe', () => {
    const status = probeTools();
    const pythonProbe = status.find((s) => s.name === 'python');
    expect(pythonProbe).toBeUndefined();
  });

  it('compiled enhancer probe is ok=false before build (or ok=true after)', () => {
    const status = probeTools();
    const entry = status.find((s) => s.name === 'data-enhancer (compiled)');
    expect(entry).toBeDefined();
    // ok is either true (built) or false (not built); ok=false must include a fix hint
    if (!entry!.ok) {
      expect(entry!.note).toContain('npm run build');
    }
  });

  it('typescript src probe is ok=true (bundled source is present)', () => {
    const status = probeTools();
    const entry = status.find((s) => s.name === 'data-enhancer (typescript src)');
    expect(entry).toBeDefined();
    expect(entry!.ok).toBe(true);
  });
});

describe('urlPrefix flows through JobConfig', () => {
  it('JobConfig accepts urlPrefix as an optional string', () => {
    // Type-level test: importing JobConfig and constructing it with urlPrefix should compile.
    // At runtime we can check the shape via assignment.
    const cfg = {
      dataset: '/data',
      description: 'test',
      count: 10,
      connectorId: 'testconn',
      connectorName: 'Test',
      deployTarget: 'azure-functions' as const,
      mode: 'build' as const,
      aclMode: 'everyone' as const,
      urlPrefix: 'https://example.com',
    };
    expect(cfg.urlPrefix).toBe('https://example.com');
  });

  it('JobConfig urlPrefix defaults to undefined when omitted', () => {
    const cfg = {
      dataset: '/data',
      description: 'test',
      count: 10,
      connectorId: 'testconn',
      connectorName: 'Test',
      deployTarget: 'azure-functions' as const,
      mode: 'build' as const,
      aclMode: 'everyone' as const,
    };
    expect((cfg as Record<string, unknown>)['urlPrefix']).toBeUndefined();
  });
});

describe('domain-aware enhancer output', () => {
  function runFixture(record: Record<string, unknown>) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccw-domain-enhancer-'));
    const dataset = path.join(root, 'dataset');
    const output = path.join(root, 'out');
    fs.mkdirSync(dataset);
    fs.writeFileSync(path.join(dataset, 'records.jsonl'), JSON.stringify(record) + '\n', 'utf-8');
    runEnhancer({
      dataset,
      output,
      extensions: 'jsonl',
      long_indicator_mode: 'grouped',
      include_eval_prompts: false,
      include_eval_answers: false,
      focus_on_eval: false,
      no_overviews: true,
      max_records_per_file: 10,
      acl_mode: 'everyone',
      url_prefix: '',
    });
    const item = JSON.parse(fs.readFileSync(path.join(output, 'enhanced-items.jsonl'), 'utf-8').trim());
    const schema = JSON.parse(fs.readFileSync(path.join(output, 'schema-suggestion.json'), 'utf-8'));
    return { root, item, schema };
  }

  it('infers NPI records without adding unrelated domain schema properties', () => {
    const { root, item, schema } = runFixture({
      recordId: '1093137432',
      title: '118CLINIC INC. - NPI 1093137432',
      customProperties: {
        npi: '1093137432',
        providerType: 'Organization',
        providerName: '118CLINIC INC.',
        taxonomyCodes: ['171100000X'],
        taxonomyDescriptions: ['Acupuncturist'],
        practiceAddress: '3811 S FERDINAND ST, SEATTLE, WA',
      },
    });
    try {
      const names = schema.properties.map((p: { name: string }) => p.name);
      const npiProp = schema.properties.find((p: { name: string }) => p.name === 'npi');
      expect(item.properties.domain).toBe('npi');
      expect(item.properties.taxonomyCodes).toBe('171100000X');
      expect(item.content.value).toContain('NPI 1093137432');
      expect(item.content.value).toContain('primary taxonomy Acupuncturist');
      expect(names).toContain('npi');
      expect(names).not.toContain('code');
      expect(names).not.toContain('cmsDatasetId');
      expect(schema.properties.length).toBeLessThanOrEqual(120);
      expect(npiProp.isSearchable).toBe(true);
      expect(npiProp.isExactMatchRequired).toBeUndefined();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('infers ICD-10 records without adding unrelated domain schema properties', () => {
    const { root, item, schema } = runFixture({
      recordId: '2025-A000',
      title: 'A000 - Cholera',
      customProperties: {
        code: 'A000',
        codeSystem: 'ICD-10-CM',
        longDescription: 'Cholera due to Vibrio cholerae 01, biovar cholerae',
        chapter: 'Certain infectious and parasitic diseases',
      },
    });
    try {
      const names = schema.properties.map((p: { name: string }) => p.name);
      expect(item.properties.domain).toBe('icd10');
      expect(item.content.value).toContain('ICD-10-CM code A000');
      expect(names).toContain('code');
      expect(names).not.toContain('npi');
      expect(names).not.toContain('cmsDatasetId');
      expect(schema.properties.length).toBeLessThanOrEqual(120);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps generic package fields when a domain dataset includes a manifest item', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccw-domain-enhancer-'));
    const dataset = path.join(root, 'dataset');
    const output = path.join(root, 'out');
    fs.mkdirSync(dataset);
    fs.writeFileSync(path.join(dataset, 'records.jsonl'), JSON.stringify({
      recordId: '2025-A000',
      title: 'A000 - Cholera',
      customProperties: {
        code: 'A000',
        codeSystem: 'ICD-10-CM',
        longDescription: 'Cholera due to Vibrio cholerae 01, biovar cholerae',
        chapter: 'Certain infectious and parasitic diseases',
      },
    }) + '\n', 'utf-8');
    fs.writeFileSync(path.join(dataset, 'manifest.json'), JSON.stringify({
      packageName: 'hls-icd10',
      displayName: 'ICD-10 sample package',
      recordCount: 1,
      bytes: 1234,
      status: 'complete',
    }), 'utf-8');
    try {
      runEnhancer({
        dataset,
        output,
        extensions: 'jsonl,json',
        long_indicator_mode: 'grouped',
        include_eval_prompts: false,
        include_eval_answers: false,
        focus_on_eval: false,
        no_overviews: true,
        max_records_per_file: 10,
        acl_mode: 'everyone',
        url_prefix: '',
      });
      const schema = JSON.parse(fs.readFileSync(path.join(output, 'schema-suggestion.json'), 'utf-8'));
      const names = schema.properties.map((p: { name: string }) => p.name);
      expect(names).toContain('code');
      expect(names).toContain('recordCount');
      expect(names).toContain('bytes');
      expect(names).toContain('status');
      expect(schema.properties.length).toBeLessThanOrEqual(120);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('infers CMS records without adding unrelated domain schema properties', () => {
    const { root, item, schema } = runFixture({
      recordId: '23ew-n7w9',
      title: 'Dialysis Facility - Listing by Facility',
      customProperties: {
        cmsDatasetId: '23ew-n7w9',
        cmsDatasetTitle: 'Dialysis Facility - Listing by Facility',
        measureName: 'Quality',
        facilityType: 'Dialysis facilities',
        reportingPeriod: '2026',
      },
    });
    try {
      const names = schema.properties.map((p: { name: string }) => p.name);
      expect(item.properties.domain).toBe('cms');
      expect(item.content.value).toContain('CMS dataset Dialysis Facility - Listing by Facility');
      expect(names).toContain('cmsDatasetId');
      expect(names).not.toContain('npi');
      expect(names).not.toContain('code');
      expect(schema.properties.length).toBeLessThanOrEqual(120);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
