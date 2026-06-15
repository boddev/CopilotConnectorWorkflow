import { describe, expect, it } from 'vitest';
import { objectHash } from '../src/jobs';

describe('objectHash', () => {
  it('depends on nested input content', () => {
    const a = objectHash([{ dataset: 'x', extensions: ['csv'] }]);
    const b = objectHash([{ dataset: 'x', extensions: ['json'] }]);
    expect(a).not.toBe(b);
  });

  it('is stable regardless of key insertion order', () => {
    const a = objectHash([{ a: 1, b: 2, nested: { x: 1, y: 2 } }]);
    const b = objectHash([{ b: 2, a: 1, nested: { y: 2, x: 1 } }]);
    expect(a).toBe(b);
  });

  it('distinguishes differing nested values', () => {
    const a = objectHash([{ nested: { count: 1 } }]);
    const b = objectHash([{ nested: { count: 2 } }]);
    expect(a).not.toBe(b);
  });

  it('ignores undefined-valued keys (matches JSON omission)', () => {
    const a = objectHash([{ a: 1, b: undefined }]);
    const b = objectHash([{ a: 1 }]);
    expect(a).toBe(b);
  });
});
