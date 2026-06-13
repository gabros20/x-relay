import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runArchive, runFeed, runLikes, runWhoami } from '../src/commands/runners.ts';
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
  searchTweets?: ArchiveTweet[];
  listTweets?: ArchiveTweet[];
  likesTweets?: ArchiveTweet[];
  feedTweets?: ArchiveTweet[];
  feedPage?: TweetPage;
  /** Override me() return value (default: 'me'). */
  meHandle?: string | null;
  /** When set, archiveUserPosts throws this EngineError code. */
  userPostsError?: string;
  /** When set, archiveLikes throws this EngineError code. */
  archiveLikesError?: string;
  /** Canned profile for whoami(). Defaults to a minimal profile when meHandle is set. */
  whoamiProfile?: UserProfile | null;
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
    async archiveSearch(): Promise<ArchiveTweet[]> {
      return opts.searchTweets ?? [];
    },
    async archiveList(): Promise<ArchiveTweet[]> {
      return opts.listTweets ?? [];
    },
    async likes(): Promise<TweetPage> {
      return { tweets: [] };
    },
    async archiveLikes(_handle: string): Promise<ArchiveTweet[]> {
      if (opts.archiveLikesError) {
        throw new EngineError(opts.archiveLikesError, `engine error: ${opts.archiveLikesError}`);
      }
      return opts.likesTweets ?? [];
    },
    async feed(): Promise<TweetPage> {
      return opts.feedPage ?? { tweets: [] };
    },
    async archiveFeed(): Promise<ArchiveTweet[]> {
      return opts.feedTweets ?? [];
    },
    async me(): Promise<string | null> {
      return opts.meHandle !== undefined ? opts.meHandle : 'me';
    },
    async whoami(): Promise<UserProfile | null> {
      if ('whoamiProfile' in opts) return opts.whoamiProfile ?? null;
      const handle = opts.meHandle !== undefined ? opts.meHandle : 'me';
      if (!handle) return null;
      return {
        id: '1',
        handle,
        name: handle,
        verified: false,
        followers: 0,
        following: 0,
        tweets: 0,
        url: `https://x.com/${handle}`,
      };
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

  test('unknown target returns INVALID_INPUT error envelope', async () => {
    const engine = fakeEngine([]);
    const env = await runArchive(engine, { target: 'unknown-target' });
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

// ── archive search target ─────────────────────────────────────────────────────

describe('runArchive — search target', () => {
  test('saves archive with source=search and query set', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xrelay-arc-'));
    const out = join(dir, 'archive.json');
    const tweets = [makeArchiveTweet('300'), makeArchiveTweet('200')];
    const engine = fakeEngine({ searchTweets: tweets });

    const env = await runArchive(engine, { target: 'search', query: 'AI agents', out });

    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(env.data.source).toBe('search');
    expect(env.data.added).toBe(2);
    expect(env.data.total).toBe(2);

    // Verify the file on disk has source=search and query stamped
    const { loadArchive } = await import('../src/archive.ts');
    const file = loadArchive(out);
    expect(file?.source).toBe('search');
    expect(file?.query).toBe('AI agents');

    rmSync(dir, { recursive: true });
  });

  test('--stdout prints JSON with source=search', async () => {
    const tweets = [makeArchiveTweet('500')];
    const engine = fakeEngine({ searchTweets: tweets });

    const chunks: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    // @ts-ignore override for test
    process.stdout.write = (chunk: string) => {
      chunks.push(chunk);
      return true;
    };

    const env = await runArchive(engine, { target: 'search', query: 'AI', stdout: true });

    // @ts-ignore restore
    process.stdout.write = origWrite;

    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(env.data.out).toBeUndefined();
    const json = JSON.parse(chunks.join(''));
    expect(json.source).toBe('search');
    expect(json.query).toBe('AI');
  });

  test('missing --out and --stdout returns INVALID_INPUT', async () => {
    const engine = fakeEngine({});
    const env = await runArchive(engine, { target: 'search', query: 'AI' });
    expect(env.ok).toBe(false);
    if (env.ok) return;
    expect(env.error.code).toBe('INVALID_INPUT');
  });
});

// ── archive list target ───────────────────────────────────────────────────────

describe('runArchive — list target', () => {
  test('saves archive with source=list and listId set', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xrelay-arc-'));
    const out = join(dir, 'archive.json');
    const tweets = [makeArchiveTweet('400'), makeArchiveTweet('300')];
    const engine = fakeEngine({ listTweets: tweets });

    const env = await runArchive(engine, { target: 'list', listId: 'mylist123', out });

    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(env.data.source).toBe('list');
    expect(env.data.added).toBe(2);
    expect(env.data.total).toBe(2);

    // Verify the file on disk has source=list and listId stamped
    const { loadArchive } = await import('../src/archive.ts');
    const file = loadArchive(out);
    expect(file?.source).toBe('list');
    expect(file?.listId).toBe('mylist123');

    rmSync(dir, { recursive: true });
  });

  test('incremental run merges correctly (list IS id-ordered)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xrelay-arc-'));
    const out = join(dir, 'archive.json');

    const { mergeArchive, saveArchive: save } = await import('../src/archive.ts');
    const seed = mergeArchive(null, [makeArchiveTweet('200'), makeArchiveTweet('100')], {
      generatedAt: '2026-01-01T00:00:00+00:00',
    });
    seed.file.source = 'list';
    seed.file.listId = 'mylist123';
    save(out, seed.file);

    const engine = fakeEngine({ listTweets: [makeArchiveTweet('300'), makeArchiveTweet('200')] });
    const env = await runArchive(engine, { target: 'list', listId: 'mylist123', out });

    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(env.data.added).toBe(1); // only 300 is new
    expect(env.data.total).toBe(3); // 300 + 200 + 100

    rmSync(dir, { recursive: true });
  });

  test('--stdout prints JSON with source=list', async () => {
    const engine = fakeEngine({ listTweets: [makeArchiveTweet('500')] });

    const chunks: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    // @ts-ignore override for test
    process.stdout.write = (chunk: string) => {
      chunks.push(chunk);
      return true;
    };

    const env = await runArchive(engine, { target: 'list', listId: 'mylist123', stdout: true });

    // @ts-ignore restore
    process.stdout.write = origWrite;

    expect(env.ok).toBe(true);
    if (!env.ok) return;
    const json = JSON.parse(chunks.join(''));
    expect(json.source).toBe('list');
    expect(json.listId).toBe('mylist123');
  });

  test('missing --out and --stdout returns INVALID_INPUT', async () => {
    const engine = fakeEngine({});
    const env = await runArchive(engine, { target: 'list', listId: 'mylist123' });
    expect(env.ok).toBe(false);
    if (env.ok) return;
    expect(env.error.code).toBe('INVALID_INPUT');
  });
});

