// Extra GraphQL normalizers built on top of parse.ts: user timelines (followers/
// following/retweeters/likers), trends, downloadable media items, and long-form
// X Articles rendered to Markdown. Pure — no I/O, no network. Reuses parse.ts's
// findDict / parseUserResult / parseTweetResult so it stays robust to layout drift.

import type { Article, Author, MediaItem, Trend, UserPage, UserProfile } from '../types.ts';
import { findDict, parseTweetResult, parseUserResult } from './parse.ts';

// ── Narrowing helpers (local, mirror parse.ts) ───────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function child(node: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = node[key];
  return isRecord(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return undefined;
}

// ── User timeline ────────────────────────────────────────────────────────────

const DROP_USER_ENTRY_PREFIXES = ['cursor-', 'promoted', 'who-to-follow'];

function startsWithAny(value: string, prefixes: string[]): boolean {
  return prefixes.some((prefix) => value.startsWith(prefix));
}

function locateInstructions(json: unknown): unknown[] {
  const found = findDict(json, 'instructions', true)[0];
  return Array.isArray(found) ? found : [];
}

function collectEntries(instructions: unknown[]): Record<string, unknown>[] {
  const entries: Record<string, unknown>[] = [];
  for (const instruction of instructions) {
    if (isRecord(instruction) && Array.isArray(instruction.entries)) {
      for (const entry of instruction.entries) {
        if (isRecord(entry)) entries.push(entry);
      }
    }
  }
  return entries;
}

/** The Bottom-cursor value from an entry, else undefined. */
function entryBottomCursor(entry: Record<string, unknown>, entryId: string): string | undefined {
  const content = child(entry, 'content');
  const cursorType = asString(content?.cursorType);
  const isBottom = cursorType === 'Bottom' || entryId.startsWith('cursor-bottom');
  if (!isBottom) return undefined;
  return asString(content?.value);
}

/** The user_results.result node reachable under an entry, else undefined. */
function entryUserNode(entry: Record<string, unknown>): unknown {
  const content = child(entry, 'content');
  const itemContent = content ? child(content, 'itemContent') : undefined;
  const userResults = itemContent ? child(itemContent, 'user_results') : undefined;
  return userResults ? userResults.result : undefined;
}

/**
 * Walk a user-list timeline (followers / following / retweeters / likers) into a
 * UserPage. Takes user_results.result nodes from `user-` entries, sets nextCursor
 * from the Bottom cursor entry, drops cursor/promoted/who-to-follow entries,
 * de-dupes by id, and skips any user that fails to parse.
 */
export function parseUserTimeline(json: unknown): UserPage {
  const entries = collectEntries(locateInstructions(json));
  const users: UserProfile[] = [];
  const seen = new Set<string>();
  let nextCursor: string | undefined;

  for (const entry of entries) {
    const entryId = asString(entry.entryId) ?? '';

    const cursor = entryBottomCursor(entry, entryId);
    if (cursor !== undefined) nextCursor = cursor;

    if (startsWithAny(entryId, DROP_USER_ENTRY_PREFIXES)) continue;

    const userNode = entryUserNode(entry);
    if (userNode === undefined) continue;
    if (!entryId.startsWith('user-') && !isRecord(userNode)) continue;

    try {
      const profile = parseUserResult(userNode);
      if (profile !== null && !seen.has(profile.id)) {
        seen.add(profile.id);
        users.push(profile);
      }
    } catch {
      // One bad user never kills the page.
    }
  }

  const page: UserPage = { users };
  if (nextCursor !== undefined) page.nextCursor = nextCursor;
  return page;
}

// ── Trends ───────────────────────────────────────────────────────────────────

/** Normalize a single trend result node, else null. */
function parseTrendResult(node: unknown): Trend | null {
  if (!isRecord(node)) return null;
  const name = asString(node.name);
  const metadata = child(node, 'trend_metadata');
  if (name === undefined || metadata === undefined) return null;

  const trend: Trend = { name };
  const rank = asNumber(node.rank);
  if (rank !== undefined) trend.rank = rank;
  const url = asString(child(node, 'trend_url')?.url);
  if (url !== undefined) trend.url = url;
  const volume = asString(metadata.meta_description);
  if (volume !== undefined) trend.volume = volume;
  return trend;
}

/**
 * Collect trending topics from an explore/trends response. Walks every
 * trend_results node anywhere in the tree (layout-drift safe), normalizing each
 * to a Trend in encounter order; skips malformed nodes.
 */
export function parseTrends(json: unknown): Trend[] {
  const out: Trend[] = [];
  for (const wrapper of findDict(json, 'trend_results')) {
    const node = isRecord(wrapper) ? wrapper.result : undefined;
    const trend = parseTrendResult(node);
    if (trend !== null) out.push(trend);
  }
  return out;
}

