export type StepName = 'evalgen' | 'enhance' | 'schema' | 'connector' | 'deploy' | 'score';

export type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export type JobStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';

export type RunMode = 'build' | 'provision';

export type DeployTarget = 'azure-functions' | 'azure-container-apps' | 'both';

export interface AuthConfig {
  tenantId?: string;
  clientId?: string;
  /** Build mode: secret/managed-identity blank is OK. Provision mode: required. */
  clientSecretEnvVar?: string;
  useManagedIdentity?: boolean;
}

export type JudgeProvider = 'github-copilot' | 'workiq';

export interface ScoreConfig {
  /** Judge provider. Defaults to 'github-copilot'. */
  judgeProvider?: JudgeProvider;
  /** Required when judgeProvider is 'workiq'. The eval-judge declarative agent id. */
  judgeAgentId?: string;
  /** M365 candidate agent id (the agent under evaluation). Required in provision mode. Discovered/persisted by Step 5; can be supplied here for an existing agent. */
  candidateAgentId?: string;
  /** Minimum wait floor (seconds) for indexing readiness gate. Default 300 (5 min). */
  indexReadyMinSeconds?: number;
  /** Maximum wait ceiling (seconds) for indexing readiness gate. Default 5400 (90 min). */
  indexReadyMaxSeconds?: number;
  /** Max retries per invalid response row before failing the job. Default 3. */
  invalidRowRetryLimit?: number;
  /** If true, Step 5 will NOT try to auto-publish the agent via `atk install`; operator must provide candidateAgentId out-of-band. */
  skipAgentPublish?: boolean;
  /** Comma-separated evaluator names or "all". Defaults to eval-score's "Relevance,Coherence". */
  evaluators?: string;
}

/** Canonical Step 6 scored-report shape, persisted to 06-score/agent-response-scores.json. */
export interface ScoredReport {
  jobId: string;
  noEnhance: boolean;
  judgeProvider: JudgeProvider;
  judgeModel?: string;
  datasetHash?: string;
  evalSetHash?: string;
  indexReadyAt?: string;
  promptCount: number;
  validPromptCount: number;
  metadataProvenance?: {
    titleFromSource: number;
    urlFromSource: number;
    iconUrlFromSource: number;
    schemaPropertiesPromotedToSearchable: number;
    schemaPropertiesPromotedToRefinable: number;
  };
  deterministicScore: {
    average: number;
    passCount: number;
    partialCount: number;
    failCount: number;
    byCategory: Record<string, { count: number; average: number }>;
  };
  semanticScore: {
    average: number;
    byDimension: Record<string, number>;
  };
  citationRate: number;
  retryCount: number;
  rateLimitCount: number;
  items: Array<{
    id: string;
    prompt: string;
    expected: string;
    actual: string;
    category?: string;
    deterministic: { score: number; status: 'pass' | 'partial' | 'fail'; assertionsPassed: number; assertionsTotal: number; factsPassed: number; factsTotal: number };
    semantic: { score: number; byDimension?: Record<string, number>; rationale?: string };
    citation?: boolean;
  }>;
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
  /** build = artifacts only; provision = full lifecycle + scoring. */
  mode: RunMode;
  /** ACL strategy for generated items. */
  aclMode: 'everyone' | 'everyoneExceptGuests' | 'none';
  /** Authentication for provision mode. */
  auth?: AuthConfig;
  /**
   * When true, Step 2 runs the identity-but-shape-aware transform instead of the
   * data enhancer. The schema is still inferred from the source data shape;
   * properties are 1:1 with sanitized source columns (no synthetic enrichment,
   * no domain inference, no long-form pivot, no prompt-example folding).
   * Steps 3-6 are unchanged.
   */
  noEnhance?: boolean;
  /**
   * Reuse the eval set from this previously-completed job (Step 1 copies its
   * eval.csv / eval.evalgen.json verbatim). Required to pair two runs for
   * post-hoc comparison so they share the same evalSetHash.
   */
  reuseEvalFromJobId?: string;
  /**
   * Reuse the eval set from this explicit path (must contain eval.csv +
   * eval.evalgen.json). Mutually exclusive with reuseEvalFromJobId.
   */
  evalSetPath?: string;
  /** Step 6 scoring configuration. */
  score?: ScoreConfig;
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
  /** Canonical dataset hash (sha256:<hex>). Populated when the job is created and on first read for legacy jobs. */
  datasetHash?: string;
  /** Canonical eval-set hash (sha256:<hex>). Populated after Step 1 emits eval.evalgen.json. */
  evalSetHash?: string;
}

export const ALL_STEPS: StepName[] = [
  'evalgen',
  'enhance',
  'schema',
  'connector',
  'deploy',
  'score',
];
