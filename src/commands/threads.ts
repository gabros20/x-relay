// ─── archive threads ─────────────────────────────────────────────────────────
// Capture the author's own continuation ("🧵 1/12 …") of archived posts. A bookmark
// pull returns only the saved post; the rest of its thread needs one TweetDetail
// call per post (engine.selfThread). Shared by `archive --threads` (new posts in the
// same run) and `archive repair --threads` (the backlog, resumable).
//
// It runs on the user's logged-in session, so it is deliberately gentle: strictly
// sequential, a delay between calls, stop at the first rate limit / auth problem
// (the next run resumes — every checked post is stamped `threadCheckedAt`), and give
// up after a few failures in a row instead of grinding through a broken X.
import { toArchiveTweet } from '../archive.ts';
import { EngineError } from '../engine/index.ts';
import { parseTwitterDateMs } from '../time.ts';
import type { ArchiveTweet, SelfThreadResult } from '../types.ts';

/** A post checked younger than this is checked once more after it — authors keep adding. */
export const RECHECK_HOURS = 48;
export const DEFAULT_THREAD_DELAY_MS = 3000;
const MAX_CONSECUTIVE_FAILURES = 5;
/** Errors that will hit every following call too: stop the sweep, resume next run. */
const STOP_CODES = new Set(['RATE_LIMITED', 'AUTH_FAILED', 'FEATURE_DRIFT']);
const HOUR_MS = 3_600_000;

function createdMs(t: ArchiveTweet): number | undefined {
  if (t.createdAtISO) {
    const ms = Date.parse(t.createdAtISO);
    if (!Number.isNaN(ms)) return ms;
  }
  return t.createdAt !== undefined ? parseTwitterDateMs(t.createdAt) : undefined;
}

/**
 * Does this post need a thread lookup? Only posts with replies can have one (a thread
 * is a reply chain); retweets aren't the author's. A post is settled once checked
 * after it was RECHECK_HOURS old; one checked younger gets exactly one more look.
 */
export function needsThreadCheck(
  t: ArchiveTweet,
  nowMs: number,
  recheckHours = RECHECK_HOURS,
): boolean {
  if (t.isRetweet || (t.metrics?.replies ?? 0) === 0) return false;
  if (t.threadCheckedAt === undefined) return true;
  const created = createdMs(t);
  const checked = Date.parse(t.threadCheckedAt);
  if (created === undefined || Number.isNaN(checked)) return false;
  const window = recheckHours * HOUR_MS;
  return checked - created < window && nowMs - created >= window;
}

const THREAD_HINT = /🧵|\bthread\b|(?:^|\s|\()1\s?\/\s?\d{1,2}\b/i;

/** Lookup order: posts that announce a thread first (🧵, "1/8", "thread"), then newest first. */
export function threadCheckOrder(tweets: ArchiveTweet[]): ArchiveTweet[] {
  const hinted = (t: ArchiveTweet) => (THREAD_HINT.test(t.text) ? 0 : 1);
  return [...tweets].sort(
    (a, b) => hinted(a) - hinted(b) || (BigInt(b.id) > BigInt(a.id) ? 1 : -1),
  );
}

export interface CaptureOpts {
  /** Max posts to look up this run. */
  limit?: number;
  /** Pause between lookups (default DEFAULT_THREAD_DELAY_MS). */
  delayMs?: number;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  progress?: (line: string) => void;
  /** Called after every `checkpointEvery` lookups (e.g. to save the file). */
  onCheckpoint?: (done: number) => void;
  checkpointEvery?: number;
}

export interface CaptureResult {
  /** Posts looked up and stamped (incl. deleted ones). */
  checked: number;
  /** Of those, posts that have an author thread. */
  withThread: number;
  /** Thread posts stored across them. */
  threadPosts: number;
  /** Lookups that failed transiently — left unstamped, retried next run. */
  failed: number;
  /** Set when the sweep ended early: the rest waits for the next run. */
  stopped?: { code: string; message: string };
}

type Lookup =
  | { kind: 'ok'; threadPosts: number }
  | { kind: 'gone' }
  | { kind: 'stop'; code: string; message: string }
  | { kind: 'failed'; code: string; message: string };

/** One post: look up its thread and store it in place. Never throws. */
async function lookupOne(
  engine: { selfThread(id: string): Promise<SelfThreadResult> },
  post: ArchiveTweet,
  stamp: string,
): Promise<Lookup> {
  try {
    const { thread } = await engine.selfThread(post.id);
    // `undefined` (not delete) drops the key from the JSON all the same.
    post.thread = thread.length > 0 ? thread.map(toArchiveTweet) : undefined;
    post.threadCheckedAt = stamp;
    return { kind: 'ok', threadPosts: thread.length };
  } catch (e) {
    const code = e instanceof EngineError ? e.code : 'FETCH_FAILED';
    const message = e instanceof Error ? e.message : String(e);
    if (STOP_CODES.has(code)) return { kind: 'stop', code, message };
    if (code === 'NOT_FOUND') {
      // Deleted / protected: nothing to read now or later.
      post.threadCheckedAt = stamp;
      return { kind: 'gone' };
    }
    return { kind: 'failed', code, message };
  }
}

/**
 * Look up the author's thread of each target post (in the given order) and store it
 * on the post in place: `thread` (when non-empty) + `threadCheckedAt`.
 */
export async function captureThreads(
  engine: { selfThread(id: string): Promise<SelfThreadResult> },
  targets: ArchiveTweet[],
  opts: CaptureOpts = {},
): Promise<CaptureResult> {
  const now = opts.now ?? (() => new Date());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const delay = opts.delayMs ?? DEFAULT_THREAD_DELAY_MS;
  const todo = opts.limit !== undefined ? targets.slice(0, opts.limit) : targets;
  const result: CaptureResult = { checked: 0, withThread: 0, threadPosts: 0, failed: 0 };
  let failStreak = 0;

  for (let i = 0; i < todo.length; i++) {
    if (i > 0 && delay > 0) await sleep(delay);
    const outcome = await lookupOne(engine, todo[i] as ArchiveTweet, now().toISOString());
    if (outcome.kind === 'stop') {
      result.stopped = { code: outcome.code, message: outcome.message };
      break;
    }
    if (outcome.kind === 'failed') {
      result.failed += 1;
      failStreak += 1;
      if (failStreak >= MAX_CONSECUTIVE_FAILURES) {
        result.stopped = {
          code: outcome.code,
          message: `${failStreak} lookups failed in a row: ${outcome.message}`,
        };
        break;
      }
    } else {
      failStreak = 0;
      result.checked += 1;
      if (outcome.kind === 'ok' && outcome.threadPosts > 0) {
        result.withThread += 1;
        result.threadPosts += outcome.threadPosts;
      }
    }
    const done = i + 1;
    if (opts.checkpointEvery && done % opts.checkpointEvery === 0) opts.onCheckpoint?.(done);
    if (opts.progress && (done % 25 === 0 || done === todo.length)) {
      opts.progress(
        `threads ${done}/${todo.length}: ${result.withThread} with a thread (${result.threadPosts} posts), ${result.failed} failed`,
      );
    }
  }
  return result;
}