// ── Media ────────────────────────────────────────────────────────────────────

function mediaDimensions(media: Record<string, unknown>): { width?: number; height?: number } {
  const info = child(media, 'original_info');
  const dims: { width?: number; height?: number } = {};
  const width = asNumber(info?.width);
  if (width !== undefined) dims.width = width;
  const height = asNumber(info?.height);
  if (height !== undefined) dims.height = height;
  return dims;
}

function photoItem(media: Record<string, unknown>): MediaItem | null {
  const url = asString(media.media_url_https);
  if (url === undefined) return null;
  return { type: 'photo', url, ...mediaDimensions(media) };
}

/** Highest-bitrate mp4 variant (HLS variants have no bitrate → skipped). */
function bestVideoVariant(variants: unknown[]): { url: string; bitrate: number } | undefined {
  let best: { url: string; bitrate: number } | undefined;
  for (const variant of variants) {
    if (!isRecord(variant)) continue;
    if (variant.content_type !== 'video/mp4') continue;
    const bitrate = asNumber(variant.bitrate);
    const url = asString(variant.url);
    if (bitrate === undefined || url === undefined) continue;
    if (best === undefined || bitrate > best.bitrate) best = { url, bitrate };
  }
  return best;
}

function videoItem(media: Record<string, unknown>): MediaItem | null {
  const info = child(media, 'video_info');
  const variants = info?.variants;
  if (!Array.isArray(variants)) return null;
  const best = bestVideoVariant(variants);
  if (best === undefined) return null;
  const item: MediaItem = { type: 'video', url: best.url, bitrate: best.bitrate };
  const thumbnail = asString(media.media_url_https);
  if (thumbnail !== undefined) item.thumbnail = thumbnail;
  const durationMs = asNumber(info?.duration_millis);
  if (durationMs !== undefined) item.durationMs = durationMs;
  return item;
}

function gifItem(media: Record<string, unknown>): MediaItem | null {
  const info = child(media, 'video_info');
  const variants = info?.variants;
  const first = Array.isArray(variants) ? variants[0] : undefined;
  const url = isRecord(first) ? asString(first.url) : undefined;
  if (url === undefined) return null;
  const item: MediaItem = { type: 'gif', url };
  const thumbnail = asString(media.media_url_https);
  if (thumbnail !== undefined) item.thumbnail = thumbnail;
  return item;
}

const MEDIA_BUILDERS: Record<string, (media: Record<string, unknown>) => MediaItem | null> = {
  photo: photoItem,
  video: videoItem,
  animated_gif: gifItem,
};

/**
 * Extract downloadable MediaItems from a tweet result node. Reads
 * `legacy.extended_entities.media[]`, falling back to a hoisted
 * `result.extended_entities` when legacy is null. Returns [] when none.
 */
export function extractTweetMedia(result: unknown): MediaItem[] {
  if (!isRecord(result)) return [];
  const legacy = child(result, 'legacy');
  const extended =
    (legacy ? child(legacy, 'extended_entities') : undefined) ?? child(result, 'extended_entities');
  const media = extended?.media;
  if (!Array.isArray(media)) return [];

  const out: MediaItem[] = [];
  for (const item of media) {
    if (!isRecord(item)) continue;
    const kind = asString(item.type);
    const build = kind !== undefined ? MEDIA_BUILDERS[kind] : undefined;
    if (build === undefined) continue;
    const built = build(item);
    if (built !== null) out.push(built);
  }
  return out;
}

// ── Article ──────────────────────────────────────────────────────────────────

type Entity = { type?: string; data?: Record<string, unknown> };

/** Normalize entityMap (object OR array of {key,value}) to a key→entity map. */
function normalizeEntityMap(raw: unknown): Map<string, Entity> {
  const map = new Map<string, Entity>();
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!isRecord(item)) continue;
      const key = asString(item.key) ?? asNumber(item.key)?.toString();
      const value = item.value;
      if (key !== undefined && isRecord(value)) map.set(key, value as Entity);
    }
  } else if (isRecord(raw)) {
    for (const [key, value] of Object.entries(raw)) {
      if (isRecord(value)) map.set(key, value as Entity);
    }
  }
  return map;
}

function entityData(entity: Entity): Record<string, unknown> {
  return isRecord(entity.data) ? entity.data : {};
}

/** Splice [label](url) for LINK entityRanges into a block's text, rightmost-first. */
function applyInlineLinks(text: string, ranges: unknown[], entityMap: Map<string, Entity>): string {
  const links: { offset: number; length: number; url: string }[] = [];
  for (const range of ranges) {
    if (!isRecord(range)) continue;
    const key = asString(range.key) ?? asNumber(range.key)?.toString();
    const offset = asNumber(range.offset);
    const length = asNumber(range.length);
    if (key === undefined || offset === undefined || length === undefined) continue;
    const entity = entityMap.get(key);
    if (entity === undefined || entity.type !== 'LINK') continue;
    const url = asString(entityData(entity).url);
    if (url === undefined) continue;
    links.push({ offset, length, url });
  }
  links.sort((a, b) => b.offset - a.offset);
  let out = text;
  for (const link of links) {
    const label = out.slice(link.offset, link.offset + link.length);
    out = `${out.slice(0, link.offset)}[${label}](${link.url})${out.slice(link.offset + link.length)}`;
  }
  return out;
}

