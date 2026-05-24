import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

export interface EvalSetBuildOptions {
  dataset: string;
  description: string;
  outputDir: string;
  targetCount: number;
  seedDir?: string;
  extensions?: string[];
}

export interface EvalSetBuildResult {
  csv: string;
  json: string;
  review: string;
  itemCount: number;
  seedCount: number;
  generatedCount: number;
}

interface EvalItem {
  id: string;
  prompt: string;
  expected_answer: string;
  source_location: string;
  assertions: Array<{ type: 'must_contain'; value: string; wholeWord?: boolean }>;
  category: string;
  difficulty: string;
  supporting_facts: string[];
  grounding_confidence: 'high' | 'medium' | 'low';
}

interface SourceRecord {
  record: Record<string, unknown>;
  source: string;
  row: number;
}

const SUPPORTED_EXTENSIONS = new Set(['csv', 'tsv', 'json', 'jsonl']);
const TITLE_KEYS = ['title', 'displayName', 'name', 'primaryName', 'country', 'countryName', 'entity', 'condition', 'recordId', 'id'];
const ID_KEYS = ['id', 'recordId', 'nctId', 'trialId', 'studyId', 'code', 'countryiso3code', 'country', 'countryName'];

export async function buildTargetEvalSet(options: EvalSetBuildOptions): Promise<EvalSetBuildResult> {
  fs.mkdirSync(options.outputDir, { recursive: true });
  const seed = readSeed(options.seedDir);
  const items = [...seed.items];
  const existingPrompts = new Set(items.map((item) => normalize(item.prompt)));
  const existingIds = new Set(items.map((item) => item.id));

  for await (const source of sourceRecords(options.dataset, options.extensions)) {
    if (items.length >= options.targetCount) break;
    const generated = evalItemFromRecord(source);
    if (!generated) continue;
    if (existingPrompts.has(normalize(generated.prompt)) || existingIds.has(generated.id)) continue;
    existingPrompts.add(normalize(generated.prompt));
    existingIds.add(generated.id);
    items.push(generated);
  }

  const finalItems = items.slice(0, options.targetCount);
  const csv = path.join(options.outputDir, 'eval.csv');
  const json = path.join(options.outputDir, 'eval.evalgen.json');
  const review = path.join(options.outputDir, 'eval-review.md');
  writeCsv(csv, finalItems);
  writeJson(json, {
    version: '1.0',
    generated_at: new Date().toISOString(),
    description: options.description,
    source_file: sourceDisplay(options.dataset),
    item_count: finalItems.length,
    items: finalItems,
  });
  writeReview(review, finalItems, seed.items.length, options.targetCount);
  return {
    csv,
    json,
    review,
    itemCount: finalItems.length,
    seedCount: seed.items.length,
    generatedCount: Math.max(0, finalItems.length - seed.items.length),
  };
}

function readSeed(seedDir?: string): { items: EvalItem[] } {
  if (!seedDir) return { items: [] };
  const json = firstExisting(path.join(seedDir, 'eval-set.evalgen.json'), path.join(seedDir, 'eval.evalgen.json'));
  if (!json) return { items: [] };
  const parsed = JSON.parse(fs.readFileSync(json, 'utf-8')) as { items?: unknown[] };
  const items = Array.isArray(parsed.items)
    ? parsed.items.map(normalizeSeedItem).filter((item): item is EvalItem => !!item)
    : [];
  return { items };
}

function normalizeSeedItem(value: unknown): EvalItem | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const item = value as Record<string, unknown>;
  const prompt = stringValue(item.prompt);
  const expected = stringValue(item.expected_answer || item.expectedAnswer);
  if (!prompt || !expected) return undefined;
  const assertions = Array.isArray(item.assertions)
    ? item.assertions
      .map((assertion) => assertion && typeof assertion === 'object' ? assertion as Record<string, unknown> : undefined)
      .filter((assertion): assertion is Record<string, unknown> => !!assertion)
      .map((assertion) => ({
        type: 'must_contain' as const,
        value: stringValue(assertion.value),
        wholeWord: assertion.wholeWord === true ? true : undefined,
      }))
      .filter((assertion) => assertion.value)
    : [];
  return {
    id: stringValue(item.id) || stableId(prompt),
    prompt,
    expected_answer: expected,
    source_location: stringValue(item.source_location || item.sourceLocation),
    assertions,
    category: stringValue(item.category) || 'single_record_lookup',
    difficulty: stringValue(item.difficulty) || 'easy',
    supporting_facts: Array.isArray(item.supporting_facts)
      ? item.supporting_facts.map(stringValue).filter(Boolean)
      : Array.isArray(item.supportingFacts)
        ? item.supportingFacts.map(stringValue).filter(Boolean)
        : [],
    grounding_confidence: item.grounding_confidence === 'medium' || item.grounding_confidence === 'low' ? item.grounding_confidence : 'high',
  };
}

