export type StepName = 'evalgen' | 'enhance' | 'schema' | 'connector' | 'deploy' | 'm365eval';

export type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export type JobStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';

export type RunMode = 'build' | 'provision';

export type DeployTarget = 'azure-functions' | 'azure-container-apps' | 'both';

export type M365Evaluator =
  | 'Relevance' | 'Coherence' | 'Groundedness' | 'ToolCallAccuracy'
  | 'Citations' | 'ExactMatch' | 'PartialMatch';

export interface AuthConfig {
  tenantId?: string;
  clientId?: string;
  /** Build mode: secret/managed-identity blank is OK. Provision mode: required. */
  clientSecretEnvVar?: string;
  useManagedIdentity?: boolean;
}

/** Configuration for the optional Step 6 (@microsoft/m365-copilot-eval). */
export interface M365EvalConfig {
  /** M365 agent ID — required by @microsoft/m365-copilot-eval. Note: this is an AGENT id, not the connector id. */
  agentId?: string;
  /** Optional path to a system prompt markdown file folded into every prompt. */
  systemPromptFile?: string;
  /** Evaluators to enable. Default: Relevance, Coherence, Groundedness, Citations. */
  evaluators?: M365Evaluator[];
  /** Concurrency for runevals. Default 1. */
  concurrency?: number;
  /** Environment passed to runevals --env. Default 'local'. */
  environment?: string;
  /** Package version pinned via npx. Default 'latest'. */
  packageVersion?: string;
  /** runevals --log-level. Default 'info'. */
  logLevel?: 'debug' | 'info' | 'warning' | 'error';
  /** If true, runs `runevals accept-eula` before the eval. Required on first use. */
  acceptEula?: boolean;
}

export interface JobConfig {
  /** Dataset folder or file. */
  dataset: string;
  /** Human description used by eval-gen and as connector description seed. */
  description: string;
  /** Number of eval prompts to generate (10-50). */
  count: number;
  /** File extensions for eval-gen when dataset is a folder. */
  extensions?: string[];
  /** Connection ID (3-128 alphanumeric). */
  connectorId: string;
  /** Connector display name shown in M365 Admin Center. */
  connectorName: string;
  /** Optional richer connector description. Falls back to job.description. */
  connectorDescription?: string;
  /** Deploy artifacts to emit. */
  deployTarget: DeployTarget;
  /** build = artifacts only; provision = actually provision + ingest. */
  mode: RunMode;
  /** ACL strategy for generated items. */
  aclMode: 'everyone' | 'everyoneExceptGuests' | 'none';
  /** Authentication for provision mode. */
  auth?: AuthConfig;
  /** Run optional Step 6 (@microsoft/m365-copilot-eval) after deploy. */
  runM365Eval?: boolean;
  /** Step 6 configuration (only used when runM365Eval is true). */
  m365Eval?: M365EvalConfig;
  /** Declarative agent display name. Defaults to `${connectorName} Assistant`. */
  agentName?: string;
  /** Declarative agent system instructions. Defaults to auto-generated from description. */
  agentInstructions?: string;
  /**
   * Base URL prefix for source items (e.g. https://wiki.example.com).
   * When set, the data-enhancer uses this prefix for generated item URLs and
   * the connector's connection model includes an active urlToItemResolver,
   * enabling URL unfurling in Teams/Copilot.
   */
  urlPrefix?: string;
}

export interface StepRecord {
  name: StepName;
  status: StepStatus;
  startedAt?: string;
  endedAt?: string;
  exitCode?: number;
  /** Hash of inputs (config + upstream artifact hashes + tool versions). */
  inputsHash?: string;
  /** Hashes of produced output files keyed by relative path. */
  outputs?: Record<string, string>;
  artifacts?: string[];
  diagnostics?: string[];
  errorMessage?: string;
}

export interface JobRecord {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: JobStatus;
  config: JobConfig;
  steps: Record<StepName, StepRecord>;
  /** Workspace directory absolute path. */
  workspace: string;
}

export const ALL_STEPS: StepName[] = [
  'evalgen',
  'enhance',
  'schema',
  'connector',
  'deploy',
  'm365eval',
];
