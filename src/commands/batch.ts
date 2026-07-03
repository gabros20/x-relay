// ─── batch + dedupe ───────────────────────────────────────────────────────
// First-class support for the "run many searches, merge, dedupe" workflow that
// agents used to hand-roll with Python loops + sleep + a manual seen-set.
//
// - runBatch: STRICTLY serialized multi-query search with a delay between calls,
//   continue-on-error, cross-query dedupe by tweet id, stderr progress, and an
//   archive-format merge/save (or in-envelope archive with --stdout).
// - runDedupe: OFFLINE merge+dedupe of files produced by `search` or `archive`,
//   with optional engagement sort. No engine, no network.
import { readFileSync } from 'node:fs';
import { loadArchive, mergeArchive, saveArchive, toArchiveTweet } from '../archive.ts';
import { type Engine, EngineError } from '../engine/index.ts';
import type { SearchProduct } from '../engine/ops.ts';
import { sortByEngagement } from '../format.ts';
import { err, ok } from '../output.ts';
import { type ProgressReporter, progressReporter } from '../progress.ts';
import type { ArchiveFile, ArchiveTweet, Envelope, Err, Tweet } from '../types.ts';

const DEFAULT_DELAY_MS = 2000;

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── batch ─────────────────────────────────────────────────────────────────

export interface BatchOpts {
  /** Path to a newline-delimited query file (blank lines and `#` comments skipped). */
  file: string;
  /** Ms to sleep between queries (default 2000). */
  delay?: number;
  /** Per-query result cap. */
  limit?: number;
  /** Search product / tab applied to every query. */
  product?: SearchProduct;
  /** Output archive path; merged into if it already exists. */
  out?: string;
  /** Return the merged archive inside the envelope instead of writing a file. */
  stdout?: boolean;
  /** Suppress stderr progress. */
  quiet?: boolean;
}

/** Injectable seams (sleep + progress) so serialization is testable without wall-clock waits. */
export interface BatchDeps {
  sleep?: (ms: number) => Promise<void>;
  progress?: ProgressReporter;
}

/** The per-query outcome recorded in the batch summary. */
export interface BatchQueryResult {
  query: string;
  /** Raw tweets returned for this query (before cross-query dedupe). Absent on error. */
  count?: number;
  /** Set instead of `count` when the query failed. */
  error?: { code: string; retryAfterMs?: number };
}

export interface BatchResult {
  queries: number;
  succeeded: number;
  failed: number;
  /** Unique tweet ids collected across all successful queries. */
  totalUnique: number;
  /** Path written to (present only with --out). */
  out?: string;
  perQuery: BatchQueryResult[];
  /** The merged archive (present only with --stdout). */
  archive?: ArchiveFile;
}

/** Parse a query file: one query per line, blank lines and `#` comments dropped. */
function parseQueryLines(raw: string): string[] {
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));
}

/** Reduce an unknown throw into the compact error record stored per query. */
function batchErrorRecord(e: unknown): { code: string; retryAfterMs?: number } {
  if (e instanceof EngineError) {
    return {
      code: e.code,
      ...(e.retryAfterMs !== undefined ? { retryAfterMs: e.retryAfterMs } : {}),
    };
  }
  return { code: 'FETCH_FAILED' };
}

function searchOpts(opts: BatchOpts): { product?: SearchProduct; limit?: number } {
  return {
    ...(opts.product ? { product: opts.product } : {}),
    ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
  };
}

/**
 * Run one query: record its tweets (deduped into `seen`) + a perQuery entry, and
 * return how long to wait before the NEXT query — the normal delay, or a
 * rate-limit's retryAfterMs when the query was throttled.
 */
async function runOneQuery(
  engine: Engine,
  query: string,
  opts: BatchOpts,
  seen: Map<string, Tweet>,
  perQuery: BatchQueryResult[],
  delay: number,
): Promise<number> {
  try {
    const res = await engine.search(query, searchOpts(opts));
    for (const t of res.tweets) if (!seen.has(t.id)) seen.set(t.id, t);
    perQuery.push({ query, count: res.tweets.length });
    return delay;
  } catch (e) {
    const rec = batchErrorRecord(e);
    perQuery.push({ query, error: rec });
    return rec.code === 'RATE_LIMITED' ? (rec.retryAfterMs ?? delay) : delay;
  }
}

/** Serialized query loop: sleep sits BETWEEN queries, never after the last. */
async function executeQueries(
  engine: Engine,
  queries: string[],
  opts: BatchOpts,
  sleep: (ms: number) => Promise<void>,
  progress: ProgressReporter,
): Promise<{ seen: Map<string, Tweet>; perQuery: BatchQueryResult[] }> {
  const seen = new Map<string, Tweet>();
  const perQuery: BatchQueryResult[] = [];
  const delay = opts.delay ?? DEFAULT_DELAY_MS;
  for (let i = 0; i < queries.length; i++) {
    const query = queries[i] as string;
    progress(`searching ${i + 1}/${queries.length}: ${query}`);
    const waitMs = await runOneQuery(engine, query, opts, seen, perQuery, delay);
    if (i < queries.length - 1) await sleep(waitMs);
  }
  return { seen, perQuery };
}

