/**
 * Identity-but-shape-aware transform for the `--no-enhance` Step 2 branch.
 *
 * Selected automatically by the dataset-shape auto-detector for text-rich
 * single-schema datasets (see src/dataset-shape-detect.ts), or explicitly
 * via `--no-enhance` on the CLI.
 *
 *  - Walks the source rows once to infer field types and the column list.
 *  - Sanitizes column names to Graph-valid schema property names.
 *  - Default any CSV/TSV column to String unless every non-empty row parses as
 *    numeric or DateTime *and* the column name does not match preserve heuristics.
 *  - Auto-injects `title` / `url` / `iconUrl` semantic labels with deterministic
 *    fallbacks when no source column matches.
 *  - Flattens nested JSON deterministically (no semantic enrichment).
 *  - Emits one external item per source record whose `properties` use the
 *    sanitized schema names; raw column names live in `sourceFieldMappings`.
 *  - Records provenance flags so the comparator can attribute deltas.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

export type AclMode = 'everyone' | 'everyoneExceptGuests' | 'none';

export interface IdentityTransformOptions {
  /** Dataset path (folder or single file). */
  dataset: string;
  /** Output folder; receives enhanced-items.jsonl, schema-suggestion.json, and a report. */
  outputDir: string;
  /** ACL mode for emitted items. */
  aclMode: AclMode;
  /** Optional file-extension filter. */
  extensions?: string[];
  /** Optional URL prefix for derived item URLs. */
  urlPrefix?: string;
}

export interface IdentityTransformResult {
  itemCount: number;
  schemaPropertyCount: number;
  schemaSuggestionPath: string;
  itemsJsonlPath: string;
  metadataProvenance: MetadataProvenance;
}

export interface MetadataProvenance {
  /** Fraction of items whose `title` came from a source column (0..1). */
  titleFromSource: number;
  /** Fraction of items whose `url` came from a source column (0..1). */
  urlFromSource: number;
  /** Fraction of items whose `iconUrl` came from a source column (0..1). */
  iconUrlFromSource: number;
  /** Number of schema properties marked searchable. */
  schemaPropertiesPromotedToSearchable: number;
  /** Number of schema properties marked refinable. */
  schemaPropertiesPromotedToRefinable: number;
}

interface SchemaProperty {
  name: string;
  type: 'String' | 'Int64' | 'Double' | 'DateTime' | 'Boolean';
  isSearchable?: boolean;
  isQueryable?: boolean;
  isRetrievable?: boolean;
  isRefinable?: boolean;
  isExactMatchRequired?: boolean;
  labels?: string[];
}

interface SourceFieldMapping {
  sourceField: string;
  schemaProperty: string;
}

interface SchemaSuggestion {
  baseType: string;
  properties: SchemaProperty[];
  sourceFieldMappings: SourceFieldMapping[];
  notes: string[];
}

interface ExternalItem {
  id: string;
  acl: Array<{ accessType: 'grant'; type: AclMode; value: AclMode }>;
  properties: Record<string, unknown>;
  content: { type: 'text'; value: string };
}

interface SourceRecord {
  flat: Record<string, unknown>;
  sourceFile: string;
  sourceRow: number;
}

const SUPPORTED_EXTENSIONS = new Set(['csv', 'tsv', 'json', 'jsonl']);

/** Column-name suffixes / names that force-preserve as String. */
const PRESERVE_STRING_NAME_PATTERNS: RegExp[] = [
  // suffixes
  /(^|[._])id$/i,
  /(^|[._])code$/i,
  /(^|[._])key$/i,
  /(^|[._])no$/i,
  /(^|[._])num$/i,
  /(^|[._])iso$/i,
  /(^|[._])zip$/i,
  /(^|[._])postal$/i,
  /(^|[._])phone$/i,
  /(^|[._])fax$/i,
  /(^|[._])npi$/i,
  /(^|[._])duns$/i,
  /(^|[._])taxonomy$/i,
  /(^|[._])account$/i,
];
const PRESERVE_STRING_EXACT = new Set([
  'year', 'month', 'quarter', 'period', 'fiscal_year', 'fiscalyear', 'week',
  'date', 'time', 'timestamp',
]);

