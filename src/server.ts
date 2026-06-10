import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';
import express, { Application, Request, Response } from 'express';
import { EventEmitter } from 'events';
import { createJob, listJobs, loadJob } from './jobs';
import { runPipeline } from './orchestrator';
import { probeTools, resolveTools } from './tools';
import { JobConfig, JobRecord, StepName } from './types';

const PORT = Number(process.env.CCW_PORT || 4321);
const HOST = '127.0.0.1';

/**
 * Build a fresh Express app. Exported so tests can mount it without listening.
 * `node dist/server.js` still goes through startServer() below.
 */
export function createApp(): Application {
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));
  registerRoutes(app);
  return app;
}

/** Per-job event bus so SSE clients can subscribe to step logs. */
const buses = new Map<string, EventEmitter>();
function busFor(jobId: string): EventEmitter {
  let b = buses.get(jobId);
  if (!b) {
    b = new EventEmitter();
    b.setMaxListeners(20);
    buses.set(jobId, b);
  }
  return b;
}

function registerJobRoutes(app: Application): void {
  app.get('/api/tools', (_req, res) => res.json(probeTools()));

  app.post('/api/browse-folder', async (_req, res) => {
    try {
      const picked = await pickFolderNative();
      res.json({ path: picked || '', canceled: !picked });
    } catch (e: any) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  app.get('/api/jobs', (req, res) => {
    const scored = req.query.scored === 'true' || req.query.scored === '1';
    const provisionOnly = req.query.provisionOnly === 'true' || req.query.provisionOnly === '1';
    const limitRaw = req.query.limit ? Number(req.query.limit) : NaN;
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 1000) : 200;
    let jobs = listJobs();
    if (provisionOnly) jobs = jobs.filter((j) => j.config.mode === 'provision');
    if (scored) jobs = jobs.filter((j) => j.steps.score?.status === 'done');
    res.json(jobs.slice(0, limit));
  });

  app.get('/api/jobs/:id', (req, res) => {
    const j = loadJob(req.params.id);
    if (!j) return res.status(404).json({ error: 'not found' });
    res.json(j);
  });

  app.post('/api/jobs', async (req, res) => {
    try {
      // Backward-compat: accept either { config, runtime } or a raw JobConfig body.
      const body = req.body || {};
      const cfg = (body.config && typeof body.config === 'object' ? body.config : body) as JobConfig;
      const runtime = (body.runtime && typeof body.runtime === 'object' ? body.runtime : {}) as {
        forceAll?: boolean; forceSteps?: StepName[]; startAt?: StepName; stopAfter?: StepName;
      };
      if (cfg.dataset) cfg.dataset = path.resolve(cfg.dataset);

      // In-app client secret: the GUI can submit the raw Graph app secret in the
      // request body. We deliberately keep it OUT of the persisted job.json —
      // instead we stash it in this server process's environment under a
      // generated name and point auth.clientSecretEnvVar at it. The existing
      // provision/ingest plumbing (step5 buildProvisionEnv) then injects
      // CLIENT_SECRET into the connector child process when data is pushed. The
      // plaintext secret only ever lives in memory for this server's lifetime.
      const rawSecret = typeof body.secret === 'string' ? body.secret.trim() : '';
      if (rawSecret) {
        cfg.auth = { ...(cfg.auth || {}) };
        const envName = `CCW_SECRET_${require('crypto').randomBytes(6).toString('hex')}`;
        process.env[envName] = rawSecret;
        cfg.auth.clientSecretEnvVar = envName;
      }

      const job = createJob(cfg);
      res.json(job);
      runPipelineForJob(job, runtime).catch((e) => console.error(`[${job.id}] runPipeline error:`, e));
    } catch (e: any) {
      res.status(400).json({ error: e.message || String(e) });
    }
  });

  app.post('/api/jobs/:id/resume', async (req, res) => {
    const job = loadJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'not found' });
    const { forceAll, forceSteps, startAt, stopAfter } = (req.body || {}) as {
      forceAll?: boolean; forceSteps?: StepName[]; startAt?: StepName; stopAfter?: StepName;
    };
    res.json({ ok: true });
    runPipelineForJob(job, { forceAll, forceSteps, startAt, stopAfter })
      .catch((e) => console.error(`[${job.id}] resume error:`, e));
  });

  app.get('/api/jobs/:id/logs', (req, res) => {
    const job = loadJob(req.params.id);
    if (!job) return res.status(404).end();
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    const bus = busFor(job.id);
    // Replay any existing log content so reconnecting clients see prior output.
    for (const step of Object.values(job.steps)) {
      const f = path.join(job.workspace, stepDirFor(step.name), 'step.log');
      if (fs.existsSync(f)) {
        const text = fs.readFileSync(f, 'utf-8');
        res.write(`data: ${jsonLine({ label: step.name, text })}\n\n`);
      }
    }
    const onLog = (e: { label?: string; text: string }) => {
      res.write(`data: ${jsonLine(e)}\n\n`);
    };
    bus.on('log', onLog);
    req.on('close', () => bus.off('log', onLog));
  });

  app.get('/api/jobs/:id/file', (req, res) => {
    const job = loadJob(req.params.id);
    if (!job) return res.status(404).end();
    const rel = String(req.query.path || '');
    const abs = path.resolve(job.workspace, rel);
    const within = path.relative(job.workspace, abs);
    if (within.startsWith('..') || path.isAbsolute(within)) return res.status(400).end();
    if (!fs.existsSync(abs)) return res.status(404).end();
    res.sendFile(abs);
  });
}

