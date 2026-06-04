/**
 * Dataset shape detector — decides whether a dataset is "text-rich
 * already-structured" (single schema with prose fields) and so should skip
 * the enhancer in favor of the identity-but-shape-aware transform.
 *
 * Rationale (from the 3-dataset comparative study in
 * workspace/compare-runs/cross-dataset-analysis-rerun.md):
 *  - Mixed-schema datasets (e.g. ngo-agriculture: CSV + JSON) →
 *    enhancer wins ~10pp because schema unification helps the LLM ground.
 *  - Single-schema text-rich datasets (e.g. hls-clinicaltrials JSONL) →
 *    identity transform wins ~8pp because verbatim field tokens (entity
 *    names, IDs) help the LLM ground; the enhancer's narrative
 *    reformulation actively loses those tokens.
 *  - Single-schema numeric/short-string datasets (e.g. ngo-energy OWID) →
 *    tie within judge noise.
 *
 * This module classifies the dataset into one of:
 *  - 'identity'   → text-rich AND single-schema; recommend `noEnhance=true`
 *  - 'enhance'    → mixed-schema OR numeric-only; recommend enhancer
 *  - 'tie'        → borderline / low-confidence; recommend enhancer
 *                   (no auto-flip) because that has historically been
 *                   the default behavior in the workflow.
 *
 * The classifier is conservative: it only returns 'identity' when both
 * the dominant-schema share and the text-richness signals are strong.
 * For any borderline case the recommendation is 'tie' so we don't
 * silently change behavior for ambiguous datasets.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface DatasetShapeDetection {
  recommendation: 'identity' | 'enhance' | 'tie';
  recordsSampled: number;
  filesScanned: number;
  distinctSchemas: number;
  dominantSchema: string[];
  dominantSchemaShare: number;
  textRichFields: TextRichField[];
  /** Human-readable explanation suitable for diagnostic logs. */
  reason: string;
}

export interface TextRichField {
  field: string;
  proseShare: number;
  averageLength: number;
  sampleValue: string;
}

interface SampleRecord {
  fields: string[];
  fieldSchemaKey: string;
  values: Record<string, unknown>;
  sourceFile: string;
}

/* -------------------------------------------------------------------------- */
/* Tunable thresholds                                                         */
/* -------------------------------------------------------------------------- */

// Per-file quota when sampling many files. Keeps detection bounded but
// guarantees we observe every file's shape.
const MAX_RECORDS_PER_FILE = 100;

// Hard cap across the whole dataset so we don't blow memory on a 100M-row
// table; the goal is shape detection, not statistical inference.
const MAX_RECORDS_TOTAL = 1000;

// Minimum dominant-schema share to consider the dataset "effectively
// single-schema". Below this we recommend 'enhance' (the enhancer's
// schema unification is the whole point on multi-shape sources).
const DOMINANT_SCHEMA_MIN_SHARE = 0.9;

// Borderline band: between this and DOMINANT_SCHEMA_MIN_SHARE we return
// 'tie' because the share is too close to call.
const DOMINANT_SCHEMA_BORDERLINE_SHARE = 0.8;

// Per-field prose detection. A field counts as text-rich when this share
// of its non-null values look like natural-language prose.
const PROSE_SHARE_MIN = 0.5;

// A single value counts as prose when it has at least this many chars,
// contains at least one whitespace, has a letter-to-char ratio above
// LETTER_RATIO_MIN, and is not an obvious URL/GUID/JSON blob.
const PROSE_MIN_LENGTH = 80;
const LETTER_RATIO_MIN = 0.5;

// We need at least this many non-null values of a field before we'll
// classify it; a field that's mostly missing isn't useful.
const FIELD_MIN_OBSERVATIONS = 10;

// Patterns excluded from prose classification.
const URL_RE = /^https?:\/\/\S+$/i;
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JSON_BLOB_RE = /^[\s]*[\[{].*[\]}]\s*$/s;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/* -------------------------------------------------------------------------- */
/* Public entry point                                                         */
/* -------------------------------------------------------------------------- */

export function detectDatasetShape(
  datasetPath: string,
  extensions?: string[],
): DatasetShapeDetection {
  const records = collectSampleRecords(datasetPath, extensions);

  if (records.length === 0) {
    return {
      recommendation: 'enhance',
      recordsSampled: 0,
      filesScanned: 0,
      distinctSchemas: 0,
      dominantSchema: [],
      dominantSchemaShare: 0,
      textRichFields: [],
      reason: 'no parseable records found; keeping enhancer default',
    };
  }

  const filesScanned = new Set(records.map((r) => r.sourceFile)).size;
  const { dominantSchema, dominantSchemaShare, distinctSchemas } = pickDominantSchema(records);
  const dominantRecords = records.filter((r) => r.fieldSchemaKey === dominantSchema.join('\u0000'));
  const textRichFields = pickTextRichFields(dominantRecords, dominantSchema);

  const reason = explainDecision({
    distinctSchemas,
    dominantSchemaShare,
    dominantSchema,
    textRichFields,
    recordsSampled: records.length,
  });

  let recommendation: 'identity' | 'enhance' | 'tie';
  if (dominantSchemaShare < DOMINANT_SCHEMA_BORDERLINE_SHARE) {
    // Multi-shape dataset: enhancer's schema-unification is its big win.
    recommendation = 'enhance';
  } else if (dominantSchemaShare < DOMINANT_SCHEMA_MIN_SHARE) {
    recommendation = 'tie';
  } else if (textRichFields.length === 0) {
    // Single-schema but no prose fields → e.g. pure numeric tabular.
    // Study showed this is a tie; keep enhancer as the conservative default.
    recommendation = 'tie';
  } else {
    recommendation = 'identity';
  }

  return {
    recommendation,
    recordsSampled: records.length,
    filesScanned,
    distinctSchemas,
    dominantSchema,
    dominantSchemaShare,
    textRichFields,
    reason,
  };
}

