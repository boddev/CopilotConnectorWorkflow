import * as fs from 'fs';
import * as path from 'path';
import { StepRecord } from '../types';
import { fileHash } from '../jobs';
import { isCached, stepInputsHash, RunStepOptions } from '../orchestrator';
import { newStepRecord, startStep, finishStep, writeStepStatus } from './step-utils';

export interface GraphProperty {
  name: string;
  type: 'String' | 'Int64' | 'Double' | 'DateTime' | 'Boolean' | 'StringCollection';
  isSearchable?: boolean;
  isQueryable?: boolean;
  isRetrievable?: boolean;
  isRefinable?: boolean;
  isExactMatchRequired?: boolean;
  labels?: string[];
  aliases?: string[];
}

export interface GraphConnectorSchema {
  baseType: 'microsoft.graph.externalItem';
  properties: GraphProperty[];
}

/**
 * Step 3: read the data-enhancer schema-suggestion.json, harden into a real
 * Graph-Connectors schema + TypeScript module, and validate constraints
 * against the schema AND a sample of the produced items.
 */
export async function runStep3Schema(opts: RunStepOptions): Promise<StepRecord> {
  const { job, force } = opts;
  const rec = newStepRecord('schema');
  const stepDir = path.join(job.workspace, '03-schema');
  fs.mkdirSync(stepDir, { recursive: true });

  const enhanceDir = path.join(job.workspace, '02-enhance');
  const suggestion = path.join(enhanceDir, 'schema-suggestion.json');
  const itemsJsonl = path.join(enhanceDir, 'enhanced-items.jsonl');
  if (!fs.existsSync(suggestion) || !fs.existsSync(itemsJsonl)) {
    finishStep(rec, 'failed', `missing inputs from step 2: schema-suggestion.json or enhanced-items.jsonl`);
    writeStepStatus(stepDir, rec); return rec;
  }
  const inputs = { suggestionHash: fileHash(suggestion), itemsHash: fileHash(itemsJsonl) };
  const inputsHash = stepInputsHash([inputs]);
  rec.inputsHash = inputsHash;
  const prev = job.steps.schema;
  if (!force && isCached(prev.inputsHash, inputsHash, prev.outputs, job.workspace)) {
    startStep(rec); finishStep(rec, 'skipped');
    rec.outputs = prev.outputs;
    rec.diagnostics?.push('cache hit');
    writeStepStatus(stepDir, rec); return rec;
  }
  startStep(rec);

  // 1. Build hardened schema from suggestion
  const raw = JSON.parse(fs.readFileSync(suggestion, 'utf-8')) as {
    properties: Array<Record<string, unknown>>;
  };
  const schema = hardenSchema(raw.properties);

  // 2. Validate schema invariants
  const issues = validateSchema(schema);

  // 3. Validate a sample of items against the schema
  const sampleIssues = await validateItemSample(itemsJsonl, schema, 200);
  issues.push(...sampleIssues);

  // 4. Write artifacts
  const schemaJsonPath = path.join(stepDir, 'connector-schema.json');
  fs.writeFileSync(schemaJsonPath, JSON.stringify(schema, null, 2), 'utf-8');
  const schemaTsPath = path.join(stepDir, 'schema.ts');
  fs.writeFileSync(schemaTsPath, schemaToTypeScript(schema), 'utf-8');
  const validationPath = path.join(stepDir, 'schema-validation.json');
  const blocking = issues.filter((i) => i.severity === 'error');
  fs.writeFileSync(validationPath, JSON.stringify({ issues, blockingCount: blocking.length }, null, 2), 'utf-8');

  rec.outputs = {
    '03-schema/connector-schema.json': fileHash(schemaJsonPath),
    '03-schema/schema.ts': fileHash(schemaTsPath),
    '03-schema/schema-validation.json': fileHash(validationPath),
  };
  rec.artifacts = [schemaJsonPath, schemaTsPath, validationPath];
  rec.diagnostics = issues.map((i) => `[${i.severity}] ${i.message}`);

  if (blocking.length > 0) {
    finishStep(rec, 'failed', `schema validation failed: ${blocking.length} blocking issues`);
  } else {
    finishStep(rec, 'done');
  }
  writeStepStatus(stepDir, rec);
  return rec;
}

interface ValidationIssue { severity: 'error' | 'warning'; message: string }

