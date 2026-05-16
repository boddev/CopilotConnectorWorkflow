import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';
import express, { Request, Response } from 'express';
import { EventEmitter } from 'events';
import { createJob, listJobs, loadJob } from './jobs';
import { runPipeline } from './orchestrator';
import { probeTools, resolveTools } from './tools';
import { JobConfig, JobRecord, StepName } from './types';

const PORT = Number(process.env.CCW_PORT || 4321);
const HOST = '127.0.0.1';

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

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

app.get('/api/tools', (_req, res) => res.json(probeTools()));

app.get('/api/jobs', (_req, res) => res.json(listJobs()));

app.get('/api/jobs/:id', (req, res) => {
  const j = loadJob(req.params.id);
  if (!j) return res.status(404).json({ error: 'not found' });
  res.json(j);
});

app.post('/api/jobs', async (req, res) => {
  try {
    const cfg = req.body as JobConfig;
    if (cfg.dataset) cfg.dataset = path.resolve(cfg.dataset);
    const job = createJob(cfg);
    res.json(job);
    // Kick off the pipeline asynchronously.
    runPipelineForJob(job).catch((e) => console.error(`[${job.id}] runPipeline error:`, e));
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
  if (!abs.startsWith(job.workspace)) return res.status(400).end();
  if (!fs.existsSync(abs)) return res.status(404).end();
  res.sendFile(abs);
});

function jsonLine(o: unknown): string {
  return JSON.stringify(o).replace(/\n/g, '\\n');
}

function stepDirFor(step: StepName): string {
  const map: Record<StepName, string> = {
    evalgen: '01-evalgen', enhance: '02-enhance', schema: '03-schema',
    connector: '04-connector', deploy: '05-deploy', m365eval: '06-m365eval',
  };
  return map[step];
}

async function runPipelineForJob(job: JobRecord, opts?: { forceAll?: boolean; forceSteps?: StepName[]; startAt?: StepName; stopAfter?: StepName }): Promise<void> {
  const tools = resolveTools();
  const bus = busFor(job.id);
  await runPipeline({ job, tools, emitter: bus, ...opts });
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

app.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}/`;
  console.log(`CopilotConnectorWorkflow listening at ${url}`);
  console.log('Opening browser... (set CCW_NO_OPEN=1 to disable)');
  // Slight delay so the listener prints first and the socket is fully bound.
  setTimeout(() => openBrowser(url), 250);
});
