// ─── archive repair --media ───────────────────────────────────────────────
// Backfill missing video/GIF posters (`thumbnail`) and video `durationMs` on an
// EXISTING archive file. Archives imported from older tools carry no posters, and
// incremental `archive` runs never revisit known tweets, so without this they
// stay posterless forever. Fresh captures already get both (parse-extra.ts).
//
// Source: X's public syndication endpoint (engine/syndication.ts) — no cookies,
// no account, no account risk. Each post with a candidate item is fetched once
// (bounded concurrency); posters are matched to stored items by media id, with a
// positional fallback only when it is unambiguous.
//
// Guarantees: only fills ABSENT fields (never overwrites), idempotent, preserves
// the file's formatting (compact vs indented) and everything else in it, writes
// atomically (temp file + rename), and `--dry-run` writes nothing.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  type SyndicationMedia,
  type SyndicationOpts,
  type SyndicationResult,
  fetchSyndicationTweet,
} from '../engine/syndication.ts';
import { err, ok } from '../output.ts';
import { type ProgressReporter, progressReporter } from '../progress.ts';
import type { ArchiveFile, ArchiveTweet, Envelope, MediaItem } from '../types.ts';

const DEFAULT_CONCURRENCY = 4;
const MAX_CONCURRENCY = 16;
const PROGRESS_EVERY = 100;

export interface RepairOpts {
  /** The archive file to repair. */
  file: string;
  /** Repair kind: video/GIF posters + video durations. Currently the only kind (required). */
  media?: boolean;
  /** Write the repaired archive here instead of in place. */
  out?: string;
  /** Fetch + match, report, but write nothing. */
  dryRun?: boolean;
  /** Parallel syndication requests (default 4, max 16). */
  concurrency?: number;
  /** Cap the number of posts fetched this run; the rest are reported as `skipped`. */
  limit?: number;
  /** Suppress stderr progress. */
  quiet?: boolean;
}

/** Injectable seams so the runner is testable with a mocked fetch and no waits. */
export interface RepairDeps {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  progress?: ProgressReporter;
  /** Per-request timeout for the syndication fetch. */
  timeoutMs?: number;
}

export interface RepairResult {
  file: string;
  kind: 'media';
  dryRun: boolean;
  /** Distinct posts (incl. quoted) holding at least one candidate item. */
  posts: number;
  /** Posts actually fetched this run (≤ posts; capped by --limit). */
  probed: number;
  /** Media items missing a poster (or a video duration). */
  candidates: number;
  /** Items that gained at least one field (would gain, under --dry-run). */
  filled: number;
  /** Items X had no answer for: deleted/protected post, or no matching media. */
  unresolved: number;
  /** Items whose post could not be fetched (network / HTTP error after retries). */
  failed: number;
  /** Items not attempted because of --limit. */
  skipped: number;
  /** Posters added. */
  thumbnails: number;
  /** Video durations added. */
  durations: number;
  /** Path written (absent under --dry-run or when nothing changed in place). */
  out?: string;
}

// ── matching (pure) ──────────────────────────────────────────────────────────

/**
 * The media id (videos) or name (GIFs) embedded in a twimg video or poster URL:
 * `amplify_video[_thumb]/<id>/`, `ext_tw_video[_thumb]/<id>/`,
 * `tweet_video[_thumb]/<name>.(mp4|jpg)`. Undefined for photos / unknown shapes.
 */
