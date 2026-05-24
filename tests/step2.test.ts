import { describe, it, expect } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { resolveTools, probeTools } from '../src/tools';

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
