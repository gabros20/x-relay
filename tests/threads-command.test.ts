import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildArchiveOpts, buildRepairOpts, isCookieless, parseArgs } from '../src/cli.ts';
import { runThreadRepair } from '../src/commands/repair.ts';
import { runArchive, runThread } from '../src/commands/runners.ts';
import { type Engine, EngineError } from '../src/engine/index.ts';
import type { ArchiveFile, ArchiveTweet, SelfThreadResult, Tweet } from '../src/types.ts';

const author = { id: '1', handle: 'a', name: 'A', verified: false };
const OLD = '2026-10-01T00:00:00+00:00';

function post(id: string, replies = 2): ArchiveTweet {
  return {
    id,
    url: `https://x.com/a/status/${id}`,
    text: `post ${id}`,
    author,
    metrics: { replies },
    createdAtISO: OLD,
  };
}
const tweet = (id: string): Tweet => ({
  id,
  url: `https://x.com/a/status/${id}`,
  text: `cont ${id}`,
  author,
  metrics: {},
});

function fakeEngine(
  opts: { bookmarks?: ArchiveTweet[]; threads?: Record<string, string[]>; failOn?: string } = {},
) {
  const calls: string[] = [];
  const engine = {
    archiveBookmarks: async () => opts.bookmarks ?? [],
    async selfThread(id: string): Promise<SelfThreadResult> {
      calls.push(id);
      if (id === opts.failOn) throw new EngineError('RATE_LIMITED', 'slow down', 429);
      return {
        root: tweet(id),
        thread: (opts.threads?.[id] ?? []).map(tweet),
        pages: 1,
        complete: true,
      };
    },
  } as unknown as Engine;
  return { engine, calls };
}

let dir: string | undefined;
function tempArchive(tweets: ArchiveTweet[], indent = 2): string {
  dir = mkdtempSync(join(tmpdir(), 'xrelay-threads-'));
  const path = join(dir, 'archive.json');
  const file: ArchiveFile = {
    schema: 'x-relay/archive@1',
    source: 'bookmarks',
    generatedAt: 'x',
    count: tweets.length,
    tweets,
  };
  writeFileSync(path, `${JSON.stringify(file, null, indent)}\n`);
  return path;
}
const read = (path: string) => JSON.parse(readFileSync(path, 'utf-8')) as ArchiveFile;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('flags', () => {
  test('archive --threads --delay', () => {
    const opts = buildArchiveOpts(
      parseArgs(['archive', 'bookmarks', '--out', 'f.json', '--threads', '--delay', '1500']),
    );
    expect(opts.threads).toBe(true);
    expect(opts.threadDelayMs).toBe(1500);
  });

  test('repair --threads needs the logged-in engine; repair --media stays cookie-less', () => {
    expect(isCookieless(parseArgs(['archive', 'repair', 'f.json', '--media']))).toBe(true);
    const parsed = parseArgs([
      'archive',
      'repair',
      'f.json',
      '--threads',
      '--limit',
      '300',
      '--delay',
      '4000',
    ]);
    expect(isCookieless(parsed)).toBe(false);
    expect(buildRepairOpts(parsed)).toMatchObject({
      file: 'f.json',
      threads: true,
      limit: 300,
      delay: 4000,
    });
  });
});

describe('archive --threads', () => {
  test('looks up threads for the newly added posts only and stores them', async () => {
    const path = tempArchive([post('100')]);
    const { engine, calls } = fakeEngine({
      bookmarks: [post('300'), post('200', 0), post('100')],
      threads: { '300': ['301', '302'] },
    });
    const res = await runArchive(engine, {
      target: 'bookmarks',
      out: path,
      threads: true,
      threadDelayMs: 0,
    });
    expect(res.ok).toBe(true);
    expect(calls).toEqual(['300']); // 200 has no replies, 100 was already archived
    const saved = read(path).tweets.find((t) => t.id === '300');
    expect(saved?.thread?.map((t) => t.id)).toEqual(['301', '302']);
    expect(saved?.threadCheckedAt).toBeDefined();
    expect(res.ok && res.data.threads).toMatchObject({
      checked: 1,
      withThread: 1,
      threadPosts: 2,
      pending: 0,
    });
  });

  test('without --threads nothing is looked up', async () => {
    const path = tempArchive([]);
    const { engine, calls } = fakeEngine({ bookmarks: [post('300')] });
    await runArchive(engine, { target: 'bookmarks', out: path });
    expect(calls).toEqual([]);
  });

  test('a rate limit never fails the archive pull itself', async () => {
    const path = tempArchive([]);
    const { engine } = fakeEngine({ bookmarks: [post('300'), post('200')], failOn: '300' });
    const res = await runArchive(engine, {
      target: 'bookmarks',
      out: path,
      threads: true,
      threadDelayMs: 0,
    });
    expect(res.ok).toBe(true);
    expect(read(path).count).toBe(2);
    expect(res.ok && res.data.threads?.stopped?.code).toBe('RATE_LIMITED');
    expect(res.ok && res.data.threads?.pending).toBe(2);
  });
});