/* -------------------------------------------------------------------------- */
/* Sampling                                                                   */
/* -------------------------------------------------------------------------- */

function collectSampleRecords(datasetPath: string, extensions?: string[]): SampleRecord[] {
  const files = walkDataset(datasetPath, extensions);
  const records: SampleRecord[] = [];

  for (const file of files) {
    if (records.length >= MAX_RECORDS_TOTAL) break;
    const remaining = Math.min(MAX_RECORDS_PER_FILE, MAX_RECORDS_TOTAL - records.length);
    try {
      const fromFile = readRecordsFromFile(file, remaining);
      records.push(...fromFile);
    } catch {
      // Unreadable file — skip it; detection should be best-effort.
    }
  }

  return records;
}

function walkDataset(datasetPath: string, extensions?: string[]): string[] {
  const out: string[] = [];
  const wantedExts = extensions && extensions.length > 0
    ? new Set(extensions.map((e) => e.toLowerCase().replace(/^\./, '')))
    : undefined;

  const stat = fs.statSync(datasetPath);
  if (stat.isFile()) {
    const ext = path.extname(datasetPath).toLowerCase().replace(/^\./, '');
    if (!wantedExts || wantedExts.has(ext)) out.push(datasetPath);
    return out;
  }

  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase().replace(/^\./, '');
        if (!wantedExts || wantedExts.has(ext)) out.push(full);
      }
    }
  };
  walk(datasetPath);
  return out.sort();
}

function readRecordsFromFile(filePath: string, max: number): SampleRecord[] {
  const ext = path.extname(filePath).toLowerCase().replace(/^\./, '');
  const content = fs.readFileSync(filePath, 'utf-8').replace(/^\uFEFF/, '');

  if (ext === 'jsonl' || (ext === 'json' && isJsonLinesShape(content))) {
    return parseJsonl(content, filePath, max);
  }
  if (ext === 'json') {
    return parseJson(content, filePath, max);
  }
  if (ext === 'csv' || ext === 'tsv') {
    return parseTabular(content, filePath, max, ext === 'tsv' ? '\t' : ',');
  }
  // Other file types (md/pdf/docx/etc.) are document-like; we model them
  // as one synthetic record with a single 'content' field — so the
  // detector still works for content-heavy datasets.
  return [{
    fields: ['content'],
    fieldSchemaKey: 'content',
    values: { content: content.slice(0, 2000) },
    sourceFile: filePath,
  }];
}

function isJsonLinesShape(content: string): boolean {
  try {
    JSON.parse(content);
    return false;
  } catch {
    // proceed
  }
  const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return false;
  for (let i = 0; i < Math.min(5, lines.length); i++) {
    try {
      const parsed = JSON.parse(lines[i]);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function parseJsonl(content: string, filePath: string, max: number): SampleRecord[] {
  const out: SampleRecord[] = [];
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    if (out.length >= max) break;
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        out.push(makeRecord(obj as Record<string, unknown>, filePath));
      }
    } catch {
      // skip malformed line
    }
  }
  return out;
}

function parseJson(content: string, filePath: string, max: number): SampleRecord[] {
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { return []; }
  if (Array.isArray(parsed)) {
    return parsed.slice(0, max)
      .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x))
      .map((obj) => makeRecord(obj, filePath));
  }
  if (parsed && typeof parsed === 'object') {
    return [makeRecord(parsed as Record<string, unknown>, filePath)];
  }
  return [];
}

function parseTabular(content: string, filePath: string, max: number, delim: string): SampleRecord[] {
  const lines = content.split(/\r?\n/);
  if (lines.length < 2) return [];
  const header = parseDelimitedLine(lines[0], delim);
  if (header.length === 0) return [];
  const out: SampleRecord[] = [];
  for (let i = 1; i < lines.length && out.length < max; i++) {
    const raw = lines[i];
    if (!raw || !raw.trim()) continue;
    const cells = parseDelimitedLine(raw, delim);
    const obj: Record<string, unknown> = {};
    for (let j = 0; j < header.length; j++) obj[header[j]] = cells[j] ?? '';
    out.push(makeRecord(obj, filePath));
  }
  return out;
}