/**
 * Microsoft Graph connector reserved property names that cannot be declared as
 * custom schema properties. `content` is owned by Graph as the item's full-text
 * content field, so an enhancer that emits a `content` column must not have it
 * promoted into the schema (it would fail Graph schema registration).
 */
const RESERVED_PROPERTY_NAMES = new Set<string>(['content']);

function hardenSchema(suggestionProps: Array<Record<string, unknown>>): GraphConnectorSchema {
  const namesSeen = new Set<string>();
  const labelsSeen = new Set<string>();
  const out: GraphProperty[] = [];
  for (const p of suggestionProps) {
    const name = sanitizeName(String(p.name || ''));
    if (!name || namesSeen.has(name)) continue;
    // Drop Graph-reserved names (e.g. 'content') so the generated schema stays
    // valid even when the upstream enhancer suggests a reserved column. The
    // data is still surfaced via the item's content field, not a schema prop.
    if (RESERVED_PROPERTY_NAMES.has(name.toLowerCase())) continue;
    namesSeen.add(name);
    const type = coerceType(String(p.type || 'String'));
    const isQueryable = bool(p.isQueryable, true);
    const isRetrievable = bool(p.isRetrievable, true);
    // searchable + refinable are mutually exclusive — prefer searchable for String unless explicit refinable.
    // Graph also rejects isExactMatchRequired on a searchable property — if both are requested,
    // drop isSearchable (an exact-match column is rarely useful as full-text search).
    const wantsRefinable = bool(p.isRefinable, false);
    let isSearchable = bool(p.isSearchable, type === 'String');
    if (p.isExactMatchRequired && isSearchable) isSearchable = false;
    const finalRefinable = wantsRefinable && !isSearchable;
    const prop: GraphProperty = { name, type, isSearchable, isQueryable, isRetrievable };
    if (finalRefinable) prop.isRefinable = true;
    if (p.isExactMatchRequired) prop.isExactMatchRequired = true;
    // Semantic labels - take from suggestion.semanticLabel string or labels array
    const labels = collectLabels(p, name);
    for (const l of labels) {
      if (!labelsSeen.has(l)) {
        labelsSeen.add(l);
        prop.labels = (prop.labels || []).concat(l);
      }
    }
    if (prop.labels && !prop.isRetrievable) prop.isRetrievable = true;
    // Collect property aliases for KQL query assistance and data mapping
    const aliases = collectAliases(p);
    if (aliases.length > 0) prop.aliases = aliases;
    if (out.length < 128) out.push(prop);
  }
  // Ensure mandatory title + url labels are present
  ensureLabel(out, 'title', 'title');
  ensureLabel(out, 'url', 'url');
  // Soft-promote iconUrl if a matching property exists (not auto-injected like title/url)
  softEnsureIconUrl(out);
  // Final enforcement: ensureLabel may have unshifted title/url to the front,
  // pushing total beyond Graph's 128 cap. Trim from the END so the labeled
  // title/url stay registered. The tail rows are typically the lowest-priority
  // source columns that were appended last by identity-transform.
  if (out.length > 128) out.length = 128;
  return { baseType: 'microsoft.graph.externalItem', properties: out };
}

function sanitizeName(raw: string): string {
  // Graph property names: ALPHANUMERIC only, must start with a letter, max 32 chars.
  // Convert snake_case / kebab-case / dot.case to camelCase so identifiers stay readable.
  let s = raw.replace(/[^A-Za-z0-9]+([A-Za-z0-9]?)/g, (_match, next: string) =>
    next ? next.toUpperCase() : '',
  );
  if (!/^[A-Za-z]/.test(s)) s = `p${s}`;
  return s.slice(0, 32);
}

