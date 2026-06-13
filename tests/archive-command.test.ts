import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runArchive } from '../src/commands/runners.ts';
import { type Engine, EngineError } from '../src/engine/index.ts';
import type {
  ArchiveTweet,
  Article,
  Community,
  MediaItem,
  SearchResult,
  ThreadResult,
  Trend,
  TweetPage,
  UserPage,
  UserProfile,
} from '../src/types.ts';

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeAuthor() {
  return {
    id: '44196397',
    handle: 'elonmusk',
    name: 'Elon Musk',
    verified: true,
    followers: 200_000_000,
    avatar: 'https://pbs.twimg.com/avatar.jpg',
  };
}

function makeMetrics() {
  return { likes: 100, retweets: 20, replies: 5, quotes: 3, bookmarks: 7, views: 12345 };
}

function makeArchiveTweet(id: string): ArchiveTweet {
  return {
    id,
    url: `https://x.com/elonmusk/status/${id}`,
    text: `Tweet ${id}`,
    author: makeAuthor(),
    metrics: makeMetrics(),
  };
}

interface FakeEngineOpts {
  bookmarks?: ArchiveTweet[];
  userPosts?: ArchiveTweet[];
  myPosts?: ArchiveTweet[];
  /** Override me() return value (default: 'me'). */
  meHandle?: string | null;
  /** When set, archiveUserPosts throws this EngineError code. */
  userPostsError?: string;
}

/** A fake Engine that returns fixed sets of ArchiveTweets per archive target. */
function fakeEngine(archiveTweetsOrOpts: ArchiveTweet[] | FakeEngineOpts): Engine {
  const opts: FakeEngineOpts = Array.isArray(archiveTweetsOrOpts)
    ? { bookmarks: archiveTweetsOrOpts }
    : archiveTweetsOrOpts;
  return {
    async search(): Promise<SearchResult> {
      return { query: '', product: 'Top', tweets: [] };
    },
    async user(): Promise<UserProfile | null> {
      return null;
    },
    async userTweets(): Promise<TweetPage> {
      return { tweets: [] };
    },
    async bookmarks(): Promise<TweetPage> {
      return { tweets: [] };
    },
    async thread(): Promise<ThreadResult> {
      return { root: {} as never, replies: [] };
    },
    async userMedia(): Promise<TweetPage> {
      return { tweets: [] };
    },
    async list(): Promise<TweetPage> {
      return { tweets: [] };
    },
    async followers(): Promise<UserPage> {
      return { users: [] };
    },
    async following(): Promise<UserPage> {
      return { users: [] };
    },
    async retweeters(): Promise<UserPage> {
      return { users: [] };
    },
    async likers(): Promise<UserPage> {
      return { users: [] };
    },
    async quoters(): Promise<SearchResult> {
      return { query: '', product: 'Latest', tweets: [] };
    },
    async trends(): Promise<Trend[]> {
      return [];
    },
    async article(): Promise<Article | null> {
      return null;
    },
    async media(): Promise<MediaItem[]> {
      return [];
    },
    async community(): Promise<TweetPage> {
      return { tweets: [] };
    },
    async communityInfo(): Promise<Community | null> {
      return null;
    },
    async archiveBookmarks(): Promise<ArchiveTweet[]> {
      return opts.bookmarks ?? [];
    },
    async archiveUserPosts(_handle: string): Promise<ArchiveTweet[]> {
      if (opts.userPostsError) {
        throw new EngineError(opts.userPostsError, `engine error: ${opts.userPostsError}`);
      }
      return opts.userPosts ?? [];
    },
    async archiveMyPosts(): Promise<ArchiveTweet[]> {
      return opts.myPosts ?? [];
    },
    async me(): Promise<string | null> {
      return opts.meHandle !== undefined ? opts.meHandle : 'me';
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('runArchive — bookmarks target', () => {
  test('returns envelope with added/total/newestId on fresh archive', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xrelay-arc-'));
    const out = join(dir, 'archive.json');
    const tweets = [makeArchiveTweet('300'), makeArchiveTweet('200'), makeArchiveTweet('100')];
    const engine = fakeEngine(tweets);

    const env = await runArchive(engine, { target: 'bookmarks', out });

    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(env.data.source).toBe('bookmarks');
    expect(env.data.added).toBe(3);
    expect(env.data.total).toBe(3);
    expect(env.data.newestId).toBe('300');
    expect(env.data.out).toBe(out);

    rmSync(dir, { recursive: true });
  });

  test('incremental run: only newly seen tweets count as added', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xrelay-arc-'));
    const out = join(dir, 'archive.json');

    // Pre-seed the archive file with tweets 200 and 100
    const { mergeArchive } = await import('../src/archive.ts');
    const seed = mergeArchive(null, [makeArchiveTweet('200'), makeArchiveTweet('100')], {
      generatedAt: '2026-01-01T00:00:00+00:00',
    });
    const { saveArchive: save } = await import('../src/archive.ts');
    save(out, seed.file);

    // Engine returns 300 (new) + 200 (already known)
    const engine = fakeEngine([makeArchiveTweet('300'), makeArchiveTweet('200')]);

    const env = await runArchive(engine, { target: 'bookmarks', out });

    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(env.data.added).toBe(1); // only 300 is new
    expect(env.data.total).toBe(3); // 300 + 200 + 100

    rmSync(dir, { recursive: true });
  });

  test('--prune replaces existing tweets entirely', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xrelay-arc-'));
    const out = join(dir, 'archive.json');

    // Pre-seed with tweets 200 and 100
    const { mergeArchive, saveArchive: save } = await import('../src/archive.ts');
    const seed = mergeArchive(null, [makeArchiveTweet('200'), makeArchiveTweet('100')], {
      generatedAt: '2026-01-01T00:00:00+00:00',
    });
    save(out, seed.file);

    // Engine returns only 300 (prune should drop 200 and 100)
    const engine = fakeEngine([makeArchiveTweet('300')]);

    const env = await runArchive(engine, { target: 'bookmarks', out, prune: true });

    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(env.data.total).toBe(1); // only 300
    expect(env.data.added).toBe(1); // prune: added = fresh.length

    rmSync(dir, { recursive: true });
  });

  test('--stdout prints to stdout without saving (returns null out)', async () => {
    const tweets = [makeArchiveTweet('500')];
    const engine = fakeEngine(tweets);

    // capture stdout
    const chunks: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    // @ts-ignore override for test
    process.stdout.write = (chunk: string) => {
      chunks.push(chunk);
      return true;
    };

    const env = await runArchive(engine, { target: 'bookmarks', stdout: true });

    // @ts-ignore restore
    process.stdout.write = origWrite;

    expect(env.ok).toBe(true);
    if (!env.ok) return;
    // out is undefined when --stdout
    expect(env.data.out).toBeUndefined();
    // stdout received JSON
    expect(chunks.length).toBeGreaterThan(0);
    const json = JSON.parse(chunks.join(''));
    expect(json.schema).toBe('x-relay/archive@1');
    expect(json.tweets).toHaveLength(1);
  });

  test('missing target returns INVALID_INPUT error envelope', async () => {
    const engine = fakeEngine([]);
    const env = await runArchive(engine, { target: 'likes' });
    expect(env.ok).toBe(false);
    if (env.ok) return;
    expect(env.error.code).toBe('INVALID_INPUT');
  });

  test('missing both --out and --stdout returns INVALID_INPUT error envelope', async () => {
    const engine = fakeEngine([makeArchiveTweet('100')]);
    const env = await runArchive(engine, { target: 'bookmarks' });
    expect(env.ok).toBe(false);
    if (env.ok) return;
    expect(env.error.code).toBe('INVALID_INPUT');
  });
});

