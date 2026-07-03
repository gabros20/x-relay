import { describe, expect, test } from 'bun:test';
import {
  requireConfirmation,
  runBookmarkAdd,
  runDelete,
  runFollow,
  runLike,
  runPost,
  runQuote,
  runReply,
  runRetweet,
  runSearch,
  runThread,
  runUnbookmark,
  runUnfollow,
  runUnlike,
  runUnretweet,
} from '../src/commands/runners.ts';
import type { Engine } from '../src/engine/index.ts';
import { EngineError } from '../src/engine/index.ts';
import type { SearchResult, Tweet } from '../src/types.ts';

describe('requireConfirmation (destructive-write guard)', () => {
  test('blocks with a CONFIRMATION_REQUIRED envelope when not confirmed', () => {
    const block = requireConfirmation('delete-tweet', {}, 'permanently delete tweet 20');
    expect(block).not.toBeNull();
    if (block === null) throw new Error('expected a block envelope');
    expect(block.ok).toBe(false);
    if (block.ok) throw new Error('expected failure envelope');
    expect(block.command).toBe('delete-tweet');
    expect(block.error.code).toBe('CONFIRMATION_REQUIRED');
    expect(block.error.message).toContain('permanently delete tweet 20');
    expect(block.error.hint).toBeDefined();
  });

  test('blocks when confirmed is explicitly false', () => {
    expect(requireConfirmation('unfollow', { confirmed: false }, 'unfollow @x')).not.toBeNull();
  });

  test('returns null (proceed) only when confirmed is exactly true', () => {
    expect(requireConfirmation('delete-tweet', { confirmed: true }, 'delete')).toBeNull();
  });
});

// ── runThread (tweet-id resolution / validation) ─────────────────────────────

/** Engine stub whose thread() records the id it was called with. */
function fakeThreadEngine(calls: string[]): Engine {
  return {
    thread: async (id: string) => {
      calls.push(id);
      return { root: {}, replies: [] };
    },
  } as unknown as Engine;
}

describe('runThread tweet-id validation', () => {
  test('malformed X URL → INVALID_INPUT and engine.thread is never called', async () => {
    const calls: string[] = [];
    const env = await runThread(fakeThreadEngine(calls), 'https://x.com/someuser');
    expect(env.ok).toBe(false);
    if (env.ok) throw new Error('expected failure');
    expect(env.error.code).toBe('INVALID_INPUT');
    expect(calls).toHaveLength(0);
  });

  test('plain garbage string → INVALID_INPUT and engine.thread is never called', async () => {
    const calls: string[] = [];
    const env = await runThread(fakeThreadEngine(calls), 'not a tweet');
    expect(env.ok).toBe(false);
    if (env.ok) throw new Error('expected failure');
    expect(env.error.code).toBe('INVALID_INPUT');
    expect(calls).toHaveLength(0);
  });

  test('valid bare id → engine.thread called with that id', async () => {
    const calls: string[] = [];
    const env = await runThread(fakeThreadEngine(calls), '1234567890');
    expect(env.ok).toBe(true);
    expect(calls).toEqual(['1234567890']);
  });

  test('valid status URL → engine.thread called with the extracted id', async () => {
    const calls: string[] = [];
    const env = await runThread(fakeThreadEngine(calls), 'https://x.com/x/status/123456789');
    expect(env.ok).toBe(true);
    expect(calls).toEqual(['123456789']);
  });
});

// ── runPost / runReply / runQuote ─────────────────────────────────────────────

type PostSpy = (
  text: string,
  opts?: { replyToId?: string; quoteTweetId?: string },
) => Promise<{ id: string; url: string }>;

/** Minimal Engine stub that delegates post() to a spy. */
function fakeEngine(spy: PostSpy): Engine {
  return {
    post: spy,
  } as unknown as Engine;
}