/** Build the summary + either persist the merged archive or embed it in the result. */
function buildBatchResult(
  queries: string[],
  seen: Map<string, Tweet>,
  perQuery: BatchQueryResult[],
  opts: BatchOpts,
): BatchResult {
  const fresh = [...seen.values()].map(toArchiveTweet);
  const existing = opts.out ? loadArchive(opts.out) : null;
  const { file } = mergeArchive(existing, fresh, { generatedAt: new Date().toISOString() });
  file.source = 'search';
  file.queries = queries;

  const succeeded = perQuery.filter((q) => q.error === undefined).length;
  const result: BatchResult = {
    queries: queries.length,
    succeeded,
    failed: perQuery.length - succeeded,
    totalUnique: seen.size,
    perQuery,
  };
  if (opts.out) {
    saveArchive(opts.out, file);
    result.out = opts.out;
  } else {
    result.archive = file;
  }
  return result;
}

function validateBatchOpts(opts: BatchOpts): Err | null {
  if (!opts.stdout && !opts.out) {
    return err('batch', 'INVALID_INPUT', 'provide --out <file.json> or --stdout');
  }
  if (!opts.file) return err('batch', 'INVALID_INPUT', 'provide --file <queries.txt>');
  return null;
}

/**
 * Run a serialized batch of searches from a query file. Continue-on-error: a
 * failed query is recorded and the loop proceeds (a rate-limited query waits its
 * retryAfterMs before the next). Results are deduped by tweet id across queries.
 */
export async function runBatch(
  engine: Engine,
  opts: BatchOpts,
  deps: BatchDeps = {},
): Promise<Envelope<BatchResult>> {
  const invalid = validateBatchOpts(opts);
  if (invalid) return invalid;

  let raw: string;
  try {
    raw = readFileSync(opts.file, 'utf-8');
  } catch {
    return err('batch', 'INVALID_INPUT', `could not read --file '${opts.file}'`);
  }
  const queries = parseQueryLines(raw);
  if (queries.length === 0) {
    return err(
      'batch',
      'INVALID_INPUT',
      `no queries in '${opts.file}' (blank lines and # comments are skipped)`,
    );
  }

  const sleep = deps.sleep ?? defaultSleep;
  const progress = deps.progress ?? progressReporter(opts.quiet ?? false);
  const { seen, perQuery } = await executeQueries(engine, queries, opts, sleep, progress);
  return ok('batch', buildBatchResult(queries, seen, perQuery, opts));
}

// ── dedupe (offline) ────────────────────────────────────────────────────────

export interface DedupeOpts {
  /** Input files: `search` envelopes and/or x-relay archive files. */
  files: string[];
  out?: string;
  stdout?: boolean;
  /** Rank the merged tweets by engagement score before writing. */
  sort?: 'engagement';
}

export interface DedupeResult {
  files: number;
  /** Total tweets read across all files, before dedupe. */
  totalIn: number;
  totalUnique: number;
  out?: string;
  archive?: ArchiveFile;
}

/**
 * Read the tweets out of one input file, normalizing to ArchiveTweet. Detects
 * shape: an x-relay archive file (schema + tweets) or a `search`-style envelope
 * ({data:{tweets}}). Returns null when the file is unreadable or unrecognized.
 */
function readTweetsFromFile(path: string): ArchiveTweet[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;

  // Archive file (or batch --out): already ArchiveTweet[].
  if (obj.schema === 'x-relay/archive@1' && Array.isArray(obj.tweets)) {
    return obj.tweets as ArchiveTweet[];
  }
  // search / quoters envelope: { ok, command, data: { tweets: Tweet[] } }.
  const data = obj.data;
  if (typeof data === 'object' && data !== null) {
    const tweets = (data as Record<string, unknown>).tweets;
    if (Array.isArray(tweets)) return (tweets as Tweet[]).map(toArchiveTweet);
  }
  return null;
}

function validateDedupeOpts(opts: DedupeOpts): Err | null {
  if (!opts.stdout && !opts.out) {
    return err('dedupe', 'INVALID_INPUT', 'provide --out <file.json> or --stdout');
  }
  if (opts.files.length === 0) {
    return err('dedupe', 'INVALID_INPUT', 'provide one or more input files');
  }
  return null;
}

/**
 * Offline merge + dedupe of `search` / `archive` output files, with optional
 * engagement sort. Writes an archive-format file (--out) or returns the merged
 * archive in the envelope (--stdout). Never touches the network.
 */
export function runDedupe(opts: DedupeOpts): Envelope<DedupeResult> {
  const invalid = validateDedupeOpts(opts);
  if (invalid) return invalid;

  const collected: ArchiveTweet[] = [];
  for (const path of opts.files) {
    const tweets = readTweetsFromFile(path);
    if (tweets === null) {
      return err(
        'dedupe',
        'INVALID_INPUT',
        `could not read or recognize '${path}' (expected a search envelope or an x-relay archive file)`,
      );
    }
    collected.push(...tweets);
  }

  const seen = new Map<string, ArchiveTweet>();
  for (const t of collected) if (!seen.has(t.id)) seen.set(t.id, t);
  let merged = [...seen.values()];
  if (opts.sort === 'engagement') {
    // sortByEngagement scores off .metrics, which ArchiveTweet carries; the cast
    // only reconciles the media[] field type, unused by the scorer.
    merged = sortByEngagement(merged as unknown as Tweet[]) as unknown as ArchiveTweet[];
  }

  const { file } = mergeArchive(null, merged, { generatedAt: new Date().toISOString() });
  file.source = 'search';

  const result: DedupeResult = {
    files: opts.files.length,
    totalIn: collected.length,
    totalUnique: merged.length,
  };
  if (opts.out) {
    saveArchive(opts.out, file);
    result.out = opts.out;
  } else {
    result.archive = file;
  }
  return ok('dedupe', result);
}