function coerceType(raw: string): GraphProperty['type'] {
  const v = raw.toLowerCase();
  if (v.startsWith('int')) return 'Int64';
  if (v === 'double' || v === 'number' || v === 'float') return 'Double';
  if (v === 'datetime' || v === 'date') return 'DateTime';
  if (v === 'boolean' || v === 'bool') return 'Boolean';
  if (v === 'stringcollection' || v === 'string[]') return 'StringCollection';
  return 'String';
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

function collectLabels(p: Record<string, unknown>, propName: string): string[] {
  const out: string[] = [];
  const single = p.semanticLabel || p.label;
  if (typeof single === 'string' && single) out.push(single);
  if (Array.isArray(p.labels)) for (const l of p.labels) if (typeof l === 'string') out.push(l);
  // Auto-promote some property names to semantic labels
  if (propName === 'title' && !out.includes('title')) out.push('title');
  if (propName === 'url' && !out.includes('url')) out.push('url');
  return out;
}

function collectAliases(p: Record<string, unknown>): string[] {
  const out: string[] = [];
  const addAlias = (value: string): void => {
    if (!/^[A-Za-z][A-Za-z0-9]{0,31}$/.test(value)) return;
    if (!out.includes(value)) out.push(value);
  };
  if (Array.isArray(p.aliases)) {
    for (const a of p.aliases) if (typeof a === 'string' && a) addAlias(a);
  } else if (typeof p.aliases === 'string' && p.aliases) {
    for (const a of p.aliases.split(',').map((s) => s.trim()).filter(Boolean)) {
      addAlias(a);
    }
  }
  // Also check 'alternateNames' which some enhancer versions produce
  if (Array.isArray(p.alternateNames)) {
    for (const a of p.alternateNames) if (typeof a === 'string' && a) addAlias(a);
  }
  return out;
}

function ensureLabel(props: GraphProperty[], propName: string, label: string): void {
  const existing = props.find((p) => p.labels?.includes(label));
  if (existing) return;
  const namedProp = props.find((p) => p.name === propName);
  if (namedProp) {
    namedProp.labels = (namedProp.labels || []).concat(label);
    namedProp.isRetrievable = true;
  } else {
    props.unshift({
      name: propName,
      type: 'String',
      isSearchable: label === 'title',
      isQueryable: true,
      isRetrievable: true,
      labels: [label],
    });
  }
}

/** Promote iconUrl label on a matching property if one exists (never auto-injects). */
function softEnsureIconUrl(props: GraphProperty[]): void {
  if (props.find((p) => p.labels?.includes('iconUrl'))) return;
  const candidate = props.find((p) => p.name === 'iconUrl' || p.name === 'icon_url' || p.name === 'iconurl');
  if (candidate) {
    candidate.labels = (candidate.labels || []).concat('iconUrl');
    candidate.isRetrievable = true;
  }
}

function validateSchema(schema: GraphConnectorSchema): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (schema.properties.length > 128) {
    issues.push({ severity: 'error', message: `>128 properties (${schema.properties.length})` });
  }
  for (const p of schema.properties) {
    if (p.isSearchable && p.isRefinable) {
      issues.push({ severity: 'error', message: `property '${p.name}' has both searchable and refinable (mutually exclusive)` });
    }
    if (p.labels && !p.isRetrievable) {
      issues.push({ severity: 'error', message: `property '${p.name}' has labels but is not retrievable` });
    }
    if (!/^[A-Za-z][A-Za-z0-9]{0,31}$/.test(p.name)) {
      issues.push({ severity: 'error', message: `property name '${p.name}' invalid (must match ^[A-Za-z][A-Za-z0-9]{0,31}$)` });
    }
    if (p.name.toLowerCase() === 'content') {
      issues.push({ severity: 'error', message: `'content' is a reserved property; do not declare it in the schema` });
    }
    for (const alias of p.aliases || []) {
      if (!/^[A-Za-z][A-Za-z0-9]{0,31}$/.test(alias)) {
        issues.push({ severity: 'error', message: `property '${p.name}' alias '${alias}' invalid (must match ^[A-Za-z][A-Za-z0-9]{0,31}$)` });
      }
    }
  }
  // Label uniqueness
  const labelCounts = new Map<string, number>();
  for (const p of schema.properties) {
    for (const l of p.labels || []) labelCounts.set(l, (labelCounts.get(l) || 0) + 1);
  }
  for (const [l, n] of labelCounts) {
    if (n > 1) issues.push({ severity: 'error', message: `label '${l}' assigned to ${n} properties (must be exactly one)` });
  }
  if (!labelCounts.has('title')) issues.push({ severity: 'error', message: `no property has the 'title' semantic label` });
  if (!labelCounts.has('url')) issues.push({ severity: 'error', message: `no property has the 'url' semantic label` });
  if (!labelCounts.has('iconUrl')) issues.push({ severity: 'warning', message: `no property has the 'iconUrl' semantic label — add an iconUrl property to improve search result appearance` });
  return issues;
}