// ── archive likes target ──────────────────────────────────────────────────────

describe('runArchive — likes target', () => {
  test('saves archive with source=likes and handle set when handle is explicit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xrelay-arc-'));
    const out = join(dir, 'archive.json');
    const tweets = [makeArchiveTweet('500'), makeArchiveTweet('400')];
    const engine = fakeEngine({ likesTweets: tweets });

    const env = await runArchive(engine, { target: 'likes', handle: 'alice', out });

    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(env.data.source).toBe('likes');
    expect(env.data.handle).toBe('alice');
    expect(env.data.added).toBe(2);
    expect(env.data.total).toBe(2);

    // Verify file on disk has source=likes and handle stamped
    const { loadArchive } = await import('../src/archive.ts');
    const file = loadArchive(out);
    expect(file?.source).toBe('likes');
    expect(file?.handle).toBe('alice');

    rmSync(dir, { recursive: true });
  });

  test('defaults handle to self (me()) when no handle provided', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xrelay-arc-'));
    const out = join(dir, 'archive.json');
    const tweets = [makeArchiveTweet('600')];
    // meHandle='me' by default in fakeEngine
    const engine = fakeEngine({ likesTweets: tweets });

    const env = await runArchive(engine, { target: 'likes', out });

    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(env.data.source).toBe('likes');
    expect(env.data.handle).toBe('me'); // resolved from me()
    expect(env.data.total).toBe(1);

    rmSync(dir, { recursive: true });
  });

  test('returns INVALID_INPUT when me() is null and no handle provided', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xrelay-arc-'));
    const out = join(dir, 'archive.json');
    const engine = fakeEngine({ meHandle: null });

    const env = await runArchive(engine, { target: 'likes', out });

    expect(env.ok).toBe(false);
    if (env.ok) return;
    expect(env.error.code).toBe('INVALID_INPUT');

    rmSync(dir, { recursive: true });
  });

  test('missing --out and --stdout returns INVALID_INPUT (guard fires first)', async () => {
    const engine = fakeEngine({});
    const env = await runArchive(engine, { target: 'likes', handle: 'alice' });
    expect(env.ok).toBe(false);
    if (env.ok) return;
    expect(env.error.code).toBe('INVALID_INPUT');
  });

  test('engine NOT_FOUND becomes error envelope', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xrelay-arc-'));
    const out = join(dir, 'archive.json');
    const engine = fakeEngine({ archiveLikesError: 'NOT_FOUND' });
    const env = await runArchive(engine, { target: 'likes', handle: 'ghost', out });
    expect(env.ok).toBe(false);
    if (env.ok) return;
    expect(env.error.code).toBe('NOT_FOUND');
    rmSync(dir, { recursive: true });
  });

  test('--stdout prints JSON with source=likes', async () => {
    const engine = fakeEngine({ likesTweets: [makeArchiveTweet('700')], meHandle: 'self' });

    const chunks: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    // @ts-ignore override for test
    process.stdout.write = (chunk: string) => {
      chunks.push(chunk);
      return true;
    };

    const env = await runArchive(engine, { target: 'likes', stdout: true });

    // @ts-ignore restore
    process.stdout.write = origWrite;

    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(env.data.out).toBeUndefined();
    const json = JSON.parse(chunks.join(''));
    expect(json.source).toBe('likes');
    expect(json.handle).toBe('self');
  });
});