function parseDelimitedLine(line: string, delim: string): string[] {
  // Minimal CSV/TSV parser: handles quoted fields containing delim/quotes.
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else cur += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === delim) { out.push(cur); cur = ''; }
      else cur += ch;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function makeRecord(obj: Record<string, unknown>, sourceFile: string): SampleRecord {
  const fields = Object.keys(obj).sort();
  return {
    fields,
    fieldSchemaKey: fields.join('\u0000'),
    values: obj,
    sourceFile,
  };
}

/* -------------------------------------------------------------------------- */
/* Schema clustering                                                          */
/* -------------------------------------------------------------------------- */

function pickDominantSchema(records: SampleRecord[]): {
  dominantSchema: string[];
  dominantSchemaShare: number;
  distinctSchemas: number;
} {
  const counts = new Map<string, { fields: string[]; count: number }>();
  for (const r of records) {
    const existing = counts.get(r.fieldSchemaKey);
    if (existing) existing.count++;
    else counts.set(r.fieldSchemaKey, { fields: r.fields, count: 1 });
  }
  let top: { fields: string[]; count: number } | undefined;
  for (const entry of counts.values()) {
    if (!top || entry.count > top.count) top = entry;
  }
  if (!top) {
    return { dominantSchema: [], dominantSchemaShare: 0, distinctSchemas: 0 };
  }
  return {
    dominantSchema: top.fields,
    dominantSchemaShare: top.count / records.length,
    distinctSchemas: counts.size,
  };
}

/* -------------------------------------------------------------------------- */
/* Text-richness                                                              */
/* -------------------------------------------------------------------------- */

function pickTextRichFields(dominantRecords: SampleRecord[], schema: string[]): TextRichField[] {
  const out: TextRichField[] = [];
  for (const field of schema) {
    const values: string[] = [];
    for (const r of dominantRecords) {
      const v = stringifyValue(r.values[field]);
      if (v) values.push(v);
    }
    if (values.length < FIELD_MIN_OBSERVATIONS) continue;

    let proseCount = 0;
    let totalLen = 0;
    let sampleValue = '';
    for (const v of values) {
      totalLen += v.length;
      if (isProseValue(v)) {
        proseCount++;
        if (!sampleValue || v.length > sampleValue.length) sampleValue = v;
      }
    }
    const proseShare = proseCount / values.length;
    const averageLength = totalLen / values.length;
    if (proseShare >= PROSE_SHARE_MIN) {
      out.push({
        field,
        proseShare,
        averageLength,
        sampleValue: sampleValue.length > 120 ? sampleValue.slice(0, 120) + '…' : sampleValue,
      });
    }
  }
  // Strongest signal first.
  return out.sort((a, b) => b.proseShare - a.proseShare);
}

function stringifyValue(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  // Nested object/array: not prose; skip.
  return '';
}

function isProseValue(v: string): boolean {
  if (v.length < PROSE_MIN_LENGTH) return false;
  if (!/\s/.test(v)) return false;
  if (URL_RE.test(v)) return false;
  if (GUID_RE.test(v)) return false;
  if (EMAIL_RE.test(v)) return false;
  if (JSON_BLOB_RE.test(v)) return false;

  // Letter-to-non-whitespace-char ratio (Unicode-aware).
  let letters = 0;
  let totalChars = 0;
  for (const ch of v) {
    if (/\s/.test(ch)) continue;
    totalChars++;
    if (/\p{L}/u.test(ch)) letters++;
  }
  if (totalChars === 0) return false;
  return letters / totalChars >= LETTER_RATIO_MIN;
}

/* -------------------------------------------------------------------------- */
/* Explanation                                                                */
/* -------------------------------------------------------------------------- */

function explainDecision(args: {
  distinctSchemas: number;
  dominantSchemaShare: number;
  dominantSchema: string[];
  textRichFields: TextRichField[];
  recordsSampled: number;
}): string {
  const sharePct = (args.dominantSchemaShare * 100).toFixed(1);
  const parts: string[] = [
    `sampled ${args.recordsSampled} records across ${args.distinctSchemas} distinct schema${args.distinctSchemas === 1 ? '' : 's'}`,
    `dominant schema covers ${sharePct}% (${args.dominantSchema.length} field${args.dominantSchema.length === 1 ? '' : 's'})`,
  ];
  if (args.textRichFields.length === 0) {
    parts.push('no text-rich fields detected');
  } else {
    const fieldList = args.textRichFields
      .slice(0, 3)
      .map((f) => `${f.field} (prose ${(f.proseShare * 100).toFixed(0)}%, avg ${f.averageLength.toFixed(0)} chars)`)
      .join(', ');
    parts.push(`text-rich fields: ${fieldList}`);
  }
  return parts.join('; ');
}

/* -------------------------------------------------------------------------- */
/* Test helpers                                                               */
/* -------------------------------------------------------------------------- */

export const _test = {
  isProseValue,
  pickDominantSchema,
  pickTextRichFields,
  walkDataset,
};
