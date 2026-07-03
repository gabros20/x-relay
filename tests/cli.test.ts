import { describe, expect, test } from 'bun:test';
import { dispatch, parseArgs } from '../src/cli.ts';
import type { Engine } from '../src/engine/index.ts';
import type {
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

function fakeEngine(calls: string[]): Engine {
  return {
    async search(query, opts): Promise<SearchResult> {
      calls.push(`search:${query}:${opts?.product ?? '-'}:${opts?.limit ?? '-'}`);
      return { query, product: opts?.product ?? 'Top', tweets: [] };
    },
    async user(handle): Promise<UserProfile | null> {
      calls.push(`user:${handle}`);
      return null;
    },
    async userTweets(handle, opts): Promise<TweetPage> {
      calls.push(`userTweets:${handle}:${opts?.replies ?? false}`);
      return { tweets: [] };
    },
    async bookmarks(opts): Promise<TweetPage> {
      calls.push(`bookmarks:${opts?.limit ?? '-'}`);
      return { tweets: [] };
    },
    async thread(id): Promise<ThreadResult> {
      calls.push(`thread:${id}`);
      return { root: {} as never, replies: [] };
    },
    async userMedia(handle): Promise<TweetPage> {
      calls.push(`userMedia:${handle}`);
      return { tweets: [] };
    },
    async list(listId): Promise<TweetPage> {
      calls.push(`list:${listId}`);
      return { tweets: [] };
    },
    async followers(handle): Promise<UserPage> {
      calls.push(`followers:${handle}`);
      return { users: [] };
    },
    async following(handle): Promise<UserPage> {
      calls.push(`following:${handle}`);
      return { users: [] };
    },
    async retweeters(id): Promise<UserPage> {
      calls.push(`retweeters:${id}`);
      return { users: [] };
    },
    async likers(id): Promise<UserPage> {
      calls.push(`likers:${id}`);
      return { users: [] };
    },
    async quoters(id): Promise<SearchResult> {
      calls.push(`quoters:${id}`);
      return { query: `quoted_tweet_id:${id}`, product: 'Latest', tweets: [] };
    },
    async trends(opts): Promise<Trend[]> {
      calls.push(`trends:${opts?.woeid ?? '-'}`);
      return [];
    },
    async article(id): Promise<Article | null> {
      calls.push(`article:${id}`);
      return { id, title: 'T', markdown: '# T', url: `https://x.com/i/status/${id}` };
    },
    async media(id): Promise<MediaItem[]> {
      calls.push(`media:${id}`);
      return [];
    },
    async community(id): Promise<TweetPage> {
      calls.push(`community:${id}`);
      return { tweets: [] };
    },
    async communityInfo(id): Promise<Community | null> {
      calls.push(`communityInfo:${id}`);
      return { id, name: 'C', url: `https://x.com/i/communities/${id}` };
    },
    async me(): Promise<string | null> {
      calls.push('me');
      return 'me';
    },
    async like(tweetId: string): Promise<void> {
      calls.push(`like:${tweetId}`);
    },
    async unlike(tweetId: string): Promise<void> {
      calls.push(`unlike:${tweetId}`);
    },
    async bookmark(tweetId: string): Promise<void> {
      calls.push(`bookmark:${tweetId}`);
    },
    async unbookmark(tweetId: string): Promise<void> {
      calls.push(`unbookmark:${tweetId}`);
    },
    async retweet(tweetId: string): Promise<void> {
      calls.push(`retweet:${tweetId}`);
    },
    async unretweet(tweetId: string): Promise<void> {
      calls.push(`unretweet:${tweetId}`);
    },
    async deleteTweet(tweetId: string): Promise<void> {
      calls.push(`deleteTweet:${tweetId}`);
    },
    async follow(handle: string): Promise<void> {
      calls.push(`follow:${handle}`);
    },
    async unfollow(handle: string): Promise<void> {
      calls.push(`unfollow:${handle}`);
    },
    async uploadMedia(path: string): Promise<string> {
      calls.push(`uploadMedia:${path}`);
      return `media-id-${path}`;
    },
    async post(
      text: string,
      opts?: { replyToId?: string; quoteTweetId?: string; mediaIds?: string[] },
    ): Promise<{ id: string; url: string }> {
      calls.push(`post:${text}:mediaIds=${(opts?.mediaIds ?? []).join(',')}`);
      return { id: 'fake-id', url: 'https://x.com/i/web/status/fake-id' };
    },
    async mutate(): Promise<unknown> {
      return {};
    },
    async friendshipAction(): Promise<unknown> {
      return {};
    },
  };
}

describe('parseArgs', () => {
  test('separates command, positionals, value flags, repeatables, and bools', () => {
    const p = parseArgs([
      'search',
      'ai agents',
      '--limit',
      '5',
      '--from',
      'karpathy',
      '--filter',
      'media',
      '--filter',
      '-replies',
      '--product',
      'Latest',
    ]);
    expect(p.command).toBe('search');
    expect(p.positionals).toEqual(['ai agents']);
    expect(p.flags.limit).toEqual(['5']);
    expect(p.flags.filter).toEqual(['media', '-replies']);
    expect(p.flags.product).toEqual(['Latest']);
  });

  test('captures boolean flags', () => {
    const p = parseArgs(['user-posts', 'karpathy', '--replies', '--limit', '3']);
    expect(p.bools.has('replies')).toBe(true);
    expect(p.flags.limit).toEqual(['3']);
  });
});

describe('dispatch', () => {
  test('search builds the query with operators and passes product/limit', async () => {
    const calls: string[] = [];
    const env = await dispatch(
      parseArgs([
        'search',
        'ai agents',
        '--from',
        'karpathy',
        '--limit',
        '5',
        '--product',
        'Latest',
      ]),
      fakeEngine(calls),
    );
    expect(env.ok).toBe(true);
    expect(calls[0]).toBe('search:ai agents from:karpathy:Latest:5');
  });

  test('user extracts a handle from a profile URL', async () => {
    const calls: string[] = [];
    await dispatch(parseArgs(['user', 'https://x.com/karpathy']), fakeEngine(calls));
    expect(calls[0]).toBe('user:karpathy');
  });

  test('thread extracts a tweet id from a status URL', async () => {
    const calls: string[] = [];
    await dispatch(parseArgs(['thread', 'https://x.com/x/status/123456789']), fakeEngine(calls));
    expect(calls[0]).toBe('thread:123456789');
  });

  test('thread with a malformed X URL is rejected without calling the engine', async () => {
    const calls: string[] = [];
    const env = await dispatch(parseArgs(['thread', 'https://x.com/foo']), fakeEngine(calls));
    expect(env.ok).toBe(false);
    if (!env.ok) expect(env.error.code).toBe('INVALID_INPUT');
    expect(calls).toHaveLength(0);
  });

  test('user-posts forwards the replies flag', async () => {
    const calls: string[] = [];
    await dispatch(parseArgs(['user-posts', 'karpathy', '--replies']), fakeEngine(calls));
    expect(calls[0]).toBe('userTweets:karpathy:true');
  });

  test('list / trends / article / media / retweeters dispatch with extracted targets', async () => {
    const calls: string[] = [];
    const eng = fakeEngine(calls);
    await dispatch(parseArgs(['list', '1539453138322673664']), eng);
    await dispatch(parseArgs(['user-media', 'https://x.com/karpathy']), eng);
    await dispatch(parseArgs(['retweeters', 'https://x.com/x/status/123']), eng);
    await dispatch(parseArgs(['trends', '--woeid', '23424977']), eng);
    await dispatch(parseArgs(['article', 'https://x.com/x/status/999']), eng);
    await dispatch(parseArgs(['media', '777888']), eng);
    expect(calls).toEqual([
      'list:1539453138322673664',
      'userMedia:karpathy',
      'retweeters:123',
      'trends:23424977',
      'article:999',
      'media:777888',
    ]);
  });

  test('community / community-info dispatch with the community id', async () => {
    const calls: string[] = [];
    const eng = fakeEngine(calls);
    await dispatch(parseArgs(['community', '1493446837214187523', '--limit', '5']), eng);
    await dispatch(parseArgs(['community-info', '1493446837214187523']), eng);
    expect(calls).toEqual(['community:1493446837214187523', 'communityInfo:1493446837214187523']);
  });

  test('unknown command yields an error envelope', async () => {
    const env = await dispatch(parseArgs(['frobnicate']), fakeEngine([]));
    expect(env.ok).toBe(false);
    if (!env.ok) expect(env.error.code).toBe('UNKNOWN_COMMAND');
  });

  test('empty search query is rejected without calling the engine', async () => {
    const calls: string[] = [];
    const env = await dispatch(parseArgs(['search']), fakeEngine(calls));
    expect(env.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test('search --compact reaches the runner and marks the output compact', async () => {
    const calls: string[] = [];
    const env = await dispatch(parseArgs(['search', 'ai', '--compact']), fakeEngine(calls));
    expect(env.ok).toBe(true);
    if (!env.ok) throw new Error('expected success');
    expect((env.data as { compact?: boolean }).compact).toBe(true);
  });

  test('search --fields x,y reaches the runner and marks the output compact', async () => {
    const calls: string[] = [];
    const env = await dispatch(
      parseArgs(['search', 'ai', '--fields', 'id,likes']),
      fakeEngine(calls),
    );
    expect(env.ok).toBe(true);
    if (!env.ok) throw new Error('expected success');
    expect((env.data as { compact?: boolean }).compact).toBe(true);
  });

  test('search --fields with only commas/blanks → INVALID_INPUT (no silent no-op)', async () => {
    const calls: string[] = [];
    const env = await dispatch(parseArgs(['search', 'ai', '--fields', ' , ,']), fakeEngine(calls));
    expect(env.ok).toBe(false);
    if (env.ok) throw new Error('expected failure');
    expect(env.error.code).toBe('INVALID_INPUT');
    expect(calls).toHaveLength(0);
  });

  test('search --sort engagement is accepted (shape untouched, no compact marker)', async () => {
    const calls: string[] = [];
    const env = await dispatch(
      parseArgs(['search', 'ai', '--sort', 'engagement']),
      fakeEngine(calls),
    );
    expect(env.ok).toBe(true);
    if (!env.ok) throw new Error('expected success');
    expect('compact' in env.data).toBe(false);
    expect(calls[0]).toBe('search:ai:-:-');
  });

  test('search with an invalid --sort value → INVALID_INPUT', async () => {
    const calls: string[] = [];
    const env = await dispatch(parseArgs(['search', 'ai', '--sort', 'foo']), fakeEngine(calls));
    expect(env.ok).toBe(false);
    if (env.ok) throw new Error('expected failure');
    expect(env.error.code).toBe('INVALID_INPUT');
    expect(calls).toHaveLength(0);
  });

  test('cache bookmarks --sort likes still routes to the cache runner (regression)', async () => {
    const calls: string[] = [];
    const env = await dispatch(parseArgs(['bookmarks', '--sort', 'likes']), fakeEngine(calls));
    // Cache read (not --live): the engine.bookmarks() live path must NOT fire.
    expect(env.ok).toBe(true);
    expect(calls.every((c) => !c.startsWith('bookmarks:'))).toBe(true);
  });

  test('like / unlike / bookmark / unbookmark dispatch to correct engine methods', async () => {
    const calls: string[] = [];
    const eng = fakeEngine(calls);
    await dispatch(parseArgs(['like', '111222333']), eng);
    await dispatch(parseArgs(['unlike', '444555666']), eng);
    await dispatch(parseArgs(['bookmark', '777888999']), eng);
    await dispatch(parseArgs(['unbookmark', '321654987']), eng);
    expect(calls).toEqual([
      'like:111222333',
      'unlike:444555666',
      'bookmark:777888999',
      'unbookmark:321654987',
    ]);
  });

  test('"bookmark" (singular write) does NOT route to "bookmarks" (plural read) handler', async () => {
    const calls: string[] = [];
    const eng = fakeEngine(calls);
    // `bookmark <id>` should call engine.bookmark(), not engine.bookmarks()
    await dispatch(parseArgs(['bookmark', '12345']), eng);
    expect(calls).toEqual(['bookmark:12345']);
    // None of the calls should be the bookmarks read handler
    expect(calls.every((c) => !c.startsWith('bookmarks:'))).toBe(true);
  });

  test('"bookmarks" (plural read) still routes to the cache runner, not the write runner', async () => {
    const calls: string[] = [];
    const eng = fakeEngine(calls);
    // `bookmarks --live` triggers the live read path, which calls engine.bookmarks()
    await dispatch(parseArgs(['bookmarks', '--live']), eng);
    expect(calls.some((c) => c.startsWith('bookmarks:'))).toBe(true);
    // None of the calls should be the bookmark write handler
    expect(calls.every((c) => c !== 'bookmark:undefined')).toBe(true);
  });

  test('bookmark extracts a tweet id from a status URL', async () => {
    const calls: string[] = [];
    const eng = fakeEngine(calls);
    await dispatch(parseArgs(['bookmark', 'https://x.com/user/status/99988877']), eng);
    expect(calls[0]).toBe('bookmark:99988877');
  });

  test('retweet / unretweet dispatch to correct engine methods with extracted ids', async () => {
    const calls: string[] = [];
    const eng = fakeEngine(calls);
    await dispatch(parseArgs(['retweet', '111222333']), eng);
    await dispatch(parseArgs(['unretweet', 'https://x.com/user/status/444555666']), eng);
    expect(calls).toEqual(['retweet:111222333', 'unretweet:444555666']);
  });

  test('delete without --confirm returns CONFIRMATION_REQUIRED (engine.deleteTweet not called)', async () => {
    const calls: string[] = [];
    const eng = fakeEngine(calls);
    const env = await dispatch(parseArgs(['delete', '99988877']), eng);
    expect(env.ok).toBe(false);
    if (env.ok) throw new Error('expected failure');
    expect(env.error.code).toBe('CONFIRMATION_REQUIRED');
    expect(calls.some((c) => c.startsWith('deleteTweet:'))).toBe(false);
  });

  test('delete with --confirm calls engine.deleteTweet with extracted tweet id', async () => {
    const calls: string[] = [];
    const eng = fakeEngine(calls);
    const env = await dispatch(
      parseArgs(['delete', 'https://x.com/user/status/55544433', '--confirm']),
      eng,
    );
    expect(env.ok).toBe(true);
    expect(calls).toContain('deleteTweet:55544433');
  });

  test('follow / unfollow dispatch to correct engine methods', async () => {
    const calls: string[] = [];
    const eng = fakeEngine(calls);
    await dispatch(parseArgs(['follow', 'jack']), eng);
    await dispatch(parseArgs(['unfollow', 'elonmusk']), eng);
    expect(calls).toEqual(['follow:jack', 'unfollow:elonmusk']);
  });

  test('post with single --image uploads the file and passes mediaId', async () => {
    const calls: string[] = [];
    const eng = fakeEngine(calls);
    await dispatch(parseArgs(['post', 'Hello!', '--image', '/tmp/photo.jpg']), eng);
    expect(calls).toContain('uploadMedia:/tmp/photo.jpg');
    const postCall = calls.find((c) => c.startsWith('post:'));
    expect(postCall).toContain('media-id-/tmp/photo.jpg');
  });

  test('post with repeated -i collects multiple image paths', async () => {
    const calls: string[] = [];
    const eng = fakeEngine(calls);
    await dispatch(
      parseArgs(['post', 'Multi!', '-i', '/a.jpg', '-i', '/b.png', '-i', '/c.gif']),
      eng,
    );
    expect(calls).toContain('uploadMedia:/a.jpg');
    expect(calls).toContain('uploadMedia:/b.png');
    expect(calls).toContain('uploadMedia:/c.gif');
  });

  test('doctor --offline dispatches without any engine calls', async () => {
    // Provide cookies via env so the doctor cookie check never touches the Keychain.
    const saved = process.env.XRELAY_COOKIES;
    process.env.XRELAY_COOKIES = 'auth_token=x; ct0=y';
    try {
      const calls: string[] = [];
      const env = await dispatch(parseArgs(['doctor', '--offline']), fakeEngine(calls));
      expect(env.ok).toBe(true);
      if (!env.ok) throw new Error('expected Ok envelope');
      expect(env.command).toBe('doctor');
      // --offline performs no live checks, so the fakeEngine is untouched.
      expect(calls).toHaveLength(0);
    } finally {
      // biome-ignore lint/performance/noDelete: env cleanup — assigning undefined would stringify to "undefined"
      if (saved === undefined) delete process.env.XRELAY_COOKIES;
      else process.env.XRELAY_COOKIES = saved;
    }
  });
});

describe('parseArgs --image / -i', () => {
  test('--image is collected as a repeatable flag', () => {
    const p = parseArgs(['post', 'hello', '--image', '/a.jpg', '--image', '/b.png']);
    expect(p.flags.image).toEqual(['/a.jpg', '/b.png']);
  });

  test('-i short alias is collected as image', () => {
    const p = parseArgs(['post', 'hello', '-i', '/a.jpg', '-i', '/b.png']);
    expect(p.flags.image).toEqual(['/a.jpg', '/b.png']);
  });

  test('mixed --image and -i are merged into one array', () => {
    const p = parseArgs(['post', 'hello', '--image', '/a.jpg', '-i', '/b.png']);
    expect(p.flags.image).toEqual(['/a.jpg', '/b.png']);
  });
});