const TITLE_SOURCE_CANDIDATES = ['title', 'name', 'headline', 'subject', 'displayname', 'primaryname'];
const URL_SOURCE_CANDIDATES = ['url', 'link', 'permalink', 'sourceurl', 'canonicalurl'];
const ICON_SOURCE_CANDIDATES = ['iconurl', 'icon', 'image', 'imageurl', 'thumbnail', 'thumbnailurl'];

const DEFAULT_ICON_URL = 'https://res.cdn.office.net/assets/mail/file-icon/png/generic_16x16.png';

const SAFE_MAX_INT = Number.MAX_SAFE_INTEGER;
const SAFE_MIN_INT = Number.MIN_SAFE_INTEGER;

export async function runIdentityTransform(options: IdentityTransformOptions): Promise<IdentityTransformResult> {
  const datasetAbs = path.resolve(options.dataset);
  if (!fs.existsSync(datasetAbs)) throw new Error(`dataset not found: ${datasetAbs}`);
  fs.mkdirSync(options.outputDir, { recursive: true });

  const files = discoverSourceFiles(datasetAbs, options.extensions);
  if (files.length === 0) {
    throw new Error(`no supported source files under ${datasetAbs} (need: ${[...SUPPORTED_EXTENSIONS].join(', ')})`);
  }

  // Pass 1: collect every flattened record and observe each column's value samples.
  const records: SourceRecord[] = [];
  const columnSamples = new Map<string, ColumnSamples>();
  for (const file of files) {
    for await (const record of readSourceRecords(file, datasetAbs)) {
      records.push(record);
      observeColumns(columnSamples, record.flat);
      if (records.length > 500_000) {
        // Defensive cap: identity transform is meant for tabular datasets.
        // The plan does not specify a row cap, but a 500k cap protects memory.
        break;
      }
    }
  }
  if (records.length === 0) {
    throw new Error('no records found in dataset');
  }

  // Build sanitized schema property names + types from observed columns.
  const sourceColumns = [...columnSamples.keys()];
  const sanitization = buildSanitizedNames(sourceColumns);
  const properties: SchemaProperty[] = [];
  const sanitizedToType = new Map<string, SchemaProperty['type']>();
  for (const sourceCol of sourceColumns) {
    const samples = columnSamples.get(sourceCol)!;
    const inferredType = inferType(sourceCol, samples);
    const schemaName = sanitization.get(sourceCol)!;
    sanitizedToType.set(schemaName, inferredType);
    const isText = inferredType === 'String';
    const wantsExactMatch = !!isExactMatchHint(sourceCol);
    // Graph rejects isExactMatchRequired on a searchable property. When the
    // source column looks like an id/code/key, prefer exact-match over
    // searchable (full-text search on identifiers is rarely useful anyway).
    const isSearchable = isText && !wantsExactMatch;
    properties.push({
      name: schemaName,
      type: inferredType,
      isSearchable,
      isQueryable: true,
      isRetrievable: true,
      isExactMatchRequired: wantsExactMatch ? true : undefined,
    });
  }

  // Auto-inject title / url / iconUrl semantic labels.
  const titlePromotion = promoteOrInjectLabel(properties, sourceColumns, sanitization, 'title', TITLE_SOURCE_CANDIDATES);
  const urlPromotion = promoteOrInjectLabel(properties, sourceColumns, sanitization, 'url', URL_SOURCE_CANDIDATES);
  const iconPromotion = promoteOrInjectLabel(properties, sourceColumns, sanitization, 'iconUrl', ICON_SOURCE_CANDIDATES);

  // Pass 2: emit items.
  const itemsPath = path.join(options.outputDir, 'enhanced-items.jsonl');
  const fd = fs.openSync(itemsPath, 'w');
  let itemCount = 0;
  let itemsWithSourceTitle = 0;
  let itemsWithSourceUrl = 0;
  let itemsWithSourceIcon = 0;
  try {
    for (const record of records) {
      const item = buildItem(
        record,
        properties,
        sanitization,
        sanitizedToType,
        options.aclMode,
        options.urlPrefix,
        titlePromotion,
        urlPromotion,
        iconPromotion,
      );
      if (item.titleFromSource) itemsWithSourceTitle++;
      if (item.urlFromSource) itemsWithSourceUrl++;
      if (item.iconUrlFromSource) itemsWithSourceIcon++;
      fs.writeSync(fd, `${JSON.stringify(item.item)}\n`);
      itemCount++;
    }
  } finally {
    fs.closeSync(fd);
  }

  const sourceFieldMappings: SourceFieldMapping[] = sourceColumns.map((sourceCol) => ({
    sourceField: sourceCol,
    schemaProperty: sanitization.get(sourceCol)!,
  }));

  const schemaSuggestion: SchemaSuggestion = {
    baseType: 'microsoft.graph.externalItem',
    properties,
    sourceFieldMappings,
    notes: [
      'Generated by the --no-enhance identity transform (no enrichment).',
      `Source files: ${files.length}`,
      `Source records: ${itemCount}`,
    ],
  };
  const schemaPath = path.join(options.outputDir, 'schema-suggestion.json');
  fs.writeFileSync(schemaPath, `${JSON.stringify(schemaSuggestion, null, 2)}\n`, 'utf-8');

  const provenance: MetadataProvenance = {
    titleFromSource: round3(itemsWithSourceTitle / Math.max(itemCount, 1)),
    urlFromSource: round3(itemsWithSourceUrl / Math.max(itemCount, 1)),
    iconUrlFromSource: round3(itemsWithSourceIcon / Math.max(itemCount, 1)),
    schemaPropertiesPromotedToSearchable: properties.filter((p) => p.isSearchable).length,
    schemaPropertiesPromotedToRefinable: properties.filter((p) => p.isRefinable).length,
  };

  // Write a short identity-transform report so downstream Step 6 can pull metadataProvenance.
  fs.writeFileSync(
    path.join(options.outputDir, 'identity-transform-report.json'),
    `${JSON.stringify({
      itemCount,
      schemaPropertyCount: properties.length,
      filesProcessed: files.length,
      metadataProvenance: provenance,
      collisions: sanitization.collisions,
    }, null, 2)}\n`,
    'utf-8',
  );

  return {
    itemCount,
    schemaPropertyCount: properties.length,
    schemaSuggestionPath: schemaPath,
    itemsJsonlPath: itemsPath,
    metadataProvenance: provenance,
  };
}

