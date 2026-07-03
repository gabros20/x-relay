import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBatch, runDedupe } from '../src/commands/batch.ts';
import type { Engine } from '../src/engine/index.ts';
import { EngineError } from '../src/engine/index.ts';
import { progressReporter } from '../src/progress.ts';
import type { ArchiveFile, ArchiveTweet, Metrics, SearchResult, Tweet } from '../src/types.ts';

// ── temp-dir bookkeeping ─────────────────────────────────────────────────────
const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'xrelay-batch-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function queryFile(lines: string[]): string {
  const path = join(tmp(), 'queries.txt');
  writeFileSync(path, lines.join('\n'), 'utf-8');
  return path;
}

// ── fixtures ─────────────────────────────────────────────────────────────────
function tw(id: string, metrics: Metrics = {}): Tweet {
  return {
    id,
    url: `https://x.com/i/status/${id}`,
    text: `t${id}`,
    author: { id, handle: 'h', name: 'N', verified: false },
    metrics,
  };
}

function atw(id: string, metrics: Metrics = {}): ArchiveTweet {
  return {
    id,
    url: `https://x.com/i/status/${id}`,
    text: `a${id}`,
    author: { id, handle: 'h', name: 'N', verified: false },
    metrics,
  };
}

/** A minimal Engine that records queries and returns per-query tweets or throws. */
function searchEngine(results: Record<string, Tweet[] | EngineError>, calls: string[]): Engine {
  return {
    async search(query: string): Promise<SearchResult> {
      calls.push(query);
      const r = results[query];
      if (r instanceof EngineError) throw r;
      return { query, product: 'Top', tweets: r ?? [] };
    },
  } as unknown as Engine;
}

function sleepSpy(): { fn: (ms: number) => Promise<void>; calls: number[] } {
  const calls: number[] = [];
  const fn = (ms: number): Promise<void> => {
    calls.push(ms);
    return Promise.resolve();
  };
  return { fn, calls };
}

// ── progressReporter ─────────────────────────────────────────────────────────
describe('progressReporter', () => {
  test('writes msg + newline when not quiet', () => {
    const out: string[] = [];
    progressReporter(false, (s) => out.push(s))('searching 1/2: ai');
    expect(out).toEqual(['searching 1/2: ai\n']);
  });

  test('quiet suppresses all writes', () => {
    const out: string[] = [];
    progressReporter(true, (s) => out.push(s))('anything');
    expect(out).toEqual([]);
  });
});

// ── runBatch: serialization + progress ───────────────────────────────────────
describe('runBatch serialization', () => {
  test('runs queries in file order with delay between each (not after last)', async () => {
    const calls: string[] = [];
    const sleep = sleepSpy();
    const progress: string[] = [];
    const env = await runBatch(
      searchEngine({ a: [], b: [], c: [] }, calls),
      { file: queryFile(['a', 'b', 'c']), stdout: true, delay: 1500 },
      { sleep: sleep.fn, progress: (m) => progress.push(m) },
    );
    expect(env.ok).toBe(true);
    expect(calls).toEqual(['a', 'b', 'c']);
    // delay sits BETWEEN queries — two gaps for three queries, none after the last.
    expect(sleep.calls).toEqual([1500, 1500]);
    expect(progress).toEqual(['searching 1/3: a', 'searching 2/3: b', 'searching 3/3: c']);
  });
});

// ── runBatch: dedupe across queries ──────────────────────────────────────────
describe('runBatch dedupe', () => {
  test('dedupes by tweet id across queries; per-query counts are raw result sizes', async () => {
    const calls: string[] = [];
    const env = await runBatch(
      searchEngine({ a: [tw('1'), tw('2')], b: [tw('2'), tw('3')] }, calls),
      { file: queryFile(['a', 'b']), stdout: true, delay: 0 },
      { sleep: sleepSpy().fn, progress: () => {} },
    );
    if (!env.ok) throw new Error('expected ok');
    expect(env.data.totalUnique).toBe(3);
    expect(env.data.perQuery.map((q) => q.count)).toEqual([2, 2]);
    expect(env.data.archive?.tweets.map((t) => t.id).sort()).toEqual(['1', '2', '3']);
  });
});

