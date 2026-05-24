import { describe, it, expect } from 'vitest';
import { _test, GraphProperty } from '../src/steps/step3-schema';

const { hardenSchema, validateSchema, collectAliases, softEnsureIconUrl } = _test;

// ---------------------------------------------------------------------------
// collectAliases
// ---------------------------------------------------------------------------
describe('collectAliases', () => {
  it('returns empty array when no alias fields are present', () => {
    expect(collectAliases({})).toEqual([]);
    expect(collectAliases({ name: 'foo', type: 'String' })).toEqual([]);
  });

  it('collects array-valued aliases field', () => {
    const aliases = collectAliases({ aliases: ['shortName', 'sn'] });
    expect(aliases).toEqual(['shortName', 'sn']);
  });

  it('collects string-valued aliases field (split by comma)', () => {
    const aliases = collectAliases({ aliases: 'shortName, sn' });
    expect(aliases).toEqual(['shortName', 'sn']);
  });

  it('collects alternateNames field', () => {
    const aliases = collectAliases({ alternateNames: ['alt1', 'alt2'] });
    expect(aliases).toEqual(['alt1', 'alt2']);
  });

  it('deduplicates aliases from both fields', () => {
    const aliases = collectAliases({ aliases: ['a', 'b'], alternateNames: ['b', 'c'] });
    expect(aliases).toContain('a');
    expect(aliases).toContain('b');
    expect(aliases).toContain('c');
    expect(aliases.filter((x) => x === 'b').length).toBe(1);
  });

  it('drops aliases that Graph schema registration would reject', () => {
    const aliases = collectAliases({ aliases: ['primaryName', 'primary Name', '2bad', 'good_alias'] });
    expect(aliases).toEqual(['primaryName', 'good_alias']);
  });
});

// ---------------------------------------------------------------------------
// softEnsureIconUrl
// ---------------------------------------------------------------------------
describe('softEnsureIconUrl', () => {
  it('does nothing when iconUrl label is already assigned', () => {
    const props: GraphProperty[] = [
      { name: 'myIcon', type: 'String', labels: ['iconUrl'], isRetrievable: true },
    ];
    softEnsureIconUrl(props);
    expect(props[0].labels).toEqual(['iconUrl']);
  });

  it('promotes iconUrl label on a property named iconUrl', () => {
    const props: GraphProperty[] = [
      { name: 'title', type: 'String', labels: ['title'], isRetrievable: true },
      { name: 'iconUrl', type: 'String', isRetrievable: true },
    ];
    softEnsureIconUrl(props);
    expect(props[1].labels).toContain('iconUrl');
    expect(props[1].isRetrievable).toBe(true);
  });

  it('promotes iconUrl label on a property named icon_url', () => {
    const props: GraphProperty[] = [
      { name: 'icon_url', type: 'String' },
    ];
    softEnsureIconUrl(props);
    expect(props[0].labels).toContain('iconUrl');
    expect(props[0].isRetrievable).toBe(true);
  });

  it('does NOT inject a new iconUrl property when none exists', () => {
    const props: GraphProperty[] = [
      { name: 'title', type: 'String', labels: ['title'], isRetrievable: true },
      { name: 'url', type: 'String', labels: ['url'], isRetrievable: true },
    ];
    softEnsureIconUrl(props);
    expect(props.length).toBe(2);
    expect(props.every((p) => !p.labels?.includes('iconUrl'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validateSchema — iconUrl warning
// ---------------------------------------------------------------------------
describe('validateSchema — iconUrl', () => {
  it('warns when no property has the iconUrl semantic label', () => {
    const schema = hardenSchema([
      { name: 'title', type: 'String', labels: ['title'], isRetrievable: true, isSearchable: true },
      { name: 'url', type: 'String', labels: ['url'], isRetrievable: true },
    ]);
    const issues = validateSchema(schema);
    const iconUrlWarning = issues.find(
      (i) => i.severity === 'warning' && i.message.includes('iconUrl'),
    );
    expect(iconUrlWarning).toBeDefined();
  });

  it('does not warn when iconUrl label is present', () => {
    const schema = hardenSchema([
      { name: 'title', type: 'String', labels: ['title'], isRetrievable: true, isSearchable: true },
      { name: 'url', type: 'String', labels: ['url'], isRetrievable: true },
      { name: 'iconUrl', type: 'String', labels: ['iconUrl'], isRetrievable: true },
    ]);
    const issues = validateSchema(schema);
    const iconUrlWarning = issues.find(
      (i) => i.severity === 'warning' && i.message.includes('iconUrl'),
    );
    expect(iconUrlWarning).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// hardenSchema — aliases round-trip
// ---------------------------------------------------------------------------
describe('hardenSchema — aliases', () => {
  it('preserves aliases from schema-suggestion properties', () => {
    const schema = hardenSchema([
      {
        name: 'title',
        type: 'String',
        labels: ['title'],
        isRetrievable: true,
        isSearchable: true,
        aliases: ['subject', 'heading'],
      },
      { name: 'url', type: 'String', labels: ['url'], isRetrievable: true },
    ]);
    const titleProp = schema.properties.find((p) => p.name === 'title');
    expect(titleProp?.aliases).toEqual(expect.arrayContaining(['subject', 'heading']));
  });

  it('collects aliases from alternateNames', () => {
    const schema = hardenSchema([
      { name: 'title', type: 'String', labels: ['title'], isRetrievable: true, isSearchable: true },
      { name: 'url', type: 'String', labels: ['url'], isRetrievable: true },
      {
        name: 'summary',
        type: 'String',
        alternateNames: ['description', 'desc'],
      },
    ]);
    const summaryProp = schema.properties.find((p) => p.name === 'summary');
    expect(summaryProp?.aliases).toEqual(expect.arrayContaining(['description', 'desc']));
  });

  it('omits aliases field when none are defined', () => {
    const schema = hardenSchema([
      { name: 'title', type: 'String', labels: ['title'], isRetrievable: true, isSearchable: true },
      { name: 'url', type: 'String', labels: ['url'], isRetrievable: true },
    ]);
    const titleProp = schema.properties.find((p) => p.name === 'title');
    // aliases should either be absent or empty
    expect(!titleProp?.aliases || titleProp.aliases.length === 0).toBe(true);
  });
});