/* -------------------------------------------------------------------------- */
/* Source file discovery + reading                                            */
/* -------------------------------------------------------------------------- */

function discoverSourceFiles(datasetPath: string, extensions?: string[]): string[] {
  const filterRaw = extensions && extensions.length > 0
    ? new Set(extensions.map(normalizeExt).filter((e) => SUPPORTED_EXTENSIONS.has(e)))
    : SUPPORTED_EXTENSIONS;
  const out: string[] = [];
  const stat = fs.statSync(datasetPath);
  if (stat.isFile()) {
    if (filterRaw.has(normalizeExt(path.extname(datasetPath)))) out.push(datasetPath);
  } else {
    walkDir(datasetPath, '', filterRaw, out);
  }
  out.sort();
  return out;
}

function walkDir(root: string, rel: string, filter: Set<string>, out: string[]): void {
  const here = path.join(root, rel);
  for (const name of fs.readdirSync(here).sort()) {
    if (name.startsWith('_')) continue;
    if (['evalset', 'workspace', 'node_modules', '.git'].includes(name.toLowerCase())) continue;
    const childRel = rel ? `${rel}/${name}` : name;
    const childAbs = path.join(here, name);
    const stat = fs.statSync(childAbs);
    if (stat.isDirectory()) walkDir(root, childRel, filter, out);
    else if (stat.isFile() && filter.has(normalizeExt(path.extname(name)))) out.push(childAbs);
  }
}

