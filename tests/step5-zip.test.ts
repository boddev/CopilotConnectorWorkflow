/**
 * Round-trip coverage for the tiny zip writer in step5-deploy.ts.
 * The writer is internal to Step 5 but exported for tests so we can guard
 * against accidental regressions in CRC32 / EOCD layout.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writeStoreZip } from '../src/steps/step5-deploy';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ccw-zip-'));
}

/**
 * Minimal in-process ZIP parser that walks the EOCD → central directory and
 * extracts each STORE entry. Sufficient for tests; we never need to handle
 * DEFLATE because writeStoreZip never emits it.
 */
function readStoreZip(zipPath: string): Map<string, Buffer> {
  const buf = fs.readFileSync(zipPath);
  // Find EOCD signature (0x06054b50) by scanning from the end of the file.
  let eocdOff = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocdOff = i; break; }
  }
  if (eocdOff < 0) throw new Error('EOCD not found');
  const cdCount = buf.readUInt16LE(eocdOff + 10);
  const cdOff = buf.readUInt32LE(eocdOff + 16);
  const out = new Map<string, Buffer>();
  let p = cdOff;
  for (let i = 0; i < cdCount; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central dir sig');
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const cmtLen = buf.readUInt16LE(p + 32);
    const lfhOff = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf-8');
    // Walk to the local file header to find the data start.
    const lfhNameLen = buf.readUInt16LE(lfhOff + 26);
    const lfhExtraLen = buf.readUInt16LE(lfhOff + 28);
    const dataStart = lfhOff + 30 + lfhNameLen + lfhExtraLen;
    out.set(name, buf.slice(dataStart, dataStart + compSize));
    p += 46 + nameLen + extraLen + cmtLen;
  }
  return out;
}

describe('writeStoreZip (Step 5 helper)', () => {
  it('round-trips files in a flat directory with intact bytes', () => {
    const dir = tempDir();
    const src = path.join(dir, 'src');
    fs.mkdirSync(src);
    fs.writeFileSync(path.join(src, 'a.json'), '{"foo":1}');
    fs.writeFileSync(path.join(src, 'b.txt'), 'hello world\n');
    // Include a binary-ish file with all byte values to stress CRC32.
    const bin = Buffer.alloc(256);
    for (let i = 0; i < 256; i++) bin[i] = i;
    fs.writeFileSync(path.join(src, 'c.bin'), bin);

    const zipPath = path.join(dir, 'out.zip');
    writeStoreZip(src, zipPath);
    expect(fs.existsSync(zipPath)).toBe(true);

    const entries = readStoreZip(zipPath);
    expect([...entries.keys()].sort()).toEqual(['a.json', 'b.txt', 'c.bin']);
    expect(entries.get('a.json')!.toString('utf-8')).toBe('{"foo":1}');
    expect(entries.get('b.txt')!.toString('utf-8')).toBe('hello world\n');
    expect(entries.get('c.bin')!.equals(bin)).toBe(true);
  });

  it('skips any pre-existing appPackage.zip in srcDir (avoids self-inclusion)', () => {
    const dir = tempDir();
    const src = path.join(dir, 'src');
    fs.mkdirSync(src);
    fs.writeFileSync(path.join(src, 'manifest.json'), '{}');
    fs.writeFileSync(path.join(src, 'appPackage.zip'), 'STALE');

    const zipPath = path.join(dir, 'src', 'appPackage.zip');
    writeStoreZip(src, zipPath);
    const entries = readStoreZip(zipPath);
    expect([...entries.keys()]).toEqual(['manifest.json']);
  });

  it('produces a zip that the in-process parser can read end-to-end (EOCD layout is well-formed)', () => {
    const dir = tempDir();
    const src = path.join(dir, 'src');
    fs.mkdirSync(src);
    fs.writeFileSync(path.join(src, 'data.txt'), 'roundtrip');
    const zipPath = path.join(dir, 'out.zip');
    writeStoreZip(src, zipPath);

    const entries = readStoreZip(zipPath);
    expect(entries.get('data.txt')!.toString('utf-8')).toBe('roundtrip');
  });
});
