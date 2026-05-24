// src/custom/enhancer.ts
// Enhancement logic: transforms raw source items into ExternalItem payloads.
//
// FAIL CLOSED: if enhancement fails for any reason, throws EnhancementError.
// The caller (crawl.ts) must NEVER ingest an item that failed enhancement.
//
// [Customization point] Extend transformProperties() to add domain-specific
// field mappings, computed fields, or content enrichment.

import { connectorSchema } from '../references/schema';

export interface RawItem {
  id?: string;
  [key: string]: unknown;
}

export interface ExternalItem {
  id: string;
  acl: AclEntry[];
  properties: Record<string, unknown>;
  content: { type: 'text' | 'html'; value: string };
}

export interface AclEntry {
  accessType: 'grant' | 'deny';
  type: 'everyone' | 'everyoneExceptGuests' | 'user' | 'group' | 'externalGroup';
  value: string;
}

export class EnhancementError extends Error {
  constructor(message: string, public readonly itemId: string) {
    super(message);
    this.name = 'EnhancementError';
  }
}

const MAX_ITEM_BYTES = 4 * 1024 * 1024; // 4 MB Microsoft Graph limit

/**
 * Enhance a raw source item into a Microsoft Graph ExternalItem payload.
 *
 * Throws EnhancementError if:
 *  - item is missing a string 'id'
 *  - resulting payload exceeds 4 MB
 *
 * @param raw  Raw item from your data source
 * @param aclMode  ACL strategy to apply
 */
export function enhance(
  raw: RawItem,
  aclMode: 'everyone' | 'everyoneExceptGuests' | 'none' = 'everyone'
): ExternalItem {
  const id = raw.id;
  if (!id || typeof id !== 'string') {
    throw new EnhancementError(
      `Item missing required string 'id'. Got: ${JSON.stringify(id)}`,
      String(id ?? '<missing>')
    );
  }

  const properties = transformProperties(raw);
  const content = buildContentString(raw, properties);
  const acl = buildAcl(aclMode, raw);

  const item: ExternalItem = { id, acl, properties, content: { type: 'text', value: content } };

  const sizeBytes = Buffer.byteLength(JSON.stringify(item), 'utf-8');
  if (sizeBytes > MAX_ITEM_BYTES) {
    throw new EnhancementError(
      `Item '${id}' exceeds 4 MB limit (${sizeBytes} bytes). Reduce content length.`,
      id
    );
  }

  return item;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function transformProperties(raw: RawItem): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const prop of connectorSchema.properties) {
    const rawValue = raw[prop.name] ?? findByAlias(raw, (prop as any).aliases) ?? fallbackValue(raw, prop.name);
    if (rawValue == null) continue;
    try {
      out[prop.name] = coerceValue(rawValue, prop.type as string);
    } catch {
      // Skip properties that fail coercion rather than failing the whole item
    }
  }
  return out;
}

function fallbackValue(raw: RawItem, propName: string): unknown {
  if (propName === 'title') {
    return firstValue(raw, ['title', 'primaryName', 'name', 'companyName', 'organizationName', 'duns', 'id']);
  }
  if (propName === 'url') {
    const existing = firstValue(raw, ['url', 'sourceUrl', 'link']);
    return existing || `file:///external-items/${encodeURIComponent(String(raw.id))}`;
  }
  if (propName === 'iconUrl') {
    return firstValue(raw, ['iconUrl', 'icon', 'imageUrl']) || 'https://res.cdn.office.net/assets/mail/file-icon/png/generic_16x16.png';
  }
  return undefined;
}

function firstValue(raw: RawItem, keys: string[]): unknown {
  for (const key of keys) {
    const value = raw[key];
    if (value !== null && value !== undefined && String(value).trim() !== '') return value;
  }
  return undefined;
}

/**
 * Build a rich content string for full-text search and Copilot summarization.
 *
 * [Customization point] Override this to produce domain-specific content.
 * Lead with the most important information; include all searchable fields.
 */
function buildContentString(raw: RawItem, mapped: Record<string, unknown>): string {
  const parts: string[] = [];
  // Use mapped properties first (schema-validated)
  for (const [k, v] of Object.entries(mapped)) {
    if (v == null || v === '') continue;
    const display = Array.isArray(v) ? (v as unknown[]).join(', ') : String(v);
    parts.push(`${k}: ${display}`);
  }
  // Append any raw fields not captured by schema (extra context for search)
  for (const [k, v] of Object.entries(raw)) {
    if (k === 'id' || k in mapped || v == null || v === '') continue;
    if (typeof v === 'object') continue;
    parts.push(`${k}: ${String(v)}`);
  }
  return parts.join('\n');
}

function findByAlias(raw: RawItem, aliases: string[] | undefined): unknown {
  if (!aliases) return undefined;
  for (const alias of aliases) {
    if (raw[alias] != null) return raw[alias];
  }
  return undefined;
}

function coerceValue(v: unknown, type: string): unknown {
  switch (type) {
    case 'Int64':
      return typeof v === 'number' ? Math.trunc(v) : parseInt(String(v), 10);
    case 'Double':
      return typeof v === 'number' ? v : parseFloat(String(v));
    case 'Boolean':
      return typeof v === 'boolean' ? v : String(v).toLowerCase() === 'true';
    case 'DateTime':
      if (typeof v === 'string') return v;
      if (v instanceof Date) return v.toISOString();
      return new Date(v as number).toISOString();
    case 'StringCollection':
      return Array.isArray(v) ? v.map(String) : [String(v)];
    default:
      return typeof v === 'string' ? v : String(v);
  }
}

/**
 * Build ACL entries for the item.
 *
 * [Customization point] For user/group-specific ACLs, override this function
 * to return per-user or per-group Entra ID object IDs.
 * See: https://learn.microsoft.com/graph/connecting-external-content-manage-items
 */
function buildAcl(
  mode: 'everyone' | 'everyoneExceptGuests' | 'none',
  _raw: RawItem
): AclEntry[] {
  if (mode === 'none') return [];
  return [{ accessType: 'grant', type: mode, value: mode }];
}