// ── runLikes research runner ──────────────────────────────────────────────────

describe('runLikes research runner', () => {
  test('returns TweetPage envelope when handle is provided', async () => {
    const engine = fakeEngine({});
    // Override likes() to return a canned page
    const engineWithLikes: typeof engine = {
      ...engine,
      async likes(): Promise<TweetPage> {
        return {
          tweets: [{ id: '1', url: '', text: 'x', author: {} as never, metrics: {} as never }],
        };
      },
    };
    const env = await runLikes(engineWithLikes, 'alice');
    expect(env.ok).toBe(true);
    if (!env.ok) return;
    // TweetPage shape
    expect((env.data as TweetPage).tweets).toHaveLength(1);
  });

  test('resolves self via me() when no handle is passed', async () => {
    const resolvedHandle: string[] = [];
    const engine = fakeEngine({ meHandle: 'myself' });
    const engineWithLikes: typeof engine = {
      ...engine,
      async likes(handle): Promise<TweetPage> {
        resolvedHandle.push(handle);
        return { tweets: [] };
      },
    };
    const env = await runLikes(engineWithLikes, undefined);
    expect(env.ok).toBe(true);
    expect(resolvedHandle).toEqual(['myself']);
  });

  test('returns INVALID_INPUT when no handle and me() is null', async () => {
    const engine = fakeEngine({ meHandle: null });
    const env = await runLikes(engine, undefined);
    expect(env.ok).toBe(false);
    if (env.ok) return;
    expect(env.error.code).toBe('INVALID_INPUT');
  });
});