describe('runPost', () => {
  test('INVALID_INPUT on empty text', async () => {
    const engine = fakeEngine(async () => ({ id: '1', url: 'u' }));
    const env = await runPost(engine, '');
    expect(env.ok).toBe(false);
    if (env.ok) throw new Error('expected failure');
    expect(env.error.code).toBe('INVALID_INPUT');
  });

  test('INVALID_INPUT on whitespace-only text', async () => {
    const engine = fakeEngine(async () => ({ id: '1', url: 'u' }));
    const env = await runPost(engine, '   ');
    expect(env.ok).toBe(false);
    if (env.ok) throw new Error('expected failure');
    expect(env.error.code).toBe('INVALID_INPUT');
  });

  test('happy path: calls engine.post() with text and returns {id, url}', async () => {
    let captured: string | undefined;
    const engine = fakeEngine(async (text) => {
      captured = text;
      return { id: '999000111', url: 'https://x.com/i/web/status/999000111' };
    });
    const env = await runPost(engine, 'Hello world!');
    expect(env.ok).toBe(true);
    if (!env.ok) throw new Error('expected success');
    expect(env.data.id).toBe('999000111');
    expect(env.data.url).toBe('https://x.com/i/web/status/999000111');
    expect(captured).toBe('Hello world!');
  });

  test('maps EngineError to an error envelope', async () => {
    const engine = fakeEngine(async () => {
      throw new EngineError('WRITE_FAILED', 'server error');
    });
    const env = await runPost(engine, 'fail');
    expect(env.ok).toBe(false);
    if (env.ok) throw new Error('expected failure');
    expect(env.error.code).toBe('WRITE_FAILED');
  });
});

describe('runReply', () => {
  test('INVALID_INPUT on missing tweetId', async () => {
    const engine = fakeEngine(async () => ({ id: '1', url: 'u' }));
    const env = await runReply(engine, '', 'some text');
    expect(env.ok).toBe(false);
    if (env.ok) throw new Error('expected failure');
    expect(env.error.code).toBe('INVALID_INPUT');
  });

  test('INVALID_INPUT on empty text', async () => {
    const engine = fakeEngine(async () => ({ id: '1', url: 'u' }));
    const env = await runReply(engine, '12345', '');
    expect(env.ok).toBe(false);
    if (env.ok) throw new Error('expected failure');
    expect(env.error.code).toBe('INVALID_INPUT');
  });

  test('happy path: calls engine.post with replyToId and returns {id, url}', async () => {
    let capturedOpts: { replyToId?: string; quoteTweetId?: string } | undefined;
    const engine = fakeEngine(async (_text, opts) => {
      capturedOpts = opts;
      return { id: '555666777', url: 'https://x.com/i/web/status/555666777' };
    });
    const env = await runReply(engine, '99988877', 'Nice thread!');
    expect(env.ok).toBe(true);
    if (!env.ok) throw new Error('expected success');
    expect(env.data.id).toBe('555666777');
    expect(capturedOpts?.replyToId).toBe('99988877');
    expect(capturedOpts?.quoteTweetId).toBeUndefined();
  });
});

describe('runQuote', () => {
  test('INVALID_INPUT on missing tweetId', async () => {
    const engine = fakeEngine(async () => ({ id: '1', url: 'u' }));
    const env = await runQuote(engine, '', 'comment');
    expect(env.ok).toBe(false);
    if (env.ok) throw new Error('expected failure');
    expect(env.error.code).toBe('INVALID_INPUT');
  });

  test('INVALID_INPUT on empty text', async () => {
    const engine = fakeEngine(async () => ({ id: '1', url: 'u' }));
    const env = await runQuote(engine, '12345', '');
    expect(env.ok).toBe(false);
    if (env.ok) throw new Error('expected failure');
    expect(env.error.code).toBe('INVALID_INPUT');
  });

  test('happy path: calls engine.post with quoteTweetId and returns {id, url}', async () => {
    let capturedOpts: { replyToId?: string; quoteTweetId?: string } | undefined;
    const engine = fakeEngine(async (_text, opts) => {
      capturedOpts = opts;
      return { id: '111222333', url: 'https://x.com/i/web/status/111222333' };
    });
    const env = await runQuote(engine, '55544433', 'Interesting take');
    expect(env.ok).toBe(true);
    if (!env.ok) throw new Error('expected success');
    expect(env.data.id).toBe('111222333');
    expect(capturedOpts?.quoteTweetId).toBe('55544433');
    expect(capturedOpts?.replyToId).toBeUndefined();
  });
});

// ── runLike / runUnlike / runBookmarkAdd / runUnbookmark ──────────────────────

