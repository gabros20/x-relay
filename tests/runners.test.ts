import { describe, expect, test } from 'bun:test';
import { requireConfirmation, runPost, runQuote, runReply } from '../src/commands/runners.ts';
import type { Engine } from '../src/engine/index.ts';
import { EngineError } from '../src/engine/index.ts';

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