// ── archive user target ───────────────────────────────────────────────────────

describe('runArchive — user target', () => {
  test('saves archive with source=user and handle set', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xrelay-arc-'));
    const out = join(dir, 'archive.json');
    const tweets = [makeArchiveTweet('300'), makeArchiveTweet('200')];
    const engine = fakeEngine({ userPosts: tweets });

    const env = await runArchive(engine, { target: 'user', handle: 'alice', out });

    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(env.data.source).toBe('user');
    expect(env.data.handle).toBe('alice');
    expect(env.data.added).toBe(2);
    expect(env.data.total).toBe(2);
    expect(env.data.newestId).toBe('300');

    // Verify the file on disk has the right source and handle
    const { loadArchive } = await import('../src/archive.ts');
    const file = loadArchive(out);
    expect(file?.source).toBe('user');
    expect(file?.handle).toBe('alice');

    rmSync(dir, { recursive: true });
  });

  test('incremental run stops after known ids and only adds new tweets', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xrelay-arc-'));
    const out = join(dir, 'archive.json');

    const { mergeArchive, saveArchive: save, loadArchive } = await import('../src/archive.ts');
    const seed = mergeArchive(null, [makeArchiveTweet('200'), makeArchiveTweet('100')], {
      generatedAt: '2026-01-01T00:00:00+00:00',
    });
    seed.file.source = 'user';
    seed.file.handle = 'alice';
    save(out, seed.file);

    const engine = fakeEngine({ userPosts: [makeArchiveTweet('300'), makeArchiveTweet('200')] });
    const env = await runArchive(engine, { target: 'user', handle: 'alice', out });

    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(env.data.added).toBe(1); // only 300 is new
    expect(env.data.total).toBe(3); // 300 + 200 + 100

    const file = loadArchive(out);
    expect(file?.source).toBe('user');
    expect(file?.handle).toBe('alice');

    rmSync(dir, { recursive: true });
  });

  test('missing handle returns INVALID_INPUT error envelope', async () => {
    const engine = fakeEngine({});
    const env = await runArchive(engine, { target: 'user', stdout: true });
    expect(env.ok).toBe(false);
    if (env.ok) return;
    expect(env.error.code).toBe('INVALID_INPUT');
  });

  test('missing --out and --stdout returns INVALID_INPUT (guard fires first)', async () => {
    const engine = fakeEngine({});
    const env = await runArchive(engine, { target: 'user', handle: 'alice' });
    expect(env.ok).toBe(false);
    if (env.ok) return;
    expect(env.error.code).toBe('INVALID_INPUT');
  });

  test('engine NOT_FOUND becomes error envelope', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xrelay-arc-'));
    const out = join(dir, 'archive.json');
    const engine = fakeEngine({ userPostsError: 'NOT_FOUND' });
    const env = await runArchive(engine, { target: 'user', handle: 'ghost', out });
    expect(env.ok).toBe(false);
    if (env.ok) return;
    expect(env.error.code).toBe('NOT_FOUND');
    rmSync(dir, { recursive: true });
  });

  test('--stdout prints JSON with source=user without saving', async () => {
    const engine = fakeEngine({ userPosts: [makeArchiveTweet('500')] });

    const chunks: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    // @ts-ignore override for test
    process.stdout.write = (chunk: string) => {
      chunks.push(chunk);
      return true;
    };

    const env = await runArchive(engine, { target: 'user', handle: 'alice', stdout: true });

    // @ts-ignore restore
    process.stdout.write = origWrite;

    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(env.data.out).toBeUndefined();
    const json = JSON.parse(chunks.join(''));
    expect(json.source).toBe('user');
    expect(json.handle).toBe('alice');
  });
});