/** Builds a minimal Engine stub whose toggle methods delegate to spies. */
function fakeToggleEngine(overrides: Partial<Engine>): Engine {
  const base: Partial<Engine> = {
    like: async () => {},
    unlike: async () => {},
    bookmark: async () => {},
    unbookmark: async () => {},
  };
  return { ...base, ...overrides } as unknown as Engine;
}

describe('runLike', () => {
  test('INVALID_INPUT on empty tweetId', async () => {
    const engine = fakeToggleEngine({});
    const env = await runLike(engine, '');
    expect(env.ok).toBe(false);
    if (env.ok) throw new Error('expected failure');
    expect(env.error.code).toBe('INVALID_INPUT');
  });

  test('happy path: calls engine.like() and returns { tweetId, action: "liked" }', async () => {
    let captured: string | undefined;
    const engine = fakeToggleEngine({
      like: async (id) => {
        captured = id;
      },
    });
    const env = await runLike(engine, '111222333');
    expect(env.ok).toBe(true);
    if (!env.ok) throw new Error('expected success');
    expect(env.data.tweetId).toBe('111222333');
    expect(env.data.action).toBe('liked');
    expect(captured).toBe('111222333');
  });

  test('surfaces ALREADY_DONE as an error envelope when already liked', async () => {
    const engine = fakeToggleEngine({
      like: async () => {
        throw new EngineError('ALREADY_DONE', 'already liked');
      },
    });
    const env = await runLike(engine, '1');
    expect(env.ok).toBe(false);
    if (env.ok) throw new Error('expected failure');
    expect(env.error.code).toBe('ALREADY_DONE');
  });
});

describe('runUnlike', () => {
  test('INVALID_INPUT on empty tweetId', async () => {
    const engine = fakeToggleEngine({});
    const env = await runUnlike(engine, '');
    expect(env.ok).toBe(false);
    if (env.ok) throw new Error('expected failure');
    expect(env.error.code).toBe('INVALID_INPUT');
  });

  test('happy path: calls engine.unlike() and returns { tweetId, action: "unliked" }', async () => {
    let captured: string | undefined;
    const engine = fakeToggleEngine({
      unlike: async (id) => {
        captured = id;
      },
    });
    const env = await runUnlike(engine, '444555666');
    expect(env.ok).toBe(true);
    if (!env.ok) throw new Error('expected success');
    expect(env.data.tweetId).toBe('444555666');
    expect(env.data.action).toBe('unliked');
    expect(captured).toBe('444555666');
  });

  test('surfaces ALREADY_DONE as an error envelope', async () => {
    const engine = fakeToggleEngine({
      unlike: async () => {
        throw new EngineError('ALREADY_DONE', 'not liked');
      },
    });
    const env = await runUnlike(engine, '1');
    expect(env.ok).toBe(false);
    if (env.ok) throw new Error('expected failure');
    expect(env.error.code).toBe('ALREADY_DONE');
  });
});

describe('runBookmarkAdd', () => {
  test('INVALID_INPUT on empty tweetId', async () => {
    const engine = fakeToggleEngine({});
    const env = await runBookmarkAdd(engine, '');
    expect(env.ok).toBe(false);
    if (env.ok) throw new Error('expected failure');
    expect(env.error.code).toBe('INVALID_INPUT');
  });

  test('happy path: calls engine.bookmark() and returns { tweetId, action: "bookmarked" }', async () => {
    let captured: string | undefined;
    const engine = fakeToggleEngine({
      bookmark: async (id) => {
        captured = id;
      },
    });
    const env = await runBookmarkAdd(engine, '777888999');
    expect(env.ok).toBe(true);
    if (!env.ok) throw new Error('expected success');
    expect(env.data.tweetId).toBe('777888999');
    expect(env.data.action).toBe('bookmarked');
    expect(captured).toBe('777888999');
  });

  test('surfaces ALREADY_DONE as an error envelope when already bookmarked', async () => {
    const engine = fakeToggleEngine({
      bookmark: async () => {
        throw new EngineError('ALREADY_DONE', 'already bookmarked');
      },
    });
    const env = await runBookmarkAdd(engine, '1');
    expect(env.ok).toBe(false);
    if (env.ok) throw new Error('expected failure');
    expect(env.error.code).toBe('ALREADY_DONE');
  });
});

