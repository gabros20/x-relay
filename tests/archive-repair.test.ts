import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type RepairDeps,
  fillMedia,
  isRepairCandidate,
  mediaKey,
  runArchiveRepair,
} from '../src/commands/repair.ts';
import type { SyndicationMedia } from '../src/engine/syndication.ts';
import type { ArchiveFile, ArchiveTweet, MediaItem } from '../src/types.ts';

// `archive repair --media` backfills video/GIF posters (+ video durations) on an
// existing archive from X's public syndication endpoint. Fetch is mocked; no network.

// ── temp-dir bookkeeping ─────────────────────────────────────────────────────
const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'xrelay-repair-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// ── fixtures ─────────────────────────────────────────────────────────────────
const AMP_A = '2059594780615507976';
const AMP_B = '2059599793807056898';
const EXT = '2058978908783902720';
const GIF = 'HHkeGKna8AA6pPm';

const ampVideo = (id: string): MediaItem => ({
  type: 'video',
  url: `https://video.twimg.com/amplify_video/${id}/vid/avc1/1920x1080/abc.mp4?tag=27`,
  width: 1920,
  height: 1080,
});
const extVideo = (id: string): MediaItem => ({
  type: 'video',
  url: `https://video.twimg.com/ext_tw_video/${id}/pu/vid/avc1/1280x720/xyz.mp4?tag=12`,
});
const gif = (name: string): MediaItem => ({
  type: 'gif',
  url: `https://video.twimg.com/tweet_video/${name}.mp4`,
  width: 1200,
  height: 674,
});
const photo = (): MediaItem => ({
  type: 'photo',
  url: 'https://pbs.twimg.com/media/HVrA3kEaQAAo9j3.jpg',
});

const ampDetail = (id: string, duration = 16788): SyndicationMedia => ({
  type: 'video',
  media_url_https: `https://pbs.twimg.com/amplify_video_thumb/${id}/img/poster-${id}.jpg`,
  video_info: {
    duration_millis: duration,
    variants: [{ url: `https://video.twimg.com/amplify_video/${id}/pl/list.m3u8` }],
  },
});
const extDetail = (id: string, duration = 15069): SyndicationMedia => ({
  type: 'video',
  media_url_https: `https://pbs.twimg.com/ext_tw_video_thumb/${id}/pu/img/poster.jpg`,
  video_info: { duration_millis: duration, variants: [] },
});
const gifDetail = (name: string): SyndicationMedia => ({
  type: 'animated_gif',
  media_url_https: `https://pbs.twimg.com/tweet_video_thumb/${name}.jpg`,
  video_info: { variants: [{ url: `https://video.twimg.com/tweet_video/${name}.mp4` }] },
});
const photoDetail = (): SyndicationMedia => ({
  type: 'photo',
  media_url_https: 'https://pbs.twimg.com/media/HVrA3kEaQAAo9j3.jpg',
});

function atw(id: string, media?: MediaItem[], extra: Partial<ArchiveTweet> = {}): ArchiveTweet {
  return {
    id,
    url: `https://x.com/i/status/${id}`,
    text: `t${id}`,
    author: { id: '1', handle: 'h', name: 'N', verified: false },
    metrics: { likes: 1 },
    ...(media ? { media } : {}),
    ...extra,
  };
}

function archive(tweets: ArchiveTweet[]): ArchiveFile {
  return {
    schema: 'x-relay/archive@1',
    source: 'bookmarks',
    generatedAt: '2026-01-01T00:00:00.000Z',
    count: tweets.length,
    newestId: tweets[0]?.id ?? '0',
    tweets,
  };
}

function writeArchive(file: ArchiveFile, format: 'compact' | 'pretty' = 'compact'): string {
  const path = join(tmp(), 'archive.json');
  const body = format === 'compact' ? JSON.stringify(file) : `${JSON.stringify(file, null, 2)}\n`;
  writeFileSync(path, body, 'utf-8');
  return path;
}