// ── archive my-posts target ───────────────────────────────────────────────────

describe('runArchive — my-posts target', () => {
  test('saves archive with source=my-posts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xrelay-arc-'));
    const out = join(dir, 'archive.json');
    const tweets = [makeArchiveTweet('400'), makeArchiveTweet('300')];
    const engine = fakeEngine({ myPosts: tweets });

    const env = await runArchive(engine, { target: 'my-posts', out });

    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(env.data.source).toBe('my-posts');
    expect(env.data.handle).toBe('me'); // self handle resolved via me()
    expect(env.data.added).toBe(2);
    expect(env.data.total).toBe(2);
    expect(env.data.newestId).toBe('400');

    const { loadArchive } = await import('../src/archive.ts');
    const file = loadArchive(out);
    expect(file?.source).toBe('my-posts');
    expect(file?.handle).toBe('me'); // provenance stamped on the file too

    rmSync(dir, { recursive: true });
  });

  test('my-posts without a resolvable handle omits handle (me() null)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xrelay-arc-'));
    const out = join(dir, 'archive.json');
    const engine = fakeEngine({ myPosts: [makeArchiveTweet('400')], meHandle: null });

    const env = await runArchive(engine, { target: 'my-posts', out });

    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(env.data.source).toBe('my-posts');
    expect(env.data.handle).toBeUndefined();

    const { loadArchive } = await import('../src/archive.ts');
    const file = loadArchive(out);
    expect(file?.handle).toBeUndefined();

    rmSync(dir, { recursive: true });
  });

  test('incremental run merges correctly', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xrelay-arc-'));
    const out = join(dir, 'archive.json');

    const { mergeArchive, saveArchive: save } = await import('../src/archive.ts');
    const seed = mergeArchive(null, [makeArchiveTweet('200'), makeArchiveTweet('100')], {
      generatedAt: '2026-01-01T00:00:00+00:00',
    });
    seed.file.source = 'my-posts';
    save(out, seed.file);

    const engine = fakeEngine({ myPosts: [makeArchiveTweet('300'), makeArchiveTweet('200')] });
    const env = await runArchive(engine, { target: 'my-posts', out });

    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(env.data.added).toBe(1);
    expect(env.data.total).toBe(3);

    rmSync(dir, { recursive: true });
  });

  test('missing --out and --stdout returns INVALID_INPUT (guard fires first)', async () => {
    const engine = fakeEngine({});
    const env = await runArchive(engine, { target: 'my-posts' });
    expect(env.ok).toBe(false);
    if (env.ok) return;
    expect(env.error.code).toBe('INVALID_INPUT');
  });
});