function registerAuthRoutes(app: Application): void {
  app.post('/api/auth-preflight', async (req, res) => {
    const body = req.body || {};
    // In-app client secret: accept a raw secret and expose it to the preflight
    // via a short-lived generated env var, cleaned up in the finally block so
    // the plaintext never lingers in this process's environment.
    let tempEnvVar: string | undefined;
    let clientSecretEnvVar: string | undefined = body.clientSecretEnvVar;
    const rawSecret = typeof body.clientSecret === 'string' ? body.clientSecret.trim() : '';
    if (rawSecret) {
      tempEnvVar = `CCW_SECRET_PRE_${require('crypto').randomBytes(6).toString('hex')}`;
      process.env[tempEnvVar] = rawSecret;
      clientSecretEnvVar = tempEnvVar;
    }
    try {
      // Lazy import so the auth-preflight module isn't loaded unless used.
      const { runAuthPreflight } = await import('./auth-preflight');
      const result = await runAuthPreflight({
        tenantId: body.tenantId,
        clientId: body.clientId,
        clientSecretEnvVar,
        useManagedIdentity: !!body.useManagedIdentity,
        runGraph: body.runGraph !== false,
        runWorkIq: body.runWorkIq !== false,
        runEvalScoreA2A: !!body.runEvalScoreA2A,
      });
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: e?.message || String(e) });
    } finally {
      if (tempEnvVar) delete process.env[tempEnvVar];
    }
  });
}

/**
 * In-memory registry of compare reports the GUI has created. Maps an opaque
 * reportId to its on-disk output directory so the file route can only serve
 * files from registered directories (not arbitrary paths on disk).
 *
 * Not persisted: restarting the server forgets prior compare runs.
 */
interface CompareRegistryEntry {
  reportId: string;
  outputDir: string;
  createdAt: string;
  jobIdA: string;
  jobIdB: string;
}
const compareRegistry = new Map<string, CompareRegistryEntry>();
const COMPARE_REPORT_ROOT = path.resolve(__dirname, '..', 'workspace', 'compare-reports');