// ── runBatch: continue-on-error + rate-limit backoff ─────────────────────────
describe('runBatch continue-on-error', () => {
  test('a failing query records its error and the loop keeps going', async () => {
    const calls: string[] = [];
    const env = await runBatch(
      searchEngine(
        { a: [tw('1')], b: new EngineError('FETCH_FAILED', 'boom'), c: [tw('2')] },
        calls,
      ),
      { file: queryFile(['a', 'b', 'c']), stdout: true, delay: 100 },
      { sleep: sleepSpy().fn, progress: () => {} },
    );
    if (!env.ok) throw new Error('expected ok');
    expect(calls).toEqual(['a', 'b', 'c']); // c still ran after b failed
    expect(env.data.perQuery[1]?.error?.code).toBe('FETCH_FAILED');
    expect(env.data.succeeded).toBe(2);
    expect(env.data.failed).toBe(1);
    expect(env.data.totalUnique).toBe(2);
  });

  test('RATE_LIMITED waits retryAfterMs (not delay) before the next query', async () => {
    const calls: string[] = [];
    const sleep = sleepSpy();
    const env = await runBatch(
      searchEngine(
        { a: [tw('1')], b: new EngineError('RATE_LIMITED', 'slow down', 429, 5000), c: [tw('2')] },
        calls,
      ),
      { file: queryFile(['a', 'b', 'c']), stdout: true, delay: 2000 },
      { sleep: sleep.fn, progress: () => {} },
    );
    if (!env.ok) throw new Error('expected ok');
    // gap after a = delay; gap after b (rate-limited) = retryAfterMs.
    expect(sleep.calls).toEqual([2000, 5000]);
    expect(env.data.perQuery[1]?.error).toEqual({ code: 'RATE_LIMITED', retryAfterMs: 5000 });
    expect(calls).toContain('c');
  });
});

// ── runBatch: file parsing + validation ──────────────────────────────────────
describe('runBatch file handling', () => {
  test('skips blank lines and # comments', async () => {
    const calls: string[] = [];
    await runBatch(
      searchEngine({ a: [], b: [] }, calls),
      { file: queryFile(['a', '', '# a comment', '   ', 'b']), stdout: true, delay: 0 },
      { sleep: sleepSpy().fn, progress: () => {} },
    );
    expect(calls).toEqual(['a', 'b']);
  });

  test('missing --file → INVALID_INPUT', async () => {
    const env = await runBatch(
      searchEngine({}, []),
      { file: join(tmp(), 'nope.txt'), stdout: true },
      { sleep: sleepSpy().fn, progress: () => {} },
    );
    expect(env.ok).toBe(false);
    if (env.ok) throw new Error('expected err');
    expect(env.error.code).toBe('INVALID_INPUT');
  });

  test('empty file (only comments/blanks) → INVALID_INPUT', async () => {
    const env = await runBatch(
      searchEngine({}, []),
      { file: queryFile(['', '# nothing here', '  ']), stdout: true },
      { sleep: sleepSpy().fn, progress: () => {} },
    );
    expect(env.ok).toBe(false);
    if (env.ok) throw new Error('expected err');
    expect(env.error.code).toBe('INVALID_INPUT');
  });

  test('neither --out nor --stdout → INVALID_INPUT', async () => {
    const env = await runBatch(
      searchEngine({ a: [] }, []),
      { file: queryFile(['a']) },
      { sleep: sleepSpy().fn, progress: () => {} },
    );
    expect(env.ok).toBe(false);
    if (env.ok) throw new Error('expected err');
    expect(env.error.code).toBe('INVALID_INPUT');
  });

  test('--out merges into an archive file on disk and records queries as provenance', async () => {
    const calls: string[] = [];
    const out = join(tmp(), 'merged.json');
    const env = await runBatch(
      searchEngine({ a: [tw('1')], b: [tw('2')] }, calls),
      { file: queryFile(['a', 'b']), out, delay: 0 },
      { sleep: sleepSpy().fn, progress: () => {} },
    );
    if (!env.ok) throw new Error('expected ok');
    expect(env.data.out).toBe(out);
    const file = JSON.parse(readFileSync(out, 'utf-8')) as ArchiveFile & { queries?: string[] };
    expect(file.schema).toBe('x-relay/archive@1');
    expect(file.count).toBe(2);
    expect(file.queries).toEqual(['a', 'b']);
  });
});