/** Mock fetch: answers tweet-result by id from `byId`; records ids and peak concurrency. */
function syndicationFetch(
  byId: Record<string, unknown | number>,
  log: { ids: string[]; inFlight: number; peak: number } = { ids: [], inFlight: 0, peak: 0 },
): typeof fetch {
  return (async (input: string | URL | Request) => {
    const id = new URL(String(input)).searchParams.get('id') ?? '';
    log.ids.push(id);
    log.inFlight += 1;
    log.peak = Math.max(log.peak, log.inFlight);
    await new Promise((r) => setTimeout(r, 1));
    log.inFlight -= 1;
    const answer = byId[id];
    if (answer === undefined) return new Response('', { status: 404 });
    if (typeof answer === 'number') return new Response('', { status: answer });
    return new Response(JSON.stringify(answer), { status: 200 });
  }) as typeof fetch;
}

const deps = (fetchImpl: typeof fetch): RepairDeps => ({
  fetchImpl,
  sleep: async () => {},
  progress: () => {},
});

const tweetResult = (id: string, mediaDetails: SyndicationMedia[]) => ({
  __typename: 'Tweet',
  id_str: id,
  mediaDetails,
});

// ── mediaKey ─────────────────────────────────────────────────────────────────
describe('mediaKey', () => {
  test('extracts the media id from amplify / ext_tw video urls and their posters', () => {
    expect(mediaKey(ampVideo(AMP_A).url)).toBe(AMP_A);
    expect(mediaKey(`https://pbs.twimg.com/amplify_video_thumb/${AMP_A}/img/x.jpg`)).toBe(AMP_A);
    expect(mediaKey(extVideo(EXT).url)).toBe(EXT);
    expect(mediaKey(`https://pbs.twimg.com/ext_tw_video_thumb/${EXT}/pu/img/x.jpg`)).toBe(EXT);
  });

  test('extracts the gif name from tweet_video urls and tweet_video_thumb posters', () => {
    expect(mediaKey(gif(GIF).url)).toBe(GIF);
    expect(mediaKey(`https://pbs.twimg.com/tweet_video_thumb/${GIF}.jpg`)).toBe(GIF);
  });

  test('returns undefined for photos and unrecognised urls', () => {
    expect(mediaKey(photo().url)).toBeUndefined();
    expect(mediaKey('https://video.twimg.com/other/clip.mp4')).toBeUndefined();
  });
});

// ── isRepairCandidate ────────────────────────────────────────────────────────
describe('isRepairCandidate', () => {
  test('a video missing thumbnail or durationMs, or a gif missing thumbnail', () => {
    expect(isRepairCandidate(ampVideo(AMP_A))).toBe(true);
    expect(isRepairCandidate({ ...ampVideo(AMP_A), thumbnail: 'p.jpg' })).toBe(true);
    expect(isRepairCandidate({ ...ampVideo(AMP_A), thumbnail: 'p.jpg', durationMs: 1 })).toBe(
      false,
    );
    expect(isRepairCandidate(gif(GIF))).toBe(true);
    expect(isRepairCandidate({ ...gif(GIF), thumbnail: 'p.jpg' })).toBe(false);
    expect(isRepairCandidate(photo())).toBe(false);
  });
});

