import { describe, expect, test } from 'bun:test';
import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isMainModule, shouldForceEntry } from '../src/entry.ts';

describe('isMainModule', () => {
  test('importMetaMain === true short-circuits to true', () => {
    expect(isMainModule('/anything', 'file:///different', true)).toBe(true);
  });

  test('importMetaMain === false short-circuits to false', () => {
    // Even when paths would otherwise match, an explicit false wins.
    const p = '/some/real/path.js';
    expect(isMainModule(p, pathToFileURL(p).href, false)).toBe(false);
  });

  test('equal plain paths → true (import.meta.main undefined)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'xrelay-entry-'));
    const file = join(dir, 'cli.js');
    writeFileSync(file, '// x');
    expect(isMainModule(file, pathToFileURL(file).href, undefined)).toBe(true);
  });

  test('unequal plain paths → false', () => {
    const dir = mkdtempSync(join(tmpdir(), 'xrelay-entry-'));
    const a = join(dir, 'a.js');
    const b = join(dir, 'b.js');
    writeFileSync(a, '// a');
    writeFileSync(b, '// b');
    expect(isMainModule(a, pathToFileURL(b).href, undefined)).toBe(false);
  });

  test('symlink argv1 resolves to real module path → true', () => {
    const dir = mkdtempSync(join(tmpdir(), 'xrelay-entry-'));
    const real = join(dir, 'cli.js');
    const link = join(dir, 'xrelay');
    writeFileSync(real, '// real');
    symlinkSync(real, link);
    // argv1 is the symlink (npm bin), moduleUrl points at the real file.
    expect(isMainModule(link, pathToFileURL(real).href, undefined)).toBe(true);
  });

  test('nonexistent argv1 falls back to plain compare → false when unequal', () => {
    expect(isMainModule('/no/such/path', 'file:///other/path', undefined)).toBe(false);
  });

  test('nonexistent argv1 equal to plain module path → true', () => {
    const missing = '/no/such/path.js';
    expect(isMainModule(missing, pathToFileURL(missing).href, undefined)).toBe(true);
  });

  test('undefined argv1 → false', () => {
    expect(isMainModule(undefined, 'file:///x', undefined)).toBe(false);
  });
});

describe('shouldForceEntry', () => {
  test('argv1 basename matching a bin name → true', () => {
    expect(shouldForceEntry('/usr/local/bin/xrelay', ['xrelay', 'cli.js'])).toBe(true);
    expect(shouldForceEntry('/some/dist/cli.js', ['xrelay', 'cli.js'])).toBe(true);
  });

  test('argv1 basename not matching → false', () => {
    expect(shouldForceEntry('/usr/local/bin/other', ['xrelay', 'cli.js'])).toBe(false);
  });

  test('undefined argv1 → false', () => {
    expect(shouldForceEntry(undefined, ['xrelay', 'cli.js'])).toBe(false);
  });
});