describe('runUnbookmark', () => {
  test('INVALID_INPUT on empty tweetId', async () => {
    const engine = fakeToggleEngine({});
    const env = await runUnbookmark(engine, '');
    expect(env.ok).toBe(false);
    if (env.ok) throw new Error('expected failure');
    expect(env.error.code).toBe('INVALID_INPUT');
  });

  test('happy path: calls engine.unbookmark() and returns { tweetId, action: "unbookmarked" }', async () => {
    let captured: string | undefined;
    const engine = fakeToggleEngine({
      unbookmark: async (id) => {
        captured = id;
      },
    });
    const env = await runUnbookmark(engine, '321654987');
    expect(env.ok).toBe(true);
    if (!env.ok) throw new Error('expected success');
    expect(env.data.tweetId).toBe('321654987');
    expect(env.data.action).toBe('unbookmarked');
    expect(captured).toBe('321654987');
  });

  test('surfaces ALREADY_DONE as an error envelope', async () => {
    const engine = fakeToggleEngine({
      unbookmark: async () => {
        throw new EngineError('ALREADY_DONE', 'not bookmarked');
      },
    });
    const env = await runUnbookmark(engine, '1');
    expect(env.ok).toBe(false);
    if (env.ok) throw new Error('expected failure');
    expect(env.error.code).toBe('ALREADY_DONE');
  });
});

// ── runRetweet / runUnretweet ─────────────────────────────────────────────────

/** Builds a minimal Engine stub whose retweet/unretweet methods delegate to spies. */
function fakeRetweetEngine(overrides: Partial<Engine>): Engine {
  const base: Partial<Engine> = {
    retweet: async () => {},
    unretweet: async () => {},
  };
  return { ...base, ...overrides } as unknown as Engine;
}

describe('runRetweet', () => {
  test('INVALID_INPUT on empty tweetId', async () => {
    const engine = fakeRetweetEngine({});
    const env = await runRetweet(engine, '');
    expect(env.ok).toBe(false);
    if (env.ok) throw new Error('expected failure');
    expect(env.error.code).toBe('INVALID_INPUT');
  });

  test('happy path: calls engine.retweet() and returns { tweetId, action: "retweeted" }', async () => {
    let captured: string | undefined;
    const engine = fakeRetweetEngine({
      retweet: async (id) => {
        captured = id;
      },
    });
    const env = await runRetweet(engine, '111222333');
    expect(env.ok).toBe(true);
    if (!env.ok) throw new Error('expected success');
    expect(env.data.tweetId).toBe('111222333');
    expect(env.data.action).toBe('retweeted');
    expect(captured).toBe('111222333');
  });

  test('surfaces ALREADY_DONE as an error envelope when already retweeted', async () => {
    const engine = fakeRetweetEngine({
      retweet: async () => {
        throw new EngineError('ALREADY_DONE', 'already retweeted');
      },
    });
    const env = await runRetweet(engine, '1');
    expect(env.ok).toBe(false);
    if (env.ok) throw new Error('expected failure');
    expect(env.error.code).toBe('ALREADY_DONE');
  });
});

describe('runUnretweet', () => {
  test('INVALID_INPUT on empty tweetId', async () => {
    const engine = fakeRetweetEngine({});
    const env = await runUnretweet(engine, '');
    expect(env.ok).toBe(false);
    if (env.ok) throw new Error('expected failure');
    expect(env.error.code).toBe('INVALID_INPUT');
  });

  test('happy path: calls engine.unretweet() and returns { tweetId, action: "unretweeted" }', async () => {
    let captured: string | undefined;
    const engine = fakeRetweetEngine({
      unretweet: async (id) => {
        captured = id;
      },
    });
    const env = await runUnretweet(engine, '444555666');
    expect(env.ok).toBe(true);
    if (!env.ok) throw new Error('expected success');
    expect(env.data.tweetId).toBe('444555666');
    expect(env.data.action).toBe('unretweeted');
    expect(captured).toBe('444555666');
  });
});

// ── runDelete ─────────────────────────────────────────────────────────────────

