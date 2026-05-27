import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import { runProcess } from './run';
import { ToolPaths, resolveTools } from './tools';

export type AuthCheckStatus = 'passed' | 'failed' | 'skipped';

export interface AuthPreflightCheck {
  name: string;
  status: AuthCheckStatus;
  message: string;
}

export interface AuthPreflightResult {
  passed: boolean;
  checks: AuthPreflightCheck[];
}

export interface AuthPreflightOptions {
  tenantId?: string;
  clientId?: string;
  clientSecretEnvVar?: string;
  useManagedIdentity?: boolean;
  runGraph?: boolean;
  runWorkIq?: boolean;
  runEvalScoreA2A?: boolean;
  runM365EvalEula?: boolean;
  m365EvalPackageVersion?: string;
  tools?: ToolPaths;
}

const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';
const GRAPH_CONNECTIONS_URL = 'https://graph.microsoft.com/v1.0/external/connections?$top=1';
const GRAPH_REQUIRED_PERMISSION_GROUPS = [
  ['ExternalConnection.ReadWrite.OwnedBy', 'ExternalConnection.ReadWrite.All'],
  ['ExternalItem.ReadWrite.OwnedBy', 'ExternalItem.ReadWrite.All'],
];
const WORKIQ_TIMEOUT_MS = 5 * 60 * 1000;

export async function runAuthPreflight(
  options: AuthPreflightOptions,
  emitter?: EventEmitter,
): Promise<AuthPreflightResult> {
  const tools = options.tools || resolveTools();
  const checks: AuthPreflightCheck[] = [];

  if (options.runGraph) {
    checks.push(await graphClientSecretCheck(options));
  } else {
    checks.push({ name: 'Graph connector app auth', status: 'skipped', message: 'Not requested' });
  }

  if (options.runWorkIq) {
    checks.push(await workIqMcpCheck(emitter));
  } else {
    checks.push({ name: 'WorkIQ MCP auth', status: 'skipped', message: 'Not requested' });
  }

  if (options.runEvalScoreA2A) {
    checks.push(await evalScoreA2AMsalCheck(options, tools, emitter));
  } else {
    checks.push({ name: 'EvalScore A2A MSAL auth', status: 'skipped', message: 'Not requested' });
  }

  if (options.runM365EvalEula) {
    checks.push(await m365EvalEulaCheck(options, emitter));
  } else {
    checks.push({ name: 'm365-copilot-eval EULA', status: 'skipped', message: 'Not requested' });
  }

  const executed = checks.some((check) => check.status !== 'skipped');
  return {
    passed: executed && checks.every((check) => check.status !== 'failed'),
    checks,
  };
}

export function formatAuthPreflightResult(result: AuthPreflightResult): string {
  const lines = ['Authentication preflight', ''];
  for (const check of result.checks) {
    const marker = check.status === 'passed' ? 'PASS' : check.status === 'failed' ? 'FAIL' : 'SKIP';
    lines.push(`[${marker}] ${check.name}: ${check.message}`);
  }
  if (!result.checks.some((check) => check.status !== 'skipped')) {
    lines.push('', 'No checks were executed. Remove a --skip-* option or provide the required auth settings.');
  }
  return lines.join('\n');
}

export function tokenHasGraphConnectorRoles(accessToken: string): { ok: boolean; missing: string[]; roles: string[] } {
  const payload = decodeJwtPayload(accessToken);
  const roles = Array.isArray(payload.roles) ? payload.roles.filter((role): role is string => typeof role === 'string') : [];
  const missing = GRAPH_REQUIRED_PERMISSION_GROUPS
    .filter((alternates) => !alternates.some((permission) => roles.includes(permission)))
    .map((alternates) => alternates[0]);
  return { ok: missing.length === 0, missing, roles };
}