function registerCompareRoutes(app: Application): void {
  app.post('/api/compare', async (req, res) => {
    try {
      const { runCompare } = await import('./compare-jobs');
      const body = (req.body || {}) as { jobIdA?: string; jobIdB?: string };
      if (!body.jobIdA || !body.jobIdB) {
        return res.status(400).json({ error: 'jobIdA and jobIdB are required' });
      }
      const reportId = require('crypto').randomBytes(6).toString('hex');
      const outputDir = path.join(COMPARE_REPORT_ROOT, reportId);
      const result = runCompare({ jobIdA: body.jobIdA, jobIdB: body.jobIdB, outputDir });
      compareRegistry.set(reportId, {
        reportId,
        outputDir: result.outputDir,
        createdAt: new Date().toISOString(),
        jobIdA: body.jobIdA,
        jobIdB: body.jobIdB,
      });
      res.json({
        reportId,
        comparable: result.comparable,
        semanticComparable: result.semanticComparable,
        reportJsonPath: result.reportJsonPath,
        reportMdPath: result.reportMdPath,
        scoreMatrixPath: result.scoreMatrixPath,
        diagnostics: result.diagnostics,
      });
    } catch (e: any) {
      res.status(400).json({ error: e?.message || String(e) });
    }
  });

  app.get('/api/compare/:reportId/file', (req, res) => {
    const entry = compareRegistry.get(req.params.reportId);
    if (!entry) return res.status(404).end();
    const rel = String(req.query.path || '');
    if (!rel) return res.status(400).end();
    const abs = path.resolve(entry.outputDir, rel);
    const within = path.relative(entry.outputDir, abs);
    if (within.startsWith('..') || path.isAbsolute(within)) return res.status(400).end();
    if (!fs.existsSync(abs)) return res.status(404).end();
    res.sendFile(abs);
  });
}

function registerRoutes(app: Application): void {
  registerJobRoutes(app);
  registerAuthRoutes(app);
  registerCompareRoutes(app);
}

function jsonLine(o: unknown): string {
  return JSON.stringify(o).replace(/\n/g, '\\n');
}

function stepDirFor(step: StepName): string {
  const map: Record<StepName, string> = {
    evalgen: '01-evalgen', enhance: '02-enhance', schema: '03-schema',
    connector: '04-connector', deploy: '05-deploy', score: '06-score',
  };
  return map[step];
}

async function runPipelineForJob(job: JobRecord, opts?: { forceAll?: boolean; forceSteps?: StepName[]; startAt?: StepName; stopAfter?: StepName }): Promise<void> {
  const tools = resolveTools();
  const bus = busFor(job.id);
  await runPipeline({ job, tools, emitter: bus, ...opts });
}

/**
 * Spawn a native OS folder picker and resolve with the selected absolute path
 * (empty string if the user cancels). The server only ever runs on localhost,
 * so the picker appears on the same machine as the browser. On Windows we drive
 * a WinForms FolderBrowserDialog via PowerShell (STA + TopMost owner so it
 * surfaces above the browser). Non-Windows platforms are unsupported here — the
 * GUI falls back to manual path entry.
 */
function pickFolderNative(): Promise<string> {
  if (process.platform !== 'win32') {
    return Promise.reject(new Error('Native folder picker is only available on Windows; type the dataset path manually.'));
  }
  const ps = [
    'Add-Type -AssemblyName System.Windows.Forms;',
    'Add-Type -AssemblyName System.Drawing;',
    '$owner = New-Object System.Windows.Forms.Form;',
    '$owner.TopMost = $true; $owner.ShowInTaskbar = $false;',
    '$owner.StartPosition = "CenterScreen"; $owner.Size = New-Object System.Drawing.Size(1,1);',
    '$owner.Show(); $owner.Activate(); $owner.Hide();',
    '$dlg = New-Object System.Windows.Forms.FolderBrowserDialog;',
    '$dlg.Description = "Select the folder containing your dataset";',
    '$dlg.ShowNewFolderButton = $true;',
    'if ($dlg.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dlg.SelectedPath) };',
    '$owner.Dispose();',
  ].join(' ');
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-STA', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps],
      { windowsHide: true }
    );
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('error', (e) => reject(e));
    child.on('close', (code) => {
      if (code === 0) resolve(out.trim());
      else reject(new Error(err.trim() || `folder picker exited with code ${code}`));
    });
  });
}

function openBrowser(url: string): void {
  if (process.env.CCW_NO_OPEN === '1') return;
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    // best-effort; the URL is also printed to the console.
  }
}

export function startServer(): void {
  const app = createApp();
  app.listen(PORT, HOST, () => {
    const url = `http://${HOST}:${PORT}/`;
    console.log(`CopilotConnectorWorkflow listening at ${url}`);
    console.log('Opening browser... (set CCW_NO_OPEN=1 to disable)');
    setTimeout(() => openBrowser(url), 250);
  });
}

if (require.main === module) {
  startServer();
}
