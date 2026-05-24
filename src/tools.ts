import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Resolve sibling project paths relative to the workflow repo. */
const REPO_ROOT = path.resolve(__dirname, '..');
const SRC_ROOT = path.resolve(REPO_ROOT, '..');

export interface ToolPaths {
  evalGen: string;          // path to eval-gen dist/index.js
  /** PowerShell script that converts EvalGen output to @microsoft/m365-copilot-eval JSON. */
  evalGenToM365Convert: string;
  /** Compiled TypeScript batch enhancer (dist/enhancer/enhance_for_copilot.js). Used by step 2. */
  dataEnhancer: string;
  /** TypeScript batch enhancer SOURCE (src/enhancer/enhance_for_copilot.ts). Vendored into generated connectors by step 4. */
  tsDataEnhancer: string;
  copilotConnectorSkill: string; // skill bundle root
  templatesRoot: string;
}

/**
 * Resolves the TypeScript batch enhancer SOURCE file.
 * Prefers the copy bundled within the workflow repo (src/enhancer/) so the workflow
 * is self-contained; falls back to the external CopilotConnectorSkill repo / skill bundle.
 */
function resolveTsEnhancer(): string {
  const candidates = [
    path.join(REPO_ROOT, 'src', 'enhancer', 'enhance_for_copilot.ts'),  // bundled within workflow
    path.join(SRC_ROOT, 'CopilotConnectorSkill', 'copilot-connector', 'sample_codes', 'data-enhancer', 'typescript', 'src', 'enhance_for_copilot.ts'),
    path.join(os.homedir(), '.copilot', 'skills', 'copilot-connector', 'sample_codes', 'data-enhancer', 'typescript', 'src', 'enhance_for_copilot.ts'),
  ];
  return candidates.find(fs.existsSync) ?? candidates[0];
}

/**
 * Priority-ordered candidates for the CopilotConnectorSkill bundle root.
 */
function resolveSkillRoot(): string {
  const candidates = [
    path.join(SRC_ROOT, 'CopilotConnectorSkill', 'copilot-connector'),
    path.join(os.homedir(), '.copilot', 'skills', 'copilot-connector'),
  ];
  return candidates.find((p) => fs.existsSync(path.join(p, 'SKILL.md'))) ?? candidates[0];
}

export function resolveTools(): ToolPaths {
  const evalGen = path.join(SRC_ROOT, 'EvaluationCLI', 'eval-gen', 'dist', 'index.js');
  const evalGenToM365Convert = path.join(SRC_ROOT, 'EvaluationCLI', 'scripts', 'convert-evalgen-to-m365-copilot-eval.ps1');
  const templatesRoot = path.join(REPO_ROOT, 'templates');
  return {
    evalGen,
    evalGenToM365Convert,
    dataEnhancer: path.join(REPO_ROOT, 'dist', 'enhancer', 'enhance_for_copilot.js'),
    tsDataEnhancer: resolveTsEnhancer(),
    copilotConnectorSkill: resolveSkillRoot(),
    templatesRoot,
  };
}

/** @microsoft/m365-copilot-eval requires Node.js >= 22.21.1. */
export const M365_EVAL_MIN_NODE = '22.21.1';

export function checkNodeMinimum(min: string): { ok: boolean; current: string } {
  const cur = process.versions.node;
  return { ok: compareSemver(cur, min) >= 0, current: cur };
}

export function compareSemver(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map((n) => Number(n) || 0);
  const pb = b.replace(/^v/, '').split('.').map((n) => Number(n) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

export interface ToolStatus {
  name: string;
  path: string;
  ok: boolean;
  note?: string;
}

export function probeTools(t: ToolPaths = resolveTools()): ToolStatus[] {
  const out: ToolStatus[] = [];
  out.push(probeFile('eval-gen', t.evalGen,
    'Build it: cd ..\\EvaluationCLI\\eval-gen && npm install && npm run build'));
  out.push(probeFile('eval-gen→m365-eval convert', t.evalGenToM365Convert,
    'Expected in ..\\EvaluationCLI\\scripts'));
  out.push(probeFile('data-enhancer (compiled)', t.dataEnhancer,
    'Build the workflow first: npm run build (in CopilotConnectorWorkflow)'));
  out.push(probeFile('data-enhancer (typescript src)', t.tsDataEnhancer,
    'Expected at src/enhancer/enhance_for_copilot.ts (bundled) or CopilotConnectorSkill skill'));
  out.push(probeFile('copilot-connector skill', path.join(t.copilotConnectorSkill, 'SKILL.md'),
    'Skill expected at CopilotConnectorSkill\\copilot-connector or ~/.copilot/skills/copilot-connector'));
  // Node version (warning only; required only for Step 6)
  const nodeCheck = checkNodeMinimum(M365_EVAL_MIN_NODE);
  out.push({
    name: `node ≥ ${M365_EVAL_MIN_NODE} (for m365-copilot-eval)`,
    path: process.execPath,
    ok: nodeCheck.ok,
    note: nodeCheck.ok ? `Node ${nodeCheck.current}` : `Node ${nodeCheck.current} is below ${M365_EVAL_MIN_NODE}; Step 6 will not run.`,
  });
  return out;
}

function probeFile(name: string, p: string, fixHint: string): ToolStatus {
  return {
    name,
    path: p,
    ok: fs.existsSync(p),
    note: fs.existsSync(p) ? undefined : `Missing. ${fixHint}`,
  };
}
