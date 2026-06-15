import * as fs from 'fs';
import * as path from 'path';

export interface PreparedDataset {
  dataset: string;
  extensions?: string[];
  diagnostics: string[];
}

interface DatasetFile {
  absolutePath: string;
  relativePath: string;
  extension: string;
}

const SUPPORTED_DISCOVERY_EXTENSIONS = new Set([
  'csv',
  'tsv',
  'json',
  'jsonl',
  'xlsx',
  'xls',
  'docx',
  'pdf',
  'pptx',
  'txt',
  'md',
]);

/**
 * Some source exports use newline-delimited JSON records but keep a .json
 * extension. EvalGen treats .json as a single JSON document, and the bundled
 * enhancer treats .json/.jsonl as document-like content. Convert only this
 * disguised JSONL shape to CSV so tabular business records stay tabular.
 */
export function prepareDatasetForWorkflow(
  datasetPath: string,
  workspace: string,
  extensions?: string[],
): PreparedDataset {
  const extensionFilter = extensions && extensions.length > 0
    ? new Set(extensions.map(normalizeExtension).filter(Boolean))
    : undefined;
  const files = collectDatasetFiles(datasetPath, extensionFilter);
  const jsonlJsonFiles = files.filter((file) => file.extension === 'json' && isJsonLinesFile(file.absolutePath));

  if (jsonlJsonFiles.length === 0) {
    return { dataset: datasetPath, extensions, diagnostics: [] };
  }

  const stageDir = path.join(workspace, '00-normalized-dataset');
  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(stageDir, { recursive: true });

  const effectiveExtensions = new Set<string>();
  let convertedRows = 0;
  const convertedSources = new Set(jsonlJsonFiles.map((file) => file.absolutePath));

  for (const file of files) {
    if (convertedSources.has(file.absolutePath)) {
      const csvRelative = replaceExtension(file.relativePath, '.csv');
      const csvPath = path.join(stageDir, csvRelative);
      convertedRows += convertJsonLinesToCsv(file.absolutePath, csvPath);
      effectiveExtensions.add('csv');
    } else {
      const dest = path.join(stageDir, file.relativePath);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(file.absolutePath, dest);
      effectiveExtensions.add(file.extension);
    }
  }

  return {
    dataset: stageDir,
    extensions: [...effectiveExtensions].sort(),
    diagnostics: [
      `normalized ${jsonlJsonFiles.length} .json JSONL file(s) to CSV (${convertedRows} row(s)) at ${stageDir}`,
    ],
  };
}

function normalizeExtension(value: string): string {
  return value.trim().toLowerCase().replace(/^\./, '');
}

const TABULAR_DISCOVERY_EXTENSIONS = new Set(['csv', 'tsv']);
// Mirror the enhancer's eval-set exclusion (enhance_for_copilot.ts datasetFiles)
// so detection never counts the operator-supplied ground-truth as data.
const EXCLUDED_DISCOVERY_DIR_NAMES = new Set(['evalset', 'eval-set', 'eval_set', 'workspace', 'node_modules', '.git']);
const EXCLUDED_DISCOVERY_FILE_PATTERN = /^eval[-_]?set/i;

/**
 * Detect the data-bearing file extensions actually present in a dataset,
 * mirroring the enhancer's eval-set exclusion rules. Returns a sorted list of
 * supported discovery extensions (empty if none / path unreadable).
 */
export function detectDatasetExtensions(datasetPath: string): string[] {
  const resolved = path.resolve(datasetPath);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    return [];
  }
  const found = new Set<string>();
  const consider = (name: string): void => {
    if (EXCLUDED_DISCOVERY_FILE_PATTERN.test(name)) return;
    const ext = normalizeExtension(path.extname(name));
    if (ext && SUPPORTED_DISCOVERY_EXTENSIONS.has(ext)) found.add(ext);
  };
  if (stat.isFile()) {
    consider(path.basename(resolved));
    return [...found].sort();
  }
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (entry.name.startsWith('_') || EXCLUDED_DISCOVERY_DIR_NAMES.has(entry.name.toLowerCase())) continue;
        walk(path.join(dir, entry.name));
      } else if (entry.isFile()) {
        consider(entry.name);
      }
    }
  };
  walk(resolved);
  return [...found].sort();
}

/**
 * Choose the extensions to pass to the enhancer when the operator did not
 * specify any. Returns null to keep the enhancer's csv/tsv default — used when
 * tabular data files are present (preserving established behavior). Returns a
 * concrete list only when there are non-tabular data files and no tabular data
 * files, which is exactly the case the csv/tsv default silently drops (e.g. a
 * dataset of .json documents).
 */
export function autoEnhancerExtensions(datasetPath: string): string[] | null {
  const present = detectDatasetExtensions(datasetPath);
  if (present.length === 0) return null;
  if (present.some((e) => TABULAR_DISCOVERY_EXTENSIONS.has(e))) return null;
  return present;
}

function collectDatasetFiles(datasetPath: string, extensionFilter?: Set<string>): DatasetFile[] {
  const resolved = path.resolve(datasetPath);
  const stat = fs.statSync(resolved);
  const files: DatasetFile[] = [];

  const includeFile = (absolutePath: string, relativePath: string): void => {
    const extension = normalizeExtension(path.extname(absolutePath));
    if (!extension || !SUPPORTED_DISCOVERY_EXTENSIONS.has(extension)) return;
    if (extensionFilter && !extensionFilter.has(extension)) return;
    files.push({ absolutePath, relativePath, extension });
  };

  if (stat.isFile()) {
    includeFile(resolved, path.basename(resolved));
    return files;
  }

  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        includeFile(fullPath, path.relative(resolved, fullPath));
      }
    }
  };

  walk(resolved);
  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

function isJsonLinesFile(filePath: string): boolean {
  const content = stripBom(fs.readFileSync(filePath, 'utf-8'));
  try {
    JSON.parse(content);
    return false;
  } catch {
    // Continue with JSONL detection below.
  }

  const lines = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2) return false;

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    } catch {
      return false;
    }
  }

  return true;
}

function convertJsonLinesToCsv(inputPath: string, outputPath: string): number {
  const lines = stripBom(fs.readFileSync(inputPath, 'utf-8'))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const rows: Array<Record<string, unknown>> = [];
  const columns: string[] = [];
  const columnsSeen = new Set<string>();

  for (const line of lines) {
    const row = JSON.parse(line) as Record<string, unknown>;
    rows.push(row);
    for (const key of Object.keys(row)) {
      if (!columnsSeen.has(key)) {
        columnsSeen.add(key);
        columns.push(key);
      }
    }
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const csv = [
    columns.map(csvEscape).join(','),
    ...rows.map((row) => columns.map((column) => csvEscape(stringifyCell(row[column]))).join(',')),
  ].join('\n');
  fs.writeFileSync(outputPath, `${csv}\n`, 'utf-8');
  return rows.length;
}

function stringifyCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function csvEscape(value: string): string {
  if (!/[",\r\n]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

function replaceExtension(relativePath: string, extension: string): string {
  const parsed = path.parse(relativePath);
  return path.join(parsed.dir, `${parsed.name}${extension}`);
}

function stripBom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

export const _test = {
  prepareDatasetForWorkflow,
  isJsonLinesFile,
  convertJsonLinesToCsv,
};