// ── fillMedia (matching) ─────────────────────────────────────────────────────
describe('fillMedia', () => {
  test('matches amplify videos by media id, not by position', () => {
    const media = [ampVideo(AMP_A), ampVideo(AMP_B)];
    // Details deliberately in the opposite order.
    const out = fillMedia(media, [ampDetail(AMP_B, 2), ampDetail(AMP_A, 1)]);
    expect(media[0]?.thumbnail).toContain(`amplify_video_thumb/${AMP_A}/`);
    expect(media[0]?.durationMs).toBe(1);
    expect(media[1]?.thumbnail).toContain(`amplify_video_thumb/${AMP_B}/`);
    expect(media[1]?.durationMs).toBe(2);
    expect(out).toEqual({ filled: 2, unresolved: 0, thumbnails: 2, durations: 2 });
  });

  test('matches ext_tw_video by id', () => {
    const media = [extVideo(EXT)];
    fillMedia(media, [extDetail(EXT)]);
    expect(media[0]?.thumbnail).toBe(
      `https://pbs.twimg.com/ext_tw_video_thumb/${EXT}/pu/img/poster.jpg`,
    );
    expect(media[0]?.durationMs).toBe(15069);
  });

  test('fills a gif poster (and never a duration) alongside photos', () => {
    const media = [photo(), gif(GIF)];
    const out = fillMedia(media, [
      photoDetail(),
      { ...gifDetail(GIF), video_info: { duration_millis: 9 } },
    ]);
    expect(media[1]?.thumbnail).toBe(`https://pbs.twimg.com/tweet_video_thumb/${GIF}.jpg`);
    expect(media[1]?.durationMs).toBeUndefined();
    expect(media[0]).toEqual(photo());
    expect(out).toEqual({ filled: 1, unresolved: 0, thumbnails: 1, durations: 0 });
  });

  test('never overwrites an existing thumbnail or durationMs', () => {
    const media: MediaItem[] = [{ ...ampVideo(AMP_A), thumbnail: 'https://keep/me.jpg' }];
    const out = fillMedia(media, [ampDetail(AMP_A, 42)]);
    expect(media[0]?.thumbnail).toBe('https://keep/me.jpg');
    expect(media[0]?.durationMs).toBe(42);
    expect(out).toEqual({ filled: 1, unresolved: 0, thumbnails: 0, durations: 1 });

    const done: MediaItem[] = [{ ...ampVideo(AMP_A), thumbnail: 'k.jpg', durationMs: 7 }];
    expect(fillMedia(done, [ampDetail(AMP_A, 42)])).toEqual({
      filled: 0,
      unresolved: 0,
      thumbnails: 0,
      durations: 0,
    });
    expect(done[0]?.durationMs).toBe(7);
  });

  test('a known id with no matching detail stays unresolved — no positional guess', () => {
    const media = [ampVideo(AMP_A)];
    const out = fillMedia(media, [ampDetail(AMP_B)]);
    expect(media[0]?.thumbnail).toBeUndefined();
    expect(out.unresolved).toBe(1);
  });

  test('falls back to position among non-photo items when the url has no id and it is unambiguous', () => {
    const odd: MediaItem = { type: 'video', url: 'https://video.twimg.com/other/clip.mp4' };
    const media = [photo(), odd];
    const out = fillMedia(media, [photoDetail(), ampDetail(AMP_A, 5)]);
    expect(media[1]?.thumbnail).toContain(`amplify_video_thumb/${AMP_A}/`);
    expect(media[1]?.durationMs).toBe(5);
    expect(out.filled).toBe(1);
  });

  test('no positional fallback when counts or types differ (ambiguous)', () => {
    const odd = (): MediaItem => ({ type: 'video', url: 'https://video.twimg.com/other/clip.mp4' });
    const countMismatch = [odd()];
    expect(fillMedia(countMismatch, [ampDetail(AMP_A), ampDetail(AMP_B)]).unresolved).toBe(1);
    expect(countMismatch[0]?.thumbnail).toBeUndefined();

    const typeMismatch = [odd()];
    expect(fillMedia(typeMismatch, [gifDetail(GIF)]).unresolved).toBe(1);
    expect(typeMismatch[0]?.thumbnail).toBeUndefined();
  });
});

