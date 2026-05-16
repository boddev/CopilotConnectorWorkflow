import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

/** Resolve sibling project paths relative to the workflow repo. */
const REPO_ROOT = path.resolve(__dirname, '..');
const SRC_ROOT = path.resolve(REPO_ROOT, '..');

export interface ToolPaths {
  evalGen: string;          // path to eval-gen dist/index.js
  /** PowerShell script that converts EvalGen output to @microsoft/m365-copilot-eval JSON. */
  evalGenToM365Convert: string;
  dataEnhancer: string;     // path to enhance_for_copilot.py
  python: string;           // resolved python invocation (e.g., 'py' or 'python')
  copilotConnectorSkill: string; // skill bundle root
  templatesRoot: string;
}

export function resolveTools(): ToolPaths {
  const evalGen = path.join(SRC_ROOT, 'EvaluationCLI', 'eval-gen', 'dist', 'index.js');
  const evalGenToM365Convert = path.join(SRC_ROOT, 'EvaluationCLI', 'scripts', 'convert-evalgen-to-m365-copilot-eval.ps1');
  const dataEnhancer = path.join(SRC_ROOT, 'data-enhancer', 'enhance_for_copilot.py');
  const copilotConnectorSkill = path.join(SRC_ROOT, 'CopilotConnectorSkill', 'copilot-connector');
  const templatesRoot = path.join(REPO_ROOT, 'templates');
  return {
    evalGen,
    evalGenToM365Convert,
    dataEnhancer,
    python: detectPython(),
    copilotConnectorSkill,
    templatesRoot,
  };
}

export function detectPython(): string {
  for (const candidate of [['py', '-3'], ['python'], ['python3']]) {
    try {
      const r = spawnSync(candidate[0], [...candidate.slice(1), '--version'], { shell: false });
      if (r.status === 0) return candidate.join(' ');
    } catch { /* ignore */ }
  }
  return 'python';
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
  out.push(probeFile('data-enhancer', t.dataEnhancer, 'Repo expected at ..\\data-enhancer'));
  out.push(probeFile('copilot-connector skill', path.join(t.copilotConnectorSkill, 'SKILL.md'),
    'Skill expected at ..\\CopilotConnectorSkill\\copilot-connector'));
  // Python
  const pyParts = t.python.split(' ');
  const pyTest = spawnSync(pyParts[0], [...pyParts.slice(1), '--version'], { shell: false });
  out.push({
    name: 'python',
    path: t.python,
    ok: pyTest.status === 0,
    note: pyTest.status === 0 ? (pyTest.stdout?.toString() || pyTest.stderr?.toString() || '').trim() : 'Python not detected',
  });
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
