import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isMainModule, shouldForceEntry, shouldRunAsEntry } from '../src/entry.ts';

const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'xrelay-entry-'));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

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
    const dir = makeTmpDir();
    const file = join(dir, 'cli.js');
    writeFileSync(file, '// x');
    expect(isMainModule(file, pathToFileURL(file).href, undefined)).toBe(true);
  });

  test('unequal plain paths → false', () => {
    const dir = makeTmpDir();
    const a = join(dir, 'a.js');
    const b = join(dir, 'b.js');
    writeFileSync(a, '// a');
    writeFileSync(b, '// b');
    expect(isMainModule(a, pathToFileURL(b).href, undefined)).toBe(false);
  });

  test('symlink argv1 resolves to real module path → true', () => {
    const dir = makeTmpDir();
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

describe('shouldRunAsEntry', () => {
  const BINS = ['xrelay', 'cli.js'];

  test('detected as main → run, no warning', () => {
    expect(shouldRunAsEntry('/anything', 'file:///different', true, BINS)).toEqual({
      run: true,
      warning: undefined,
    });
  });

  test('undefined runtime answer + matching bin basename → force-run with warning', () => {
    const decision = shouldRunAsEntry(
      '/usr/local/bin/xrelay',
      'file:///real/cli.js',
      undefined,
      BINS,
    );
    expect(decision.run).toBe(true);
    expect(decision.warning).toBe(
      'xrelay: entry detection failed — treating as main; report at github.com/gabros20/x-relay/issues',
    );
  });

  test('warning label comes from binNames[0]', () => {
    const decision = shouldRunAsEntry(
      '/usr/local/bin/x-relay-mcp',
      'file:///real/mcp-shim.js',
      undefined,
      ['x-relay-mcp', 'mcp-shim.js'],
    );
    expect(decision.warning).toBe(
      'x-relay-mcp: entry detection failed — treating as main; report at github.com/gabros20/x-relay/issues',
    );
  });

  test('import.meta.main === false is authoritative — never force-run even with matching basename', () => {
    // The definitive-false gap: a runtime that explicitly says "not main" must
    // NOT be overridden by the bin-basename heuristic.
    expect(shouldRunAsEntry('/usr/local/bin/xrelay', 'file:///real/cli.js', false, BINS)).toEqual({
      run: false,
      warning: undefined,
    });
  });

  test('undefined runtime answer + non-matching basename → no run, no warning', () => {
    expect(
      shouldRunAsEntry('/usr/local/bin/other', 'file:///real/cli.js', undefined, BINS),
    ).toEqual({ run: false, warning: undefined });
  });
});