// ── runDedupe ────────────────────────────────────────────────────────────────
describe('runDedupe', () => {
  function searchEnvelopeFile(tweets: Tweet[]): string {
    const path = join(tmp(), 'search.json');
    writeFileSync(
      path,
      JSON.stringify({ ok: true, command: 'search', data: { query: 'x', product: 'Top', tweets } }),
      'utf-8',
    );
    return path;
  }
  function archiveFile(tweets: ArchiveTweet[]): string {
    const path = join(tmp(), 'archive.json');
    const file: ArchiveFile = {
      schema: 'x-relay/archive@1',
      source: 'bookmarks',
      generatedAt: '2026-01-01T00:00:00.000Z',
      count: tweets.length,
      tweets,
    };
    writeFileSync(path, JSON.stringify(file), 'utf-8');
    return path;
  }

  test('merges a search envelope + an archive file, deduping by id', () => {
    const s = searchEnvelopeFile([tw('1'), tw('2')]);
    const a = archiveFile([atw('2'), atw('3')]);
    const out = join(tmp(), 'out.json');
    const env = runDedupe({ files: [s, a], out });
    if (!env.ok) throw new Error('expected ok');
    expect(env.data.files).toBe(2);
    expect(env.data.totalIn).toBe(4);
    expect(env.data.totalUnique).toBe(3);
    const file = JSON.parse(readFileSync(out, 'utf-8')) as ArchiveFile;
    expect(file.count).toBe(3);
    expect(file.tweets.map((t) => t.id).sort()).toEqual(['1', '2', '3']);
  });

  test('--stdout returns the merged archive in the envelope', () => {
    const s = searchEnvelopeFile([tw('1')]);
    const env = runDedupe({ files: [s], stdout: true });
    if (!env.ok) throw new Error('expected ok');
    expect(env.data.out).toBeUndefined();
    expect(env.data.archive?.tweets.map((t) => t.id)).toEqual(['1']);
  });

  test('--sort engagement orders the merged tweets by score', () => {
    const s = searchEnvelopeFile([
      tw('1', { likes: 1 }),
      tw('100', { likes: 100 }),
      tw('10', { likes: 10 }),
    ]);
    const out = join(tmp(), 'out.json');
    const env = runDedupe({ files: [s], out, sort: 'engagement' });
    if (!env.ok) throw new Error('expected ok');
    const file = JSON.parse(readFileSync(out, 'utf-8')) as ArchiveFile;
    expect(file.tweets.map((t) => t.id)).toEqual(['100', '10', '1']);
  });

  test('an unreadable / unrecognized file → INVALID_INPUT naming the file', () => {
    const bad = join(tmp(), 'bad.json');
    writeFileSync(bad, JSON.stringify({ not: 'a known shape' }), 'utf-8');
    const env = runDedupe({ files: [bad], stdout: true });
    expect(env.ok).toBe(false);
    if (env.ok) throw new Error('expected err');
    expect(env.error.code).toBe('INVALID_INPUT');
    expect(env.error.message).toContain(bad);
  });

  test('no input files → INVALID_INPUT', () => {
    const env = runDedupe({ files: [], stdout: true });
    expect(env.ok).toBe(false);
    if (env.ok) throw new Error('expected err');
    expect(env.error.code).toBe('INVALID_INPUT');
  });

  test('neither --out nor --stdout → INVALID_INPUT', () => {
    const s = searchEnvelopeFile([tw('1')]);
    const env = runDedupe({ files: [s] });
    expect(env.ok).toBe(false);
    if (env.ok) throw new Error('expected err');
    expect(env.error.code).toBe('INVALID_INPUT');
  });
});
