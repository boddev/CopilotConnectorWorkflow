import * as fs from 'fs';
import * as path from 'path';
import { StepRecord, DeployTarget } from '../types';
import { fileHash, dirHash } from '../jobs';
import { isCached, stepInputsHash, RunStepOptions } from '../orchestrator';
import { newStepRecord, startStep, finishStep, writeStepStatus } from './step-utils';
import { renderFileToDir, renderString, renderTree } from '../templating';

/** Step 5: render deploy artifacts (Azure Functions + Container Apps). */
export async function runStep5Deploy(opts: RunStepOptions): Promise<StepRecord> {
  const { job, tools, force } = opts;
  const rec = newStepRecord('deploy');
  const stepDir = path.join(job.workspace, '05-deploy');
  fs.mkdirSync(stepDir, { recursive: true });

  const projectDir = path.join(job.workspace, '04-connector', 'connector');
  if (!fs.existsSync(projectDir)) {
    finishStep(rec, 'failed', `connector project not found at ${projectDir}; run step 4 first`);
    writeStepStatus(stepDir, rec); return rec;
  }

  const target: DeployTarget = job.config.deployTarget;
  const templatesDeployRoot = path.join(tools.templatesRoot, 'deploy');
  const inputs = { target, projectHash: dirHash(projectDir), templatesHash: dirHash(templatesDeployRoot), connectorId: job.config.connectorId };
  const inputsHash = stepInputsHash([inputs]);
  rec.inputsHash = inputsHash;
  const prev = job.steps.deploy;
  if (!force && isCached(prev.inputsHash, inputsHash, prev.outputs, job.workspace)) {
    startStep(rec); finishStep(rec, 'skipped');
    rec.outputs = prev.outputs;
    rec.diagnostics?.push('cache hit');
    writeStepStatus(stepDir, rec); return rec;
  }
  startStep(rec);

  const deployRoot = path.join(projectDir, 'deploy');
  fs.mkdirSync(deployRoot, { recursive: true });

  const values: Record<string, string> = {
    connectorId: job.config.connectorId,
    connectorName: job.config.connectorName,
    aclMode: job.config.aclMode,
    tenantId: job.config.auth?.tenantId || '',
    clientId: job.config.auth?.clientId || '',
  };

  const outputs: Record<string, string> = {};
  const artifacts: string[] = [];

  if (target === 'azure-functions' || target === 'both') {
    const dest = path.join(deployRoot, 'azure-functions');
    fs.mkdirSync(dest, { recursive: true });
    renderTree(path.join(templatesDeployRoot, 'azure-functions'), dest, values);
    artifacts.push(dest);
    for (const f of fs.readdirSync(dest)) {
      const abs = path.join(dest, f);
      const rel = path.relative(job.workspace, abs).replace(/\\/g, '/');
      outputs[rel] = fileHash(abs);
    }
  }
  if (target === 'azure-container-apps' || target === 'both') {
    const dest = path.join(deployRoot, 'azure-container-apps');
    fs.mkdirSync(dest, { recursive: true });
    renderTree(path.join(templatesDeployRoot, 'azure-container-apps'), dest, values);
    artifacts.push(dest);
    for (const f of fs.readdirSync(dest)) {
      const abs = path.join(dest, f);
      const rel = path.relative(job.workspace, abs).replace(/\\/g, '/');
      outputs[rel] = fileHash(abs);
    }
  }

  // Render the deploy README
  const deployMdSrc = path.join(templatesDeployRoot, 'deploy.md.hbs');
  if (fs.existsSync(deployMdSrc)) {
    const md = renderString(fs.readFileSync(deployMdSrc, 'utf-8'), values);
    const out = path.join(deployRoot, 'README.md');
    fs.writeFileSync(out, md, 'utf-8');
    outputs[path.relative(job.workspace, out).replace(/\\/g, '/')] = fileHash(out);
    artifacts.push(out);
  }

  rec.outputs = outputs;
  rec.artifacts = artifacts;
  rec.diagnostics?.push(`deploy target: ${target}`);
  finishStep(rec, 'done');
  writeStepStatus(stepDir, rec);
  return rec;
}