describe('runDelete', () => {
  function fakeDeleteEngine(deleteSpy?: (id: string) => Promise<void>): Engine {
    const calls: string[] = [];
    return {
      deleteTweet:
        deleteSpy ??
        (async (id) => {
          calls.push(id);
        }),
    } as unknown as Engine;
  }

  test('INVALID_INPUT on empty tweetId', async () => {
    const engine = fakeDeleteEngine();
    const env = await runDelete(engine, '', {});
    expect(env.ok).toBe(false);
    if (env.ok) throw new Error('expected failure');
    expect(env.error.code).toBe('INVALID_INPUT');
  });

  test('CONFIRMATION_REQUIRED when confirmed is not set — engine.deleteTweet NOT called', async () => {
    let called = false;
    const engine = fakeDeleteEngine(async () => {
      called = true;
    });
    const env = await runDelete(engine, '999', {});
    expect(env.ok).toBe(false);
    if (env.ok) throw new Error('expected failure');
    expect(env.error.code).toBe('CONFIRMATION_REQUIRED');
    expect(called).toBe(false);
  });

  test('CONFIRMATION_REQUIRED when confirmed is explicitly false — engine.deleteTweet NOT called', async () => {
    let called = false;
    const engine = fakeDeleteEngine(async () => {
      called = true;
    });
    const env = await runDelete(engine, '999', { confirmed: false });
    expect(env.ok).toBe(false);
    if (env.ok) throw new Error('expected failure');
    expect(env.error.code).toBe('CONFIRMATION_REQUIRED');
    expect(called).toBe(false);
  });

  test('happy path: with confirmed=true calls engine.deleteTweet and returns { tweetId, action: "deleted" }', async () => {
    let captured: string | undefined;
    const engine = fakeDeleteEngine(async (id) => {
      captured = id;
    });
    const env = await runDelete(engine, '55544433', { confirmed: true });
    expect(env.ok).toBe(true);
    if (!env.ok) throw new Error('expected success');
    expect(env.data.tweetId).toBe('55544433');
    expect(env.data.action).toBe('deleted');
    expect(captured).toBe('55544433');
  });

  test('maps EngineError to an error envelope (with confirmed)', async () => {
    const engine = fakeDeleteEngine(async () => {
      throw new EngineError('WRITE_FAILED', 'not found');
    });
    const env = await runDelete(engine, '1', { confirmed: true });
    expect(env.ok).toBe(false);
    if (env.ok) throw new Error('expected failure');
    expect(env.error.code).toBe('WRITE_FAILED');
  });
});

// ── runFollow / runUnfollow ───────────────────────────────────────────────────

function fakeFollowEngine(overrides: Partial<Engine>): Engine {
  const base: Partial<Engine> = {
    follow: async () => {},
    unfollow: async () => {},
  };
  return { ...base, ...overrides } as unknown as Engine;
}

describe('runFollow', () => {
  test('INVALID_INPUT on empty handle', async () => {
    const engine = fakeFollowEngine({});
    const env = await runFollow(engine, '');
    expect(env.ok).toBe(false);
    if (env.ok) throw new Error('expected failure');
    expect(env.error.code).toBe('INVALID_INPUT');
  });

  test('happy path: calls engine.follow() and returns { handle, action: "followed" }', async () => {
    let captured: string | undefined;
    const engine = fakeFollowEngine({
      follow: async (h) => {
        captured = h;
      },
    });
    const env = await runFollow(engine, 'jack');
    expect(env.ok).toBe(true);
    if (!env.ok) throw new Error('expected success');
    expect(env.data.handle).toBe('jack');
    expect(env.data.action).toBe('followed');
    expect(captured).toBe('jack');
  });

  test('surfaces NOT_FOUND as an error envelope', async () => {
    const engine = fakeFollowEngine({
      follow: async () => {
        throw new EngineError('NOT_FOUND', 'user not found');
      },
    });
    const env = await runFollow(engine, 'ghost');
    expect(env.ok).toBe(false);
    if (env.ok) throw new Error('expected failure');
    expect(env.error.code).toBe('NOT_FOUND');
  });
});