/** An atomic block's rendered markdown (MARKDOWN verbatim, IMAGE as image), else null. */
function renderAtomic(ranges: unknown[], entityMap: Map<string, Entity>): string | null {
  for (const range of ranges) {
    if (!isRecord(range)) continue;
    const key = asString(range.key) ?? asNumber(range.key)?.toString();
    if (key === undefined) continue;
    const entity = entityMap.get(key);
    if (entity === undefined) continue;
    const data = entityData(entity);
    if (entity.type === 'MARKDOWN') {
      const markdown = asString(data.markdown);
      if (markdown !== undefined) return markdown;
    }
    const imageUrl =
      asString(data.media_url_https) ?? asString(data.original_img_url) ?? asString(data.url);
    if (imageUrl !== undefined) return `![](${imageUrl})`;
  }
  return null;
}

const BLOCK_PREFIX: Record<string, string> = {
  'header-one': '# ',
  'header-two': '## ',
  'header-three': '### ',
  blockquote: '> ',
  'unordered-list-item': '- ',
};

/** Render a Draft.js content_state's blocks to Markdown. */
function renderBlocks(blocks: unknown[], entityMap: Map<string, Entity>): string {
  const rendered: string[] = [];
  let orderedIndex = 0;

  for (const block of blocks) {
    if (!isRecord(block)) continue;
    const type = asString(block.type) ?? 'unstyled';
    if (type !== 'ordered-list-item') orderedIndex = 0;

    if (type === 'atomic') {
      const ranges = Array.isArray(block.entityRanges) ? block.entityRanges : [];
      const atomic = renderAtomic(ranges, entityMap);
      if (atomic !== null) rendered.push(atomic);
      continue;
    }

    const rawText = asString(block.text) ?? '';
    const ranges = Array.isArray(block.entityRanges) ? block.entityRanges : [];
    const text = applyInlineLinks(rawText, ranges, entityMap);

    if (type === 'code-block') {
      rendered.push(`\`\`\`\n${text}\n\`\`\``);
    } else if (type === 'ordered-list-item') {
      orderedIndex += 1;
      rendered.push(`${orderedIndex}. ${text}`);
    } else {
      rendered.push(`${BLOCK_PREFIX[type] ?? ''}${text}`);
    }
  }

  return rendered.join('\n\n');
}

/** Locate the tweet result node from a TweetResultByRestId response. */
function locateTweetResult(json: unknown): Record<string, unknown> | undefined {
  const wrapper = findDict(json, 'tweetResult', true)[0];
  let result = isRecord(wrapper) ? wrapper.result : undefined;
  if (!isRecord(result)) return undefined;
  if (result.__typename === 'TweetWithVisibilityResults' && isRecord(result.tweet)) {
    result = result.tweet;
  }
  return isRecord(result) ? result : undefined;
}

/**
 * Render a long-form X Article from a TweetResultByRestId response to Markdown.
 * Returns null when the response carries no article_results. Renders Draft.js
 * blocks (headers, lists, blockquote, code, atomic) with inline LINK splicing.
 */
export function parseArticle(json: unknown): Article | null {
  const tweetResult = locateTweetResult(json);
  if (tweetResult === undefined) return null;

  const articleWrapper = findDict(tweetResult, 'article_results', true)[0];
  const articleResult = isRecord(articleWrapper) ? articleWrapper.result : undefined;
  if (!isRecord(articleResult)) return null;

  const title = asString(articleResult.title);
  if (title === undefined) return null;

  const contentState = child(articleResult, 'content_state');
  const blocks = Array.isArray(contentState?.blocks) ? contentState.blocks : [];
  const entityMap = normalizeEntityMap(contentState?.entityMap);
  const markdown = renderBlocks(blocks, entityMap);

  const id = asString(tweetResult.rest_id) ?? asString(child(tweetResult, 'legacy')?.id_str) ?? '';

  const article: Article = {
    id,
    title,
    markdown,
    url: `https://x.com/i/status/${id}`,
  };
  const author = articleAuthor(tweetResult);
  if (author !== undefined) article.author = author;
  return article;
}

/** Best-effort author from the tweet result via parseTweetResult. */
function articleAuthor(tweetResult: Record<string, unknown>): Author | undefined {
  try {
    return parseTweetResult(tweetResult)?.author;
  } catch {
    return undefined;
  }
}
