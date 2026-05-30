/**
 * Canonical hashing per STREAMLINED_CONNECTOR_EVAL_PLAN.md "Canonical hashing".
 *
 * The post-hoc comparator (ccw compare) uses these hashes to verify that two
 * jobs ran against the same dataset and the same eval set. Hashes are stable
 * across runs that should match and distinct across runs that shouldn't.
 *
 *  - datasetHash:   SHA-256 over a normalized manifest of source files
 *                   (relativePath + sha256 + byteLength), sorted, excluding
 *                   generated artifacts (evalset/, workspace/, leading-underscore
 *                   paths). Dataset description is NOT in the hash.
 *  - evalSetHash:   SHA-256 over canonicalized eval items
 *                   { id, prompt, expected_answer, assertions, supporting_facts,
 *                     category, difficulty } sorted by id. Generation timestamp
 *                   and review markdown are NOT in the hash.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

export interface DatasetFileEntry {
  relativePath: string;
  sha256: string;
  byteLength: number;
}

export interface DatasetHashResult {
  hash: string;
  files: DatasetFileEntry[];
}

const EXCLUDED_PATH_SEGMENTS = new Set(['evalset', 'workspace', 'node_modules', '.git']);

/**
 * Hash a dataset (folder or single file) canonically.
 *
 * @param datasetPath   Folder or single file.
 * @param extensions    Optional include list (e.g. ['csv','json']). If omitted,
 *                      every file under the dataset is included (with EXCLUDED
 *                      path segments still skipped).
 */
export function hashDataset(datasetPath: string, extensions?: string[]): DatasetHashResult {
  const resolved = path.resolve(datasetPath);
  if (!fs.existsSync(resolved)) throw new Error(`dataset not found: ${resolved}`);
  const extFilter = extensions && extensions.length > 0
    ? new Set(extensions.map((e) => normalizeExt(e)))
    : undefined;

  const entries: DatasetFileEntry[] = [];
  const stat = fs.statSync(resolved);
  if (stat.isFile()) {
    if (!extFilter || extFilter.has(normalizeExt(path.extname(resolved)))) {
      entries.push(hashOneFile(resolved, path.basename(resolved)));
    }
  } else {
    walkDirectory(resolved, '', extFilter, entries);
  }
  entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  const manifest = entries.map((e) => `${e.relativePath}\t${e.sha256}\t${e.byteLength}`).join('\n');
  const hash = sha256(manifest);
  return { hash: `sha256:${hash}`, files: entries };
}

function walkDirectory(
  root: string,
  rel: string,
  extFilter: Set<string> | undefined,
  out: DatasetFileEntry[],
): void {
  const here = path.join(root, rel);
  for (const name of fs.readdirSync(here).sort()) {
    if (name.startsWith('_')) continue;
    if (EXCLUDED_PATH_SEGMENTS.has(name.toLowerCase())) continue;
    const childRel = rel ? `${rel}/${name}` : name;
    const childAbs = path.join(here, name);
    const childStat = fs.statSync(childAbs);
    if (childStat.isDirectory()) {
      walkDirectory(root, childRel, extFilter, out);
    } else if (childStat.isFile()) {
      if (extFilter && !extFilter.has(normalizeExt(path.extname(name)))) continue;
      out.push(hashOneFile(childAbs, childRel));
    }
  }
}

function hashOneFile(absolutePath: string, relativePath: string): DatasetFileEntry {
  return {
    relativePath: normalizeRelativePath(relativePath),
    sha256: sha256File(absolutePath),
    byteLength: fs.statSync(absolutePath).size,
  };
}

/* ----- eval-set hashing ----- */

export interface CanonicalEvalItem {
  id: string;
  prompt: string;
  expected_answer: string;
  assertions: Array<{ value: string; wholeWord?: boolean }>;
  supporting_facts: string[];
  category: string;
  difficulty: string;
}

export interface EvalSetHashResult {
  hash: string;
  itemCount: number;
}

/** Hash an eval set canonically from its JSON sidecar. */
export function hashEvalSetFile(evalGenJsonPath: string): EvalSetHashResult {
  if (!fs.existsSync(evalGenJsonPath)) throw new Error(`eval set not found: ${evalGenJsonPath}`);
  const parsed = JSON.parse(fs.readFileSync(evalGenJsonPath, 'utf-8')) as { items?: unknown[] };
  const items = Array.isArray(parsed.items) ? parsed.items : [];
  return hashEvalSetItems(items);
}

/** Hash an eval set canonically from raw items already parsed. */
export function hashEvalSetItems(rawItems: unknown[]): EvalSetHashResult {
  const canonical = rawItems
    .map(canonicalizeEvalItem)
    .filter((x): x is CanonicalEvalItem => x !== undefined)
    .sort((a, b) => a.id.localeCompare(b.id));
  const payload = canonical.map((item) => JSON.stringify(item)).join('\n');
  return { hash: `sha256:${sha256(payload)}`, itemCount: canonical.length };
}

function canonicalizeEvalItem(value: unknown): CanonicalEvalItem | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const item = value as Record<string, unknown>;
  const prompt = stringField(item.prompt);
  if (!prompt) return undefined;
  const id = stringField(item.id) || hashId(prompt);
  return {
    id,
    prompt,
    expected_answer: stringField(item.expected_answer ?? item.expectedAnswer),
    assertions: normalizeAssertions(item.assertions),
    supporting_facts: normalizeSupportingFacts(item.supporting_facts ?? item.supportingFacts),
    category: stringField(item.category),
    difficulty: stringField(item.difficulty),
  };
}

function normalizeAssertions(value: unknown): CanonicalEvalItem['assertions'] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return undefined;
      const obj = entry as Record<string, unknown>;
      const v = stringField(obj.value);
      if (!v) return undefined;
      return obj.wholeWord === true ? { value: v, wholeWord: true } : { value: v };
    })
    .filter((x): x is { value: string; wholeWord?: boolean } => x !== undefined);
}

function normalizeSupportingFacts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(stringField).filter((s) => s.length > 0);
}

function stringField(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function hashId(prompt: string): string {
  return sha256(prompt).slice(0, 12);
}

/* ----- low-level helpers ----- */

function sha256(input: string): string {
  return crypto.createHash('sha256').update(input, 'utf-8').digest('hex');
}

function sha256File(filePath: string): string {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    while (true) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      h.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex');
}

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/g, '/').toLowerCase();
}

function normalizeExt(value: string): string {
  return value.replace(/^\./, '').toLowerCase();
}