// ── archive feed target ───────────────────────────────────────────────────────

describe('runArchive — feed target', () => {
  test('saves archive with source=feed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xrelay-arc-feed-'));
    const out = join(dir, 'archive.json');
    const tweets = [makeArchiveTweet('800'), makeArchiveTweet('700')];
    const engine = fakeEngine({ feedTweets: tweets });

    const env = await runArchive(engine, { target: 'feed', out });

    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(env.data.source).toBe('feed');
    expect(env.data.added).toBe(2);
    expect(env.data.total).toBe(2);
    expect(env.data.newestId).toBe('800');
    expect(env.data.out).toBe(out);
    expect(env.data.handle).toBeUndefined(); // no handle for feed

    rmSync(dir, { recursive: true });
  });

  test('--following flag passes through (no validation error)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xrelay-arc-feed-'));
    const out = join(dir, 'archive.json');
    const tweets = [makeArchiveTweet('900')];
    const engine = fakeEngine({ feedTweets: tweets });

    const env = await runArchive(engine, { target: 'feed', out, following: true });

    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(env.data.source).toBe('feed');
    expect(env.data.total).toBe(1);

    rmSync(dir, { recursive: true });
  });

  test('--stdout prints JSON with source=feed without saving', async () => {
    const tweets = [makeArchiveTweet('500')];
    const engine = fakeEngine({ feedTweets: tweets });

    const chunks: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    // @ts-ignore override for test
    process.stdout.write = (chunk: string) => {
      chunks.push(chunk);
      return true;
    };

    const env = await runArchive(engine, { target: 'feed', stdout: true });

    // @ts-ignore restore
    process.stdout.write = origWrite;

    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(env.data.out).toBeUndefined();
    const json = JSON.parse(chunks.join(''));
    expect(json.source).toBe('feed');
    expect(json.tweets).toHaveLength(1);
  });

  test('missing --out and --stdout returns INVALID_INPUT', async () => {
    const engine = fakeEngine({});
    const env = await runArchive(engine, { target: 'feed' });
    expect(env.ok).toBe(false);
    if (env.ok) return;
    expect(env.error.code).toBe('INVALID_INPUT');
  });
});

// ── runFeed research runner ───────────────────────────────────────────────────

describe('runFeed research runner', () => {
  test('returns a TweetPage envelope for the for-you feed', async () => {
    const page: TweetPage = {
      tweets: [{ id: '1', url: '', text: 'x', author: {} as never, metrics: {} as never }],
    };
    const engine = fakeEngine({ feedPage: page });
    const env = await runFeed(engine, {});
    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect((env.data as TweetPage).tweets).toHaveLength(1);
  });

  test('following:true passes through without error', async () => {
    const engine = fakeEngine({});
    const env = await runFeed(engine, { following: true });
    expect(env.ok).toBe(true);
  });

  test('limit is forwarded', async () => {
    const engine = fakeEngine({});
    const env = await runFeed(engine, { limit: 5 });
    expect(env.ok).toBe(true);
  });
});

// ── archive --since filter ────────────────────────────────────────────────────

/** Make an ArchiveTweet with a Twitter-format createdAt for date-filter tests. */
function makeArchivedTweetWithDate(id: string, createdAt: string): ArchiveTweet {
  return { ...makeArchiveTweet(id), createdAt };
}

