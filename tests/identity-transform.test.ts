import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runIdentityTransform } from '../src/identity-transform';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ccw-identity-'));
}

function readSchema(outputDir: string) {
  return JSON.parse(fs.readFileSync(path.join(outputDir, 'schema-suggestion.json'), 'utf-8'));
}

function readItems(outputDir: string): Array<Record<string, unknown>> {
  return fs.readFileSync(path.join(outputDir, 'enhanced-items.jsonl'), 'utf-8')
    .split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

describe('runIdentityTransform — basic CSV', () => {
  it('infers a Graph-shaped schema from source columns and emits 1:1 items', async () => {
    const root = tempDir();
    const dataset = path.join(root, 'data');
    fs.mkdirSync(dataset);
    fs.writeFileSync(path.join(dataset, 'people.csv'),
      'id,name,year,score\n1,Alice,2024,87\n2,Bob,2023,42\n');
    const out = path.join(root, 'out');

    const result = await runIdentityTransform({ dataset, outputDir: out, aclMode: 'everyone' });

    expect(result.itemCount).toBe(2);
    const schema = readSchema(out);
    expect(schema.baseType).toBe('microsoft.graph.externalItem');
    const names = schema.properties.map((p: any) => p.name);
    expect(names).toContain('id');
    expect(names).toContain('name');
    expect(names).toContain('year');
    expect(names).toContain('score');
    // `title` label is promoted onto the matching source column (`name`), not a separate property.
    const nameProp = schema.properties.find((p: any) => p.name === 'name');
    expect(nameProp.labels).toContain('title');
    // `url` and `iconUrl` have no source match so they are injected as stand-alone properties.
    expect(names).toContain('url');
    expect(names).toContain('iconUrl');

    const items = readItems(out);
    expect(items[0].properties).toMatchObject({ id: '1', name: 'Alice', year: '2024' });
    expect(items[0].properties.title).toBe('Alice');  // value derived from `name`
  });
});

describe('runIdentityTransform — type preservation', () => {
  it('keeps leading-zero numbers as String', async () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, 'a.csv'), 'zipcode,value\n02134,10\n09001,20\n');
    const out = path.join(root, 'out');
    await runIdentityTransform({ dataset: root, outputDir: out, aclMode: 'everyone' });
    const schema = readSchema(out);
    const zip = schema.properties.find((p: any) => p.name === 'zipcode');
    expect(zip.type).toBe('String');
    const value = schema.properties.find((p: any) => p.name === 'value');
    expect(value.type).toBe('Int64');
  });

  it('keeps year column as String even when numeric', async () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, 'a.csv'), 'year,count\n2024,10\n2023,12\n');
    const out = path.join(root, 'out');
    await runIdentityTransform({ dataset: root, outputDir: out, aclMode: 'everyone' });
    const schema = readSchema(out);
    expect(schema.properties.find((p: any) => p.name === 'year').type).toBe('String');
  });

  it('keeps *_id, *_code, *_no fields as String (sanitized to camelCase)', async () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, 'a.csv'), 'user_id,country_code,phone_no\n42,US,5551234\n');
    const out = path.join(root, 'out');
    await runIdentityTransform({ dataset: root, outputDir: out, aclMode: 'everyone' });
    const schema = readSchema(out);
    // Source columns sanitize to camelCase Graph-safe names; underscore preserve rule still triggers on the source name.
    for (const propName of ['userId', 'countryCode', 'phoneNo']) {
      const prop = schema.properties.find((p: any) => p.name === propName);
      expect(prop?.type, `${propName} should be String`).toBe('String');
    }
  });

  it('keeps values that exceed JS safe integer range as String', async () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, 'a.csv'), 'longid,value\n9999999999999999999,1\n');
    const out = path.join(root, 'out');
    await runIdentityTransform({ dataset: root, outputDir: out, aclMode: 'everyone' });
    const schema = readSchema(out);
    expect(schema.properties.find((p: any) => p.name === 'longid').type).toBe('String');
  });

  it('keeps scientific-notation values as String', async () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, 'a.csv'), 'measurement,note\n1.23e10,big\n');
    const out = path.join(root, 'out');
    await runIdentityTransform({ dataset: root, outputDir: out, aclMode: 'everyone' });
    const schema = readSchema(out);
    expect(schema.properties.find((p: any) => p.name === 'measurement').type).toBe('String');
  });

  it('infers DateTime for ISO date columns', async () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, 'a.csv'), 'eventOn,note\n2024-01-15T10:00:00Z,foo\n2024-02-01,bar\n');
    const out = path.join(root, 'out');
    await runIdentityTransform({ dataset: root, outputDir: out, aclMode: 'everyone' });
    const schema = readSchema(out);
    expect(schema.properties.find((p: any) => p.name === 'eventOn').type).toBe('DateTime');
  });
});