export function mediaKey(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  const m = /\/(?:amplify_video|ext_tw_video|tweet_video)(?:_thumb)?\/([^/?#.]+)/.exec(url);
  return m?.[1];
}

/** True when an item is a video missing a poster or duration, or a GIF missing a poster. */
export function isRepairCandidate(item: MediaItem): boolean {
  if (item.type === 'video') return item.thumbnail === undefined || item.durationMs === undefined;
  if (item.type === 'gif') return item.thumbnail === undefined;
  return false;
}

/** Every media key a syndication detail can be identified by. */
function detailKeys(detail: SyndicationMedia): Set<string> {
  const keys = new Set<string>();
  const add = (k: string | undefined) => {
    if (k !== undefined) keys.add(k);
  };
  add(mediaKey(detail.media_url_https));
  for (const v of detail.video_info?.variants ?? []) add(mediaKey(v.url));
  return keys;
}

const DETAIL_TYPE: Record<string, MediaItem['type']> = {
  video: 'video',
  animated_gif: 'gif',
  photo: 'photo',
};

export interface FillCounts {
  filled: number;
  unresolved: number;
  thumbnails: number;
  durations: number;
}

/** Copy the absent poster / duration from a detail onto an item. Returns which fields were set. */
function fillFrom(item: MediaItem, detail: SyndicationMedia): { thumb: boolean; dur: boolean } {
  let thumb = false;
  let dur = false;
  if (item.thumbnail === undefined && typeof detail.media_url_https === 'string') {
    item.thumbnail = detail.media_url_https;
    thumb = true;
  }
  const millis = detail.video_info?.duration_millis;
  if (item.type === 'video' && item.durationMs === undefined && typeof millis === 'number') {
    item.durationMs = millis;
    dur = true;
  }
  return { thumb, dur };
}

/**
 * Match one post's stored media to its syndication `mediaDetails` and fill absent
 * fields IN PLACE. Matching is by media id; a positional fallback (among non-photo
 * items) applies only when the stored item carries no id, the non-photo counts
 * agree, types line up, and the detail at that slot isn't claimed or contradicted.
 */
export function fillMedia(media: MediaItem[], details: SyndicationMedia[]): FillCounts {
  const counts: FillCounts = { filled: 0, unresolved: 0, thumbnails: 0, durations: 0 };
  const items = media.filter((m) => m.type !== 'photo');
  const pool = details.filter((d) => DETAIL_TYPE[d.type ?? ''] !== 'photo');
  const poolKeys = pool.map(detailKeys);

  // Pass 1: claim details by id, so the positional pass can't reuse them.
  const assigned = new Map<MediaItem, SyndicationMedia>();
  const claimed = new Set<number>();
  for (const item of items) {
    if (!isRepairCandidate(item)) continue;
    const key = mediaKey(item.url) ?? mediaKey(item.thumbnail);
    if (key === undefined) continue;
    const idx = poolKeys.findIndex((keys) => keys.has(key));
    if (idx >= 0) {
      assigned.set(item, pool[idx] as SyndicationMedia);
      claimed.add(idx);
    }
  }

  // Pass 2: positional fallback for id-less items, only when unambiguous.
  const aligned =
    items.length === pool.length &&
    items.every((m, i) => DETAIL_TYPE[pool[i]?.type ?? ''] === m.type);
  items.forEach((item, i) => {
    if (!isRepairCandidate(item) || assigned.has(item) || !aligned || claimed.has(i)) return;
    const key = mediaKey(item.url) ?? mediaKey(item.thumbnail);
    const keys = poolKeys[i];
    // A known id that disagrees with the slot's detail means different media.
    if (key !== undefined && keys !== undefined && keys.size > 0) return;
    assigned.set(item, pool[i] as SyndicationMedia);
    claimed.add(i);
  });

  for (const item of items) {
    if (!isRepairCandidate(item)) continue;
    const detail = assigned.get(item);
    const set = detail ? fillFrom(item, detail) : { thumb: false, dur: false };
    if (set.thumb || set.dur) counts.filled += 1;
    else counts.unresolved += 1;
    if (set.thumb) counts.thumbnails += 1;
    if (set.dur) counts.durations += 1;
  }
  return counts;
}

// ── planning ─────────────────────────────────────────────────────────────────

/** Post id → every media array (top-level or quoted occurrence) holding a candidate. */
function planTargets(tweets: ArchiveTweet[]): Map<string, MediaItem[][]> {
  const targets = new Map<string, MediaItem[][]>();
  const visit = (t: ArchiveTweet) => {
    if (t.media?.some(isRepairCandidate)) {
      const list = targets.get(t.id) ?? [];
      list.push(t.media);
      targets.set(t.id, list);
    }
    if (t.quoted !== undefined) visit(t.quoted);
  };
  for (const t of tweets) visit(t);
  return targets;
}

const countCandidates = (groups: MediaItem[][]): number =>
  groups.reduce((n, media) => n + media.filter(isRepairCandidate).length, 0);

// ── file I/O ─────────────────────────────────────────────────────────────────

/** The indent the file was written with: '' for compact JSON, else the first line's lead. */
function detectIndent(raw: string): string {
  return /^\{\r?\n([ \t]+)"/.exec(raw)?.[1] ?? '';
}

/** Re-serialize in the input's own style (indent + trailing newline). */
function serializeLike(raw: string, file: ArchiveFile): string {
  const indent = detectIndent(raw);
  const body = indent ? JSON.stringify(file, null, indent) : JSON.stringify(file);
  return /\n$/.test(raw) ? `${body}\n` : body;
}

/** Write via a sibling temp file + rename, so a crash never leaves a half-written archive. */
function writeFileAtomic(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now().toString(36)}.tmp`;
  try {
    writeFileSync(tmp, data, 'utf-8');
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

type Loaded = { raw: string; file: ArchiveFile } | { error: string };

function loadForRepair(path: string): Loaded {
  if (!existsSync(path)) return { error: `archive file not found: ${path}` };
  let raw: string;
  let parsed: unknown;
  try {
    raw = readFileSync(path, 'utf-8');
    parsed = JSON.parse(raw);
  } catch (e) {
    return { error: `could not read ${path}: ${e instanceof Error ? e.message : String(e)}` };
  }
  const rec = parsed as Record<string, unknown> | null;
  if (rec === null || typeof rec !== 'object' || rec.schema !== 'x-relay/archive@1') {
    return { error: `${path} is not an x-relay archive (schema "x-relay/archive@1")` };
  }
  if (!Array.isArray(rec.tweets)) return { error: `${path} has no tweets[] array` };
  return { raw, file: parsed as ArchiveFile };
}

// ── runner ───────────────────────────────────────────────────────────────────

/** Run `worker` over `items` with at most `limit` in flight, preserving nothing but completion. */
async function forEachBounded<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const item = items[next++] as T;
      await worker(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
}

function validate(opts: RepairOpts): string | null {
  if (!opts.file)
    return 'archive repair requires a file: xrelay archive repair <file.json> --media';
  if (!opts.media) {
    return 'choose what to repair: --media (video/GIF posters + video durations)';
  }
  const c = opts.concurrency;
  if (c !== undefined && (!Number.isInteger(c) || c < 1 || c > MAX_CONCURRENCY)) {
    return `--concurrency must be an integer from 1 to ${MAX_CONCURRENCY}`;
  }
  if (opts.limit !== undefined && (!Number.isInteger(opts.limit) || opts.limit < 1)) {
    return '--limit must be a positive integer';
  }
  return null;
}

/**
 * `xrelay archive repair <file> --media`: backfill absent video/GIF posters and
 * video durations from the public syndication endpoint. No cookies, no engine.
 */
export async function runArchiveRepair(
  opts: RepairOpts,
  deps: RepairDeps = {},
): Promise<Envelope<RepairResult>> {
  const invalid = validate(opts);
  if (invalid) return err('archive', 'INVALID_INPUT', invalid);
  const loaded = loadForRepair(opts.file);
  if ('error' in loaded) return err('archive', 'INVALID_INPUT', loaded.error);
  const { raw, file } = loaded;

  const progress = deps.progress ?? progressReporter(opts.quiet ?? false);
  const syndication: SyndicationOpts = {
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
    ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
  };

  const targets = planTargets(file.tweets);
  const ids = [...targets.keys()];
  const probe = opts.limit !== undefined ? ids.slice(0, opts.limit) : ids;
  const result: RepairResult = {
    file: opts.file,
    kind: 'media',
    dryRun: opts.dryRun ?? false,
    posts: ids.length,
    probed: probe.length,
    candidates: 0,
    filled: 0,
    unresolved: 0,
    failed: 0,
    skipped: 0,
    thumbnails: 0,
    durations: 0,
  };
  const probing = new Set(probe);
  for (const [id, groups] of targets) {
    const n = countCandidates(groups);
    result.candidates += n;
    if (!probing.has(id)) result.skipped += n;
  }

  progress(
    `repair: ${result.candidates} media item(s) across ${ids.length} post(s); probing ${probe.length}`,
  );
  let done = 0;
  await forEachBounded(probe, opts.concurrency ?? DEFAULT_CONCURRENCY, async (id) => {
    const groups = targets.get(id) ?? [];
    const res: SyndicationResult = await fetchSyndicationTweet(id, syndication);
    if (res.status === 'ok') {
      for (const media of groups) {
        const c = fillMedia(media, res.tweet.mediaDetails ?? []);
        result.filled += c.filled;
        result.unresolved += c.unresolved;
        result.thumbnails += c.thumbnails;
        result.durations += c.durations;
      }
    } else if (res.status === 'unavailable') {
      result.unresolved += countCandidates(groups);
    } else {
      result.failed += countCandidates(groups);
    }
    done += 1;
    if (done % PROGRESS_EVERY === 0 || done === probe.length) {
      progress(
        `repair ${done}/${probe.length}: filled ${result.filled}, unresolved ${result.unresolved}, failed ${result.failed}`,
      );
    }
  });

  const out = opts.out ?? opts.file;
  const inPlace = resolve(out) === resolve(opts.file);
  if (!result.dryRun && (result.filled > 0 || !inPlace)) {
    writeFileAtomic(out, serializeLike(raw, file));
    result.out = out;
  }
  return ok('archive', result);
}
