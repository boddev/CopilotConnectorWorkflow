import { describe, expect, it } from 'vitest';
import { applyConfigDefaults } from '../src/jobs';
import { JobConfig } from '../src/types';

function baseConfig(overrides: Partial<JobConfig>): JobConfig {
  return {
    dataset: 'C:\\data\\sales-records',
    description: '',
    count: 10,
    connectorId: '',
    connectorName: '',
    deployTarget: 'azure-functions',
    mode: 'build',
    aclMode: 'everyone',
    ...overrides,
  } as JobConfig;
}

describe('applyConfigDefaults', () => {
  it('auto-generates connectorName, connectorId and description from the dataset folder when blank', () => {
    const cfg = baseConfig({});
    applyConfigDefaults(cfg);
    expect(cfg.connectorName).toBe('Sales Records');
    expect(cfg.connectorId).toBe('salesrecords');
    expect(/^[a-zA-Z0-9]{3,128}$/.test(cfg.connectorId)).toBe(true);
    expect(cfg.description.length).toBeGreaterThanOrEqual(10);
    expect(cfg.description).toContain('Sales Records');
  });

  it('preserves explicit, valid values supplied by the caller', () => {
    const cfg = baseConfig({
      connectorName: 'My Real Connector',
      connectorId: 'realconn1',
      description: 'A perfectly good human-written description.',
    });
    applyConfigDefaults(cfg);
    expect(cfg.connectorName).toBe('My Real Connector');
    expect(cfg.connectorId).toBe('realconn1');
    expect(cfg.description).toBe('A perfectly good human-written description.');
  });

  it('regenerates a description that is too short to pass validation', () => {
    const cfg = baseConfig({ description: 'short' });
    applyConfigDefaults(cfg);
    expect(cfg.description.length).toBeGreaterThanOrEqual(10);
  });

  it('sanitizes a connectorId that fails the validation regex', () => {
    const cfg = baseConfig({ connectorId: 'has-dashes-and spaces!' });
    applyConfigDefaults(cfg);
    expect(/^[a-zA-Z0-9]{3,128}$/.test(cfg.connectorId)).toBe(true);
  });

  it('falls back to safe defaults when there is nothing to derive from', () => {
    const cfg = baseConfig({ dataset: '' });
    applyConfigDefaults(cfg);
    expect(cfg.connectorName).toBe('My Connector');
    expect(/^[a-zA-Z0-9]{3,128}$/.test(cfg.connectorId)).toBe(true);
    expect(cfg.description.length).toBeGreaterThanOrEqual(10);
  });
});