describe('runUnfollow', () => {
  test('INVALID_INPUT on empty handle', async () => {
    const engine = fakeFollowEngine({});
    const env = await runUnfollow(engine, '');
    expect(env.ok).toBe(false);
    if (env.ok) throw new Error('expected failure');
    expect(env.error.code).toBe('INVALID_INPUT');
  });

  test('happy path: calls engine.unfollow() and returns { handle, action: "unfollowed" }', async () => {
    let captured: string | undefined;
    const engine = fakeFollowEngine({
      unfollow: async (h) => {
        captured = h;
      },
    });
    const env = await runUnfollow(engine, 'jack');
    expect(env.ok).toBe(true);
    if (!env.ok) throw new Error('expected success');
    expect(env.data.handle).toBe('jack');
    expect(env.data.action).toBe('unfollowed');
    expect(captured).toBe('jack');
  });

  test('surfaces NOT_FOUND as an error envelope', async () => {
    const engine = fakeFollowEngine({
      unfollow: async () => {
        throw new EngineError('NOT_FOUND', 'user not found');
      },
    });
    const env = await runUnfollow(engine, 'ghost');
    expect(env.ok).toBe(false);
    if (env.ok) throw new Error('expected failure');
    expect(env.error.code).toBe('NOT_FOUND');
  });
});

// ── guard(): rate-limit surfacing (status + retryAfterMs + hint) ──────────────

describe('guard rate-limit surfacing', () => {
  test('RATE_LIMITED EngineError → envelope carries status, retryAfterMs, and a hint', async () => {
    const engine = fakeToggleEngine({
      like: async () => {
        throw new EngineError('RATE_LIMITED', 'Rate limited; retries exhausted.', 429, 30000);
      },
    });
    const env = await runLike(engine, '1');
    expect(env.ok).toBe(false);
    if (env.ok) throw new Error('expected failure');
    expect(env.error.code).toBe('RATE_LIMITED');
    expect(env.error.status).toBe(429);
    expect(env.error.retryAfterMs).toBe(30000);
    expect(env.error.hint).toBeDefined();
    expect(env.error.hint).toContain('retryAfterMs');
  });

  test('non-rate-limit EngineError → status/retryAfterMs absent from the envelope', async () => {
    const engine = fakeToggleEngine({
      like: async () => {
        throw new EngineError('ALREADY_DONE', 'already liked');
      },
    });
    const env = await runLike(engine, '1');
    expect(env.ok).toBe(false);
    if (env.ok) throw new Error('expected failure');
    expect('status' in env.error).toBe(false);
    expect('retryAfterMs' in env.error).toBe(false);
  });
});

// ── runPost / runReply / runQuote with imagePaths ─────────────────────────────

/** Minimal Engine stub for image-attachment tests. */
function fakePostEngineWithUpload(
  uploadSpy: (path: string) => Promise<string>,
  postSpy: (
    text: string,
    opts?: { replyToId?: string; quoteTweetId?: string; mediaIds?: string[] },
  ) => Promise<{ id: string; url: string }>,
): Engine {
  return {
    uploadMedia: uploadSpy,
    post: postSpy,
  } as unknown as Engine;
}

describe('runPost with imagePaths', () => {
  test('calls uploadMedia for each path and passes mediaIds to engine.post', async () => {
    const uploadedPaths: string[] = [];
    const receivedOpts: Array<{ mediaIds?: string[] } | undefined> = [];
    const engine = fakePostEngineWithUpload(
      async (p) => {
        uploadedPaths.push(p);
        return `media-${p}`;
      },
      async (_text, opts) => {
        receivedOpts.push(opts as { mediaIds?: string[] } | undefined);
        return { id: '1', url: 'u' };
      },
    );

    const env = await runPost(engine, 'Hello with image!', {
      imagePaths: ['/tmp/a.jpg', '/tmp/b.png'],
    });

    expect(env.ok).toBe(true);
    expect(uploadedPaths).toEqual(['/tmp/a.jpg', '/tmp/b.png']);
    expect(receivedOpts[0]?.mediaIds).toEqual(['media-/tmp/a.jpg', 'media-/tmp/b.png']);
  });

  test('rejects with INVALID_INPUT when more than 4 images are provided', async () => {
    const engine = fakePostEngineWithUpload(
      async (p) => `id-${p}`,
      async () => ({ id: '1', url: 'u' }),
    );

    const env = await runPost(engine, 'Too many images!', {
      imagePaths: ['/a.jpg', '/b.jpg', '/c.jpg', '/d.jpg', '/e.jpg'],
    });

    expect(env.ok).toBe(false);
    if (env.ok) throw new Error('expected failure');
    expect(env.error.code).toBe('INVALID_INPUT');
  });

  test('with no imagePaths calls engine.post without mediaIds', async () => {
    let capturedOpts: { mediaIds?: string[] } | undefined;
    const engine = fakePostEngineWithUpload(
      async () => 'id',
      async (_text, opts) => {
        capturedOpts = opts as typeof capturedOpts;
        return { id: '2', url: 'u' };
      },
    );

    await runPost(engine, 'Plain tweet');
    expect(capturedOpts).toBeUndefined();
  });

  test('surfaces MEDIA_UPLOAD_FAILED from uploadMedia as an error envelope', async () => {
    const engine = fakePostEngineWithUpload(
      async () => {
        throw new EngineError('MEDIA_UPLOAD_FAILED', 'upload error');
      },
      async () => ({ id: '3', url: 'u' }),
    );

    const env = await runPost(engine, 'Will fail', { imagePaths: ['/x.jpg'] });
    expect(env.ok).toBe(false);
    if (env.ok) throw new Error('expected failure');
    expect(env.error.code).toBe('MEDIA_UPLOAD_FAILED');
  });
});