describe('archive repair --threads', () => {
  test('backfills the backlog in check order, stamps, writes in the file’s own style', async () => {
    const path = tempArchive(
      [post('100'), post('300'), { ...post('200'), text: 'launch 🧵' }, post('400', 0)],
      1,
    );
    const { engine, calls } = fakeEngine({ threads: { '200': ['201'] } });
    const res = await runThreadRepair(engine, { file: path, threads: true, delay: 0, quiet: true });
    expect(calls).toEqual(['200', '300', '100']);
    expect(res.ok && res.data).toMatchObject({
      kind: 'threads',
      candidates: 3,
      checked: 3,
      withThread: 1,
      threadPosts: 1,
      remaining: 0,
      out: path,
    });
    const raw = readFileSync(path, 'utf-8');
    expect(raw.startsWith('{\n "schema"')).toBe(true); // indent preserved
    expect(read(path).tweets.find((t) => t.id === '200')?.thread?.[0]?.id).toBe('201');
  });

  test('is resumable: --limit, then the next run continues where it stopped', async () => {
    const path = tempArchive([post('100'), post('200'), post('300')]);
    const first = fakeEngine();
    const r1 = await runThreadRepair(first.engine, {
      file: path,
      threads: true,
      delay: 0,
      limit: 2,
      quiet: true,
    });
    expect(first.calls).toEqual(['300', '200']);
    expect(r1.ok && r1.data.remaining).toBe(1);
    const second = fakeEngine();
    await runThreadRepair(second.engine, { file: path, threads: true, delay: 0, quiet: true });
    expect(second.calls).toEqual(['100']);
  });

  test('--dry-run looks up but writes nothing', async () => {
    const path = tempArchive([post('100')]);
    const before = readFileSync(path, 'utf-8');
    const res = await runThreadRepair(fakeEngine({ threads: { '100': ['101'] } }).engine, {
      file: path,
      threads: true,
      delay: 0,
      dryRun: true,
      quiet: true,
    });
    expect(res.ok && res.data.withThread).toBe(1);
    expect(readFileSync(path, 'utf-8')).toBe(before);
  });

  test('progress already made is saved when X rate-limits mid-run', async () => {
    const path = tempArchive([post('100'), post('200'), post('300')]);
    const { engine } = fakeEngine({ threads: { '300': ['301'] }, failOn: '200' });
    const res = await runThreadRepair(engine, { file: path, threads: true, delay: 0, quiet: true });
    expect(res.ok && res.data.stopped?.code).toBe('RATE_LIMITED');
    const saved = read(path).tweets;
    expect(saved.find((t) => t.id === '300')?.threadCheckedAt).toBeDefined();
    expect(saved.find((t) => t.id === '200')?.threadCheckedAt).toBeUndefined();
  });

  test('--media and --threads are separate runs', async () => {
    const path = tempArchive([post('100')]);
    const res = await runThreadRepair(fakeEngine().engine, {
      file: path,
      threads: true,
      media: true,
    });
    expect(res.ok).toBe(false);
  });
});

describe('thread --self', () => {
  test('returns the author’s own thread', async () => {
    // Tweet ids are snowflakes; the resolver rejects short numbers as ambiguous refs.
    const id = '1933625251851874568';
    const res = await runThread(
      fakeEngine({ threads: { [id]: ['101', '102'] } }).engine,
      id,
      undefined,
      true,
    );
    expect(res.ok && 'thread' in res.data && res.data.thread.map((t) => t.id)).toEqual([
      '101',
      '102',
    ]);
  });
});
