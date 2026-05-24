import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export type SemanticJudgeProvider = 'm365-copilot' | 'github-copilot' | 'azure-openai';

export interface CompareDatasetConfig {
  slug?: string;
  dataset?: string;
  path?: string;
  description: string;
  connectorPrefix?: string;
  connectorId?: string;
  displayName?: string;
  connectorName?: string;
  extensions?: string[];
  evalSetDir?: string;
  tenantId?: string;
  authProfile?: string;
  evalQuestionTarget?: number;
  promptDelaySeconds?: number;
  semanticJudge?: SemanticJudgeProvider;
  mode?: 'build' | 'provision';
  clientId?: string;
  clientSecretEnvVar?: string;
  useManagedIdentity?: boolean;
  enhancedAgentId?: string;
  rawAgentId?: string;
  collectResponses?: boolean;
}

export interface CompareBatchManifest {
  tenantId?: string;
  authProfile?: string;
  evalQuestionTarget?: number;
  promptDelaySeconds?: number;
  semanticJudge?: SemanticJudgeProvider;
  mode?: 'build' | 'provision';
  clientId?: string;
  clientSecretEnvVar?: string;
  useManagedIdentity?: boolean;
  collectResponses?: boolean;
  datasets: CompareDatasetConfig[];
}

export interface ComparePlan {
  slug: string;
  dataset: string;
  description: string;
  extensions?: string[];
  evalSetDir?: string;
  tenantId?: string;
  authProfile?: string;
  evalQuestionTarget: number;
  promptDelaySeconds: number;
  semanticJudge: SemanticJudgeProvider;
  mode: 'build' | 'provision';
  clientId?: string;
  clientSecretEnvVar?: string;
  useManagedIdentity?: boolean;
  collectResponses: boolean;
  enhanced: {
    connectorId: string;
    connectorName: string;
    agentName: string;
    agentId?: string;
  };
  raw: {
    connectorId: string;
    connectorName: string;
    agentName: string;
    agentId?: string;
  };
  phases: ComparePhase[];
}

export interface ComparePhase {
  name: string;
  owner: 'CopilotConnectorSkill' | 'CopilotConnectorWorkflow' | 'EvaluationCLI';
  status: 'planned' | 'not-started';
  notes: string[];
}

export interface CompareRunState {
  id: string;
  kind: 'compare-dataset' | 'compare-batch';
  status: 'dry-run' | 'planned' | 'running' | 'done' | 'failed' | 'blocked';
  createdAt: string;
  updatedAt: string;
  sourceConfig: string;
  dryRun: boolean;
  plans: ComparePlan[];
}

const COMPARE_ROOT = path.resolve(__dirname, '..', 'workspace', 'compare-runs');

export function createCompareDatasetRun(configFile: string, dryRun: boolean): CompareRunState {
  const fullConfigPath = path.resolve(configFile);
  const raw = readJson<CompareDatasetConfig>(fullConfigPath);
  const plan = buildDatasetPlan(raw, path.dirname(fullConfigPath));
  return writeCompareState('compare-dataset', fullConfigPath, [plan], dryRun);
}

export function createCompareBatchRun(manifestFile: string, dryRun: boolean): CompareRunState {
  const fullManifestPath = path.resolve(manifestFile);
  const manifest = readJson<CompareBatchManifest>(fullManifestPath);
  if (!Array.isArray(manifest.datasets) || manifest.datasets.length === 0) {
    throw new Error('batch manifest must include a non-empty datasets array');
  }

  const baseDir = path.dirname(fullManifestPath);
  const plans = manifest.datasets.map((dataset) => buildDatasetPlan({
    tenantId: dataset.tenantId || manifest.tenantId,
    authProfile: dataset.authProfile || manifest.authProfile,
    evalQuestionTarget: dataset.evalQuestionTarget || manifest.evalQuestionTarget,
    promptDelaySeconds: dataset.promptDelaySeconds || manifest.promptDelaySeconds,
    semanticJudge: dataset.semanticJudge || manifest.semanticJudge,
    mode: dataset.mode || manifest.mode,
    clientId: dataset.clientId || manifest.clientId,
    clientSecretEnvVar: dataset.clientSecretEnvVar || manifest.clientSecretEnvVar,
    useManagedIdentity: dataset.useManagedIdentity ?? manifest.useManagedIdentity,
    collectResponses: dataset.collectResponses ?? manifest.collectResponses,
    ...dataset,
  }, baseDir));

  return writeCompareState('compare-batch', fullManifestPath, plans, dryRun);
}

export function formatCompareState(state: CompareRunState): string {
  const lines = [
    `${state.kind} ${state.id} (${state.status})`,
    `State: ${compareStatePath(state.id)}`,
    '',
  ];

  for (const plan of state.plans) {
    lines.push(`Dataset: ${plan.slug}`);
    lines.push(`  Path: ${plan.dataset}`);
    lines.push(`  Enhanced: ${plan.enhanced.connectorId} / ${plan.enhanced.agentName}`);
    lines.push(`  RAW: ${plan.raw.connectorId} / ${plan.raw.agentName}`);
    lines.push(`  Eval target: ${plan.evalQuestionTarget}`);
    lines.push(`  Semantic judge: ${plan.semanticJudge}`);
    lines.push(`  Mode: ${plan.mode}${plan.collectResponses ? ' + response collection' : ''}`);
    lines.push('  Planned phases:');
    for (const phase of plan.phases) {
      lines.push(`    - ${phase.name} [${phase.owner}]`);
    }
    lines.push('');
  }

  if (state.dryRun) {
    lines.push('Dry-run only: no Graph, WorkIQ, EvalGen, connector, or agent writes were performed.');
  }

  return lines.join('\n');
}