describe('runReply with imagePaths', () => {
  test('calls uploadMedia and passes mediaIds with replyToId', async () => {
    const uploadedPaths: string[] = [];
    let capturedOpts: { replyToId?: string; mediaIds?: string[] } | undefined;
    const engine = fakePostEngineWithUpload(
      async (p) => {
        uploadedPaths.push(p);
        return `mid-${p}`;
      },
      async (_text, opts) => {
        capturedOpts = opts as typeof capturedOpts;
        return { id: '99', url: 'u' };
      },
    );

    await runReply(engine, '12345', 'Reply with image!', { imagePaths: ['/img.png'] });

    expect(uploadedPaths).toEqual(['/img.png']);
    expect(capturedOpts?.replyToId).toBe('12345');
    expect(capturedOpts?.mediaIds).toEqual(['mid-/img.png']);
  });
});

describe('runQuote with imagePaths', () => {
  test('calls uploadMedia and passes mediaIds with quoteTweetId', async () => {
    const uploadedPaths: string[] = [];
    let capturedOpts: { quoteTweetId?: string; mediaIds?: string[] } | undefined;
    const engine = fakePostEngineWithUpload(
      async (p) => {
        uploadedPaths.push(p);
        return `qid-${p}`;
      },
      async (_text, opts) => {
        capturedOpts = opts as typeof capturedOpts;
        return { id: '88', url: 'u' };
      },
    );

    await runQuote(engine, '55544433', 'Quote with image!', { imagePaths: ['/q.webp'] });

    expect(uploadedPaths).toEqual(['/q.webp']);
    expect(capturedOpts?.quoteTweetId).toBe('55544433');
    expect(capturedOpts?.mediaIds).toEqual(['qid-/q.webp']);
  });
});

// ── runSearch output modes (--sort engagement / --compact / --fields) ─────────

/** Minimal Tweet factory — only the fields format.ts reads matter. */
function searchTweet(over: Partial<Tweet> & { id: string }): Tweet {
  return {
    url: `https://x.com/u/status/${over.id}`,
    text: 'hello',
    author: {
      id: `a${over.id}`,
      handle: `user${over.id}`,
      name: `User ${over.id}`,
      verified: false,
    },
    metrics: {},
    ...over,
  } as Tweet;
}

/** Engine stub whose search() returns a fixed tweet set as a SearchResult. */
function fakeSearchEngine(tweets: Tweet[]): Engine {
  return {
    search: async (query: string, opts?: { product?: string }): Promise<SearchResult> => ({
      query,
      product: (opts?.product ?? 'Top') as SearchResult['product'],
      tweets,
    }),
  } as unknown as Engine;
}