describe('runIdentityTransform — name sanitization', () => {
  it('sanitizes spaces and punctuation, and disambiguates collisions', async () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, 'a.csv'), 'First Name,first.name,first-name\nAlice,Alpha,Anna\n');
    const out = path.join(root, 'out');
    await runIdentityTransform({ dataset: root, outputDir: out, aclMode: 'everyone' });
    const schema = readSchema(out);
    const names = schema.properties.map((p: any) => p.name);
    // Three distinct sanitized names
    const firstNameLikes = names.filter((n: string) => /first/i.test(n));
    expect(new Set(firstNameLikes).size).toBe(firstNameLikes.length);
    expect(firstNameLikes.length).toBe(3);
    // sourceFieldMappings records the original column names
    expect(schema.sourceFieldMappings).toContainEqual({ sourceField: 'First Name', schemaProperty: expect.any(String) });
  });

  it('prefixes leading-digit columns with a letter', async () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, 'a.csv'), '1stCol,2ndCol\nx,y\n');
    const out = path.join(root, 'out');
    await runIdentityTransform({ dataset: root, outputDir: out, aclMode: 'everyone' });
    const schema = readSchema(out);
    for (const prop of schema.properties.filter((p: any) => /col/i.test(p.name))) {
      expect(/^[A-Za-z]/.test(prop.name)).toBe(true);
    }
  });

  it('keeps every schema property within 32 characters', async () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, 'a.csv'),
      'this_is_a_very_long_column_name_that_should_be_truncated\nval\n');
    const out = path.join(root, 'out');
    await runIdentityTransform({ dataset: root, outputDir: out, aclMode: 'everyone' });
    const schema = readSchema(out);
    for (const prop of schema.properties) {
      expect(prop.name.length).toBeLessThanOrEqual(32);
    }
  });
});

describe('runIdentityTransform — semantic labels', () => {
  it('promotes a source name column to the title label', async () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, 'a.csv'), 'name,year\nAlice,2024\n');
    const out = path.join(root, 'out');
    const result = await runIdentityTransform({ dataset: root, outputDir: out, aclMode: 'everyone' });
    expect(result.metadataProvenance.titleFromSource).toBeCloseTo(1.0);
    const item = readItems(out)[0];
    expect((item.properties as any).title).toBe('Alice');
  });

  it('falls back to <sourceFile> row <n> when no source title column exists', async () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, 'a.csv'), 'value\n42\n');
    const out = path.join(root, 'out');
    const result = await runIdentityTransform({ dataset: root, outputDir: out, aclMode: 'everyone' });
    expect(result.metadataProvenance.titleFromSource).toBe(0);
    const item = readItems(out)[0];
    expect((item.properties as any).title).toMatch(/row 1/);
  });

  it('uses url-prefix when no url source column exists', async () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, 'a.csv'), 'value\n42\n');
    const out = path.join(root, 'out');
    await runIdentityTransform({ dataset: root, outputDir: out, aclMode: 'everyone', urlPrefix: 'https://example.com' });
    const item = readItems(out)[0];
    expect((item.properties as any).url).toMatch(/^https:\/\/example\.com\//);
  });
});

describe('runIdentityTransform — nested JSON', () => {
  it('flattens nested objects deterministically', async () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, 'data.json'), JSON.stringify([
      { id: 'a', address: { city: 'NYC', zip: '10001' }, tags: ['x', 'y'] },
    ]));
    const out = path.join(root, 'out');
    await runIdentityTransform({ dataset: root, outputDir: out, aclMode: 'everyone' });
    const schema = readSchema(out);
    const names = schema.properties.map((p: any) => p.name);
    // 'address.city' and 'address.zip' get sanitized to camelCase addressCity / addressZip
    expect(names).toContain('addressCity');
    expect(names).toContain('addressZip');
    expect(names).toContain('tags');
    const item = readItems(out)[0];
    expect((item.properties as any).addressCity).toBe('NYC');
    expect((item.properties as any).addressZip).toBe('10001');
    expect((item.properties as any).tags).toBe('x, y');
  });

  it('handles JSONL-as-.json (newline-delimited)', async () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, 'data.json'),
      `{"id":"a","value":1}\n{"id":"b","value":2}\n`);
    const out = path.join(root, 'out');
    const result = await runIdentityTransform({ dataset: root, outputDir: out, aclMode: 'everyone' });
    expect(result.itemCount).toBe(2);
  });
});

describe('runIdentityTransform — no enrichment leak', () => {
  it('does not emit synthetic recordId / summary / domain properties', async () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, 'a.csv'), 'value\n1\n');
    const out = path.join(root, 'out');
    await runIdentityTransform({ dataset: root, outputDir: out, aclMode: 'everyone' });
    const schema = readSchema(out);
    const names = schema.properties.map((p: any) => p.name);
    for (const forbidden of ['recordId', 'summary', 'recordType', 'lastModified', 'domain']) {
      expect(names).not.toContain(forbidden);
    }
  });

  it('does not emit dataset-overview items', async () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, 'a.csv'), 'value\n1\n2\n3\n');
    const out = path.join(root, 'out');
    const result = await runIdentityTransform({ dataset: root, outputDir: out, aclMode: 'everyone' });
    // 3 source rows = 3 items, period.
    expect(result.itemCount).toBe(3);
  });

  it('caps content.value at 4000 chars and appends a truncation marker', async () => {
    // Build a row whose serialized "k: v" lines exceed the cap. We pad a single
    // text column past 4000 chars to keep the construction simple.
    const root = tempDir();
    const padding = 'x'.repeat(5000);
    fs.writeFileSync(path.join(root, 'wide.csv'), `id,description\n1,${padding}\n`);
    const out = path.join(root, 'out');
    await runIdentityTransform({ dataset: root, outputDir: out, aclMode: 'everyone' });
    const items = fs.readFileSync(path.join(out, 'enhanced-items.jsonl'), 'utf-8')
      .split('\n').filter(Boolean).map((line) => JSON.parse(line));
    expect(items).toHaveLength(1);
    const content = items[0].content.value as string;
    // 4000 cap + a single newline + the truncation marker; well under 4200.
    expect(content.length).toBeLessThan(4200);
    expect(content).toMatch(/\(truncated; \d+ chars elided\)$/);
    // Properties still carry the full untyped value (no truncation in props).
    expect(String(items[0].properties.description)).toHaveLength(5000);
  });
});