function buildDatasetPlan(config: CompareDatasetConfig, baseDir: string): ComparePlan {
  const datasetInput = config.dataset || config.path;
  if (!datasetInput) throw new Error('dataset config requires dataset or path');

  const dataset = path.resolve(baseDir, datasetInput);
  if (!fs.existsSync(dataset)) throw new Error(`dataset not found: ${dataset}`);
  if (!config.description || config.description.trim().length < 10) {
    throw new Error('dataset description must be at least 10 characters');
  }

  const slug = sanitizeSlug(config.slug || config.displayName || config.connectorName || path.basename(dataset));
  const connectorPrefix = sanitizeConnectorId(config.connectorPrefix || config.connectorId || `ccw${slug}`);
  const displayName = config.displayName || config.connectorName || titleFromSlug(slug);
  const enhancedConnectorId = truncateConnectorId(connectorPrefix);
  const rawConnectorId = truncateConnectorId(`${connectorPrefix}raw`);

  return {
    slug,
    dataset,
    description: config.description,
    extensions: config.extensions,
    evalSetDir: config.evalSetDir ? path.resolve(baseDir, config.evalSetDir) : undefined,
    tenantId: config.tenantId,
    authProfile: config.authProfile,
    evalQuestionTarget: config.evalQuestionTarget || 100,
    promptDelaySeconds: config.promptDelaySeconds || 30,
    semanticJudge: config.semanticJudge || 'm365-copilot',
    mode: config.mode || 'build',
    clientId: config.clientId,
    clientSecretEnvVar: config.clientSecretEnvVar,
    useManagedIdentity: !!config.useManagedIdentity,
    collectResponses: !!config.collectResponses,
    enhanced: {
      connectorId: enhancedConnectorId,
      connectorName: displayName,
      agentName: `${displayName} Assistant`,
      agentId: config.enhancedAgentId,
    },
    raw: {
      connectorId: rawConnectorId,
      connectorName: `${displayName} RAW`,
      agentName: `${displayName} RAW Assistant`,
      agentId: config.rawAgentId,
    },
    phases: plannedPhases(),
  };
}

function plannedPhases(): ComparePhase[] {
  return [
    {
      name: 'skill-artifact-generation',
      owner: 'CopilotConnectorSkill',
      status: 'planned',
      notes: [
        'Generate generic enhanced connector artifacts by default.',
        'Apply optional RAW-baseline recipe only because compare workflow requested it.',
      ],
    },
    {
      name: 'evalgen-target-set',
      owner: 'CopilotConnectorWorkflow',
      status: 'planned',
      notes: [
        'Wrap EvalGen with multi-batch generation and merge to target question count.',
        'Move into EvaluationCLI only if wrapping proves brittle.',
      ],
    },
    {
      name: 'connector-provision-ingest',
      owner: 'CopilotConnectorWorkflow',
      status: 'planned',
      notes: [
        'Provision enhanced and RAW external connections with app-only Graph auth.',
        'Poll schema completion and verify item ingestion.',
      ],
    },
    {
      name: 'agent-create-discover',
      owner: 'CopilotConnectorWorkflow',
      status: 'planned',
      notes: [
        'Create one GraphConnectors-only declarative agent per connection.',
        'Persist deployed agent IDs.',
      ],
    },
    {
      name: 'await-indexing',
      owner: 'CopilotConnectorWorkflow',
      status: 'planned',
      notes: ['Run canary prompts until both agents can answer from indexed connector data.'],
    },
    {
      name: 'collect-responses',
      owner: 'CopilotConnectorWorkflow',
      status: 'planned',
      notes: ['Use long-lived WorkIQ REST/A2A runner with durable token cache and retry queue.'],
    },
    {
      name: 'score-and-report',
      owner: 'CopilotConnectorWorkflow',
      status: 'planned',
      notes: [
        'Produce deterministic grounding score.',
        'Produce required semantic quality score.',
        'Write per-dataset and aggregate comparison reports.',
      ],
    },
  ];
}

function writeCompareState(
  kind: CompareRunState['kind'],
  sourceConfig: string,
  plans: ComparePlan[],
  dryRun: boolean,
): CompareRunState {
  fs.mkdirSync(COMPARE_ROOT, { recursive: true });
  const now = new Date().toISOString();
  const id = `${now.replace(/[-:TZ.]/g, '').slice(0, 14)}-${crypto.randomBytes(3).toString('hex')}`;
  const state: CompareRunState = {
    id,
    kind,
    status: dryRun ? 'dry-run' : 'planned',
    createdAt: now,
    updatedAt: now,
    sourceConfig,
    dryRun,
    plans,
  };
  fs.mkdirSync(compareRunDir(id), { recursive: true });
  fs.writeFileSync(compareStatePath(id), JSON.stringify(state, null, 2), 'utf-8');
  return state;
}

function readJson<T>(file: string): T {
  if (!fs.existsSync(file)) throw new Error(`config file not found: ${file}`);
  return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
}

export function compareRunDir(id: string): string {
  return path.join(COMPARE_ROOT, id);
}

export function compareStatePath(id: string): string {
  return path.join(compareRunDir(id), 'compare-state.json');
}

function sanitizeSlug(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug) throw new Error('could not derive dataset slug');
  return slug.slice(0, 48);
}

function sanitizeConnectorId(value: string): string {
  const id = value.replace(/[^a-zA-Z0-9]/g, '');
  if (id.length < 3) throw new Error(`connector id prefix is too short after sanitization: ${value}`);
  return id;
}

function truncateConnectorId(value: string): string {
  return value.slice(0, 128);
}

function titleFromSlug(slug: string): string {
  return slug.split('-').filter(Boolean).map((part) => part[0].toUpperCase() + part.slice(1)).join(' ');
}