async function* sourceRecords(dataset: string, extensions?: string[]): AsyncIterable<SourceRecord> {
  for (const file of discoverFiles(dataset, extensions)) {
    const ext = normalizeExtension(path.extname(file));
    const relative = relativeDatasetPath(dataset, file);
    if (ext === 'csv' || ext === 'tsv') {
      const rows = parseDelimited(fs.readFileSync(file, 'utf-8'), ext === 'tsv' ? '\t' : ',');
      const header = rows[0] || [];
      for (let i = 1; i < rows.length; i++) {
        const record: Record<string, unknown> = {};
        for (let c = 0; c < header.length; c++) record[header[c] || `column_${c + 1}`] = rows[i]?.[c] ?? '';
        yield { record, source: relative, row: i };
      }
    } else if (ext === 'json') {
      for (const source of jsonRecords(file, relative)) yield source;
    } else if (ext === 'jsonl') {
      for await (const source of jsonlRecords(file, relative)) yield source;
    }
  }
}

function evalItemFromRecord(source: SourceRecord): EvalItem | undefined {
  const flat = flattenRecord(source.record);
  const facts = Object.entries(flat)
    .filter(([, value]) => usefulValue(value))
    .slice(0, 40);
  if (facts.length < 3) return undefined;

  const title = firstByKeys(flat, TITLE_KEYS) || facts[0][1];
  const identity = firstByKeys(flat, ID_KEYS) || title;
  const selected = selectFacts(flat, facts, title);
  if (selected.length < 2) return undefined;

  const fieldList = selected.map(([key]) => humanize(key)).join(', ');
  const prompt = `For ${title}, what are the values for ${fieldList}?`;
  const expectedParts = selected.map(([key, value]) => `${humanize(key)} is ${value}`);
  const expected = `${title}: ${expectedParts.join('; ')}.`;
  const assertions = [
    assertion(title),
    ...selected.map(([, value]) => assertion(value)),
  ].filter((item, index, array) => item.value && array.findIndex((other) => other.value === item.value) === index);

  return {
    id: stableId(`${source.source}:${source.row}:${identity}:${selected.map(([, value]) => value).join('|')}`),
    prompt,
    expected_answer: expected,
    source_location: `${source.source}:row ${source.row}`,
    assertions,
    category: 'single_record_lookup',
    difficulty: 'easy',
    supporting_facts: selected.map(([key, value]) => `${key}=${value}`),
    grounding_confidence: assertions.length >= 3 ? 'high' : 'medium',
  };
}

function selectFacts(flat: Record<string, string>, facts: Array<[string, string]>, title: string): Array<[string, string]> {
  const priority = [...ID_KEYS, ...TITLE_KEYS, 'year', 'status', 'condition', 'intervention', 'sponsor', 'phase', 'value'];
  const selected: Array<[string, string]> = [];
  for (const key of priority) {
    const entry = Object.entries(flat).find(([candidate]) => normalizeKey(candidate).endsWith(normalizeKey(key)) && usefulValue(flat[candidate]));
    if (entry && !selected.some(([existing]) => existing === entry[0])) selected.push(entry);
    if (selected.length >= 4) return selected;
  }
  for (const entry of facts) {
    if (entry[1] === title) continue;
    if (!selected.some(([existing]) => existing === entry[0])) selected.push(entry);
    if (selected.length >= 4) break;
  }
  return selected;
}

function flattenRecord(record: Record<string, unknown>, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    const nextKey = prefix ? `${prefix}.${key}` : key;
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) {
      const scalars = value.filter((item) => item === null || typeof item !== 'object').map(stringValue).filter(Boolean);
      if (scalars.length > 0) out[nextKey] = scalars.slice(0, 5).join(', ');
      const object = value.find((item) => item && typeof item === 'object' && !Array.isArray(item));
      if (object) Object.assign(out, flattenRecord(object as Record<string, unknown>, nextKey));
    } else if (typeof value === 'object') {
      Object.assign(out, flattenRecord(value as Record<string, unknown>, nextKey));
    } else {
      out[nextKey] = stringValue(value);
    }
  }
  return out;
}