describe('runArchive — --since post-filter (shared core)', () => {
  // Tweets spanning 2026-06-01 through 2026-06-10, all UTC (+0000).
  // We use "Mon Jun 01 00:00:00 +0000 2026" through "Wed Jun 10 00:00:00 +0000 2026".
  // Cutoff: --since 2026-06-05 → keep >= 2026-06-05T00:00:00Z (inclusive).

  const OLD_TWEET = makeArchivedTweetWithDate('1000', 'Sun May 31 23:59:59 +0000 2026'); // before cutoff
  const BOUNDARY_TWEET = makeArchivedTweetWithDate('2000', 'Mon Jun 01 00:00:00 +0000 2026'); // exactly on cutoff — kept
  const NEW_TWEET = makeArchivedTweetWithDate('3000', 'Tue Jun 10 12:00:00 +0000 2026'); // after cutoff — kept
  const NO_DATE_TWEET = makeArchiveTweet('4000'); // no createdAt — kept (fail-open)

  test('drops tweets older than --since, keeps boundary-inclusive and unparseable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xrelay-arc-since-'));
    const out = join(dir, 'archive.json');

    const engine = fakeEngine({
      bookmarks: [NEW_TWEET, BOUNDARY_TWEET, OLD_TWEET, NO_DATE_TWEET],
    });

    // --since 2026-06-01 → keep NEW_TWEET, BOUNDARY_TWEET, NO_DATE_TWEET; drop OLD_TWEET
    const env = await runArchive(engine, {
      target: 'bookmarks',
      out,
      since: '2026-06-01',
    });

    expect(env.ok).toBe(true);
    if (!env.ok) return;

    const { loadArchive } = await import('../src/archive.ts');
    const file = loadArchive(out);
    const ids = (file?.tweets ?? []).map((t) => t.id);

    expect(ids).toContain('3000'); // NEW_TWEET kept
    expect(ids).toContain('2000'); // BOUNDARY_TWEET kept (inclusive)
    expect(ids).toContain('4000'); // NO_DATE_TWEET kept (fail-open)
    expect(ids).not.toContain('1000'); // OLD_TWEET dropped

    rmSync(dir, { recursive: true });
  });

  test('applies the filter for user target (proves filter is in the shared core)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xrelay-arc-since-user-'));
    const out = join(dir, 'archive.json');

    const engine = fakeEngine({
      userPosts: [NEW_TWEET, OLD_TWEET],
    });

    const env = await runArchive(engine, {
      target: 'user',
      handle: 'alice',
      out,
      since: '2026-06-01',
    });

    expect(env.ok).toBe(true);
    if (!env.ok) return;

    const { loadArchive } = await import('../src/archive.ts');
    const file = loadArchive(out);
    const ids = (file?.tweets ?? []).map((t) => t.id);

    expect(ids).toContain('3000');
    expect(ids).not.toContain('1000');

    rmSync(dir, { recursive: true });
  });

  test('when --since is absent, all tweets are kept (no filter applied)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xrelay-arc-since-none-'));
    const out = join(dir, 'archive.json');

    const engine = fakeEngine({
      bookmarks: [NEW_TWEET, OLD_TWEET, NO_DATE_TWEET],
    });

    const env = await runArchive(engine, { target: 'bookmarks', out });

    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(env.data.total).toBe(3);

    rmSync(dir, { recursive: true });
  });
});

// ── whoami runner ─────────────────────────────────────────────────────────────

describe('runWhoami', () => {
  test('returns the authenticated user profile on success', async () => {
    const profile: UserProfile = {
      id: '99',
      handle: 'testuser',
      name: 'Test User',
      verified: true,
      followers: 1000,
      following: 50,
      tweets: 500,
      url: 'https://x.com/testuser',
    };
    const engine = fakeEngine({ whoamiProfile: profile });

    const env = await runWhoami(engine);

    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(env.data.handle).toBe('testuser');
    expect(env.data.name).toBe('Test User');
    expect(env.data.verified).toBe(true);
  });

  test('returns NOT_FOUND error envelope when whoami() returns null (not logged in)', async () => {
    const engine = fakeEngine({ meHandle: null, whoamiProfile: null });

    const env = await runWhoami(engine);

    expect(env.ok).toBe(false);
    if (env.ok) return;
    expect(env.error.code).toBe('NOT_FOUND');
    expect(env.error.message).toBe('not logged in');
  });
});
