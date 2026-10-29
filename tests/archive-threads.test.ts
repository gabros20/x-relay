import { describe, expect, test } from 'bun:test';
import { mergeArchive, toArchiveTweet } from '../src/archive.ts';
import { captureThreads, needsThreadCheck, threadCheckOrder } from '../src/commands/threads.ts';
import { EngineError } from '../src/engine/index.ts';
import type { ArchiveFile, ArchiveTweet, SelfThreadResult, Tweet } from '../src/types.ts';

const HOUR = 3_600_000;
const NOW = Date.parse('2026-10-29T12:00:00Z');

function post(id: string, patch: Partial<ArchiveTweet> = {}): ArchiveTweet {
  return {
    id,
    url: `https://x.com/a/status/${id}`,
    text: `post ${id}`,
    author: { id: '100', handle: 'a', name: 'A', verified: false },
    metrics: { replies: 3 },
    createdAtISO: new Date(NOW - 10 * 24 * HOUR).toISOString(),
    ...patch,
  };
}

function tweet(id: string): Tweet {
  return {
    id,
    url: `https://x.com/a/status/${id}`,
    text: `cont ${id}`,
    author: { id: '100', handle: 'a', name: 'A', verified: false },
    metrics: {},
  };
}

/** A fake engine: threads by id, errors by id, and a log of calls. */
function fakeEngine(threads: Record<string, string[]>, errors: Record<string, EngineError> = {}) {
  const calls: string[] = [];
  return {
    calls,
    async selfThread(id: string): Promise<SelfThreadResult> {
      calls.push(id);
      const e = errors[id];
      if (e) throw e;
      return { root: tweet(id), thread: (threads[id] ?? []).map(tweet), pages: 1, complete: true };
    },
  };
}

const noSleep = async () => {};

describe('needsThreadCheck', () => {
  test('a never-checked post with replies needs a check', () => {
    expect(needsThreadCheck(post('1'), NOW)).toBe(true);
  });

  test('no replies, or a retweet → no thread possible, no call', () => {
    expect(needsThreadCheck(post('1', { metrics: { replies: 0 } }), NOW)).toBe(false);
    expect(needsThreadCheck(post('1', { metrics: {} }), NOW)).toBe(false);
    expect(needsThreadCheck(post('1', { isRetweet: true }), NOW)).toBe(false);
  });

  test('checked once it was old enough → settled', () => {
    const p = post('1', { threadCheckedAt: new Date(NOW - 5 * 24 * HOUR).toISOString() });
    expect(needsThreadCheck(p, NOW)).toBe(false);
  });

  test('checked while young (author may still be adding) → re-check once 48h have passed', () => {
    const created = NOW - 50 * HOUR;
    const young = post('1', {
      createdAtISO: new Date(created).toISOString(),
      threadCheckedAt: new Date(created + HOUR).toISOString(),
    });
    expect(needsThreadCheck(young, NOW)).toBe(true);
    const stillYoung = post('1', {
      createdAtISO: new Date(NOW - 10 * HOUR).toISOString(),
      threadCheckedAt: new Date(NOW - 9 * HOUR).toISOString(),
    });
    expect(needsThreadCheck(stillYoung, NOW)).toBe(false);
  });

  test('falls back to X’s raw createdAt when createdAtISO is absent', () => {
    // Posted Oct 26 10:00, checked an hour later (young), now 74h after posting.
    const p = post('1', {
      createdAtISO: undefined,
      createdAt: 'Mon Oct 26 10:00:00 +0000 2026',
      threadCheckedAt: '2026-10-26T11:00:00Z',
    });
    expect(needsThreadCheck(p, NOW)).toBe(true);
  });
});

describe('threadCheckOrder', () => {
  test('posts that look like threads first, then newest first', () => {
    const order = threadCheckOrder([
      post('100'),
      post('300'),
      post('200', { text: 'Big launch 🧵' }),
      post('150', { text: '1/8 here is how we built it' }),
    ]);
    expect(order.map((p) => p.id)).toEqual(['200', '150', '300', '100']);
  });
});