// ── runArchiveRepair ─────────────────────────────────────────────────────────
describe('runArchiveRepair', () => {
  function fixture(): ArchiveFile {
    return archive([
      atw('300', [photo(), ampVideo(AMP_A), ampVideo(AMP_B)]),
      atw('200', [gif(GIF)], {
        isQuote: true,
        quoted: atw('150', [extVideo(EXT)]),
      }),
      atw('100', [photo()]),
      atw('90', [ampVideo('111')]), // deleted post → tombstone
      atw('80', [ampVideo('222')]), // server keeps failing
    ]);
  }
  const answers = (): Record<string, unknown> => ({
    '300': tweetResult('300', [photoDetail(), ampDetail(AMP_A, 1), ampDetail(AMP_B, 2)]),
    '200': tweetResult('200', [gifDetail(GIF)]),
    '150': tweetResult('150', [extDetail(EXT, 3)]),
    '90': { __typename: 'TweetTombstone' },
    '80': 503,
  });

  test('fills posters + durations (incl. quoted media), classifies the rest, writes in place', async () => {
    const path = writeArchive(fixture());
    const log = { ids: [] as string[], inFlight: 0, peak: 0 };
    const env = await runArchiveRepair(
      { file: path, media: true },
      deps(syndicationFetch(answers(), log)),
    );
    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(env.data).toEqual({
      file: path,
      kind: 'media',
      dryRun: false,
      posts: 5,
      probed: 5,
      candidates: 6,
      filled: 4,
      unresolved: 1,
      failed: 1,
      skipped: 0,
      thumbnails: 4,
      durations: 3,
      out: path,
    });
    // Photo-only tweet 100 is never fetched.
    expect(new Set(log.ids)).toEqual(new Set(['300', '200', '150', '90', '80']));

    const after = JSON.parse(readFileSync(path, 'utf-8')) as ArchiveFile;
    const expected = fixture();
    const [t300, t200, , t90, t80] = expected.tweets;
    Object.assign(t300?.media?.[1] ?? {}, {
      thumbnail: ampDetail(AMP_A).media_url_https,
      durationMs: 1,
    });
    Object.assign(t300?.media?.[2] ?? {}, {
      thumbnail: ampDetail(AMP_B).media_url_https,
      durationMs: 2,
    });
    Object.assign(t200?.media?.[0] ?? {}, { thumbnail: gifDetail(GIF).media_url_https });
    Object.assign(t200?.quoted?.media?.[0] ?? {}, {
      thumbnail: extDetail(EXT).media_url_https,
      durationMs: 3,
    });
    // Everything else — order, schema, generatedAt, newestId, unresolved items — is untouched.
    expect(after).toEqual(expected);
    expect(t90?.media?.[0]?.thumbnail).toBeUndefined();
    expect(t80?.media?.[0]?.thumbnail).toBeUndefined();
  });

  test('preserves the input formatting: compact stays compact, pretty keeps its indent + newline', async () => {
    const compact = writeArchive(archive([atw('300', [gif(GIF)])]), 'compact');
    await runArchiveRepair(
      { file: compact, media: true },
      deps(syndicationFetch({ '300': tweetResult('300', [gifDetail(GIF)]) })),
    );
    const c = readFileSync(compact, 'utf-8');
    expect(c).toBe(JSON.stringify(JSON.parse(c)));

    const pretty = writeArchive(archive([atw('300', [gif(GIF)])]), 'pretty');
    await runArchiveRepair(
      { file: pretty, media: true },
      deps(syndicationFetch({ '300': tweetResult('300', [gifDetail(GIF)]) })),
    );
    const p = readFileSync(pretty, 'utf-8');
    expect(p).toBe(`${JSON.stringify(JSON.parse(p), null, 2)}\n`);
    expect(p).toContain('tweet_video_thumb');
  });

  test('is idempotent: a second run has no candidates, fetches nothing, leaves bytes as-is', async () => {
    const path = writeArchive(fixture());
    const fetchImpl = syndicationFetch(answers());
    await runArchiveRepair({ file: path, media: true }, deps(fetchImpl));
    const before = readFileSync(path, 'utf-8');
    const log = { ids: [] as string[], inFlight: 0, peak: 0 };
    const second = await runArchiveRepair(
      { file: path, media: true },
      deps(syndicationFetch(answers(), log)),
    );
    expect(second.ok && second.data.candidates).toBe(2); // only the tombstone + failure remain
    expect(second.ok && second.data.filled).toBe(0);
    expect(new Set(log.ids)).toEqual(new Set(['90', '80']));
    expect(readFileSync(path, 'utf-8')).toBe(before);

    const clean = writeArchive(archive([atw('300', [{ ...gif(GIF), thumbnail: 'p.jpg' }])]));
    const cleanBefore = readFileSync(clean, 'utf-8');
    const log2 = { ids: [] as string[], inFlight: 0, peak: 0 };
    const env = await runArchiveRepair(
      { file: clean, media: true },
      deps(syndicationFetch({}, log2)),
    );
    expect(env.ok && env.data.candidates).toBe(0);
    expect(log2.ids).toEqual([]);
    expect(readFileSync(clean, 'utf-8')).toBe(cleanBefore);
  });

  test('--dry-run reports what it would fill without writing', async () => {
    const path = writeArchive(fixture());
    const before = readFileSync(path, 'utf-8');
    const env = await runArchiveRepair(
      { file: path, media: true, dryRun: true },
      deps(syndicationFetch(answers())),
    );
    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(env.data.dryRun).toBe(true);
    expect(env.data.filled).toBe(4);
    expect(env.data.out).toBeUndefined();
    expect(readFileSync(path, 'utf-8')).toBe(before);
  });

  test('--out writes the repaired archive elsewhere and leaves the input untouched', async () => {
    const path = writeArchive(fixture());
    const before = readFileSync(path, 'utf-8');
    const out = join(tmp(), 'nested', 'repaired.json');
    const env = await runArchiveRepair(
      { file: path, media: true, out },
      deps(syndicationFetch(answers())),
    );
    expect(env.ok && env.data.out).toBe(out);
    expect(readFileSync(path, 'utf-8')).toBe(before);
    expect(readFileSync(out, 'utf-8')).toContain('amplify_video_thumb');
  });

  test('writes atomically: no temp files are left beside the archive', async () => {
    const path = writeArchive(fixture());
    await runArchiveRepair({ file: path, media: true }, deps(syndicationFetch(answers())));
    const dir = join(path, '..');
    expect(readdirSync(dir)).toEqual(['archive.json']);
  });

  test('--limit caps the posts probed this run; the rest are reported as skipped', async () => {
    const path = writeArchive(fixture());
    const log = { ids: [] as string[], inFlight: 0, peak: 0 };
    const env = await runArchiveRepair(
      { file: path, media: true, limit: 1, dryRun: true },
      deps(syndicationFetch(answers(), log)),
    );
    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(log.ids).toEqual(['300']);
    expect(env.data).toMatchObject({ posts: 5, probed: 1, candidates: 6, filled: 2, skipped: 4 });
  });

  test('bounds concurrency', async () => {
    const tweets = Array.from({ length: 12 }, (_, i) => atw(String(1000 + i), [gif(`G${i}`)]));
    const byId = Object.fromEntries(
      tweets.map((t, i) => [t.id, tweetResult(t.id, [gifDetail(`G${i}`)])]),
    );
    const path = writeArchive(archive(tweets));
    const log = { ids: [] as string[], inFlight: 0, peak: 0 };
    const env = await runArchiveRepair(
      { file: path, media: true, concurrency: 3 },
      deps(syndicationFetch(byId, log)),
    );
    expect(env.ok && env.data.filled).toBe(12);
    expect(log.peak).toBeLessThanOrEqual(3);
    expect(log.peak).toBeGreaterThan(1);
  });

  test('rejects bad input without touching the network', async () => {
    const log = { ids: [] as string[], inFlight: 0, peak: 0 };
    const d = deps(syndicationFetch({}, log));

    const noFile = await runArchiveRepair({ file: '', media: true }, d);
    expect(!noFile.ok && noFile.error.code).toBe('INVALID_INPUT');

    const missing = await runArchiveRepair({ file: join(tmp(), 'nope.json'), media: true }, d);
    expect(!missing.ok && missing.error.code).toBe('INVALID_INPUT');

    const notArchive = join(tmp(), 'x.json');
    writeFileSync(notArchive, '{"hello":1}');
    const wrong = await runArchiveRepair({ file: notArchive, media: true }, d);
    expect(!wrong.ok && wrong.error.code).toBe('INVALID_INPUT');

    const noKind = await runArchiveRepair({ file: writeArchive(fixture()) }, d);
    expect(!noKind.ok && noKind.error.code).toBe('INVALID_INPUT');
    expect(!noKind.ok && noKind.error.message).toContain('--media');

    const badConcurrency = await runArchiveRepair(
      { file: writeArchive(fixture()), media: true, concurrency: 0 },
      d,
    );
    expect(!badConcurrency.ok && badConcurrency.error.code).toBe('INVALID_INPUT');

    expect(log.ids).toEqual([]);
  });
});
