import { describe, it, expect } from 'vitest';
import { renderString } from '../src/templating';
import { buildDefaultInstructions } from '../src/steps/step4-connector';
import type { JobConfig } from '../src/types';

describe('renderString', () => {
  it('leaves unknown keys unchanged', () => {
    const result = renderString('hello {{UNKNOWN_KEY}} world', {});
    expect(result).toBe('hello {{UNKNOWN_KEY}} world');
  });

  it('substitutes known keys', () => {
    const result = renderString('id={{connectorId}}', { connectorId: 'myconn' });
    expect(result).toBe('id=myconn');
  });

  it('leaves Agents Toolkit env vars unchanged', () => {
    const input = 'name: {{connectorName}}-${{TEAMSFX_ENV}}';
    const result = renderString(input, { connectorName: 'MyConn' });
    expect(result).toBe('name: MyConn-${{TEAMSFX_ENV}}');
  });

  it('handles multiple substitutions', () => {
    const result = renderString('{{a}} and {{b}}', { a: 'foo', b: 'bar' });
    expect(result).toBe('foo and bar');
  });

  it('substitutes null/undefined values as empty string', () => {
    const result = renderString('{{key}}', { key: null as unknown as string });
    expect(result).toBe('');
  });
});

describe('buildDefaultInstructions', () => {
  it('uses connectorName in output', () => {
    const cfg: Partial<JobConfig> = {
      connectorName: 'My Docs',
      description: 'Documentation about widgets',
    };
    const instructions = buildDefaultInstructions(cfg as JobConfig);
    expect(instructions).toContain('My Docs');
    expect(instructions).toContain('Documentation about widgets');
    expect(instructions).toContain('Preserve exact source values');
  });

  it('prefers connectorDescription over description when available', () => {
    const cfg: Partial<JobConfig> = {
      connectorName: 'Test Connector',
      description: 'Fallback description',
      connectorDescription: 'Richer connector description',
    };
    const instructions = buildDefaultInstructions(cfg as JobConfig);
    expect(instructions).toContain('Richer connector description');
    expect(instructions).not.toContain('Fallback description');
  });

  it('falls back to description when connectorDescription is absent', () => {
    const cfg: Partial<JobConfig> = {
      connectorName: 'Test Connector',
      description: 'Fallback description',
    };
    const instructions = buildDefaultInstructions(cfg as JobConfig);
    expect(instructions).toContain('Fallback description');
  });
});
