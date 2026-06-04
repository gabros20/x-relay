import { beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCache } from '../src/cache/store.ts';
import { syncBookmarks } from '../src/cache/sync.ts';
import type { Engine } from '../src/engine/index.ts';
import type { Tweet, TweetPage } from '../src/types.ts';

function tweet(id: string): Tweet {
  return {
    id,
    url: `https://x.com/a/status/${id}`,
    text: `t${id}`,
    author: { id: 'u', handle: 'a', name: 'A', verified: false },
    metrics: {},
  };
}

/** A fake whose bookmark timeline is newest-first and honors stopAtId. */
function fakeEngine(ids: string[]): Engine {
  return {
    async bookmarks(opts): Promise<TweetPage> {
      const stop = opts?.stopAtId;
      const out: Tweet[] = [];
      for (const id of ids) {
        if (stop !== undefined && BigInt(id) <= BigInt(stop)) break;
        out.push(tweet(id));
        if (opts?.limit !== undefined && out.length >= opts.limit) break;
      }
      return { tweets: out };
    },
  } as unknown as Engine;
}

describe('syncBookmarks (incremental)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'xrelay-sync-'));
  });

  test('first sync pulls everything and sets the watermark', async () => {
    const r = await syncBookmarks(fakeEngine(['5', '4', '3', '2', '1']), { dir });
    expect(r.added).toBe(5);
    expect(r.total).toBe(5);
    expect(r.watermark).toBe('5');
    expect(loadCache('bookmarks', dir).watermark).toBe('5');
  });

  test('second sync pulls only tweets newer than the watermark', async () => {
    await syncBookmarks(fakeEngine(['5', '4', '3', '2', '1']), { dir });
    // Two new bookmarks arrive at the head of the timeline.
    const r = await syncBookmarks(fakeEngine(['7', '6', '5', '4', '3', '2', '1']), { dir });
    expect(r.added).toBe(2);
    expect(r.total).toBe(7);
    expect(r.watermark).toBe('7');
  });

  test('a sync with no new tweets adds nothing', async () => {
    await syncBookmarks(fakeEngine(['5', '4', '3']), { dir });
    const r = await syncBookmarks(fakeEngine(['5', '4', '3']), { dir });
    expect(r.added).toBe(0);
    expect(r.total).toBe(3);
  });
});