export function shouldRunEvalScoreA2AFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return [
    env.EVALSCORE_A2A_AUTH_MODE,
    env.WORK_IQ_A2A_AUTH_MODE,
    env.EVALSCORE_A2A_AUTH,
    env.WORK_IQ_A2A_AUTH,
  ].some((value) => value?.toLowerCase() === 'msal');
}

async function graphClientSecretCheck(options: AuthPreflightOptions): Promise<AuthPreflightCheck> {
  if (options.useManagedIdentity) {
    return {
      name: 'Graph connector app auth',
      status: 'skipped',
      message: 'Managed identity selected; local client-secret validation is not applicable.',
    };
  }

  const missing: string[] = [];
  if (!options.tenantId) missing.push('tenant ID');
  if (!options.clientId) missing.push('client ID');
  if (!options.clientSecretEnvVar) missing.push('client secret env var name');
  const secret = options.clientSecretEnvVar ? process.env[options.clientSecretEnvVar] : undefined;
  if (options.clientSecretEnvVar && !secret) missing.push(`environment variable ${options.clientSecretEnvVar}`);
  if (missing.length > 0) {
    return {
      name: 'Graph connector app auth',
      status: 'failed',
      message: `Missing ${missing.join(', ')}.`,
    };
  }

  try {
    const token = await acquireClientCredentialsToken(options.tenantId!, options.clientId!, secret!);
    const rolesCheck = tokenHasGraphConnectorRoles(token);
    if (!rolesCheck.ok) {
      return {
        name: 'Graph connector app auth',
        status: 'failed',
        message: `Token is missing required app role(s): ${rolesCheck.missing.join(', ')}. Grant admin consent for the Graph connector app permissions.`,
      };
    }
    await probeGraphConnections(token);
    return {
      name: 'Graph connector app auth',
      status: 'passed',
      message: `Client credentials validated for tenant ${options.tenantId} and client ${options.clientId}.`,
    };
  } catch (error) {
    return {
      name: 'Graph connector app auth',
      status: 'failed',
      message: sanitizeError(error),
    };
  }
}

async function acquireClientCredentialsToken(tenantId: string, clientId: string, clientSecret: string): Promise<string> {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'client_credentials',
    scope: GRAPH_SCOPE,
  });
  const response = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Token endpoint returned HTTP ${response.status}: ${summarizeJsonError(text)}`);
  }
  const parsed = JSON.parse(text) as { access_token?: string };
  if (!parsed.access_token) {
    throw new Error('Token endpoint did not return an access token.');
  }
  return parsed.access_token;
}

async function probeGraphConnections(accessToken: string): Promise<void> {
  const response = await fetch(GRAPH_CONNECTIONS_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (response.status === 401 || response.status === 403) {
    const text = await response.text();
    throw new Error(`Graph external connections probe returned HTTP ${response.status}: ${summarizeJsonError(text)}`);
  }
  if (!response.ok) {
    throw new Error(`Graph external connections probe returned HTTP ${response.status}.`);
  }
}

async function workIqMcpCheck(emitter?: EventEmitter): Promise<AuthPreflightCheck> {
  const client = new WorkIqMcpPreflightClient(emitter);
  try {
    await client.start();
    const response = await client.callTool('ask_work_iq', {
      question: 'Reply with exactly this JSON object and no extra text: {"ok":true}',
    });
    const text = String(response.result?.content?.[0]?.text ?? '').trim();
    if (!text) {
      throw new Error('WorkIQ returned an empty auth-check response.');
    }
    return {
      name: 'WorkIQ MCP auth',
      status: 'passed',
      message: 'WorkIQ MCP session and delegated Microsoft 365 auth verified.',
    };
  } catch (error) {
    return {
      name: 'WorkIQ MCP auth',
      status: 'failed',
      message: sanitizeError(error),
    };
  } finally {
    client.stop();
  }
}

async function evalScoreA2AMsalCheck(
  options: AuthPreflightOptions,
  tools: ToolPaths,
  emitter?: EventEmitter,
): Promise<AuthPreflightCheck> {
  if (!tools.evalScore || !path.isAbsolute(tools.evalScore) || !fs.existsSync(tools.evalScore)) {
    return {
      name: 'EvalScore A2A MSAL auth',
      status: 'failed',
      message: 'EvalScore is not built. Run: cd ..\\EvaluationCLI\\eval-score\\node && npm install && npm run build',
    };
  }
  const workiqClient = path.join(path.dirname(tools.evalScore), 'workiq-client.js');
  if (!fs.existsSync(workiqClient)) {
    return {
      name: 'EvalScore A2A MSAL auth',
      status: 'failed',
      message: `EvalScore WorkIQ client module not found: ${workiqClient}`,
    };
  }

  const script = `