async function* readSourceRecords(file: string, datasetRoot: string): AsyncIterable<SourceRecord> {
  const ext = normalizeExt(path.extname(file));
  const stat = fs.statSync(datasetRoot);
  const relativeSource = stat.isFile() ? path.basename(file) : path.relative(datasetRoot, file).replace(/\\/g, '/');
  if (ext === 'csv' || ext === 'tsv') {
    const rows = parseDelimitedFile(file, ext === 'tsv' ? '\t' : ',');
    const header = rows[0] || [];
    for (let i = 1; i < rows.length; i++) {
      const record: Record<string, unknown> = {};
      for (let c = 0; c < header.length; c++) {
        const key = header[c] || `column_${c + 1}`;
        record[key] = rows[i]?.[c] ?? '';
      }
      yield { flat: flatten(record), sourceFile: relativeSource, sourceRow: i };
    }
  } else if (ext === 'json') {
    const content = stripBom(fs.readFileSync(file, 'utf-8'));
    try {
      const parsed = JSON.parse(content) as unknown;
      const records = Array.isArray(parsed) ? parsed : [parsed];
      for (let i = 0; i < records.length; i++) {
        const obj = asObject(records[i]);
        if (Object.keys(obj).length === 0) continue;
        yield { flat: flatten(obj), sourceFile: relativeSource, sourceRow: i + 1 };
      }
    } catch {
      // JSONL disguised as .json: fall back line-by-line.
      const lines = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      for (let i = 0; i < lines.length; i++) {
        const obj = asObject(JSON.parse(lines[i]));
        yield { flat: flatten(obj), sourceFile: relativeSource, sourceRow: i + 1 };
      }
    }
  } else if (ext === 'jsonl') {
    const input = fs.createReadStream(file, { encoding: 'utf-8' });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    let row = 0;
    for await (const raw of lines) {
      const line = stripBom(raw).trim();
      if (!line) continue;
      row++;
      const obj = asObject(JSON.parse(line));
      yield { flat: flatten(obj), sourceFile: relativeSource, sourceRow: row };
    }
  }
}