function discoverFiles(dataset: string, extensions?: string[]): string[] {
  const resolved = path.resolve(dataset);
  const filter = extensions && extensions.length > 0
    ? new Set(extensions.map(normalizeExtension).filter((ext) => SUPPORTED_EXTENSIONS.has(ext)))
    : SUPPORTED_EXTENSIONS;
  const files: string[] = [];
  const include = (file: string): void => {
    if (path.relative(resolved, file).split(path.sep).includes('evalset')) return;
    if (filter.has(normalizeExtension(path.extname(file)))) files.push(file);
  };
  const stat = fs.statSync(resolved);
  if (stat.isFile()) include(resolved);
  else {
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile()) include(full);
      }
    };
    walk(resolved);
  }
  return files.sort();
}

function jsonRecords(file: string, relative: string): SourceRecord[] {
  const content = fs.readFileSync(file, 'utf-8');
  try {
    const parsed = JSON.parse(stripBom(content)) as unknown;
    const records = Array.isArray(parsed) ? parsed : [parsed];
    return records
      .map((record, index) => ({ record: objectRecord(record), source: relative, row: index + 1 }))
      .filter((source) => Object.keys(source.record).length > 0);
  } catch {
    return content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line, index) => ({ record: objectRecord(JSON.parse(line) as unknown), source: relative, row: index + 1 }));
  }
}

async function* jsonlRecords(file: string, relative: string): AsyncIterable<SourceRecord> {
  const input = fs.createReadStream(file, { encoding: 'utf-8' });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let row = 0;
  for await (const raw of lines) {
    const line = stripBom(raw).trim();
    if (!line) continue;
    row++;
    yield { record: objectRecord(JSON.parse(line) as unknown), source: relative, row };
  }
}

function parseDelimited(content: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  const text = stripBom(content);
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

function writeCsv(file: string, items: EvalItem[]): void {
  const rows = ['prompt,expected_answer,source_location,actual_answer'];
  for (const item of items) {
    rows.push([item.prompt, item.expected_answer, item.source_location, ''].map(csvEscape).join(','));
  }
  fs.writeFileSync(file, `${rows.join('\n')}\n`, 'utf-8');
}

function writeReview(file: string, items: EvalItem[], seedCount: number, target: number): void {
  const lines = [
    '# Evaluation Set Review',
    '',
    `Target count: ${target}`,
    `Final count: ${items.length}`,
    `Seeded items: ${seedCount}`,
    `Deterministically generated items: ${Math.max(0, items.length - seedCount)}`,
    '',
  ];
  for (const [index, item] of items.entries()) {
    lines.push(`## ${index + 1}. ${item.prompt}`, '', item.expected_answer, '', `Source: ${item.source_location}`, '');
  }
  fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf-8');
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : { value };
}

function firstByKeys(flat: Record<string, string>, keys: string[]): string {
  for (const key of keys) {
    const exact = Object.entries(flat).find(([candidate, value]) => normalizeKey(candidate) === normalizeKey(key) && usefulValue(value));
    if (exact) return exact[1];
    const suffix = Object.entries(flat).find(([candidate, value]) => normalizeKey(candidate).endsWith(normalizeKey(key)) && usefulValue(value));
    if (suffix) return suffix[1];
  }
  return '';
}

function usefulValue(value: string): boolean {
  const text = stringValue(value).trim();
  return text.length > 0 && text.length <= 160 && !['null', 'none', 'nan', 'n/a'].includes(text.toLowerCase());
}

function assertion(value: string): EvalItem['assertions'][number] {
  const wholeWord = /^[A-Z0-9]{2,4}$/.test(value) ? true : undefined;
  return { type: 'must_contain', value, wholeWord };
}

function stringValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function humanize(key: string): string {
  const leaf = key.split('.').pop() || key;
  return leaf.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function stableId(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf-8').digest('hex').slice(0, 12);
}

function firstExisting(...candidates: string[]): string | undefined {
  return candidates.find((candidate) => fs.existsSync(candidate));
}

function sourceDisplay(dataset: string): string {
  return fs.statSync(dataset).isFile() ? path.basename(dataset) : path.basename(path.resolve(dataset));
}

function relativeDatasetPath(dataset: string, file: string): string {
  const resolved = path.resolve(dataset);
  return fs.statSync(resolved).isFile() ? path.basename(file) : path.relative(resolved, file);
}

function normalizeExtension(value: string): string {
  return value.toLowerCase().replace(/^\./, '');
}

function stripBom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

function csvEscape(value: string): string {
  if (!/[",\r\n]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

function writeJson(file: string, value: unknown): void {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