const { MsalA2ATokenProvider } = require(${JSON.stringify(workiqClient)});
const scopes = (process.env.EVALSCORE_A2A_SCOPES || process.env.WORK_IQ_A2A_SCOPES || '').split(/[ ,]+/).filter(Boolean);
const provider = new MsalA2ATokenProvider({
  clientId: process.env.EVALSCORE_A2A_CLIENT_ID || process.env.WORK_IQ_A2A_CLIENT_ID || '',
  tenantId: ${JSON.stringify(options.tenantId || '')} || process.env.EVALSCORE_A2A_TENANT_ID || process.env.WORK_IQ_A2A_TENANT_ID || process.env.EVALSCORE_TENANT_ID || process.env.TENANT_ID || '',
  scopes,
  cachePath: process.env.EVALSCORE_A2A_TOKEN_CACHE_PATH || process.env.WORK_IQ_A2A_TOKEN_CACHE_PATH || require('path').join(process.env.USERPROFILE || process.env.HOME || '.', '.evalscore', 'msal-a2a-cache.json'),
  allowDeviceCode: true,
});
provider.getToken(false).then(() => console.error('EvalScore MSAL A2A token acquired.')).catch((e) => { console.error(e && e.stack || e); process.exit(1); });
`;
  const result = await runProcess({
    cmd: process.execPath,
    args: ['-e', script],
    cwd: path.dirname(tools.evalScore),
    env: sanitizedChildEnv(options.clientSecretEnvVar),
    emitter,
    label: 'evalscore-auth',
    shell: false,
  });
  return {
    name: 'EvalScore A2A MSAL auth',
    status: result.ok ? 'passed' : 'failed',
    message: result.ok
      ? 'EvalScore MSAL A2A token cache is ready.'
      : `EvalScore MSAL A2A preflight exited ${result.exitCode}. Build eval-score and verify EVALSCORE_A2A_* settings.`,
  };
}

async function m365EvalEulaCheck(options: AuthPreflightOptions, emitter?: EventEmitter): Promise<AuthPreflightCheck> {
  const pkgRef = `@microsoft/m365-copilot-eval@${options.m365EvalPackageVersion || 'latest'}`;
  const result = await runProcess({
    cmd: 'npx',
    args: ['-y', pkgRef, 'accept-eula'],
    env: sanitizedChildEnv(options.clientSecretEnvVar),
    emitter,
    label: 'm365eval-eula',
    shell: true,
  });
  return {
    name: 'm365-copilot-eval EULA',
    status: result.ok ? 'passed' : 'failed',
    message: result.ok ? 'EULA accepted or already accepted.' : `accept-eula exited ${result.exitCode}.`,
  };
}

class WorkIqMcpPreflightClient {
  private child?: ReturnType<typeof spawn>;
  private lines: string[] = [];
  private resolvers: Array<(line: string) => void> = [];
  private requestId = 0;

  constructor(private readonly emitter?: EventEmitter) {}

  async start(): Promise<void> {
    this.child = spawnWorkIqMcp();
    this.child.stdout?.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf-8').split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const resolver = this.resolvers.shift();
        if (resolver) resolver(trimmed);
        else this.lines.push(trimmed);
      }
    });
    this.child.stderr?.on('data', (chunk: Buffer) => {
      this.emitter?.emit('log', { label: 'workiq-auth', text: chunk.toString('utf-8') });
      if (!this.emitter) process.stderr.write(chunk);
    });
    this.child.on('error', (error) => {
      this.emitter?.emit('log', { label: 'workiq-auth', text: `WorkIQ process error: ${error.message}\n` });
    });

    this.write({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'ccw-auth-preflight', version: '1.0.0' },
      },
    });
    await this.readResponse(0);
    this.write({ jsonrpc: '2.0', method: 'notifications/initialized' });
    await this.callTool('accept_eula', { eulaUrl: 'https://github.com/microsoft/work-iq-mcp' });
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<any> {
    const id = ++this.requestId;
    this.write({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name, arguments: args },
    });
    const response = await this.readResponse(id);
    if (response.error) {
      throw new Error(`WorkIQ error: ${response.error.message || JSON.stringify(response.error)}`);
    }
    if (response.result?.isError) {
      throw new Error(`WorkIQ tool error: ${response.result?.content?.[0]?.text || 'unknown error'}`);
    }
    return response;
  }

  stop(): void {
    if (this.child && !this.child.killed) {
      this.child.stdin?.end();
      this.child.kill();
    }
    this.child = undefined;
    this.lines = [];
    this.resolvers = [];
  }

  private write(payload: unknown): void {
    this.child?.stdin?.write(`${JSON.stringify(payload)}\n`);
  }

  private async readResponse(expectedId: number): Promise<any> {
    const deadline = Date.now() + WORKIQ_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const line = await this.readLineWithTimeout(Math.max(1, deadline - Date.now()));
      try {
        const message = JSON.parse(line);
        if (message.id === expectedId) return message;
      } catch {
        // Ignore non-JSON status lines from the MCP process.
      }
    }
    throw new Error(`Timed out waiting for WorkIQ MCP response (id=${expectedId}).`);
  }

  private readLineWithTimeout(timeoutMs: number): Promise<string> {
    const existing = this.lines.shift();
    if (existing) return Promise.resolve(existing);
    if (!this.child || this.child.killed) return Promise.reject(new Error('WorkIQ MCP process is not running.'));
    return new Promise((resolve, reject) => {
      let settled = false;
      const resolver = (line: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(line);
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const idx = this.resolvers.indexOf(resolver);
        if (idx >= 0) this.resolvers.splice(idx, 1);
        reject(new Error(`Timed out waiting for WorkIQ MCP response.`));
      }, timeoutMs);
      this.resolvers.push(resolver);
    });
  }
}

function spawnWorkIqMcp(): ReturnType<typeof spawn> {
  if (process.platform === 'win32') {
    return spawn('workiq mcp', {
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: sanitizedChildEnv(),
      windowsHide: false,
    });
  }
  return spawn('workiq', ['mcp'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: sanitizedChildEnv(),
  });
}

function sanitizedChildEnv(secretEnvVar?: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of ['CLIENT_SECRET', 'CCW_SECRET', secretEnvVar]) {
    if (name) delete env[name];
  }
  return env;
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length < 2) throw new Error('Access token is not a JWT.');
  const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
  return JSON.parse(Buffer.from(padded, 'base64').toString('utf-8')) as Record<string, unknown>;
}

function summarizeJsonError(text: string): string {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const code = typeof parsed.error === 'string' ? parsed.error : undefined;
    const description = typeof parsed.error_description === 'string'
      ? parsed.error_description
      : typeof parsed.message === 'string'
        ? parsed.message
        : undefined;
    return [code, description].filter(Boolean).join(' - ') || 'No error details returned.';
  } catch {
    return text.slice(0, 500);
  }
}

function sanitizeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return error.message.replace(/client_secret=[^&\s]+/gi, 'client_secret=<redacted>');
}