function flatten(record: Record<string, unknown>, prefix = '', out: Record<string, unknown> = {}): Record<string, unknown> {
  for (const [rawKey, value] of Object.entries(record)) {
    const key = prefix ? `${prefix}.${rawKey}` : rawKey;
    if (value === null || value === undefined) {
      out[key] = '';
    } else if (Array.isArray(value)) {
      const allScalars = value.every((v) => v === null || typeof v !== 'object');
      if (allScalars) {
        out[key] = value.map(stringifyScalar).filter((s) => s.length > 0).join(', ');
      } else {
        // Array of objects: stringify deterministically as compact JSON.
        out[key] = JSON.stringify(value);
      }
    } else if (typeof value === 'object') {
      flatten(value as Record<string, unknown>, key, out);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Type inference                                                             */
/* -------------------------------------------------------------------------- */

interface ColumnSamples {
  total: number;
  nonEmpty: number;
  numericLike: number;
  floatLike: number;
  leadingZero: number;
  outOfSafeInt: number;
  scientific: number;
  dateLike: number;
  booleanLike: number;
}

function observeColumns(map: Map<string, ColumnSamples>, record: Record<string, unknown>): void {
  for (const [key, raw] of Object.entries(record)) {
    let entry = map.get(key);
    if (!entry) {
      entry = { total: 0, nonEmpty: 0, numericLike: 0, floatLike: 0, leadingZero: 0, outOfSafeInt: 0, scientific: 0, dateLike: 0, booleanLike: 0 };
      map.set(key, entry);
    }
    entry.total++;
    const value = stringifyScalar(raw).trim();
    if (!value) continue;
    entry.nonEmpty++;
    if (/^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(value)) {
      entry.numericLike++;
      if (value.includes('.')) entry.floatLike++;
      if (/[eE]/.test(value)) entry.scientific++;
      if (/^0\d/.test(value)) entry.leadingZero++;
      const num = Number(value);
      if (!Number.isFinite(num) || num > SAFE_MAX_INT || num < SAFE_MIN_INT) entry.outOfSafeInt++;
    } else if (/^(true|false)$/i.test(value)) {
      entry.booleanLike++;
    } else if (looksLikeIsoDateTime(value)) {
      entry.dateLike++;
    }
  }
}

function inferType(columnName: string, samples: ColumnSamples): SchemaProperty['type'] {
  // Preserve-as-String heuristics win unconditionally.
  if (matchesPreserveString(columnName)) return 'String';
  if (samples.leadingZero > 0 || samples.outOfSafeInt > 0 || samples.scientific > 0) return 'String';
  if (samples.nonEmpty === 0) return 'String';
  if (samples.numericLike === samples.nonEmpty) {
    return samples.floatLike > 0 ? 'Double' : 'Int64';
  }
  if (samples.dateLike === samples.nonEmpty) return 'DateTime';
  if (samples.booleanLike === samples.nonEmpty) return 'Boolean';
  return 'String';
}

function matchesPreserveString(columnName: string): boolean {
  const lower = columnName.toLowerCase();
  const lastSegment = lower.split('.').pop() || lower;
  if (PRESERVE_STRING_EXACT.has(lastSegment)) return true;
  return PRESERVE_STRING_NAME_PATTERNS.some((re) => re.test(lastSegment));
}

function isExactMatchHint(columnName: string): boolean {
  const lower = columnName.toLowerCase();
  const lastSegment = lower.split('.').pop() || lower;
  return /(^|[._])(id|code|key)$/.test(lastSegment);
}

function looksLikeIsoDateTime(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}([T\s]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(value);
}

/* -------------------------------------------------------------------------- */
/* Name sanitization                                                          */
/* -------------------------------------------------------------------------- */

interface SanitizationResult extends Map<string, string> {
  collisions: string[];
}

function buildSanitizedNames(sourceColumns: string[]): SanitizationResult {
  const map = new Map<string, string>() as SanitizationResult;
  map.collisions = [];
  const used = new Set<string>();
  for (const source of sourceColumns) {
    const baseName = sanitizeName(source);
    let candidate = baseName;
    let suffix = 1;
    while (used.has(candidate)) {
      // Graph doesn't allow underscores, so suffix with a digit only.
      const tail = String(suffix++);
      candidate = `${baseName.slice(0, 32 - tail.length)}${tail}`;
    }
    if (candidate !== baseName) map.collisions.push(`${source} -> ${candidate}`);
    used.add(candidate);
    map.set(source, candidate);
  }
  return map;
}

function sanitizeName(source: string): string {
  // Graph property names: ALPHANUMERIC only, must start with a letter, max 32 chars.
  // Convert snake_case / kebab-case / dot.case to camelCase so identifiers stay readable.
  let cleaned = source.replace(/[^A-Za-z0-9]+([A-Za-z0-9]?)/g, (_match, next: string) =>
    next ? next.toUpperCase() : '',
  );
  if (!cleaned) cleaned = 'col';
  if (!/^[A-Za-z]/.test(cleaned)) cleaned = `p${cleaned}`;
  return cleaned.slice(0, 32);
}

/* -------------------------------------------------------------------------- */
/* Semantic label promotion                                                   */
/* -------------------------------------------------------------------------- */

interface LabelPromotion {
  label: 'title' | 'url' | 'iconUrl';
  /** Schema property whose value should be used at runtime, if any. */
  sourceProperty?: string;
}

function promoteOrInjectLabel(
  properties: SchemaProperty[],
  sourceColumns: string[],
  sanitization: Map<string, string>,
  label: 'title' | 'url' | 'iconUrl',
  candidates: string[],
): LabelPromotion {
  // Find a source column whose sanitized name (or original name) matches a candidate.
  for (const sourceCol of sourceColumns) {
    const lower = sourceCol.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (candidates.includes(lower)) {
      const schemaName = sanitization.get(sourceCol)!;
      ensurePropertyHasLabel(properties, schemaName, label);
      return { label, sourceProperty: schemaName };
    }
  }
  // No source candidate: inject a stand-alone property carrying the label.
  const injectedName = label;  // 'title' / 'url' / 'iconUrl' are all Graph-safe names.
  if (!properties.find((p) => p.name === injectedName)) {
    properties.push({
      name: injectedName,
      type: 'String',
      isSearchable: label === 'title',
      isQueryable: true,
      isRetrievable: true,
      labels: [label],
    });
  } else {
    ensurePropertyHasLabel(properties, injectedName, label);
  }
  return { label };
}

function ensurePropertyHasLabel(properties: SchemaProperty[], schemaName: string, label: string): void {
  const prop = properties.find((p) => p.name === schemaName);
  if (!prop) return;
  prop.labels = prop.labels || [];
  if (!prop.labels.includes(label)) prop.labels.push(label);
  prop.isRetrievable = true;
}

/* -------------------------------------------------------------------------- */
/* Item construction                                                          */
/* -------------------------------------------------------------------------- */

function buildItem(
  record: SourceRecord,
  properties: SchemaProperty[],
  sanitization: Map<string, string>,
  sanitizedToType: Map<string, SchemaProperty['type']>,
  aclMode: AclMode,
  urlPrefix: string | undefined,
  titlePromotion: LabelPromotion,
  urlPromotion: LabelPromotion,
  iconPromotion: LabelPromotion,
): { item: ExternalItem; titleFromSource: boolean; urlFromSource: boolean; iconUrlFromSource: boolean } {
  const props: Record<string, unknown> = {};
  for (const [sourceCol, value] of Object.entries(record.flat)) {
    const schemaName = sanitization.get(sourceCol);
    if (!schemaName) continue;
    const propType = sanitizedToType.get(schemaName) || 'String';
    const coerced = coerceForSchema(value, propType);
    if (coerced !== undefined) props[schemaName] = coerced;
  }

  // Title.
  let titleFromSource = false;
  if (titlePromotion.sourceProperty && props[titlePromotion.sourceProperty]) {
    props.title = props.title ?? props[titlePromotion.sourceProperty];
    titleFromSource = true;
  } else {
    props.title = `${record.sourceFile} row ${record.sourceRow}`;
  }

  // URL.
  let urlFromSource = false;
  if (urlPromotion.sourceProperty && props[urlPromotion.sourceProperty]) {
    props.url = props.url ?? props[urlPromotion.sourceProperty];
    urlFromSource = true;
  } else if (urlPrefix) {
    props.url = `${urlPrefix.replace(/\/$/, '')}/${encodeURIComponent(record.sourceFile)}#row-${record.sourceRow}`;
  } else {
    props.url = `file:///raw/${record.sourceFile}#row-${record.sourceRow}`;
  }

  // IconUrl.
  let iconUrlFromSource = false;
  if (iconPromotion.sourceProperty && props[iconPromotion.sourceProperty]) {
    props.iconUrl = props.iconUrl ?? props[iconPromotion.sourceProperty];
    iconUrlFromSource = true;
  } else {
    props.iconUrl = DEFAULT_ICON_URL;
  }

  // Item id is deterministic over (sourceFile, sourceRow, sanitized properties JSON).
  const idMaterial = `${record.sourceFile}\u001f${record.sourceRow}\u001f${JSON.stringify(record.flat)}`;
  const id = crypto.createHash('sha256').update(idMaterial, 'utf-8').digest('hex').slice(0, 32);

  const contentLines = Object.entries(record.flat).map(([k, v]) => `${k}: ${stringifyScalar(v)}`);
  let content = contentLines.join('\n');
  // Cap content.value to stay well under the Graph external-item request body
  // limit (~4 KB observed for `Expected ',' or '}'` server-side parse failures
  // on wide rows). 4000 chars is conservative; truncated rows still carry the
  // first few dozen labeled fields, which is what the connector needs for
  // grounded retrieval. `properties` carry the typed values regardless.
  const MAX_CONTENT_CHARS = 4000;
  if (content.length > MAX_CONTENT_CHARS) {
    content = `${content.slice(0, MAX_CONTENT_CHARS)}\n…(truncated; ${content.length - MAX_CONTENT_CHARS} chars elided)`;
  }

  const acl = aclMode === 'none'
    ? []
    : [{ accessType: 'grant' as const, type: aclMode, value: aclMode }];

  return {
    item: { id, acl, properties: props, content: { type: 'text', value: content } },
    titleFromSource,
    urlFromSource,
    iconUrlFromSource,
  };
}

function coerceForSchema(raw: unknown, schemaType: SchemaProperty['type']): unknown {
  const text = stringifyScalar(raw).trim();
  if (!text) return undefined;
  switch (schemaType) {
    case 'Int64': {
      const n = Number(text);
      return Number.isFinite(n) ? Math.trunc(n) : text;
    }
    case 'Double': {
      const n = Number(text);
      return Number.isFinite(n) ? n : text;
    }
    case 'Boolean':
      if (/^true$/i.test(text)) return true;
      if (/^false$/i.test(text)) return false;
      return text;
    case 'DateTime':
      return text;
    case 'String':
    default:
      return text;
  }
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

function asObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  return { value };
}

function stringifyScalar(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function parseDelimitedFile(file: string, delimiter: string): string[][] {
  const text = stripBom(fs.readFileSync(file, 'utf-8'));
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (inQuotes && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === delimiter && !inQuotes) {
      row.push(cell);
      cell = '';
    } else if ((ch === '\n' || ch === '\r') && !inQuotes) {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((value) => value.trim()));
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function normalizeExt(value: string): string {
  return value.toLowerCase().replace(/^\./, '');
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