const MAX_ITEM_BYTES = 4 * 1024 * 1024;

async function validateItemSample(jsonlPath: string, schema: GraphConnectorSchema, sampleSize: number): Promise<ValidationIssue[]> {
  const propByName = new Map(schema.properties.map((p) => [p.name, p] as const));
  const issues: ValidationIssue[] = [];
  const lines = readJsonlSample(jsonlPath, sampleSize);
  let lineNo = 0;
  for (const line of lines) {
    lineNo++;
    let item: Record<string, unknown>;
    try { item = JSON.parse(line); }
    catch (e) {
      issues.push({ severity: 'error', message: `line ${lineNo}: not valid JSON` });
      continue;
    }
    if (!item.id || typeof item.id !== 'string') {
      issues.push({ severity: 'error', message: `line ${lineNo}: missing string 'id'` });
    } else if (!/^[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=-]+$/.test(item.id)) {
      issues.push({ severity: 'warning', message: `line ${lineNo}: id '${item.id}' may not be URL-safe` });
    }
    const size = Buffer.byteLength(line, 'utf-8');
    if (size > MAX_ITEM_BYTES) {
      issues.push({ severity: 'error', message: `line ${lineNo}: item exceeds 4MB (${size} bytes)` });
    }
    const props = (item.properties || {}) as Record<string, unknown>;
    for (const [k, v] of Object.entries(props)) {
      const schemaProp = propByName.get(sanitizeName(k));
      if (!schemaProp) continue; // extra source properties are ignored by Graph
      if (v == null) continue;
      if (!matchesType(v, schemaProp.type)) {
        issues.push({ severity: 'warning', message: `line ${lineNo}: property '${k}' value type does not match schema (${schemaProp.type})` });
      }
    }
  }
  if (lines.length === 0) issues.push({ severity: 'error', message: 'enhanced-items.jsonl is empty' });
  return dedupeIssues(issues);
}

function readJsonlSample(jsonlPath: string, sampleSize: number): string[] {
  const fd = fs.openSync(jsonlPath, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const lines: string[] = [];
  let carry = '';
  try {
    while (lines.length < sampleSize) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      const text = carry + buffer.subarray(0, bytesRead).toString('utf-8');
      const parts = text.split(/\r?\n/);
      carry = parts.pop() || '';
      for (const part of parts) {
        if (part.trim()) lines.push(part);
        if (lines.length >= sampleSize) break;
      }
    }
    if (lines.length < sampleSize && carry.trim()) lines.push(carry);
  } finally {
    fs.closeSync(fd);
  }
  return lines;
}

function matchesType(v: unknown, t: GraphProperty['type']): boolean {
  if (t === 'String') return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
  if (t === 'Int64') return typeof v === 'number' && Number.isFinite(v) && Math.floor(v) === v;
  if (t === 'Double') return typeof v === 'number' && Number.isFinite(v);
  if (t === 'Boolean') return typeof v === 'boolean';
  if (t === 'DateTime') return typeof v === 'string' && !Number.isNaN(Date.parse(v));
  if (t === 'StringCollection') return Array.isArray(v) && v.every((x) => typeof x === 'string');
  return true;
}

function dedupeIssues(issues: ValidationIssue[]): ValidationIssue[] {
  const seen = new Set<string>();
  const out: ValidationIssue[] = [];
  for (const i of issues) {
    const key = i.severity + '|' + i.message.replace(/line \d+/, 'line *');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(i);
  }
  return out;
}

function schemaToTypeScript(schema: GraphConnectorSchema): string {
  return `// Generated by CopilotConnectorWorkflow step 3. Do not edit by hand.\n` +
    `// Schema includes property aliases for data mapping and KQL query assistance.\n` +
    `export const connectorSchema = ${JSON.stringify(schema, null, 2)} as const;\n` +
    `export type ConnectorSchema = typeof connectorSchema;\n`;
}

// ---------------------------------------------------------------------------
// Test-only exports — allow unit tests to exercise internal functions
// without making them part of the public module API.
// ---------------------------------------------------------------------------
export const _test = {
  hardenSchema,
  validateSchema,
  collectAliases,
  softEnsureIconUrl,
  schemaToTypeScript,
};
