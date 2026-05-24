#!/usr/bin/env node
/**
 * Generate Microsoft 365 Copilot-friendly records from tabular datasets.
 *
 * The tool converts sparse tabular rows into self-contained semantic records for
 * Microsoft Graph connector ingestion. Evaluation sets can be used to validate
 * coverage and, optionally, to add prompt examples to matching records.
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

//  Constants 

export const EMPTY_VALUES = new Set(["", "null", "none", "nan", "n/a", "na"]);
export const DELIMITER_CANDIDATES = ",\t;|";

const PRESERVE_NUMERIC_FIELD_NAMES = new Set([
  "year", "date", "month", "quarter", "period",
  "timestamp", "time", "fiscal_year", "week",
]);

const PRESERVE_NUMERIC_SUFFIXES = ["id", "code", "key", "no", "num", "iso"];

export const DEFAULT_KEY_FIELD_CANDIDATES: Record<string, string[]> = {
  entity: ["country", "countryName", "country_name", "name", "entity", "region",
           "company", "organization", "station", "city", "state", "location"],
  year: ["year", "date", "time_period", "period", "quarter", "month"],
  iso: ["iso_code", "countryiso3code", "countryIso3Code", "country_id", "countryId", "id", "code"],
};

export const DEFAULT_LONG_INDICATOR_COLUMNS: Record<string, string> = {
  idColumn: "indicatorId",
  nameColumn: "indicatorName",
  entityColumn: "countryName",
  yearColumn: "date",
  valueColumn: "value",
  isoColumn: "countryiso3code",
  groupLabel: "long-format indicators",
};

export const VALID_CONFIG_KEYS = new Set([
  "description", "fieldAliases", "priorityFields",
  "keyFieldCandidates", "longIndicatorColumns",
]);

export const VALID_LONG_INDICATOR_KEYS = new Set([
  "idColumn", "nameColumn", "entityColumn", "yearColumn",
  "valueColumn", "isoColumn", "groupLabel",
]);

//  Interfaces / Types 

export interface EnhancerConfig {
  fieldAliases: Record<string, string>;
  priorityFields: string[];
  keyFieldCandidates: Record<string, string[]>;
  longIndicatorColumns: Record<string, string>;
  hasExplicitLongConfig: boolean;
}

export interface EvalItem {
  id: string;
  prompt: string;
  expectedAnswer: string;
  supportingFacts: Record<string, string>;
  assertions: string[];
  category: string;
  difficulty: string;
  referencedRows: Array<[string, number]>;
}

export interface FileStats {
  relativePath: string;
  header: string[];
  rowCount: number;
  nonEmptyCounts: Map<string, number>;
  entityExamples: Map<string, number>;
  yearValues: Set<string>;
  skippedReason: string | null;
}

export interface EvalCoverage {
  matchedItems: Set<string>;
  matchedRecords: Map<string, string[]>;
  assertionsFound: Map<string, Set<string>>;
}

export interface RunArgs {
  dataset: string;
  eval?: string;
  output: string;
  config?: string;
  extensions: string;
  long_indicator_mode: "grouped" | "row" | "both";
  include_eval_prompts: boolean;
  include_eval_answers: boolean;
  focus_on_eval: boolean;
  no_overviews: boolean;
  max_records_per_file: number;
  acl_mode: "none" | "everyone" | "everyoneExceptGuests";
  encoding?: string;
  url_prefix: string;
}

export const NON_TABULAR_EXTENSIONS = new Set(["txt", "md", "markdown", "html", "htm", "json", "jsonl"]);
export const NONTABULAR_EXTENSIONS = NON_TABULAR_EXTENSIONS;
const ALL_NON_TABULAR_EXTENSIONS = new Set([...NON_TABULAR_EXTENSIONS, "text"]);

export const DEFAULT_CHUNK_MAX_CHARS = 2000;
export const DEFAULT_CHUNK_OVERLAP = 200;
export const CONTENT_TYPE_MAP = {
  txt: "text",
  text: "text",
  md: "markdown",
  markdown: "markdown",
  html: "html",
  htm: "html",
  json: "json",
  jsonl: "jsonl",
} as const;

const CONTENT_TYPE_MIME_MAP: Record<DocumentInfo["contentType"], string> = {
  text: "text/plain",
  markdown: "text/markdown",
  html: "text/html",
  json: "application/json",
  jsonl: "application/jsonl",
};

const FRONTMATTER_RE = /^---\s*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)\s*\r?\n/;
const MARKDOWN_HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;
const TEXT_METADATA_RE = /^(author|byline|date|published|source|url)\s*:\s*(.+)$/i;
const HTML_META_RE = /<meta\b[^>]*(?:name|property)\s*=\s*["']([^"']+)["'][^>]*content\s*=\s*["']([^"']*)["'][^>]*>/gi;
const HTML_TITLE_RE = /<title\b[^>]*>([\s\S]*?)<\/title>/i;
const HTML_H1_RE = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i;
const HTML_HEADING_RE = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
const HTML_LINK_RE = /<link\b([^>]*)>/gi;
const HTML_ATTR_RE = /([a-zA-Z_:][a-zA-Z0-9_:\-.]*)\s*=\s*["']([^"']*)["']/g;

const TITLE_KEYS = new Set(["title", "name", "headline", "subject"]);
const AUTHOR_KEYS = new Set(["author", "authors", "by", "byline", "creator", "createdby"]);
const DATE_KEYS = new Set(["date", "published", "publisheddate", "publishedat", "created", "createdat", "updatedat", "timestamp"]);
const URL_KEYS = new Set(["url", "link", "source", "sourceurl", "canonicalurl", "permalink"]);
const ICON_KEYS = new Set(["icon", "iconurl", "image", "imageurl", "thumbnail", "thumbnailurl"]);
const BODY_FIELD_KEYS = new Set(["body", "content", "text", "summary", "description", "excerpt", "message"]);
const MIN_CHUNK_CHARS = 50;

export interface DocumentInfo {
  title: string;
  author: string;
  date: string;
  contentType: "text" | "markdown" | "html" | "json" | "jsonl";
  sourcePath: string;
  relativePath: string;
  body: string;
  url: string;
  metadata: Record<string, string>;
}

export interface DocumentChunk {
  sectionPath: string;
  heading: string;
  chunkIndex: number;
  chunkCount: number;
  text: string;
  itemId: string;
}

interface SectionInfo {
  sectionPath: string;
  heading: string;
  text: string;
}

interface ParsedHtmlInfo {
  title: string;
  author: string;
  date: string;
  iconUrl: string;
  canonicalUrl: string;
  body: string;
}

function fileStem(filePath: string): string {
  return path.basename(filePath, path.extname(filePath));
}

function normalizeMetadataKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCharCode(parseInt(code, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, code) => String.fromCharCode(parseInt(code, 16)));
}

function humanizeJsonKey(value: string): string {
  const cleaned = value
    .replace(/[_\-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim();
  if (!cleaned) return "Value";
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

function normalizeDocumentUrl(relativePath: string, urlPrefix: string, anchor?: string): string {
  const base = urlPrefix
    ? `${urlPrefix.replace(/\/+$/, "")}/${relativePath.replace(/\\/g, "/").replace(/^\//, "")}`
    : `file:///${relativePath.replace(/\\/g, "/")}`;
  if (!anchor) return base;
  const slug = anchor.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return slug ? `${base}#${slug}` : base;
}

export function cleanContent(text: string): string {
  const normalizedText = decodeHtmlEntities(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const normalizedLines = normalizedText
    .split("\n")
    .map(line => line.replace(/[ \t]+/g, " ").trim());
  return normalizedLines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export const cleanupContent = cleanContent;

function readDocumentFile(filePath: string): string {
  const raw = fs.readFileSync(filePath);
  if (raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) {
    return raw.subarray(3).toString("utf-8");
  }
  return raw.toString("utf-8");
}

function buildDocumentInfo(
  base: Omit<DocumentInfo, "metadata">,
  metadata: Record<string, string>,
): DocumentInfo {
  return {
    ...base,
    metadata: Object.fromEntries(
      Object.entries(metadata).filter(([, value]) => value.trim() !== "")
    ),
  };
}

function parseTextMetadata(lines: string[]): Record<string, string> {
  const metadata: Record<string, string> = {};
  for (const line of lines.slice(0, 12)) {
    const match = TEXT_METADATA_RE.exec(line);
    if (!match) continue;
    const key = normalizeMetadataKey(match[1]);
    if (!(key in metadata)) {
      metadata[key] = match[2].trim();
    }
  }
  return metadata;
}

function markdownToPlainText(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_match, alt, target) => `Image: ${(alt || target).trim()}`)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/[*_`~]+/g, "");
}

function parseMarkdownFrontmatter(content: string): { body: string; metadata: Record<string, string> } {
  const match = FRONTMATTER_RE.exec(content);
  if (!match) {
    return { body: content, metadata: {} };
  }
  const metadata: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const colonIndex = line.indexOf(":");
    if (colonIndex < 0) continue;
    const key = normalizeMetadataKey(line.slice(0, colonIndex));
    const value = line.slice(colonIndex + 1).trim().replace(/^["']|["']$/g, "");
    if (value && !(key in metadata)) {
      metadata[key] = value;
    }
  }
  return { body: content.slice(match[0].length), metadata };
}

function stripHtmlToStructuredText(content: string): ParsedHtmlInfo {
  const withoutBlocks = content
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<nav\b[\s\S]*?<\/nav>/gi, " ")
    .replace(/<footer\b[\s\S]*?<\/footer>/gi, " ")
    .replace(/<form\b[\s\S]*?<\/form>/gi, " ")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ");

  let author = "";
  let date = "";
  let iconUrl = "";
  let canonicalUrl = "";

  let metaMatch: RegExpExecArray | null;
  HTML_META_RE.lastIndex = 0;
  while ((metaMatch = HTML_META_RE.exec(withoutBlocks)) !== null) {
    const key = normalizeMetadataKey(metaMatch[1]);
    const value = decodeHtmlEntities(metaMatch[2]).trim();
    if (!value) continue;
    if (AUTHOR_KEYS.has(key) && !author) author = value;
    else if (DATE_KEYS.has(key) && !date) date = value;
    else if (ICON_KEYS.has(key) && !iconUrl) iconUrl = value;
    else if (URL_KEYS.has(key) && !canonicalUrl) canonicalUrl = value;
  }

  let linkMatch: RegExpExecArray | null;
  HTML_LINK_RE.lastIndex = 0;
  while ((linkMatch = HTML_LINK_RE.exec(withoutBlocks)) !== null) {
    const attrs: Record<string, string> = {};
    let attrMatch: RegExpExecArray | null;
    HTML_ATTR_RE.lastIndex = 0;
    while ((attrMatch = HTML_ATTR_RE.exec(linkMatch[1])) !== null) {
      attrs[attrMatch[1].toLowerCase()] = attrMatch[2];
    }
    const rel = (attrs.rel || "").toLowerCase().split(/\s+/);
    if (!canonicalUrl && rel.includes("canonical") && attrs.href) {
      canonicalUrl = attrs.href.trim();
    }
    if (!iconUrl && rel.includes("icon") && attrs.href) {
      iconUrl = attrs.href.trim();
    }
  }

  const title = decodeHtmlEntities((HTML_TITLE_RE.exec(withoutBlocks)?.[1] || "").replace(/<[^>]+>/g, " ").trim());
  const firstHeading = decodeHtmlEntities((HTML_H1_RE.exec(withoutBlocks)?.[1] || "").replace(/<[^>]+>/g, " ").trim());

  const withHeadingMarkers = withoutBlocks.replace(HTML_HEADING_RE, (_match, level, inner) => {
    const headingText = decodeHtmlEntities(inner.replace(/<[^>]+>/g, " ").replace(/[ \t]+/g, " ").trim());
    return headingText ? `\n${"#".repeat(parseInt(level, 10))} ${headingText}\n` : "\n";
  });

  const withoutTags = withHeadingMarkers
    .replace(/<\/?(article|aside|blockquote|br|div|li|main|ol|p|pre|section|table|tbody|td|th|tr|ul)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");

  return {
    title: title || firstHeading,
    author,
    date,
    iconUrl,
    canonicalUrl,
    body: cleanContent(withoutTags),
  };
}

function stringifyJsonScalar(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return value;
  return String(value);
}

function extractJsonMetadata(value: Record<string, unknown>): Record<string, string> {
  const metadata: Record<string, string> = {};
  Object.assign(metadata, flattenedJsonMap(value));
  for (const [key, rawValue] of Object.entries(value)) {
    const normalizedKey = normalizeMetadataKey(key);
    let textValue = "";
    if (typeof rawValue === "string") {
      textValue = rawValue;
    } else if (Array.isArray(rawValue) && rawValue.every(item => typeof item !== "object")) {
      textValue = rawValue.map(item => stringifyJsonScalar(item)).join(", ");
    } else if (rawValue && typeof rawValue === "object" && !Array.isArray(rawValue)) {
      const nested = rawValue as Record<string, unknown>;
      if (typeof nested.title === "string") textValue = nested.title;
      else if (typeof nested.name === "string") textValue = nested.name;
    }
    if (!textValue) continue;
    if (!metadata.title && TITLE_KEYS.has(normalizedKey)) metadata.title = textValue;
    else if (!metadata.author && AUTHOR_KEYS.has(normalizedKey)) metadata.author = textValue;
    else if (!metadata.date && DATE_KEYS.has(normalizedKey)) metadata.date = textValue;
    else if (!metadata.url && URL_KEYS.has(normalizedKey)) metadata.url = textValue;
    else if (!metadata.iconUrl && ICON_KEYS.has(normalizedKey)) metadata.iconUrl = textValue;
  }
  return metadata;
}

function jsonValueToText(value: unknown, heading = "", level = 1): string {
  const headingPrefix = heading ? `${"#".repeat(Math.min(level, 6))} ${heading}\n\n` : "";
  if (Array.isArray(value)) {
    return (headingPrefix + value.map((item, index) => {
      if (item && typeof item === "object") {
        return jsonValueToText(item, `Item ${index + 1}`, level + 1);
      }
      return `- ${stringifyJsonScalar(item)}`;
    }).join("\n\n")).trim();
  }
  if (value && typeof value === "object") {
    const mapping = value as Record<string, unknown>;
    const lines: string[] = [];
    for (const [key, item] of Object.entries(mapping)) {
      const label = humanizeJsonKey(key);
      if (item && typeof item === "object") {
        lines.push(jsonValueToText(item, label, level + 1));
        continue;
      }
      const text = stringifyJsonScalar(item);
      if (!text) continue;
      if (BODY_FIELD_KEYS.has(normalizeMetadataKey(key)) && text.length > 120) {
        lines.push(jsonValueToText(text, label, level + 1));
      } else {
        lines.push(`- ${label}: ${text}`);
      }
    }
    return (headingPrefix + lines.join("\n\n")).trim();
  }
  return (headingPrefix + stringifyJsonScalar(value)).trim();
}

function jsonValueToExactFacts(value: unknown, prefix = ""): string[] {
  const facts: string[] = [];
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      facts.push(...jsonValueToExactFacts(item, prefix ? `${prefix}.${index}` : String(index)));
    });
    return facts;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const nextKey = prefix ? `${prefix}.${key}` : key;
      if (item && typeof item === "object") {
        facts.push(...jsonValueToExactFacts(item, nextKey));
        continue;
      }
      const text = stringifyJsonScalar(item);
      if (!text || text.length > 1000) continue;
      facts.push(`${nextKey}: ${text}`);
      const leaf = nextKey.split(".").pop() || nextKey;
      if (leaf !== nextKey) {
        facts.push(`${leaf}: ${text}`);
      }
    }
  }
  return facts;
}

const STRUCTURED_PROPERTY_KEYS = [
  "recordId",
  "title",
  "summary",
  "recordType",
  "lastModified",
  "cmsDatasetId",
  "cmsDatasetTitle",
  "measureName",
  "providerName",
  "facilityType",
  "reportingPeriod",
  "geography",
  "metricValue",
  "methodologyUrl",
  "packageName",
  "displayName",
  "recordCount",
  "bytes",
  "status",
] as const;

function flattenedJsonMap(value: unknown, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(value)) {
    value.forEach((item, index) => Object.assign(out, flattenedJsonMap(item, prefix ? `${prefix}.${index}` : String(index))));
    return out;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const nextKey = prefix ? `${prefix}.${key}` : key;
      if (item && typeof item === "object") {
        Object.assign(out, flattenedJsonMap(item, nextKey));
        continue;
      }
      const text = stringifyJsonScalar(item);
      if (!text || text.length > 1000) continue;
      out[nextKey] = text;
      const leaf = nextKey.split(".").pop() || nextKey;
      if (!out[leaf]) out[leaf] = text;
    }
  }
  return out;
}

function pickStructuredValue(flat: Record<string, string>, key: string): string {
  if (flat[key]) return flat[key];
  const normalizedKey = normalizeMetadataKey(key);
  const match = Object.entries(flat).find(([candidate]) => normalizeMetadataKey(candidate) === normalizedKey || normalizeMetadataKey(candidate).endsWith(normalizedKey));
  return match?.[1] || "";
}

function buildStructuredJsonContent(value: unknown): string {
  const flat = flattenedJsonMap(value);
  const canonical = STRUCTURED_PROPERTY_KEYS
    .map(key => [key, pickStructuredValue(flat, key)] as const)
    .filter(([, val]) => val);
  const exactFacts = Object.entries(flat)
    .filter(([key]) => key.includes("."))
    .map(([key, val]) => `${key}: ${val}`);
  const aliases = canonical
    .map(([key, val]) => `${humanizeJsonKey(key)}: ${val}`);
  const summary = pickStructuredValue(flat, "summary");
  const title = pickStructuredValue(flat, "title") || pickStructuredValue(flat, "displayName") || pickStructuredValue(flat, "cmsDatasetTitle");
  const blocks: string[] = [];
  if (canonical.length > 0) {
    blocks.push("Canonical facts:", ...canonical.map(([key, val]) => `- ${key}: ${val}`));
  }
  if (exactFacts.length > 0) {
    blocks.push("", "Exact source fields:", ...exactFacts.map(fact => `- ${fact}`));
  }
  if (aliases.length > 0) {
    blocks.push("", "Search aliases:", ...aliases.map(alias => `- ${alias}`));
  }
  if (summary) {
    blocks.push("", "Summary:", summary);
  } else if (title) {
    blocks.push("", "Summary:", `${title} record.`);
  }
  return blocks.join("\n") || jsonValueToText(value);
}

function extractJsonDocumentsFromValue(
  value: unknown,
  filePath: string,
  relativePath: string,
  urlPrefix: string,
): DocumentInfo[] {
  if (Array.isArray(value)) {
    const docs = value.map((item, index) => {
      const obj = item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : { value: item };
      const metadata = extractJsonMetadata(obj);
      const title = metadata.title || `${fileStem(filePath)} item ${index + 1}`;
      return buildDocumentInfo({
        title,
        author: metadata.author || "",
        date: metadata.date || "",
        contentType: "json",
        sourcePath: path.resolve(filePath),
        relativePath,
        body: cleanContent(buildStructuredJsonContent(item)),
        url: metadata.url || normalizeDocumentUrl(relativePath, urlPrefix),
      }, metadata);
    });
    return docs.filter(doc => doc.body);
  }

  const objectValue = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : { value };
  const metadata = extractJsonMetadata(objectValue);
  const title = metadata.title || fileStem(filePath);
  return [buildDocumentInfo({
    title,
    author: metadata.author || "",
    date: metadata.date || "",
    contentType: "json",
    sourcePath: path.resolve(filePath),
    relativePath,
    body: cleanContent(buildStructuredJsonContent(value)),
    url: metadata.url || normalizeDocumentUrl(relativePath, urlPrefix),
  }, metadata)];
}

function extractJsonlEntries(
  filePath: string,
  relativePath: string,
  urlPrefix: string,
): Array<{ text: string; title: string; metadata: Record<string, string> }> {
  const rawContent = readDocumentFile(filePath);
  const entries: Array<{ text: string; title: string; metadata: Record<string, string> }> = [];
  let lineNumber = 0;
  for (const rawLine of rawContent.split(/\r?\n/)) {
    lineNumber++;
    const line = rawLine.trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const metadata = parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? extractJsonMetadata(parsed)
        : {};
      entries.push({
        text: cleanContent(jsonValueToText(parsed)),
        title: metadata.title || `Line ${lineNumber}`,
        metadata: {
          ...metadata,
          url: metadata.url || normalizeDocumentUrl(relativePath, urlPrefix),
        },
      });
    } catch {
      entries.push({
        text: cleanContent(line),
        title: `Line ${lineNumber}`,
        metadata: { url: normalizeDocumentUrl(relativePath, urlPrefix) },
      });
    }
  }
  return entries.filter(entry => entry.text);
}

export function extractTextDocument(filePath: string, relativePath: string, urlPrefix: string): DocumentInfo {
  const raw = readDocumentFile(filePath);
  const cleaned = cleanContent(raw);
  const lines = cleaned.split("\n");
  const metadata = parseTextMetadata(lines);
  const title = lines.find(line => line && !TEXT_METADATA_RE.test(line)) || fileStem(filePath);
  return buildDocumentInfo({
    title,
    author: metadata.author || metadata.byline || "",
    date: metadata.date || metadata.published || "",
    contentType: "text",
    sourcePath: path.resolve(filePath),
    relativePath,
    body: cleaned,
    url: metadata.source || metadata.url || normalizeDocumentUrl(relativePath, urlPrefix),
  }, metadata);
}

export function extractMarkdownDocument(filePath: string, relativePath: string, urlPrefix: string): DocumentInfo {
  const raw = readDocumentFile(filePath);
  const { body, metadata } = parseMarkdownFrontmatter(raw);
  const cleaned = cleanContent(markdownToPlainText(body));
  const firstHeading = cleaned.split("\n").map(line => MARKDOWN_HEADING_RE.exec(line)?.[2].trim() || "").find(Boolean) || "";
  return buildDocumentInfo({
    title: metadata.title || firstHeading || fileStem(filePath),
    author: metadata.author || "",
    date: metadata.date || metadata.published || "",
    contentType: "markdown",
    sourcePath: path.resolve(filePath),
    relativePath,
    body: cleaned,
    url: metadata.url || normalizeDocumentUrl(relativePath, urlPrefix),
  }, metadata);
}

export function extractHtmlDocument(filePath: string, relativePath: string, urlPrefix: string): DocumentInfo {
  const parsed = stripHtmlToStructuredText(readDocumentFile(filePath));
  return buildDocumentInfo({
    title: parsed.title || fileStem(filePath),
    author: parsed.author,
    date: parsed.date,
    contentType: "html",
    sourcePath: path.resolve(filePath),
    relativePath,
    body: parsed.body,
    url: parsed.canonicalUrl || normalizeDocumentUrl(relativePath, urlPrefix),
  }, {
    title: parsed.title,
    author: parsed.author,
    date: parsed.date,
    iconUrl: parsed.iconUrl,
    url: parsed.canonicalUrl,
  });
}

export function extractJsonDocument(filePath: string, relativePath: string, urlPrefix: string): DocumentInfo {
  const raw = readDocumentFile(filePath);
  try {
    const [document] = extractJsonDocumentsFromValue(JSON.parse(raw), filePath, relativePath, urlPrefix);
    return document;
  } catch {
    return buildDocumentInfo({
      title: fileStem(filePath),
      author: "",
      date: "",
      contentType: "json",
      sourcePath: path.resolve(filePath),
      relativePath,
      body: cleanContent(raw),
      url: normalizeDocumentUrl(relativePath, urlPrefix),
    }, {});
  }
}

export function extractJsonlDocument(filePath: string, relativePath: string, urlPrefix: string): DocumentInfo {
  const entries = extractJsonlEntries(filePath, relativePath, urlPrefix);
  const metadata: Record<string, string> = {
    __jsonlEntries: JSON.stringify(entries.map(entry => ({ text: entry.text, heading: entry.title }))),
  };
  return buildDocumentInfo({
    title: fileStem(filePath),
    author: "",
    date: "",
    contentType: "jsonl",
    sourcePath: path.resolve(filePath),
      relativePath,
      body: entries.map(entry => entry.text).join("\n\n"),
      url: normalizeDocumentUrl(relativePath, urlPrefix),
  }, metadata);
}

function splitHeadingSections(text: string): SectionInfo[] {
  const sections: SectionInfo[] = [];
  let stack: string[] = [];
  let currentLines: string[] = [];
  let currentHeading = "";
  let currentPath = "";

  const flush = (): void => {
    const content = cleanContent(currentLines.join("\n"));
    if (!content) return;
    sections.push({
      sectionPath: currentPath,
      heading: currentHeading,
      text: content,
    });
  };

  for (const rawLine of text.split("\n")) {
    const match = MARKDOWN_HEADING_RE.exec(rawLine);
    if (!match) {
      currentLines.push(rawLine);
      continue;
    }
    flush();
    const level = match[1].length;
    const heading = match[2].trim();
    stack = stack.slice(0, level - 1);
    stack.push(heading);
    currentHeading = heading;
    currentPath = stack.join(" > ");
    currentLines = [];
  }
  flush();
  if (sections.length === 0) {
    return [{ sectionPath: "", heading: "", text: cleanContent(text) }];
  }
  return sections;
}

function splitParagraphSections(text: string): SectionInfo[] {
  const cleaned = cleanContent(text);
  if (!cleaned) {
    return [];
  }
  return [{
    sectionPath: "",
    heading: "",
    text: cleaned,
  }];
}

function splitDelimitedSections(text: string): SectionInfo[] {
  return cleanContent(text)
    .split(/\n{2,}/)
    .map(section => section.trim())
    .filter(Boolean)
    .map(section => ({
      sectionPath: "",
      heading: "",
      text: section,
    }));
}

function splitJsonlSections(doc: DocumentInfo): SectionInfo[] {
  const encodedEntries = doc.metadata.__jsonlEntries;
  if (encodedEntries) {
    try {
      const parsed = JSON.parse(encodedEntries) as Array<{ text: string; heading: string } | string>;
      return parsed
        .map(entry =>
          typeof entry === "string"
            ? { sectionPath: "", heading: "", text: cleanContent(entry) }
            : { sectionPath: "", heading: entry.heading || "", text: cleanContent(entry.text) }
        )
        .filter(s => s.text);
    } catch {
      // Fall through to the body-based split below.
    }
  }
  return splitDelimitedSections(doc.body);
}

function chunkParagraphText(text: string, maxChars: number, overlapChars: number): string[] {
  const cleaned = cleanContent(text);
  if (!cleaned) return [];
  if (cleaned.length <= maxChars) return [cleaned];

  const chunks: string[] = [];
  let start = 0;
  while (start < cleaned.length) {
    let end = Math.min(cleaned.length, start + maxChars);
    if (end < cleaned.length) {
      const searchRegion = cleaned.slice(start, Math.min(cleaned.length, end + 80));
      const boundaryMatches = ["\n\n", "\n", ". ", "! ", "? ", "; ", ", ", " "]
        .map(marker => searchRegion.lastIndexOf(marker, end - start))
        .filter(index => index > 0);
      if (boundaryMatches.length > 0) {
        end = start + Math.max(...boundaryMatches) + 1;
      }
    }
    const chunk = cleaned.slice(start, end).trim();
    if (chunk) {
      chunks.push(chunk);
    }
    if (end >= cleaned.length) break;
    start = Math.max(end - overlapChars, start + 1);
  }
  return chunks;
}

function chunkSection(section: SectionInfo, maxChars: number, overlapChars: number): Array<Omit<DocumentChunk, "chunkIndex" | "chunkCount" | "itemId">> {
  const paragraphs = section.text.split(/\n{2,}/).map(paragraph => paragraph.trim()).filter(Boolean);
  if (paragraphs.length === 0) return [];

  const chunks: Array<Omit<DocumentChunk, "chunkIndex" | "chunkCount" | "itemId">> = [];
  let current = "";

  const pushChunk = (value: string): void => {
    const cleaned = cleanContent(value);
    if (!cleaned) return;
    chunks.push({
      sectionPath: section.sectionPath,
      heading: section.heading,
      text: cleaned,
    });
  };

  for (const paragraph of paragraphs) {
    if (!current) {
      current = paragraph;
      continue;
    }

    const next = `${current}\n\n${paragraph}`;
    if (next.length <= maxChars || current.length < MIN_CHUNK_CHARS) {
      current = next;
      continue;
    }

    pushChunk(current);
    const overlapPrefix = overlapChars > 0 ? current.slice(-overlapChars).trim() : "";
    current = overlapPrefix ? `${overlapPrefix}\n\n${paragraph}` : paragraph;
  }

  if (current.length > maxChars) {
    for (const part of chunkParagraphText(current, maxChars, overlapChars)) {
      pushChunk(part);
    }
  } else {
    pushChunk(current);
  }

  return chunks;
}

export function chunkDocument(
  doc: DocumentInfo,
  maxChars: number = DEFAULT_CHUNK_MAX_CHARS,
  overlapChars: number = DEFAULT_CHUNK_OVERLAP,
): DocumentChunk[] {
  const sections = doc.contentType === "markdown" || doc.contentType === "html"
    ? splitHeadingSections(doc.body)
    : doc.contentType === "jsonl"
      ? splitJsonlSections(doc)
      : splitParagraphSections(doc.body);

  const rawChunks = sections.flatMap(section => chunkSection(section, maxChars, overlapChars));
  if (rawChunks.length === 0 && doc.body) {
    rawChunks.push({
      sectionPath: "",
      heading: "",
      text: cleanContent(doc.body).slice(0, maxChars),
    });
  }

  const documentId = stableDocumentId(doc.relativePath, 0, doc.title);
  const chunkCount = rawChunks.length;
  return rawChunks.map((chunk, index) => ({
    ...chunk,
    chunkIndex: index,
    chunkCount,
    itemId: stableChunkId(doc.relativePath, documentId, index, chunk.sectionPath),
  }));
}

export function chunkText(text: string, maxChars: number = DEFAULT_CHUNK_MAX_CHARS, overlapChars: number = DEFAULT_CHUNK_OVERLAP): string[] {
  return chunkParagraphText(text, maxChars, overlapChars);
}

export function semanticChunkDocument(
  content: string,
  contentType: string,
  maxChars: number = DEFAULT_CHUNK_MAX_CHARS,
  overlapChars: number = DEFAULT_CHUNK_OVERLAP,
): Array<[string, string]> {
  const info = buildDocumentInfo({
    title: "",
    author: "",
    date: "",
    contentType: (contentType in CONTENT_TYPE_MIME_MAP ? contentType : "text") as DocumentInfo["contentType"],
    sourcePath: "",
    relativePath: "",
    body: cleanContent(content),
    url: "",
  }, {});
  return chunkDocument(info, maxChars, overlapChars).map(chunk => [chunk.sectionPath, chunk.text]);
}

export function splitIntoSections(content: string, contentType: string): Array<[string, string]> {
  const normalizedType = contentType === "text/markdown" ? "markdown"
    : contentType === "text/html" ? "html"
      : contentType === "application/json" ? "json"
        : contentType === "application/jsonl" ? "jsonl"
          : contentType === "markdown" || contentType === "html" || contentType === "json" || contentType === "jsonl"
            ? contentType
            : "text";
  const doc = buildDocumentInfo({
    title: "",
    author: "",
    date: "",
    contentType: normalizedType as DocumentInfo["contentType"],
    sourcePath: "",
    relativePath: "",
    body: cleanContent(content),
    url: "",
  }, {});
  return (normalizedType === "markdown" || normalizedType === "html" ? splitHeadingSections(doc.body) : splitParagraphSections(doc.body))
    .map(section => [section.sectionPath, section.text]);
}

export function stableDocumentId(sourceFile: string, documentIndex: number, title: string): string {
  return stableId("docsrc", sourceFile, String(documentIndex), title);
}

export function stableChunkId(sourceFile: string, documentId: string, chunkIndex: number, sectionPath: string): string {
  return stableId("doc", sourceFile, documentId, String(chunkIndex), sectionPath);
}

function documentChunkTitle(chunk: DocumentChunk, doc: DocumentInfo): string {
  return chunk.heading
    ? `${doc.title} — ${chunk.heading}`
    : `${doc.title} [${chunk.chunkIndex + 1}/${chunk.chunkCount}]`;
}

export function buildDocumentChunkContent(chunk: DocumentChunk, doc: DocumentInfo): string {
  const title = documentChunkTitle(chunk, doc);
  const lines = [
    chunk.text,
    "",
    "Connector metadata:",
    `Title: ${title}`,
    `Source file: ${doc.relativePath}`,
    `Content type: ${CONTENT_TYPE_MIME_MAP[doc.contentType]}`,
    `Chunk: ${chunk.chunkIndex + 1} of ${chunk.chunkCount}`,
  ];
  if (chunk.sectionPath) lines.push(`Section path: ${chunk.sectionPath}`);
  if (doc.author) lines.push(`Author: ${doc.author}`);
  if (doc.date) lines.push(`Date published: ${doc.date}`);
  if (doc.url) lines.push(`Source URL: ${doc.url}`);
  return lines.join("\n");
}

export function buildDocumentItem(chunk: DocumentChunk, doc: DocumentInfo, aclMode: string): Record<string, unknown> {
  const documentId = stableDocumentId(doc.relativePath, 0, doc.title);
  const baseUrl = (doc.url || normalizeDocumentUrl(doc.relativePath, "")).replace(/#.*$/, "");
  const title = documentChunkTitle(chunk, doc);
  const iconUrl = doc.metadata.iconUrl || "";
  const item = graphLikeItem({
    itemId: chunk.itemId || stableChunkId(doc.relativePath, documentId, chunk.chunkIndex, chunk.sectionPath),
    title,
    itemType: "document-chunk",
    content: buildDocumentChunkContent(chunk, doc),
    properties: {
      url: `${baseUrl}#chunk=${chunk.chunkIndex}`,
      iconUrl,
      sourceFile: doc.relativePath,
      documentId,
      contentType: CONTENT_TYPE_MIME_MAP[doc.contentType],
      sectionPath: chunk.sectionPath,
      chunkIndex: chunk.chunkIndex,
      chunkCount: chunk.chunkCount,
      ...structuredPropertiesFromMetadata(doc.metadata),
      ...(doc.author ? { author: doc.author } : {}),
      ...(doc.date ? { datePublished: doc.date } : {}),
    },
    aclMode,
  });
  // graphLikeItem filters empty strings; re-set iconUrl so it is always present
  // in properties even when empty, matching Python's build_document_item behavior.
  (item.properties as Record<string, unknown>).iconUrl = iconUrl;
  return item;
}

function structuredPropertiesFromMetadata(metadata: Record<string, string>): Record<string, string | number> {
  const props: Record<string, string | number> = {};
  for (const key of STRUCTURED_PROPERTY_KEYS) {
    const value = pickStructuredValue(metadata, key);
    if (!value) continue;
    if (key === "bytes" || key === "recordCount" || key === "metricValue") {
      const num = Number(value);
      if (Number.isFinite(num)) {
        props[key] = num;
        continue;
      }
    }
    props[key] = value;
  }
  return props;
}

function extractJsonDocuments(filePath: string, relativePath: string, urlPrefix: string): DocumentInfo[] {
  const raw = readDocumentFile(filePath);
  try {
    return extractJsonDocumentsFromValue(JSON.parse(raw), filePath, relativePath, urlPrefix);
  } catch {
    return [buildDocumentInfo({
      title: fileStem(filePath),
      author: "",
      date: "",
      contentType: "json",
      sourcePath: path.resolve(filePath),
      relativePath,
      body: cleanContent(raw),
      url: normalizeDocumentUrl(relativePath, urlPrefix),
    }, {})];
  }
}

function extractDocumentInfos(filePath: string, relativePath: string, urlPrefix: string): DocumentInfo[] {
  const extension = path.extname(filePath).toLowerCase().replace(".", "");
  const contentType = CONTENT_TYPE_MAP[extension as keyof typeof CONTENT_TYPE_MAP] || "text";
  switch (contentType) {
    case "markdown":
      return [extractMarkdownDocument(filePath, relativePath, urlPrefix)];
    case "html":
      return [extractHtmlDocument(filePath, relativePath, urlPrefix)];
    case "json":
      return extractJsonDocuments(filePath, relativePath, urlPrefix);
    case "jsonl":
      return [extractJsonlDocument(filePath, relativePath, urlPrefix)];
    case "text":
    default:
      return [extractTextDocument(filePath, relativePath, urlPrefix)];
  }
}

export function processNontabularFile(
  filePath: string,
  relativePath: string,
  _contentType?: string,
  options: {
    encoding?: BufferEncoding;
    maxChunkChars?: number;
    chunkOverlap?: number;
    urlPrefix?: string;
  } = {},
): Array<{ doc: DocumentInfo; chunk: DocumentChunk }> {
  if (!fs.existsSync(filePath) || !readDocumentFile(filePath).trim()) {
    return [];
  }
  return extractDocumentInfos(filePath, relativePath, options.urlPrefix || "")
    .flatMap(doc => chunkDocument(doc, options.maxChunkChars, options.chunkOverlap).map(chunk => ({ doc, chunk })));
}

function* processJsonlFileStreaming(
  filePath: string,
  relativePath: string,
  urlPrefix: string,
  byRef?: Map<string, EvalItem[]>,
  byEntityYear?: Map<string, EvalItem[]>,
  config?: EnhancerConfig,
): Iterable<{ doc: DocumentInfo; chunk: DocumentChunk; matches: EvalItem[] }> {
  let lineNumber = 0;
  for (const rawLine of readLinesSync(filePath)) {
    lineNumber++;
    const line = rawLine.trim();
    if (!line) continue;
    let parsed: unknown = line;
    let metadata: Record<string, string> = {};
    try {
      parsed = JSON.parse(line) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        metadata = extractJsonMetadata(parsed as Record<string, unknown>);
      }
    } catch {
      parsed = line;
    }
    const body = cleanContent(typeof parsed === "string" ? parsed : buildStructuredJsonContent(parsed));
    if (!body) continue;
    const flatRecord = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? Object.fromEntries(jsonValueToExactFacts(parsed).map(fact => {
        const idx = fact.indexOf(":");
        return [fact.slice(0, idx), fact.slice(idx + 1).trim()];
      }))
      : {};
    const matches = byRef && byEntityYear && config
      ? jsonEvalMatches(flatRecord, path.basename(filePath).toLowerCase(), lineNumber, byRef, byEntityYear, config)
      : [];
    const lineRelativePath = `${relativePath}#line-${lineNumber}`;
    const doc = buildDocumentInfo({
      title: metadata.title || `Line ${lineNumber}`,
      author: metadata.author || "",
      date: metadata.date || "",
      contentType: "jsonl",
      sourcePath: path.resolve(filePath),
      relativePath: lineRelativePath,
      body,
      url: metadata.url || `${normalizeDocumentUrl(relativePath, urlPrefix)}#line-${lineNumber}`,
    }, metadata);
    const text = doc.body.length > 30_000
      ? `${doc.body.slice(0, 30_000)}\n\n[Content truncated for connector item size; source record remains available in RAW baseline.]`
      : doc.body;
    yield {
      doc,
      chunk: {
        sectionPath: "",
        heading: doc.title,
        chunkIndex: 0,
        chunkCount: 1,
        text,
        itemId: stableChunkId(doc.relativePath, stableDocumentId(doc.relativePath, 0, doc.title), 0, ""),
      },
      matches,
    };
  }
}

function jsonEvalMatches(
  row: Record<string, string>,
  basename: string,
  lineNumber: number,
  byRef: Map<string, EvalItem[]>,
  byEntityYear: Map<string, EvalItem[]>,
  config: EnhancerConfig,
): EvalItem[] {
  const matches = new Map<string, EvalItem>();
  for (const rowNumber of [lineNumber, lineNumber + 1]) {
    for (const item of compatibleEvalMatches(row, basename, rowNumber, "", "", byRef, byEntityYear, config)) {
      matches.set(item.id, item);
    }
  }
  for (const item of Array.from(matches.values())) {
    for (const [key, expected] of Object.entries(item.supportingFacts)) {
      const value = rowValueForFact(row, key, config);
      if (expected && value && normalized(value) === normalized(expected)) {
        matches.set(item.id, item);
      }
    }
  }
  return Array.from(matches.values());
}

function contentOnlyEvalMatches(evalItems: EvalItem[], content: string): EvalItem[] {
  const folded = normalized(content);
  return evalItems.filter(item => item.assertions.length > 0 && item.assertions.some(assertion => folded.includes(normalized(assertion))));
}

function dedupeEvalItems(items: EvalItem[]): EvalItem[] {
  const seen = new Set<string>();
  const out: EvalItem[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

function* readLinesSync(filePath: string): Iterable<string> {
  const fd = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let carry = "";
  let firstLine = true;
  try {
    while (true) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      const text = carry + buffer.subarray(0, bytesRead).toString("utf-8");
      const parts = text.split(/\r?\n/);
      carry = parts.pop() || "";
      for (const part of parts) {
        yield firstLine ? stripBom(part) : part;
        firstLine = false;
      }
    }
    if (carry) yield firstLine ? stripBom(carry) : carry;
  } finally {
    fs.closeSync(fd);
  }
}

function stripBom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

//  Config Loading ─

export function loadConfig(configPath: string | null | undefined): EnhancerConfig {
  const baseAliases: Record<string, string> = {};
  let basePriority: string[] = [];
  const baseKeys: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(DEFAULT_KEY_FIELD_CANDIDATES)) {
    baseKeys[k] = [...v];
  }
  const baseLong: Record<string, string> = { ...DEFAULT_LONG_INDICATOR_COLUMNS };

  if (!configPath) {
    return {
      fieldAliases: baseAliases,
      priorityFields: basePriority,
      keyFieldCandidates: baseKeys,
      longIndicatorColumns: baseLong,
      hasExplicitLongConfig: false,
    };
  }

  const resolved = path.resolve(configPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Config file not found: ${resolved}`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(resolved, "utf-8"));
  } catch (exc: unknown) {
    throw new Error(`Invalid JSON in config file ${resolved}: ${(exc as Error).message}`);
  }

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`Config file must be a JSON object, got ${Array.isArray(raw) ? "array" : typeof raw}`);
  }
  const obj = raw as Record<string, unknown>;

  const unknownKeys = Object.keys(obj).filter(k => !VALID_CONFIG_KEYS.has(k));
  if (unknownKeys.length > 0) {
    throw new Error(`Unknown config keys: ${JSON.stringify(unknownKeys.sort())}`);
  }

  if ("fieldAliases" in obj) {
    if (typeof obj.fieldAliases !== "object" || obj.fieldAliases === null || Array.isArray(obj.fieldAliases)) {
      throw new Error("fieldAliases must be a JSON object mapping field names to labels");
    }
    const aliases = obj.fieldAliases as Record<string, unknown>;
    for (const [aliasKey, aliasVal] of Object.entries(aliases)) {
      if (typeof aliasVal !== "string") {
        throw new Error(`fieldAliases.${aliasKey} must be a string label, got ${typeof aliasVal}`);
      }
      baseAliases[aliasKey] = aliasVal;
    }
  }

  if ("priorityFields" in obj) {
    if (!Array.isArray(obj.priorityFields)) {
      throw new Error("priorityFields must be a JSON array of field names");
    }
    for (let i = 0; i < obj.priorityFields.length; i++) {
      if (typeof obj.priorityFields[i] !== "string") {
        throw new Error(`priorityFields[${i}] must be a string field name, got ${typeof obj.priorityFields[i]}`);
      }
    }
    basePriority = obj.priorityFields as string[];
  }

  if ("keyFieldCandidates" in obj) {
    if (typeof obj.keyFieldCandidates !== "object" || obj.keyFieldCandidates === null || Array.isArray(obj.keyFieldCandidates)) {
      throw new Error("keyFieldCandidates must be a JSON object");
    }
    const kfc = obj.keyFieldCandidates as Record<string, unknown>;
    for (const [key, candidates] of Object.entries(kfc)) {
      if (!Array.isArray(candidates)) {
        throw new Error(`keyFieldCandidates.${key} must be an array`);
      }
      for (let i = 0; i < candidates.length; i++) {
        if (typeof candidates[i] !== "string") {
          throw new Error(`keyFieldCandidates.${key}[${i}] must be a string, got ${typeof candidates[i]}`);
        }
      }
      baseKeys[key] = candidates as string[];
    }
  }

  let hasExplicitLongConfig = false;
  if ("longIndicatorColumns" in obj) {
    if (typeof obj.longIndicatorColumns !== "object" || obj.longIndicatorColumns === null || Array.isArray(obj.longIndicatorColumns)) {
      throw new Error("longIndicatorColumns must be a JSON object");
    }
    const lic = obj.longIndicatorColumns as Record<string, unknown>;
    const unknownLi = Object.keys(lic).filter(k => !VALID_LONG_INDICATOR_KEYS.has(k));
    if (unknownLi.length > 0) {
      throw new Error(`Unknown longIndicatorColumns keys: ${JSON.stringify(unknownLi.sort())}`);
    }
    for (const [liKey, liVal] of Object.entries(lic)) {
      if (typeof liVal !== "string") {
        throw new Error(`longIndicatorColumns.${liKey} must be a string, got ${typeof liVal}`);
      }
      baseLong[liKey] = liVal;
    }
    const requiredLi = ["idColumn", "nameColumn", "entityColumn", "yearColumn", "valueColumn"];
    for (const reqKey of requiredLi) {
      if (!baseLong[reqKey]) {
        throw new Error(`longIndicatorColumns.${reqKey} must be a non-empty string after merging defaults`);
      }
    }
    hasExplicitLongConfig = true;
  }

  return {
    fieldAliases: baseAliases,
    priorityFields: basePriority,
    keyFieldCandidates: baseKeys,
    longIndicatorColumns: baseLong,
    hasExplicitLongConfig,
  };
}

//  CSV Parsing ─

export function parseCsvLine(line: string, delimiter: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === delimiter) {
        fields.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
  }
  fields.push(current);
  return fields;
}

export function sniffDelimiter(sample: string, filePath: string): string {
  if (sample) {
    const firstLine = sample.split(/\r?\n/)[0] || "";
    let bestDelim = ",";
    let bestCount = 0;
    for (const delim of DELIMITER_CANDIDATES) {
      const count = parseCsvLine(firstLine, delim).length;
      if (count > bestCount) {
        bestCount = count;
        bestDelim = delim;
      }
    }
    if (bestCount > 1) {
      return bestDelim;
    }
  }
  return path.extname(filePath).toLowerCase() === ".tsv" ? "\t" : ",";
}

export function readTabularFile(
  filePath: string,
  encoding?: string
): { header: string[]; rows: Array<Record<string, string>> } {
  let content: string;
  if (encoding) {
    content = fs.readFileSync(filePath, encoding as BufferEncoding);
  } else {
    // Try utf-8 (with BOM handling) first
    const buf = fs.readFileSync(filePath);
    // Check for UTF-8 BOM
    if (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
      content = buf.subarray(3).toString("utf-8");
    } else {
      content = buf.toString("utf-8");
    }
  }

  const lines = content.split(/\r?\n/).filter((line, i, arr) => {
    // Keep all lines except trailing empty line
    return i < arr.length - 1 || line.trim() !== "";
  });

  if (lines.length === 0) {
    return { header: [], rows: [] };
  }

  const delimiter = sniffDelimiter(content.slice(0, 16384), filePath);
  const header = parseCsvLine(lines[0], delimiter);
  const rows: Array<Record<string, string>> = [];

  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "") continue;
    const values = parseCsvLine(lines[i], delimiter);
    const row: Record<string, string> = {};
    for (let j = 0; j < header.length; j++) {
      row[header[j]] = values[j] ?? "";
    }
    rows.push(row);
  }

  return { header, rows };
}
//  Utility Functions ─

export function isEmpty(value: unknown): boolean {
  return value === null || value === undefined || EMPTY_VALUES.has(String(value).trim().toLowerCase());
}

export function normalized(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

export function stableId(prefix: string, ...parts: string[]): string {
  const digest = crypto.createHash("sha256")
    .update(parts.join("\u001f"), "utf-8")
    .digest("hex")
    .slice(0, 24);
  return `${prefix}-${digest}`;
}

export function findFirst(row: Record<string, string>, candidates: string[]): string {
  const lowered: Record<string, string> = {};
  for (const k of Object.keys(row)) {
    lowered[k.toLowerCase()] = k;
  }
  for (const candidate of candidates) {
    const actual = lowered[candidate.toLowerCase()];
    if (actual && !isEmpty(row[actual])) {
      return row[actual].trim();
    }
  }
  return "";
}

export function humanizeField(name: string, config: EnhancerConfig): string {
  if (name in config.fieldAliases) {
    return config.fieldAliases[name];
  }
  let readable = name.replace(/[_\-]+/g, " ").trim();
  readable = readable.replace(/([a-z])([A-Z])/g, "$1 $2");
  return readable || name;
}

function preservesNumericLiteral(fieldName: string, config: EnhancerConfig | null = null): boolean {
  const fieldLower = fieldName.toLowerCase();
  if (config !== null) {
    for (const candidates of Object.values(config.keyFieldCandidates)) {
      if (candidates.some(c => c.toLowerCase() === fieldLower)) {
        return true;
      }
    }
  }
  if (PRESERVE_NUMERIC_FIELD_NAMES.has(fieldLower)) return true;
  return PRESERVE_NUMERIC_SUFFIXES.some(suf => fieldLower.endsWith(suf));
}

export function displayValue(value: string, fieldName: string = "", config: EnhancerConfig | null = null): string {
  const raw = String(value).trim();
  if (!raw) return raw;
  return raw;
}

export function factLine(fieldName: string, value: string, config: EnhancerConfig): string {
  return `- ${fieldName}: ${displayValue(value, fieldName, config)}`;
}

export function splitSupportingFact(fact: string): [string, string] | null {
  if (!fact.includes("=")) return null;
  const idx = fact.indexOf("=");
  const key = fact.slice(0, idx).trim();
  const value = fact.slice(idx + 1).trim();
  return key ? [key, value] : null;
}

export function parseReferencedRows(values: string[]): Array<[string, number]> {
  const refs: Array<[string, number]> = [];
  const pattern = /(?<file>[A-Za-z0-9][A-Za-z0-9._\-/]*\.[A-Za-z0-9]+):row\s+(?<row>\d+)/g;
  for (const value of values) {
    let match: RegExpExecArray | null;
    pattern.lastIndex = 0;
    while ((match = pattern.exec(value)) !== null) {
      if (match.groups) {
        refs.push([match.groups.file.toLowerCase(), parseInt(match.groups.row, 10)]);
      }
    }
  }
  return refs;
}
//  Eval Loading ─

export function loadEvalItems(evalPath: string | null | undefined, encoding?: string): EvalItem[] {
  if (!evalPath) return [];
  const resolved = path.resolve(evalPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Evaluation set not found: ${resolved}`);
  }

  if (path.extname(resolved).toLowerCase() === ".json") {
    const payload = JSON.parse(fs.readFileSync(resolved, "utf-8"));
    const rawItems: unknown[] = Array.isArray(payload) ? payload : (payload.items || []);
    const items: EvalItem[] = [];
    for (let index = 0; index < rawItems.length; index++) {
      const item = rawItems[index] as Record<string, unknown>;
      const supporting: Record<string, string> = {};
      const facts = (item.supporting_facts as string[]) || [];
      for (const fact of facts) {
        const parsed = splitSupportingFact(String(fact));
        if (parsed) {
          supporting[parsed[0]] = parsed[1];
        }
      }
      const assertions: string[] = [];
      for (const assertion of ((item.assertions as Array<Record<string, unknown>>) || [])) {
        if (assertion.type === "must_contain" && assertion.value != null) {
          assertions.push(String(assertion.value));
        }
      }
      items.push({
        id: String(item.id || `eval-${index + 1}`),
        prompt: String(item.prompt || ""),
        expectedAnswer: String(item.expected_answer || ""),
        supportingFacts: supporting,
        assertions,
        category: String(item.category || ""),
        difficulty: String(item.difficulty || ""),
        referencedRows: parseReferencedRows([
          ...((item.referenced_rows as string[]) || []),
          String(item.source_location || ""),
        ]),
      });
    }
    return items;
  }

  // CSV eval file
  const { rows } = readTabularFile(resolved, encoding || undefined);
  return rows.map((row, index) => ({
    id: stableId("eval", row.prompt || "", String(index + 1)),
    prompt: row.prompt || "",
    expectedAnswer: row.expected_answer || "",
    supportingFacts: {},
    assertions: [],
    category: "",
    difficulty: "",
    referencedRows: parseReferencedRows([row.source_location || ""]),
  }));
}

//  Eval Indexes 

export function evalIndexes(
  evalItems: EvalItem[],
  config: EnhancerConfig
): {
  byRef: Map<string, EvalItem[]>;
  byEntityYear: Map<string, EvalItem[]>;
} {
  const byRef = new Map<string, EvalItem[]>();
  const byEntityYear = new Map<string, EvalItem[]>();

  const entityCandidates = config.keyFieldCandidates.entity || [];
  const yearCandidates = config.keyFieldCandidates.year || [];

  for (const item of evalItems) {
    for (const [filename, rowNumber] of item.referencedRows) {
      const key = `${filename}\u001f${rowNumber}`;
      if (!byRef.has(key)) byRef.set(key, []);
      byRef.get(key)!.push(item);
    }

    const entity = findFirst(item.supportingFacts, entityCandidates);
    const year = findFirst(item.supportingFacts, yearCandidates);
    if (entity && year) {
      const key = `${normalized(entity)}\u001f${normalized(year)}`;
      if (!byEntityYear.has(key)) byEntityYear.set(key, []);
      byEntityYear.get(key)!.push(item);
    }
  }

  return { byRef, byEntityYear };
}

export function rowValueForFact(row: Record<string, string>, factKey: string, config: EnhancerConfig): string {
  // 1. Exact case-insensitive row-key match
  const loweredRow: Record<string, string> = {};
  for (const k of Object.keys(row)) {
    loweredRow[k.toLowerCase()] = k;
  }
  const exactKey = loweredRow[factKey.toLowerCase()];
  if (exactKey && !isEmpty(row[exactKey] || "")) {
    return (row[exactKey] || "").trim();
  }

  // 2. Logical category name match
  const roleMap: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(config.keyFieldCandidates)) {
    roleMap[k.toLowerCase()] = v;
  }
  const roleCandidates = roleMap[factKey.toLowerCase()];
  if (roleCandidates !== undefined) {
    return findFirst(row, roleCandidates);
  }

  // 3. Candidate reverse-lookup
  const factCf = factKey.toLowerCase();
  const factNormalized = normalizeMetadataKey(factKey);
  for (const [rowKey, value] of Object.entries(row)) {
    if (isEmpty(value)) continue;
    const rowNormalized = normalizeMetadataKey(rowKey);
    if (rowNormalized === factNormalized || rowNormalized.endsWith(factNormalized)) {
      return value.trim();
    }
  }
  for (const candidates of Object.values(config.keyFieldCandidates)) {
    if (candidates.some(c => c.toLowerCase() === factCf)) {
      return findFirst(row, candidates);
    }
  }

  return "";
}

export function compatibleEvalMatches(
  row: Record<string, string>,
  basename: string,
  rowNumber: number,
  entity: string,
  year: string,
  byRef: Map<string, EvalItem[]>,
  byEntityYear: Map<string, EvalItem[]>,
  config: EnhancerConfig
): EvalItem[] {
  const matches = new Map<string, EvalItem>();

  const refKey = `${basename.toLowerCase()}\u001f${rowNumber}`;
  for (const item of byRef.get(refKey) || []) {
    matches.set(item.id, item);
  }

  const eyKey = `${normalized(entity)}\u001f${normalized(year)}`;
  for (const item of byEntityYear.get(eyKey) || []) {
    const presentFacts: Record<string, string> = {};
    for (const [key, expected] of Object.entries(item.supportingFacts)) {
      if (!isEmpty(expected) && !isEmpty(rowValueForFact(row, key, config))) {
        presentFacts[key] = expected;
      }
    }
    if (Object.keys(presentFacts).length > 0 &&
        Object.entries(presentFacts).every(([key, expected]) =>
          normalized(rowValueForFact(row, key, config)) === normalized(expected)
        )) {
      matches.set(item.id, item);
    }
  }

  return Array.from(matches.values());
}
//  Long Indicator & File Helpers ─

export function isLongIndicatorCsv(header: string[], config: EnhancerConfig): boolean {
  if (!config.hasExplicitLongConfig) return false;
  const li = config.longIndicatorColumns;
  const required = new Set([li.idColumn, li.nameColumn, li.entityColumn, li.yearColumn, li.valueColumn]);
  const headerSet = new Set(header);
  for (const r of required) {
    if (!headerSet.has(r)) return false;
  }
  return true;
}

export function naturalKey(
  row: Record<string, string>,
  relativePath: string,
  rowNumber: number,
  longIndicator: boolean,
  config: EnhancerConfig
): string {
  const entity = findFirst(row, config.keyFieldCandidates.entity || []);
  const year = findFirst(row, config.keyFieldCandidates.year || []);
  const iso = findFirst(row, config.keyFieldCandidates.iso || []);
  const li = config.longIndicatorColumns;
  const sep = "\u001f";
  if (longIndicator && row[li.idColumn] && entity && year) {
    return [relativePath, row[li.idColumn] || "", iso, entity, year].join(sep);
  }
  return [relativePath, iso, entity, year, "row", String(rowNumber)].join(sep);
}

export function datasetFiles(datasetPath: string, extensions: Set<string>, excludePath?: string, excludeFiles?: string[]): string[] {
  const resolved = path.resolve(datasetPath);
  const stat = fs.statSync(resolved);
  if (stat.isFile()) {
    const ext = path.extname(resolved).toLowerCase().replace(".", "");
    return extensions.has(ext) ? [resolved] : [];
  }
  const excludedResolved = new Set((excludeFiles || []).filter(f => f).map(f => path.resolve(f)));
  const results: string[] = [];
  function walk(dir: string): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (excludePath && (full === excludePath || full.startsWith(excludePath + path.sep))) {
        continue;
      }
      if (excludedResolved.has(path.resolve(full))) {
        continue;
      }
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase().replace(".", "");
        if (extensions.has(ext)) {
          results.push(full);
        }
      }
    }
  }
  walk(resolved);
  return results.sort();
}

export function collectEvalFieldCounts(evalItems: EvalItem[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of evalItems) {
    for (const key of Object.keys(item.supportingFacts)) {
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  return counts;
}

//  Record Building ─

export function orderedFields(header: string[], evalFieldCounts: Map<string, number>, config: EnhancerConfig): string[] {
  const priorityFields = config.priorityFields;
  function score(fieldName: string): [number, number, string] {
    if (priorityFields.includes(fieldName)) {
      return [0, priorityFields.indexOf(fieldName), fieldName];
    }
    const evalCount = evalFieldCounts.get(fieldName) || 0;
    if (evalCount > 0) {
      return [1, -evalCount, fieldName];
    }
    return [2, header.indexOf(fieldName), fieldName];
  }
  return [...header].sort((a, b) => {
    const sa = score(a);
    const sb = score(b);
    for (let i = 0; i < 3; i++) {
      if (sa[i] < sb[i]) return -1;
      if (sa[i] > sb[i]) return 1;
    }
    return 0;
  });
}

export function buildRecordContent(opts: {
  title: string;
  relativePath: string;
  rowNumber: number | null;
  row: Record<string, string>;
  header: string[];
  evalMatches: EvalItem[];
  evalFieldCounts: Map<string, number>;
  includeEvalPrompts: boolean;
  includeEvalAnswers: boolean;
  rowPurpose: string;
  config: EnhancerConfig;
}): string {
  const { title, relativePath, rowNumber, row, header, evalMatches, evalFieldCounts,
    includeEvalPrompts, includeEvalAnswers, rowPurpose, config } = opts;

  const entity = findFirst(row, config.keyFieldCandidates.entity || []);
  const year = findFirst(row, config.keyFieldCandidates.year || []);
  const nonEmptyFields = orderedFields(header, evalFieldCounts, config)
    .filter(f => !isEmpty(row[f]));
  const priorityFields = config.priorityFields;

  const keyEmptyFields: string[] = [];
  for (const f of priorityFields) {
    if (header.includes(f) && isEmpty(row[f])) {
      keyEmptyFields.push(f);
    }
  }
  for (const f of orderedFields(header, evalFieldCounts, config)) {
    if (evalFieldCounts.has(f) && isEmpty(row[f]) && !keyEmptyFields.includes(f)) {
      keyEmptyFields.push(f);
    }
  }
  const dedupedKeyEmpty = [...new Set(keyEmptyFields)].slice(0, 25);

  const lines: string[] = [
    `${title}${rowNumber !== null ? ` (sourceRow=${rowNumber})` : ""}`,
  ];
  lines.push("", "Key facts:");

  const keyFields: string[] = priorityFields.filter(f => f in row && !isEmpty(row[f]));
  const additionalEvalFields = nonEmptyFields
    .filter(f => !keyFields.includes(f) && (evalFieldCounts.get(f) || 0) > 0)
    .slice(0, 12);
  keyFields.push(...additionalEvalFields);

  for (const f of keyFields.slice(0, 28)) {
    lines.push(factLine(f, row[f], config));
  }

  const remaining = nonEmptyFields.filter(f => !keyFields.includes(f));
  if (remaining.length > 0) {
    lines.push("", "All populated fields:");
    for (const f of remaining) {
      lines.push(factLine(f, row[f], config));
    }
  }

  if (dedupedKeyEmpty.length > 0) {
    lines.push("", "Important fields with no value in this row:");
    lines.push("- " + dedupedKeyEmpty.join(", "));
  }

  if (includeEvalPrompts && evalMatches.length > 0) {
    lines.push("", "Example questions this record can answer:");
    for (const item of evalMatches.slice(0, 8)) {
      if (item.prompt) lines.push(`- ${item.prompt}`);
      if (includeEvalAnswers && item.expectedAnswer) {
        lines.push(`  Expected answer: ${item.expectedAnswer}`);
      }
    }
  }

  return lines.join("\n");
}
//  Item Generation ─

export function graphLikeItem(opts: {
  itemId: string;
  title: string;
  itemType: string;
  content: string;
  properties: Record<string, unknown>;
  aclMode: string;
}): Record<string, unknown> {
  const { itemId, title, itemType, content, properties, aclMode } = opts;
  const props: Record<string, unknown> = {
    title,
    itemType,
  };
  for (const [key, value] of Object.entries(properties)) {
    if (value !== null && value !== "") {
      props[key] = value;
    }
  }
  const item: Record<string, unknown> = {
    id: itemId,
    properties: props,
    content: { type: "text", value: content },
  };
  if (aclMode !== "none") {
    item.acl = [{ type: aclMode, value: aclMode, accessType: "grant" }];
  }
  return item;
}

export function itemUrl(relativePath: string, rowNumber?: number | null, urlPrefix: string = ""): string {
  if (urlPrefix) {
    const prefix = urlPrefix.replace(/\/+$/, "");
    const urlPath = relativePath.replace(/\\/g, "/").replace(/^\//, "");
    const base = `${prefix}/${urlPath}`;
    return rowNumber != null ? `${base}#row=${rowNumber}` : base;
  }
  const url = relativePath.replace(/\\/g, "/");
  return rowNumber != null ? `file:///${url}#row=${rowNumber}` : `file:///${url}`;
}

export function groupedItemUrl(entity: string, year: string, iso: string, sourceFiles: string, urlPrefix: string = ""): string {
  if (urlPrefix) {
    const prefix = urlPrefix.replace(/\/+$/, "");
    const parts = [entity, year, iso].filter(x => x).map(x => encodeURIComponent(x));
    const slug = parts.length > 0 ? parts.join("/") : "unknown";
    return `${prefix}/_grouped/${slug}`;
  }
  const urlPath = sourceFiles.replace(/\\/g, "/");
  return `file:///${urlPath}`;
}

function updateCoverage(coverage: EvalCoverage, evalMatches: EvalItem[], itemId: string, content: string): void {
  for (const evalItem of evalMatches) {
    coverage.matchedItems.add(evalItem.id);
    if (!coverage.matchedRecords.has(evalItem.id)) {
      coverage.matchedRecords.set(evalItem.id, []);
    }
    coverage.matchedRecords.get(evalItem.id)!.push(itemId);
    for (const assertion of evalItem.assertions) {
      if (assertion && content.includes(assertion)) {
        if (!coverage.assertionsFound.has(evalItem.id)) {
          coverage.assertionsFound.set(evalItem.id, new Set());
        }
        coverage.assertionsFound.get(evalItem.id)!.add(assertion);
      }
    }
  }
}

function updateFileStats(stats: FileStats, row: Record<string, string>, config: EnhancerConfig): void {
  stats.rowCount++;
  for (const [key, value] of Object.entries(row)) {
    if (!isEmpty(value)) {
      stats.nonEmptyCounts.set(key, (stats.nonEmptyCounts.get(key) || 0) + 1);
    }
  }
  const entity = findFirst(row, config.keyFieldCandidates.entity || []);
  const year = findFirst(row, config.keyFieldCandidates.year || []);
  if (entity) stats.entityExamples.set(entity, (stats.entityExamples.get(entity) || 0) + 1);
  if (year) stats.yearValues.add(year);
}

function buildDatasetOverviewContent(
  stats: FileStats,
  evalItems: EvalItem[],
  includeEvalPrompts: boolean,
  config: EnhancerConfig
): string {
  const populated = [...stats.nonEmptyCounts.entries()]
    .sort((a, b) => b[1] - a[1]);
  const entityExamples = [...stats.entityExamples.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([e]) => e)
    .join(", ");
  const years = [...stats.yearValues].sort((a, b) => {
    if (a.length !== b.length) return a.length - b.length;
    return a.localeCompare(b);
  });

  const lines: string[] = [
    `Title: Dataset guide \u2014 ${stats.relativePath}`,
    `Source file: ${stats.relativePath}`,
    `Rows: ${stats.rowCount}`,
    `Columns: ${stats.header.length}`,
  ];
  if (entityExamples) lines.push(`Common entities: ${entityExamples}`);
  if (years.length > 0) lines.push(`Year/date range: ${years[0]} to ${years[years.length - 1]}`);

  lines.push("", "Column glossary:");
  for (const fieldName of stats.header) {
    const count = stats.nonEmptyCounts.get(fieldName) || 0;
    lines.push(`- ${fieldName}: ${humanizeField(fieldName, config)}; populated in ${count} row(s)`);
  }

  if (populated.length > 0) {
    lines.push("", "Most populated fields:");
    lines.push("- " + populated.slice(0, 20).map(([f]) => f).join(", "));
  }

  if (includeEvalPrompts && evalItems.length > 0) {
    lines.push("", "Representative evaluation questions for this corpus:");
    for (const item of evalItems.slice(0, 8)) {
      if (item.prompt) lines.push(`- ${item.prompt}`);
    }
  }

  lines.push(
    "",
    "Retrieval guidance:",
    "- Use row records for exact entity/year lookups and multi-field metric questions.",
    "- Use this dataset guide for field meanings, abbreviations, units, and available columns.",
  );
  return lines.join("\n");
}

const GRAPH_SCHEMA_NAME_MAX_LENGTH = 32;

function graphSchemaPropertyName(sourceName: string, usedNames: Set<string>): string {
  const parts = sourceName.match(/[A-Za-z0-9]+/g) || [];
  let base = "field";
  if (parts.length > 0) {
    const firstPart = parts[0] || "";
    base = firstPart.charAt(0).toLowerCase() + firstPart.slice(1);
    base += parts.slice(1).map(part => part.charAt(0).toUpperCase() + part.slice(1)).join("");
  }
  if (!/^[A-Za-z]/.test(base)) {
    base = "field" + base.charAt(0).toUpperCase() + base.slice(1);
  }
  base = base.slice(0, GRAPH_SCHEMA_NAME_MAX_LENGTH);

  let candidate = base;
  let suffix = 2;
  while (usedNames.has(candidate)) {
    const suffixText = String(suffix);
    candidate = base.slice(0, GRAPH_SCHEMA_NAME_MAX_LENGTH - suffixText.length) + suffixText;
    suffix += 1;
  }
  usedNames.add(candidate);
  return candidate;
}

function schemaAliases(...aliases: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const alias of aliases) {
    const cleaned = alias.trim().replace(/\s+/g, " ");
    if (!cleaned || cleaned.length > 128 || !/^[A-Za-z][A-Za-z0-9 ]*$/.test(cleaned)) continue;
    const key = cleaned.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(cleaned);
    }
  }
  return result;
}

function schemaSuggestion(
  fileStats: FileStats[],
  evalFieldCounts: Map<string, number>,
  config: EnhancerConfig,
  hasNontabular: boolean = false,
): Record<string, unknown> {
  const allFields = new Map<string, number>();
  for (const stats of fileStats) {
    for (const [field, count] of stats.nonEmptyCounts) {
      allFields.set(field, (allFields.get(field) || 0) + count);
    }
  }

  const properties: Array<Record<string, unknown>> = [
    { name: "title", type: "String", isSearchable: true, isQueryable: true, isRetrievable: true, labels: ["title"], aliases: ["name", "heading"] },
    { name: "url", type: "String", isRetrievable: true, labels: ["url"] },
    { name: "iconUrl", type: "String", isRetrievable: true, labels: ["iconUrl"] },
    { name: "itemType", type: "String", isSearchable: false, isQueryable: true, isRetrievable: true, isRefinable: true, aliases: ["type", "recordType"] },
    { name: "sourceFile", type: "String", isSearchable: false, isQueryable: true, isRetrievable: true, isRefinable: true, aliases: ["file", "dataset", "source"] },
    { name: "sourceRow", type: "Int64", isQueryable: true, isRetrievable: true, aliases: ["row", "rowNumber"] },
    { name: "entityName", type: "String", isSearchable: false, isQueryable: true, isRetrievable: true, isRefinable: true, aliases: ["entity", "country", "region", "organization", "location"] },
    { name: "year", type: "String", isSearchable: false, isQueryable: true, isRetrievable: true, isRefinable: true, aliases: ["date", "period", "time"] },
    { name: "isoCode", type: "String", isSearchable: false, isQueryable: true, isRetrievable: true, isRefinable: true, isExactMatchRequired: true, aliases: ["iso", "countryCode"] },
    { name: "rowCount", type: "Int64", isQueryable: true, isRetrievable: true, aliases: ["records", "recordCount"] },
  ];

  // Document/chunk properties when non-tabular files are present
  if (hasNontabular) {
    properties.push(
      { name: "documentId", type: "String", isQueryable: true, isRetrievable: true, aliases: ["document", "sourceDocument"] },
      { name: "contentType", type: "String", isSearchable: false, isQueryable: true, isRetrievable: true, isRefinable: true, aliases: ["format", "fileType", "documentFormat", "mimeType"] },
      { name: "sectionPath", type: "String", isSearchable: false, isQueryable: true, isRetrievable: true, aliases: ["section", "heading", "headingPath"] },
      { name: "chunkIndex", type: "Int64", isQueryable: true, isRetrievable: true, aliases: ["chunk"] },
      { name: "chunkCount", type: "Int64", isQueryable: true, isRetrievable: true, aliases: ["totalParts", "totalSegments"] },
      { name: "author", type: "String", isSearchable: false, isQueryable: true, isRetrievable: true, aliases: ["creator", "writer"] },
      { name: "datePublished", type: "String", isSearchable: false, isQueryable: true, isRetrievable: true, aliases: ["publishedDate", "documentDate", "created"] },
    );
    const structuredProps: Array<Record<string, unknown>> = [
      { name: "recordId", type: "String", isSearchable: false, isQueryable: true, isRetrievable: true, isExactMatchRequired: true, aliases: ["id", "cmsDatasetId"] },
      { name: "summary", type: "String", isSearchable: true, isQueryable: false, isRetrievable: true, aliases: ["description", "abstract"] },
      { name: "recordType", type: "String", isSearchable: true, isQueryable: true, isRetrievable: true, aliases: ["type"] },
      { name: "lastModified", type: "String", isSearchable: false, isQueryable: true, isRetrievable: true, aliases: ["modified", "updated"] },
      { name: "cmsDatasetId", type: "String", isSearchable: false, isQueryable: true, isRetrievable: true, isExactMatchRequired: true, aliases: ["datasetId"] },
      { name: "cmsDatasetTitle", type: "String", isSearchable: true, isQueryable: true, isRetrievable: true, aliases: ["datasetTitle"] },
      { name: "measureName", type: "String", isSearchable: true, isQueryable: true, isRetrievable: true, aliases: ["measure"] },
      { name: "providerName", type: "String", isSearchable: true, isQueryable: true, isRetrievable: true, aliases: ["provider"] },
      { name: "facilityType", type: "String", isSearchable: true, isQueryable: true, isRetrievable: true, aliases: ["facility"] },
      { name: "reportingPeriod", type: "String", isSearchable: true, isQueryable: true, isRetrievable: true, aliases: ["period"] },
      { name: "geography", type: "String", isSearchable: true, isQueryable: true, isRetrievable: true, aliases: ["location"] },
      { name: "metricValue", type: "Double", isQueryable: true, isRetrievable: true, aliases: ["value"] },
      { name: "methodologyUrl", type: "String", isSearchable: true, isQueryable: true, isRetrievable: true, aliases: ["methodology"] },
      { name: "packageName", type: "String", isSearchable: true, isQueryable: true, isRetrievable: true },
      { name: "displayName", type: "String", isSearchable: true, isQueryable: true, isRetrievable: true },
      { name: "bytes", type: "Int64", isQueryable: true, isRetrievable: true },
      { name: "status", type: "String", isSearchable: true, isQueryable: true, isRetrievable: true },
    ];
    for (const prop of structuredProps) {
      if (!properties.some(existing => existing.name === prop.name)) properties.push(prop);
    }
  }

  const valueColCf = (config.longIndicatorColumns.valueColumn || "value").toLowerCase();
  const usedPropertyNames = new Set(properties.map(p => p.name as string));
  const sourceFieldMappings: Array<Record<string, unknown>> = [];
  if (hasNontabular) {
    sourceFieldMappings.push(
      { sourceField: "documentId", schemaProperty: "documentId", displayName: "Document ID" },
      { sourceField: "contentType", schemaProperty: "contentType", displayName: "Content type" },
      { sourceField: "sectionPath", schemaProperty: "sectionPath", displayName: "Section path" },
      { sourceField: "chunkIndex", schemaProperty: "chunkIndex", displayName: "Chunk index" },
      { sourceField: "chunkCount", schemaProperty: "chunkCount", displayName: "Chunk count" },
      { sourceField: "author", schemaProperty: "author", displayName: "Author" },
      { sourceField: "datePublished", schemaProperty: "datePublished", displayName: "Date published" },
    );
  }
  const propertyGuidance: Array<Record<string, unknown>> = properties.map(prop => ({
    name: prop.name,
    description: "Core connector property generated by the enhancer or populated by the connector pipeline.",
  }));
  const combined = new Map<string, number>();
  for (const [k, v] of evalFieldCounts) combined.set(k, (combined.get(k) || 0) + v);
  for (const [k, v] of allFields) combined.set(k, (combined.get(k) || 0) + v);
  const sorted = [...combined.entries()].sort((a, b) => b[1] - a[1]).slice(0, 80);

  for (const [fieldName] of sorted) {
    if (usedPropertyNames.has(fieldName)) continue;
    const propertyName = graphSchemaPropertyName(fieldName, usedPropertyNames);
    const displayName = humanizeField(fieldName, config);
    const aliases = displayName !== propertyName
      ? schemaAliases(fieldName, displayName)
      : schemaAliases(fieldName);
    const prop: Record<string, unknown> = {
      name: propertyName,
      type: "String",
      isSearchable: fieldName.toLowerCase() !== valueColCf,
      isQueryable: true,
      isRetrievable: true,
    };
    if (aliases.length > 0) {
      prop.aliases = aliases.slice(0, 10);
    }
    sourceFieldMappings.push({
      sourceField: fieldName,
      schemaProperty: propertyName,
      displayName,
    });
    propertyGuidance.push({
      name: propertyName,
      sourceField: fieldName,
      displayName,
      description: "Source tabular field kept as a structured property for exact filtering or display. Keep richer narrative context in externalItem.content.",
    });
    properties.push(prop);
  }

  let description = "Suggested Microsoft Graph connector schema for enhanced data.";
  if (hasNontabular && fileStats.length > 0) {
    description = "Suggested Microsoft Graph connector schema for enhanced tabular and document data.";
  } else if (hasNontabular) {
    description = "Suggested Microsoft Graph connector schema for enhanced document data.";
  } else if (fileStats.length > 0) {
    description = "Suggested Microsoft Graph connector schema for enhanced tabular data.";
  }

  const notes = [
    "This schema uses Graph connector labels arrays; register it before ingesting items and poll schema status until completed.",
    "No property is both searchable and refinable; those attributes are mutually exclusive.",
    "Refinable properties are intentionally limited to itemType, sourceFile, entityName, year, isoCode, and contentType because refinable cannot be added later via schema update.",
    "Populate url and iconUrl with valid absolute URLs in your connector pipeline before production ingestion.",
    "Use sourceFieldMappings to translate raw tabular column names to the Graph-safe schema property names during ingestion.",
    "Keep ACL assignment in the connector pipeline and use Entra object IDs or external groups according to source permissions.",
    "Keep exact source values as string properties when verbatim answers matter; precompute summary items for aggregate questions instead of relying on Copilot to sum across records.",
    "Use dataset guide and grouped long-format items to improve Copilot's understanding of tabular context.",
  ];
  if (hasNontabular) {
    notes.push("Document chunks use sectionPath and chunkIndex/chunkCount to preserve reading order and section context for Copilot retrieval.");
  }

  return {
    description,
    baseType: "microsoft.graph.externalItem",
    contentProperty: "Put the generated content.value text into the built-in externalItem content property; do not register content as a schema property.",
    semanticLabels: { title: "title", url: "url", iconUrl: "iconUrl" },
    properties,
    sourceFieldMappings,
    propertyGuidance,
    notes,
  };
}
//  Long Indicator Grouping ─

function buildLongIndicatorGroups(
  rowsByGroup: Map<string, Array<Record<string, string>>>,
  sourceFilesByGroup: Map<string, Set<string>>,
  config: EnhancerConfig
): Array<{ groupRow: Record<string, string>; indicatorLines: string[]; sourceFileList: string[] }> {
  const li = config.longIndicatorColumns;
  const idCol = li.idColumn;
  const nameCol = li.nameColumn;
  const entityCol = li.entityColumn;
  const yearCol = li.yearColumn;
  const valueCol = li.valueColumn;
  const isoCol = li.isoColumn || "";

  const results: Array<{ groupRow: Record<string, string>; indicatorLines: string[]; sourceFileList: string[] }> = [];

  const sortedKeys = [...rowsByGroup.keys()].sort();
  for (const key of sortedKeys) {
    const rows = rowsByGroup.get(key)!;
    const [entity, year, iso] = key.split("\u001f");
    const groupRow: Record<string, string> = {
      [entityCol]: entity,
      [yearCol]: year,
    };
    if (isoCol) groupRow[isoCol] = iso;

    const indicatorLines: string[] = [];
    const sortedRows = [...rows].sort((a, b) => (a[idCol] || "").localeCompare(b[idCol] || ""));
    for (const row of sortedRows) {
      const indicatorId = row[idCol] || "";
      const indicatorName = row[nameCol] || "";
      const value = row[valueCol] || "";
      if (isEmpty(value)) continue;
      const fieldName = indicatorId ? `${indicatorId} value` : indicatorName;
      groupRow[fieldName] = value;
      if (indicatorId && indicatorName) {
        indicatorLines.push(`- ${indicatorId} (${indicatorName}): ${displayValue(value, valueCol, config)}`);
      } else if (indicatorName) {
        indicatorLines.push(`- ${indicatorName}: ${displayValue(value, valueCol, config)}`);
      } else {
        indicatorLines.push(`- ${valueCol}: ${displayValue(value, valueCol, config)}`);
      }
    }
    if (indicatorLines.length > 0) {
      results.push({
        groupRow,
        indicatorLines,
        sourceFileList: [...(sourceFilesByGroup.get(key) || [])].sort(),
      });
    }
  }
  return results;
}

function groupedRecordTitle(groupRow: Record<string, string>, sourceFilesDisplay: string, config: EnhancerConfig): string {
  const entity = findFirst(groupRow, config.keyFieldCandidates.entity || []);
  const year = findFirst(groupRow, config.keyFieldCandidates.year || []);
  const label = config.longIndicatorColumns.groupLabel || "grouped long-format values";
  if (entity && year) return `${entity} (${year}) \u2014 ${label}`;
  if (entity) return `${entity} \u2014 ${label}`;
  return `${sourceFilesDisplay} \u2014 ${label}`;
}
//  Main Pipeline ─

export function run(args: RunArgs): Record<string, unknown> {
  const config = loadConfig(args.config || null);

  const datasetPath = path.resolve(args.dataset);
  if (!fs.existsSync(datasetPath)) {
    throw new Error(`Dataset path not found: ${datasetPath}`);
  }
  const outputPath = path.resolve(args.output);
  fs.mkdirSync(outputPath, { recursive: true });

  const evalItems = loadEvalItems(args.eval || null, args.encoding);
  const { byRef, byEntityYear } = evalIndexes(evalItems, config);
  const evalFieldCounts = collectEvalFieldCounts(evalItems);

  if (args.include_eval_prompts && !args.eval) {
    process.stderr.write("warning: --include-eval-prompts has no effect without --eval\n");
  }
  if (args.include_eval_answers && !args.eval) {
    process.stderr.write("warning: --include-eval-answers has no effect without --eval\n");
  }
  if (args.focus_on_eval && !args.eval) {
    process.stderr.write("warning: --focus-on-eval without --eval will suppress all row output (no rows match an empty eval set)\n");
  }

  const extensions = new Set(
    args.extensions.split(",")
      .map(e => e.trim().toLowerCase().replace(/^\./, ""))
      .filter(e => e)
  );
  if (extensions.size === 0) {
    throw new Error("--extensions must specify at least one file extension");
  }

  const urlPrefix = args.url_prefix || "";
  if (urlPrefix && !["http://", "https://", "file://"].some(s => urlPrefix.startsWith(s))) {
    throw new Error(`--url-prefix must start with http://, https://, or file://; got: '${urlPrefix}'`);
  }

  // Separate tabular and non-tabular extensions
  const tabularExtensions = new Set([...extensions].filter(e => !ALL_NON_TABULAR_EXTENSIONS.has(e)));
  const nontabularExtensions = new Set([...extensions].filter(e => ALL_NON_TABULAR_EXTENSIONS.has(e)));

  // Exclude eval/config files from dataset discovery
  const excludeFiles: string[] = [];
  if (args.eval) excludeFiles.push(path.resolve(args.eval));
  if (args.config) excludeFiles.push(path.resolve(args.config));

  const csvFiles = tabularExtensions.size > 0 ? datasetFiles(datasetPath, tabularExtensions, outputPath, excludeFiles) : [];
  const nontabularFiles = nontabularExtensions.size > 0 ? datasetFiles(datasetPath, nontabularExtensions, outputPath, excludeFiles) : [];

  // Warn when eval flags are used with non-tabular files
  if (nontabularFiles.length > 0 && args.eval) {
    process.stderr.write("warning: eval matching is only supported for tabular files; non-tabular files will not participate in eval matching\n");
  }

  if (csvFiles.length === 0 && nontabularFiles.length === 0) {
    process.stderr.write(
      `warning: no files with extension(s) {${[...extensions].sort().join(", ")}} found under ${datasetPath}\n`
    );
  }

  // Check for duplicate basenames
  const basenameCounts = new Map<string, number>();
  for (const f of csvFiles) {
    const bn = path.basename(f).toLowerCase();
    basenameCounts.set(bn, (basenameCounts.get(bn) || 0) + 1);
  }
  const duplicateBasenames = [...basenameCounts.entries()].filter(([, c]) => c > 1).map(([n]) => n);
  if (duplicateBasenames.length > 0) {
    process.stderr.write(
      `warning: duplicate filenames detected (${duplicateBasenames.sort().join(", ")}); eval row references by filename may match multiple files\n`
    );
  }

  const fileStats: FileStats[] = [];
  const skippedFiles: Array<{ file: string; reason: string }> = [];
  const coverage: EvalCoverage = {
    matchedItems: new Set(),
    matchedRecords: new Map(),
    assertionsFound: new Map(),
  };
  const nontabularStats: Array<{ file: string; contentType: string; chunkCount: number; titles: string[] }> = [];
  const nontabularContentTypes: string[] = [];

  let itemCount = 0;
  let documentItemsWritten = 0;
  const longGroups = new Map<string, Array<Record<string, string>>>();
  const longGroupSources = new Map<string, Set<string>>();

  const jsonlPath = path.join(outputPath, "enhanced-items.jsonl");
  const csvOutPath = path.join(outputPath, "enhanced-records.csv");
  const csvFields = [
    "id",
    "itemType",
    "title",
    "sourceFile",
    "sourceRow",
    "entityName",
    "year",
    "documentId",
    "contentType",
    "sectionPath",
    "chunkIndex",
    "chunkCount",
    "author",
    "datePublished",
    "content",
  ];

  const jsonlFd = fs.openSync(jsonlPath, "w");
  const csvFd = fs.openSync(csvOutPath, "w");
  fs.writeSync(csvFd, csvFields.join(",") + "\n", undefined, "utf-8");
  const writeItem = (item: Record<string, unknown>): void => {
    fs.writeSync(jsonlFd, JSON.stringify(item) + "\n", undefined, "utf-8");
    fs.writeSync(csvFd, writeCsvRow(item, csvFields), undefined, "utf-8");
  };

  const datasetIsDir = fs.statSync(datasetPath).isDirectory();

  for (const csvFile of csvFiles) {
    const relativePath = datasetIsDir
      ? path.relative(datasetPath, csvFile)
      : path.relative(path.dirname(datasetPath), csvFile);

    const { header, rows } = readTabularFile(csvFile, args.encoding);

    // Check for duplicate header names
    const headerCounts = new Map<string, number>();
    for (const h of header) {
      headerCounts.set(h, (headerCounts.get(h) || 0) + 1);
    }
    const dupHeaders = [...headerCounts.entries()].filter(([, c]) => c > 1).map(([n]) => n);
    if (dupHeaders.length > 0) {
      process.stderr.write(
        `warning: ${relativePath} has duplicate column name(s): ${dupHeaders.sort().join(", ")}; later values will overwrite earlier ones for these columns\n`
      );
    }

    const stats: FileStats = {
      relativePath,
      header,
      rowCount: 0,
      nonEmptyCounts: new Map(),
      entityExamples: new Map(),
      yearValues: new Set(),
      skippedReason: null,
    };

    const longIndicator = isLongIndicatorCsv(header, config);
    let rowsGeneratedForFile = 0;

    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
      const row = rows[rowIndex];
      const rowNumber = rowIndex + 1;
      updateFileStats(stats, row, config);

      const entity = findFirst(row, config.keyFieldCandidates.entity || []);
      const year = findFirst(row, config.keyFieldCandidates.year || []);
      const basename = path.basename(csvFile).toLowerCase();
      const matches = compatibleEvalMatches(row, basename, rowNumber, entity, year, byRef, byEntityYear, config);

      if (args.focus_on_eval && matches.length === 0) continue;
      if (args.max_records_per_file && rowsGeneratedForFile >= args.max_records_per_file) continue;

      if (longIndicator && (args.long_indicator_mode === "grouped" || args.long_indicator_mode === "both")) {
        const iso = findFirst(row, config.keyFieldCandidates.iso || []);
        if (entity && year) {
          const groupKey = [entity, year, iso].join("\u001f");
          if (!longGroups.has(groupKey)) longGroups.set(groupKey, []);
          longGroups.get(groupKey)!.push({ ...row });
          if (!longGroupSources.has(groupKey)) longGroupSources.set(groupKey, new Set());
          longGroupSources.get(groupKey)!.add(relativePath);
          rowsGeneratedForFile++;
        }
        if (args.long_indicator_mode === "grouped") continue;
      }

      if (header.length === 0 || Object.values(row).every(v => isEmpty(v))) continue;

      const titleEntity = entity || path.basename(csvFile, path.extname(csvFile));
      const titleYear = year ? ` (${year})` : "";
      const title = `${titleEntity}${titleYear} \u2014 ${path.basename(csvFile, path.extname(csvFile))}`;
      const itemId = stableId("row", naturalKey(row, relativePath, rowNumber, longIndicator, config));
      const content = buildRecordContent({
        title,
        relativePath,
        rowNumber,
        row,
        header,
        evalMatches: matches,
        evalFieldCounts,
        includeEvalPrompts: args.include_eval_prompts,
        includeEvalAnswers: args.include_eval_answers,
        rowPurpose: "Self-contained tabular record for exact lookup and multi-field retrieval.",
        config,
      });

      const properties: Record<string, unknown> = {
        url: itemUrl(relativePath, rowNumber, urlPrefix),
        sourceFile: relativePath,
        sourceRow: rowNumber,
        entityName: entity,
        year,
        isoCode: findFirst(row, config.keyFieldCandidates.iso || []),
      };
      for (const fieldName of header) {
        if (evalFieldCounts.has(fieldName) && !isEmpty(row[fieldName])) {
          properties[fieldName] = row[fieldName];
        }
      }

      const item = graphLikeItem({
        itemId,
        title,
        itemType: "record",
        content,
        properties,
        aclMode: args.acl_mode,
      });
      writeItem(item);
      updateCoverage(coverage, matches, itemId, content);
      rowsGeneratedForFile++;
      itemCount++;
    }

    if (stats.rowCount === 0) {
      stats.skippedReason = "No data rows found";
      skippedFiles.push({ file: relativePath, reason: stats.skippedReason });
    }
    fileStats.push(stats);
  }

  // Long indicator groups
  const li = config.longIndicatorColumns;
  const entityCol = li.entityColumn;
  const yearCol = li.yearColumn;
  const isoCol = li.isoColumn || "";

  for (const { groupRow, indicatorLines, sourceFileList } of buildLongIndicatorGroups(longGroups, longGroupSources, config)) {
    const entity = groupRow[entityCol] || "";
    const year = groupRow[yearCol] || "";
    const eyKey = `${normalized(entity)}\u001f${normalized(year)}`;
    const matches = byEntityYear.get(eyKey) || [];
    if (args.focus_on_eval && matches.length === 0) continue;

    const primarySource = sourceFileList[0] || "";
    const sourceFilesDisplay = sourceFileList.join(", ");
    const title = groupedRecordTitle(groupRow, sourceFilesDisplay, config);
    const header = Object.keys(groupRow);
    let content = buildRecordContent({
      title,
      relativePath: sourceFilesDisplay,
      rowNumber: null,
      row: groupRow,
      header,
      evalMatches: matches,
      evalFieldCounts,
      includeEvalPrompts: args.include_eval_prompts,
      includeEvalAnswers: args.include_eval_answers,
      rowPurpose: "Grouped long-format record; multiple related values are co-located for the same key fields.",
      config,
    });
    content += "\n\nGrouped values:\n" + indicatorLines.join("\n");

    const itemId = stableId("indicator-group", sourceFilesDisplay, entity, year, isoCol ? (groupRow[isoCol] || "") : "");
    const item = graphLikeItem({
      itemId,
      title,
      itemType: "grouped-record",
      content,
      properties: {
        url: groupedItemUrl(entity, year, isoCol ? (groupRow[isoCol] || "") : "", primarySource, urlPrefix),
        sourceFile: sourceFilesDisplay,
        entityName: entity,
        year,
        isoCode: isoCol ? (groupRow[isoCol] || "") : "",
      },
      aclMode: args.acl_mode,
    });
    writeItem(item);
    updateCoverage(coverage, matches, itemId, content);
    itemCount++;
  }

  // Dataset overviews
  if (!args.no_overviews) {
    for (const stats of fileStats) {
      if (stats.rowCount === 0) continue;
      const title = `Dataset guide \u2014 ${stats.relativePath}`;
      const content = buildDatasetOverviewContent(stats, evalItems, args.include_eval_prompts, config);
      const item = graphLikeItem({
        itemId: stableId("dataset-guide", stats.relativePath),
        title,
        itemType: "dataset-guide",
        content,
        properties: {
          url: itemUrl(stats.relativePath, null, urlPrefix),
          sourceFile: stats.relativePath,
          rowCount: stats.rowCount,
        },
        aclMode: args.acl_mode,
      });
      writeItem(item);
      itemCount++;
    }
  }

  // --- Non-tabular file processing ---
  for (const ntFile of nontabularFiles) {
    const relativePath = datasetIsDir
      ? path.relative(datasetPath, ntFile)
      : path.relative(path.dirname(datasetPath), ntFile);
    const ext = path.extname(ntFile).toLowerCase().replace(".", "");
    const documentType = CONTENT_TYPE_MAP[ext as keyof typeof CONTENT_TYPE_MAP] || "text";
    const mimeType = CONTENT_TYPE_MIME_MAP[documentType];

    if (documentType === "jsonl") {
      let emittedForFile = 0;
      const limit = args.max_records_per_file || Number.POSITIVE_INFINITY;
      for (const { doc, chunk, matches } of processJsonlFileStreaming(ntFile, relativePath, urlPrefix, byRef, byEntityYear, config)) {
        if (emittedForFile >= limit) break;
        const item = buildDocumentItem(chunk, doc, args.acl_mode);
        writeItem(item);
        const contentValue = (item.content as { value: string }).value;
        updateCoverage(
          coverage,
          dedupeEvalItems([...matches, ...contentOnlyEvalMatches(evalItems, contentValue)]),
          item.id as string,
          contentValue,
        );
        itemCount++;
        documentItemsWritten++;
        emittedForFile++;
      }
      if (emittedForFile === 0) {
        skippedFiles.push({ file: relativePath, reason: "No extractable document content found" });
        continue;
      }
      nontabularContentTypes.push(mimeType);
      nontabularStats.push({
        file: relativePath,
        contentType: mimeType,
        chunkCount: emittedForFile,
        titles: [fileStem(ntFile)],
      });
      continue;
    }

    let documents = processNontabularFile(ntFile, relativePath, mimeType, {
      urlPrefix,
    });
    if (documents.length === 0) {
      skippedFiles.push({ file: relativePath, reason: "No extractable document content found" });
      continue;
    }
    nontabularContentTypes.push(mimeType);
    if (args.max_records_per_file) {
      // Smoke-test cap: limit emitted chunks while preserving each chunk's
      // original chunkCount metadata so downstream consumers know the full
      // document size even when only a prefix is written.
      documents = documents.slice(0, args.max_records_per_file);
    }
    nontabularStats.push({
      file: relativePath,
      contentType: mimeType,
      chunkCount: documents.length,
      titles: [...new Set(documents.map(({ doc }) => doc.title))].slice(0, 10),
    });

    for (const { doc, chunk } of documents) {
      const item = buildDocumentItem(chunk, doc, args.acl_mode);
      writeItem(item);
      updateCoverage(
        coverage,
        contentOnlyEvalMatches(evalItems, (item.content as { value: string }).value),
        item.id as string,
        (item.content as { value: string }).value,
      );
      itemCount++;
      documentItemsWritten++;
    }
  }
  fs.closeSync(jsonlFd);
  fs.closeSync(csvFd);

  // Unmatched eval items
  const unmatchedEvalItems = evalItems
    .filter(item => !coverage.matchedItems.has(item.id))
    .map(item => ({
      id: item.id,
      prompt: item.prompt,
      supportingFacts: item.supportingFacts,
      referencedRows: item.referencedRows.map(([f, r]) => `${f}:row ${r}`),
    }));

  const assertionGaps: Array<{ id: string; prompt: string; missingAssertions: string[] }> = [];
  for (const item of evalItems) {
    const found = coverage.assertionsFound.get(item.id) || new Set();
    const missing = item.assertions.filter(a => !found.has(a)).sort();
    if (missing.length > 0) {
      assertionGaps.push({ id: item.id, prompt: item.prompt, missingAssertions: missing });
    }
  }

  const report: Record<string, unknown> = {
    dataset: datasetPath,
    eval: args.eval ? path.resolve(args.eval) : null,
    config: args.config ? path.resolve(args.config) : null,
    output: outputPath,
    itemsWritten: itemCount,
    filesProcessed: csvFiles.length + nontabularFiles.length,
    tabularFilesProcessed: csvFiles.length,
    nontabularFilesProcessed: nontabularFiles.length,
    nontabularContentTypes: [...new Set(nontabularContentTypes)].sort(),
    filesSkipped: skippedFiles,
    evalItems: evalItems.length,
    evalItemsMatched: coverage.matchedItems.size,
    evalItemsUnmatched: unmatchedEvalItems.length,
    evalAssertionGaps: assertionGaps.length,
    longIndicatorMode: args.long_indicator_mode,
    includeEvalPrompts: args.include_eval_prompts,
    includeEvalAnswers: args.include_eval_answers,
    outputs: {
      jsonl: jsonlPath,
      csv: csvOutPath,
      report: path.join(outputPath, "enhancement-report.json"),
      schemaSuggestion: path.join(outputPath, "schema-suggestion.json"),
    },
  };

  fs.writeFileSync(
    path.join(outputPath, "enhancement-report.json"),
    JSON.stringify({
      ...report,
      unmatchedEvalItems,
      assertionGaps,
      fileStats: fileStats.map(stats => ({
        file: stats.relativePath,
        rows: stats.rowCount,
        columns: stats.header,
        topEntities: [...stats.entityExamples.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10)
          .map(([entity, count]) => [entity, count]),
        yearCount: stats.yearValues.size,
        skippedReason: stats.skippedReason,
      })),
      nontabularStats,
    }, null, 2),
    "utf-8"
  );

  fs.writeFileSync(
    path.join(outputPath, "schema-suggestion.json"),
    JSON.stringify(schemaSuggestion(fileStats, evalFieldCounts, config, documentItemsWritten > 0), null, 2),
    "utf-8"
  );

  fs.writeFileSync(
    path.join(outputPath, "unmatched-eval-items.json"),
    JSON.stringify(unmatchedEvalItems, null, 2),
    "utf-8"
  );

  return report;
}
//  CSV Output Helper ─

function escapeCsvField(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n") || value.includes("\r")) {
    return '"' + value.replace(/"/g, '""') + '"';
  }
  return value;
}

function writeCsvRow(item: Record<string, unknown>, fields: string[]): string {
  const props = item.properties as Record<string, unknown>;
  const contentObj = item.content as { value: string };
  const row: Record<string, string> = {
    id: String(item.id || ""),
    itemType: String(props.itemType || ""),
    title: String(props.title || ""),
    sourceFile: String(props.sourceFile || ""),
    sourceRow: String(props.sourceRow || ""),
    entityName: String(props.entityName || ""),
    year: String(props.year || ""),
    documentId: String(props.documentId || ""),
    contentType: String(props.contentType || ""),
    sectionPath: String(props.sectionPath || ""),
    chunkIndex: String(props.chunkIndex || ""),
    chunkCount: String(props.chunkCount || ""),
    author: String(props.author || ""),
    datePublished: String(props.datePublished || ""),
    content: contentObj.value,
  };
  return fields.map(f => escapeCsvField(row[f] || "")).join(",") + "\n";
}

//  CLI Argument Parsing 

export function parseArgs(argv: string[]): RunArgs {
  const args: RunArgs = {
    dataset: "",
    output: "",
    extensions: "csv,tsv",
    long_indicator_mode: "grouped",
    include_eval_prompts: false,
    include_eval_answers: false,
    focus_on_eval: false,
    no_overviews: false,
    max_records_per_file: 0,
    acl_mode: "none",
    url_prefix: "",
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--version":
        console.log("data-enhancer 0.1.0");
        process.exit(0);
        break;
      case "--dataset":
        args.dataset = argv[++i] || "";
        break;
      case "--eval":
        args.eval = argv[++i] || "";
        break;
      case "--output":
        args.output = argv[++i] || "";
        break;
      case "--config":
        args.config = argv[++i] || "";
        break;
      case "--extensions":
        args.extensions = argv[++i] || "csv,tsv";
        break;
      case "--long-indicator-mode":
        args.long_indicator_mode = (argv[++i] || "grouped") as RunArgs["long_indicator_mode"];
        break;
      case "--include-eval-prompts":
        args.include_eval_prompts = true;
        break;
      case "--include-eval-answers":
        args.include_eval_answers = true;
        break;
      case "--focus-on-eval":
        args.focus_on_eval = true;
        break;
      case "--no-overviews":
        args.no_overviews = true;
        break;
      case "--max-records-per-file":
        args.max_records_per_file = parseInt(argv[++i] || "0", 10);
        break;
      case "--acl-mode":
        args.acl_mode = (argv[++i] || "none") as RunArgs["acl_mode"];
        break;
      case "--encoding":
        args.encoding = argv[++i] || undefined;
        break;
      case "--url-prefix":
        args.url_prefix = argv[++i] || "";
        break;
      default:
        if (arg.startsWith("--")) {
          process.stderr.write(`error: unrecognized argument: ${arg}\n`);
          process.exit(2);
        }
        break;
    }
  }

  if (!args.dataset) {
    process.stderr.write("error: --dataset is required\n");
    process.exit(2);
  }
  if (!args.output) {
    process.stderr.write("error: --output is required\n");
    process.exit(2);
  }
  if (args.include_eval_answers && !args.include_eval_prompts) {
    process.stderr.write("error: --include-eval-answers requires --include-eval-prompts\n");
    process.exit(2);
  }

  return args;
}

export function main(argv?: string[]): number {
  try {
    const report = run(parseArgs(argv || process.argv.slice(2)));
    console.log(JSON.stringify(report, null, 2));
    return 0;
  } catch (exc: unknown) {
    process.stderr.write(`error: ${(exc as Error).message}\n`);
    return 1;
  }
}

if (require.main === module) {
  process.exit(main());
}
