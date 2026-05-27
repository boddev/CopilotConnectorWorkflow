import { describe, expect, it } from 'vitest';
import {
  formatAuthPreflightResult,
  shouldRunEvalScoreA2AFromEnv,
  tokenHasGraphConnectorRoles,
} from '../src/auth-preflight';

function unsignedJwt(payload: Record<string, unknown>): string {
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf-8')
    .toString('base64url');
  return `header.${encodedPayload}.signature`;
}

describe('auth preflight helpers', () => {
  it('accepts required Graph connector app roles in access token', () => {
    const token = unsignedJwt({
      roles: ['ExternalConnection.ReadWrite.OwnedBy', 'ExternalItem.ReadWrite.OwnedBy'],
    });

    const result = tokenHasGraphConnectorRoles(token);

    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it('reports missing Graph connector item role', () => {
    const token = unsignedJwt({
      roles: ['ExternalConnection.ReadWrite.OwnedBy'],
    });

    const result = tokenHasGraphConnectorRoles(token);

    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(['ExternalItem.ReadWrite.OwnedBy']);
  });

  it('detects EvalScore A2A MSAL auth mode from supported env vars', () => {
    expect(shouldRunEvalScoreA2AFromEnv({ EVALSCORE_A2A_AUTH_MODE: 'msal' })).toBe(true);
    expect(shouldRunEvalScoreA2AFromEnv({ WORK_IQ_A2A_AUTH: 'MSAL' })).toBe(true);
    expect(shouldRunEvalScoreA2AFromEnv({ EVALSCORE_A2A_AUTH_MODE: 'auto' })).toBe(false);
  });

  it('fails the aggregate result when every check is skipped', () => {
    const rendered = formatAuthPreflightResult({
      passed: false,
      checks: [
        { name: 'Graph connector app auth', status: 'skipped', message: 'Not requested' },
      ],
    });

    expect(rendered).toContain('No checks were executed');
  });
});