describe('runSearch output modes', () => {
  // Scores: A = 10, B = 5*3 = 15, C = 3*2 = 6 → engagement order B, A, C.
  const tweets = (): Tweet[] => [
    searchTweet({ id: 'A', metrics: { likes: 10 } }),
    searchTweet({ id: 'B', metrics: { replies: 5 } }),
    searchTweet({ id: 'C', metrics: { bookmarks: 3 } }),
  ];

  test('sort=engagement orders tweets by likes+replies*3+bookmarks*2 desc', async () => {
    const env = await runSearch(fakeSearchEngine(tweets()), { query: 'x', sort: 'engagement' });
    expect(env.ok).toBe(true);
    if (!env.ok) throw new Error('expected success');
    expect(env.data.tweets.map((t) => (t as Tweet).id)).toEqual(['B', 'A', 'C']);
    // sort-only leaves the shape untouched — no compact marker.
    expect('compact' in env.data).toBe(false);
  });

  test('compact returns flat compact tweets and a data.compact marker', async () => {
    const env = await runSearch(fakeSearchEngine(tweets()), { query: 'x', compact: true });
    expect(env.ok).toBe(true);
    if (!env.ok) throw new Error('expected success');
    expect((env.data as { compact?: boolean }).compact).toBe(true);
    const first = env.data.tweets[0] as Record<string, unknown>;
    expect(first.handle).toBe('userA');
    expect(first.likes).toBe(10);
    // flattened — no nested author/metrics objects
    expect('author' in first).toBe(false);
    expect('metrics' in first).toBe(false);
  });

  test('compact + sort=engagement sorts first, then compacts', async () => {
    const env = await runSearch(fakeSearchEngine(tweets()), {
      query: 'x',
      sort: 'engagement',
      compact: true,
    });
    expect(env.ok).toBe(true);
    if (!env.ok) throw new Error('expected success');
    expect(env.data.tweets.map((t) => (t as { id: string }).id)).toEqual(['B', 'A', 'C']);
  });

  test('fields projects only the requested keys', async () => {
    const env = await runSearch(fakeSearchEngine(tweets()), {
      query: 'x',
      fields: ['id', 'likes'],
    });
    expect(env.ok).toBe(true);
    if (!env.ok) throw new Error('expected success');
    expect((env.data as { compact?: boolean }).compact).toBe(true);
    expect(env.data.tweets[0]).toEqual({ id: 'A', likes: 10 });
  });

  test('fields + sort=engagement projects AND reorders (sort applied before projection)', async () => {
    const env = await runSearch(fakeSearchEngine(tweets()), {
      query: 'x',
      sort: 'engagement',
      fields: ['id', 'likes'],
    });
    expect(env.ok).toBe(true);
    if (!env.ok) throw new Error('expected success');
    expect((env.data as { compact?: boolean }).compact).toBe(true);
    // engagement order B(15), A(10), C(6); each projected to {id, likes}.
    expect(env.data.tweets).toEqual([
      { id: 'B', likes: 0 },
      { id: 'A', likes: 10 },
      { id: 'C', likes: 0 },
    ]);
  });

  test('compact + fields together → INVALID_INPUT', async () => {
    const env = await runSearch(fakeSearchEngine(tweets()), {
      query: 'x',
      compact: true,
      fields: ['id'],
    });
    expect(env.ok).toBe(false);
    if (env.ok) throw new Error('expected failure');
    expect(env.error.code).toBe('INVALID_INPUT');
  });

  test('unknown field name → INVALID_INPUT listing the valid names', async () => {
    const env = await runSearch(fakeSearchEngine(tweets()), {
      query: 'x',
      fields: ['id', 'nope'],
    });
    expect(env.ok).toBe(false);
    if (env.ok) throw new Error('expected failure');
    expect(env.error.code).toBe('INVALID_INPUT');
    expect(env.error.message).toContain('nope');
    // the valid field names are surfaced (message or hint)
    const blob = `${env.error.message} ${env.error.hint ?? ''}`;
    expect(blob).toContain('handle');
    expect(blob).toContain('likes');
  });

  test('fields flag present but empty (parses to []) → INVALID_INPUT, not a silent no-op', async () => {
    const env = await runSearch(fakeSearchEngine(tweets()), { query: 'x', fields: [] });
    expect(env.ok).toBe(false);
    if (env.ok) throw new Error('expected failure');
    expect(env.error.code).toBe('INVALID_INPUT');
    expect(`${env.error.message} ${env.error.hint ?? ''}`).toContain('handle');
  });

  test('no output-mode flags → untransformed SearchResult (no compact marker)', async () => {
    const env = await runSearch(fakeSearchEngine(tweets()), { query: 'x' });
    expect(env.ok).toBe(true);
    if (!env.ok) throw new Error('expected success');
    expect('compact' in env.data).toBe(false);
    // full Tweet shape retained (nested author present)
    expect((env.data.tweets[0] as Tweet).author.handle).toBe('userA');
  });
});