describe('captureThreads', () => {
  test('attaches the author’s continuation and stamps every checked post', async () => {
    const posts = [post('1'), post('2')];
    const engine = fakeEngine({ '1': ['11', '12'] });
    const res = await captureThreads(engine, posts, { now: () => new Date(NOW), sleep: noSleep });
    expect(posts[0]?.thread?.map((t) => t.id)).toEqual(['11', '12']);
    expect(posts[1]?.thread).toBeUndefined();
    expect(posts.every((p) => p.threadCheckedAt === new Date(NOW).toISOString())).toBe(true);
    expect(res).toMatchObject({ checked: 2, withThread: 1, threadPosts: 2, failed: 0 });
  });

  test('a re-check that finds a longer thread replaces the stored one', async () => {
    const p = post('1', { thread: [toArchiveTweet(tweet('11'))] });
    await captureThreads(fakeEngine({ '1': ['11', '12', '13'] }), [p], {
      now: () => new Date(NOW),
      sleep: noSleep,
    });
    expect(p.thread?.map((t) => t.id)).toEqual(['11', '12', '13']);
  });

  test('respects limit and waits delayMs between calls', async () => {
    const waits: number[] = [];
    const engine = fakeEngine({});
    const res = await captureThreads(engine, [post('1'), post('2'), post('3')], {
      limit: 2,
      delayMs: 4000,
      now: () => new Date(NOW),
      sleep: async (ms) => void waits.push(ms),
    });
    expect(engine.calls).toEqual(['1', '2']);
    expect(waits).toEqual([4000]);
    expect(res.checked).toBe(2);
  });

  test('stops on a rate limit and leaves the rest unchecked for next time', async () => {
    const posts = [post('1'), post('2'), post('3')];
    const engine = fakeEngine({}, { '2': new EngineError('RATE_LIMITED', 'slow down', 429) });
    const res = await captureThreads(engine, posts, { now: () => new Date(NOW), sleep: noSleep });
    expect(engine.calls).toEqual(['1', '2']);
    expect(res.stopped?.code).toBe('RATE_LIMITED');
    expect(posts[1]?.threadCheckedAt).toBeUndefined();
    expect(posts[2]?.threadCheckedAt).toBeUndefined();
  });

  test('a deleted post is stamped (never retried); a transient failure is not', async () => {
    const posts = [post('1'), post('2')];
    const engine = fakeEngine(
      {},
      {
        '1': new EngineError('NOT_FOUND', 'gone', 404),
        '2': new EngineError('FETCH_FAILED', 'socket hang up'),
      },
    );
    const res = await captureThreads(engine, posts, { now: () => new Date(NOW), sleep: noSleep });
    expect(posts[0]?.threadCheckedAt).toBeDefined();
    expect(posts[1]?.threadCheckedAt).toBeUndefined();
    expect(res).toMatchObject({ checked: 1, failed: 1 });
  });

  test('gives up after 5 failures in a row (X is down / drifted)', async () => {
    const posts = Array.from({ length: 9 }, (_, i) => post(String(i + 1)));
    const errors = Object.fromEntries(
      posts.map((p) => [p.id, new EngineError('FETCH_FAILED', 'down')]),
    );
    const engine = fakeEngine({}, errors);
    const res = await captureThreads(engine, posts, { now: () => new Date(NOW), sleep: noSleep });
    expect(engine.calls.length).toBe(5);
    expect(res.stopped?.code).toBe('FETCH_FAILED');
  });

  test('checkpoints every N checks so a long run survives a crash', async () => {
    const marks: number[] = [];
    await captureThreads(
      fakeEngine({}),
      Array.from({ length: 5 }, (_, i) => post(String(i + 1))),
      {
        now: () => new Date(NOW),
        sleep: noSleep,
        checkpointEvery: 2,
        onCheckpoint: (done) => marks.push(done),
      },
    );
    expect(marks).toEqual([2, 4]);
  });
});

describe('archive format', () => {
  test('toArchiveTweet keeps inReplyToId', () => {
    expect(toArchiveTweet({ ...tweet('2'), isReply: true, inReplyToId: '1' }).inReplyToId).toBe(
      '1',
    );
  });

  test('re-pulling a known post keeps its captured thread', () => {
    const existing: ArchiveFile = {
      schema: 'x-relay/archive@1',
      source: 'bookmarks',
      generatedAt: 'x',
      count: 1,
      tweets: [
        post('1', {
          thread: [toArchiveTweet(tweet('11'))],
          threadCheckedAt: '2026-10-01T00:00:00Z',
        }),
      ],
    };
    const fresh = [post('1', { text: 'edited' }), post('2')];
    for (const prune of [false, true]) {
      const { file } = mergeArchive(
        existing,
        fresh.map((p) => ({ ...p })),
        { generatedAt: 'y', prune },
      );
      const merged = file.tweets.find((t) => t.id === '1');
      expect(merged?.text).toBe('edited');
      expect(merged?.thread?.map((t) => t.id)).toEqual(['11']);
      expect(merged?.threadCheckedAt).toBe('2026-10-01T00:00:00Z');
    }
  });
});
