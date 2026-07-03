#!/usr/bin/env node
// ─── xrelay CLI ───────────────────────────────────────────────────────────
// Parses args, dispatches a command against the Engine, prints a JSON envelope
// to stdout. Errors print an error envelope to stdout and exit non-zero.
import type { CacheSort } from './cache/index.ts';
import {
  type ArchiveCommandOpts,
  type CacheViewOpts,
  type SearchCommandOpts,
  runArchive,
  runArticle,
  runBookmarkAdd,
  runBookmarkFolders,
  runBookmarks,
  runCommunity,
  runCommunityInfo,
  runDelete,
  runFeed,
  runFollow,
  runFollowers,
  runFollowing,
  runLike,
  runLikers,
  runLikes,
  runList,
  runMedia,
  runMyPosts,
  runPost,
  runQuote,
  runQuoters,
  runReply,
  runRetweet,
  runRetweeters,
  runSearch,
  runSync,
  runThread,
  runTrends,
  runUnbookmark,
  runUnfollow,
  runUnlike,
  runUnretweet,
  runUser,
  runUserMedia,
  runUserPosts,
  runWhoami,
} from './commands/index.ts';
import type { SearchQueryFlags } from './commands/query.ts';
import { COMMANDS, commandNames } from './commands/registry.ts';
import { type Engine, createEngine } from './engine/index.ts';
import type { SearchProduct } from './engine/ops.ts';
import { isMainModule, shouldForceEntry } from './entry.ts';
import { extractHandle, extractTweetId } from './ids.ts';
import { err, toJson } from './output.ts';
import type { Envelope } from './types.ts';

const VALUE_FLAGS = new Set([
  'limit',
  'product',
  'from',
  'to',
  'since',
  'until',
  'lang',
  'min-faves',
  'min-retweets',
  'filter',
  'query',
  'sort',
  'handle',
  'max',
  'woeid',
  'out',
  'type',
  'folder',
  'image',
]);
const BOOL_FLAGS = new Set([
  'replies',
  'sync',
  'live',
  'repair',
  'full',
  'prune',
  'stdout',
  'following',
  'confirm',
]);
/** Single-dash aliases. */
const SHORT_FLAGS: Record<string, string> = { q: 'query', i: 'image' };

/**
 * Command name aliases not in the COMMANDS registry.
 * 'status' is a user-facing alias for 'whoami'.
 */
const COMMAND_ALIASES = new Set(['status']);

export interface ParsedArgs {
  command?: string;
  positionals: string[];
  flags: Record<string, string[]>;
  bools: Set<string>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string[]> = {};
  const bools = new Set<string>();
  let command: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === undefined) continue;
    const name = token.startsWith('--')
      ? token.slice(2)
      : token.startsWith('-') && token.length > 1
        ? SHORT_FLAGS[token.slice(1)]
        : undefined;
    if (name !== undefined) {
      if (BOOL_FLAGS.has(name)) {
        bools.add(name);
      } else if (VALUE_FLAGS.has(name)) {
        const value = argv[i + 1];
        if (value !== undefined) {
          const existing = flags[name] ?? [];
          existing.push(value);
          flags[name] = existing;
          i += 1;
        }
      }
      continue;
    }
    if (command === undefined) command = token;
    else positionals.push(token);
  }

  return { command, positionals, flags, bools };
}

const first = (p: ParsedArgs, name: string): string | undefined => p.flags[name]?.[0];
const num = (p: ParsedArgs, name: string): number | undefined => {
  const v = first(p, name);
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

const PRODUCTS = new Set<SearchProduct>(['Top', 'Latest', 'Media', 'People']);
const SORTS = new Set<CacheSort>(['relevance', 'newest', 'oldest', 'likes', 'views', 'bookmarks']);

/** Advanced search flags shared by `search` command and `archive search` target. */
function parseSearchFlags(
  parsed: ParsedArgs,
): Partial<SearchQueryFlags> & { product?: SearchProduct } {
  const product = first(parsed, 'product');
  const minFaves = num(parsed, 'min-faves');
  const minRetweets = num(parsed, 'min-retweets');
  return {
    ...(product && PRODUCTS.has(product as SearchProduct)
      ? { product: product as SearchProduct }
      : {}),
    ...(first(parsed, 'from') ? { from: first(parsed, 'from') } : {}),
    ...(first(parsed, 'to') ? { to: first(parsed, 'to') } : {}),
    ...(first(parsed, 'since') ? { since: first(parsed, 'since') } : {}),
    ...(first(parsed, 'until') ? { until: first(parsed, 'until') } : {}),
    ...(first(parsed, 'lang') ? { lang: first(parsed, 'lang') } : {}),
    ...(minFaves !== undefined ? { minFaves } : {}),
    ...(minRetweets !== undefined ? { minRetweets } : {}),
    ...(parsed.flags.filter ? { filter: parsed.flags.filter } : {}),
  };
}

function buildArchiveOpts(parsed: ParsedArgs): ArchiveCommandOpts {
  const target = parsed.positionals[0] ?? '';
  // For `archive user <handle>`, positionals[1] is the handle.
  // For `archive likes [<handle>]`, positionals[1] is the optional handle.
  const rawHandle = target === 'user' || target === 'likes' ? (parsed.positionals[1] ?? '') : '';
  const archiveHandle = rawHandle ? (extractHandle(rawHandle) ?? rawHandle) : undefined;
  // For `archive search "<query>"`, positionals[1] is the query string.
  const searchQuery = target === 'search' ? (parsed.positionals[1] ?? '') : undefined;
  // For `archive list <id>`, positionals[1] is the list id.
  const listId = target === 'list' ? (parsed.positionals[1] ?? '') : undefined;
  const limit = num(parsed, 'limit');
  // For `archive feed`, --following or --type following → chronological timeline.
  const typeFlag = first(parsed, 'type');
  const following =
    target === 'feed' && (parsed.bools.has('following') || typeFlag === 'following');
  return {
    target,
    ...(first(parsed, 'out') ? { out: first(parsed, 'out') } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(parsed.bools.has('full') ? { full: true } : {}),
    ...(parsed.bools.has('prune') ? { prune: true } : {}),
    ...(parsed.bools.has('stdout') ? { stdout: true } : {}),
    ...(archiveHandle ? { handle: archiveHandle } : {}),
    ...(parsed.bools.has('replies') ? { replies: true } : {}),
    // search-target fields (query + advanced search flags)
    ...(searchQuery !== undefined ? { query: searchQuery } : {}),
    ...parseSearchFlags(parsed),
    // list-target field
    ...(listId !== undefined ? { listId } : {}),
    // bookmarks --folder target field
    ...(first(parsed, 'folder') ? { folderId: first(parsed, 'folder') } : {}),
    // feed-target field
    ...(following ? { following: true } : {}),
  };
}

function buildCacheOpts(parsed: ParsedArgs): CacheViewOpts {
  const limit = num(parsed, 'limit');
  const sort = first(parsed, 'sort');
  return {
    ...(first(parsed, 'query') ? { query: first(parsed, 'query') } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(sort && SORTS.has(sort as CacheSort) ? { sort: sort as CacheSort } : {}),
    ...(parsed.bools.has('live') ? { live: true } : {}),
    ...(parsed.bools.has('sync') ? { sync: true } : {}),
    ...(parsed.bools.has('repair') ? { repair: true } : {}),
    ...(num(parsed, 'max') !== undefined ? { max: num(parsed, 'max') } : {}),
  };
}

function helpText(): string {
  const lines = ['xrelay — deep-research over X/Twitter', '', 'Commands:'];
  for (const c of COMMANDS) {
    lines.push(`  ${c.name.padEnd(11)} ${c.summary}  [${c.cost}]`);
  }
  lines.push('', 'Run `xrelay <command>` with --help-style usage in SKILL.md.');
  return lines.join('\n');
}

function buildSearchOpts(parsed: ParsedArgs): SearchCommandOpts {
  const product = first(parsed, 'product');
  const limit = num(parsed, 'limit');
  const minFaves = num(parsed, 'min-faves');
  const minRetweets = num(parsed, 'min-retweets');
  return {
    query: parsed.positionals.join(' '),
    ...(limit !== undefined ? { limit } : {}),
    ...(product && PRODUCTS.has(product as SearchProduct)
      ? { product: product as SearchProduct }
      : {}),
    ...(first(parsed, 'from') ? { from: first(parsed, 'from') } : {}),
    ...(first(parsed, 'to') ? { to: first(parsed, 'to') } : {}),
    ...(first(parsed, 'since') ? { since: first(parsed, 'since') } : {}),
    ...(first(parsed, 'until') ? { until: first(parsed, 'until') } : {}),
    ...(first(parsed, 'lang') ? { lang: first(parsed, 'lang') } : {}),
    ...(minFaves !== undefined ? { minFaves } : {}),
    ...(minRetweets !== undefined ? { minRetweets } : {}),
    ...(parsed.flags.filter ? { filter: parsed.flags.filter } : {}),
  };
}

/**
 * The simple target-based endpoints (one id/handle + optional limit) plus the
 * T8–T9 write commands (post / reply / quote / like / unlike / bookmark /
 * unbookmark). Named dispatchReadOps for historical reasons — it hosts both
 * read and write commands; T10 writes live in dispatchWriteOps below.
 * Split out of dispatch() to keep each switch within complexity limits.
 * Returns null when the command isn't one of these.
 */
function dispatchReadOps(
  parsed: ParsedArgs,
  engine: Engine,
  command: string | undefined,
  target: string,
): Promise<Envelope<unknown>> | null {
  const limit = num(parsed, 'limit');
  switch (command) {
    case 'list':
      return runList(engine, target, limit);
    case 'user-media':
      return runUserMedia(engine, extractHandle(target) ?? target, limit);
    case 'followers':
      return runFollowers(engine, extractHandle(target) ?? target, limit);
    case 'following':
      return runFollowing(engine, extractHandle(target) ?? target, limit);
    case 'retweeters':
      return runRetweeters(engine, extractTweetId(target) ?? target, limit);
    case 'likers':
      return runLikers(engine, extractTweetId(target) ?? target, limit);
    case 'likes': {
      // Handle is optional — runner falls back to the authenticated user when omitted.
      const likesHandle = target ? (extractHandle(target) ?? target) : undefined;
      return runLikes(engine, likesHandle, limit);
    }
    case 'quoters':
      return runQuoters(engine, extractTweetId(target) ?? target, limit);
    case 'trends':
      return runTrends(engine, {
        ...(num(parsed, 'woeid') !== undefined ? { woeid: num(parsed, 'woeid') } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
    case 'article':
      return runArticle(engine, extractTweetId(target) ?? target);
    case 'media':
      return runMedia(engine, extractTweetId(target) ?? target, first(parsed, 'out'));
    case 'community':
      return runCommunity(engine, target, limit);
    case 'community-info':
      return runCommunityInfo(engine, target);
    // ── write commands ─────────────────────────────────────────────────────
    case 'like':
      return runLike(engine, extractTweetId(target) ?? target);
    case 'unlike':
      return runUnlike(engine, extractTweetId(target) ?? target);
    case 'bookmark':
      return runBookmarkAdd(engine, extractTweetId(target) ?? target);
    case 'unbookmark':
      return runUnbookmark(engine, extractTweetId(target) ?? target);
    default:
      return (
        dispatchPostOps(parsed, engine, command, target) ??
        dispatchWriteOps(parsed, engine, command, target)
      );
  }
}

/**
 * Post / reply / quote commands, split from dispatchReadOps to keep cognitive
 * complexity within biome's limit of 25. Supports optional --image/-i attachments.
 * Returns null when the command isn't one of these.
 */
function dispatchPostOps(
  parsed: ParsedArgs,
  engine: Engine,
  command: string | undefined,
  target: string,
): Promise<Envelope<unknown>> | null {
  const imagePaths = parsed.flags.image;
  const imageOpts = imagePaths ? { imagePaths } : {};
  switch (command) {
    case 'post':
      return runPost(engine, parsed.positionals.join(' '), imageOpts);
    case 'reply':
      return runReply(
        engine,
        extractTweetId(target) ?? target,
        parsed.positionals.slice(1).join(' '),
        imageOpts,
      );
    case 'quote':
      return runQuote(
        engine,
        extractTweetId(target) ?? target,
        parsed.positionals.slice(1).join(' '),
        imageOpts,
      );
    default:
      return null;
  }
}

/**
 * T10 write commands (retweet / unretweet / delete / follow / unfollow).
 * Split out of dispatchReadOps to keep cognitive complexity within limits.
 * Returns null when the command isn't one of these.
 */
function dispatchWriteOps(
  parsed: ParsedArgs,
  engine: Engine,
  command: string | undefined,
  target: string,
): Promise<Envelope<unknown>> | null {
  switch (command) {
    case 'retweet':
      return runRetweet(engine, extractTweetId(target) ?? target);
    case 'unretweet':
      return runUnretweet(engine, extractTweetId(target) ?? target);
    case 'delete':
      return runDelete(engine, extractTweetId(target) ?? target, {
        confirmed: parsed.bools.has('confirm'),
      });
    case 'follow':
      return runFollow(engine, extractHandle(target) ?? target);
    case 'unfollow':
      return runUnfollow(engine, extractHandle(target) ?? target);
    default:
      return null;
  }
}

/** Dispatch parsed args against an engine. Returns an envelope (does not print). */
export async function dispatch(parsed: ParsedArgs, engine: Engine): Promise<Envelope<unknown>> {
  const { command } = parsed;
  const target = parsed.positionals[0] ?? '';

  switch (command) {
    case 'search':
      return runSearch(engine, buildSearchOpts(parsed));
    case 'user':
      return runUser(engine, extractHandle(target) ?? target);
    case 'user-posts':
      return runUserPosts(engine, {
        handle: extractHandle(target) ?? target,
        replies: parsed.bools.has('replies'),
        ...(num(parsed, 'limit') !== undefined ? { limit: num(parsed, 'limit') } : {}),
      });
    case 'thread':
      return runThread(engine, extractTweetId(target) ?? target);
    case 'bookmarks': {
      // `bookmarks folders [<id>]` → bookmark folder list or folder timeline
      if (target === 'folders') {
        const folderId = parsed.positionals[1];
        return runBookmarkFolders(engine, folderId, num(parsed, 'limit'));
      }
      return runBookmarks(engine, buildCacheOpts(parsed));
    }
    case 'my-posts':
      return runMyPosts(engine, {
        ...buildCacheOpts(parsed),
        ...(first(parsed, 'handle') ? { handle: first(parsed, 'handle') } : {}),
      });
    case 'feed': {
      // --following or --type following → chronological; --type for-you → algorithmic (default)
      const typeFlag = first(parsed, 'type');
      const following = parsed.bools.has('following') || typeFlag === 'following';
      return runFeed(engine, {
        ...(following ? { following: true } : {}),
        ...(num(parsed, 'limit') !== undefined ? { limit: num(parsed, 'limit') } : {}),
      });
    }
    case 'sync': {
      const source = target === 'posts' || target === 'all' ? target : 'bookmarks';
      return runSync(engine, {
        source,
        ...(first(parsed, 'handle') ? { handle: first(parsed, 'handle') } : {}),
        repair: parsed.bools.has('repair'),
        ...(num(parsed, 'max') !== undefined ? { max: num(parsed, 'max') } : {}),
      });
    }
    case 'archive':
      return runArchive(engine, buildArchiveOpts(parsed));
    case 'whoami':
    case 'status':
      return runWhoami(engine);
    default:
      return (
        dispatchReadOps(parsed, engine, command, target) ??
        Promise.resolve(err('cli', 'UNKNOWN_COMMAND', `unknown command: ${command ?? '(none)'}`))
      );
  }
}

export async function run(argv: string[], engine?: Engine): Promise<number> {
  const parsed = parseArgs(argv);
  if (parsed.command === undefined || parsed.command === 'help') {
    process.stdout.write(`${helpText()}\n`);
    return 0;
  }
  // 'status' is an alias for 'whoami'; allow it through the name guard.
  if (!commandNames.includes(parsed.command) && !COMMAND_ALIASES.has(parsed.command)) {
    process.stdout.write(
      `${toJson(err('cli', 'UNKNOWN_COMMAND', `unknown command: ${parsed.command}`))}\n`,
    );
    return 2;
  }
  const eng = engine ?? createEngine({});
  const envelope = await dispatch(parsed, eng);
  process.stdout.write(`${toJson(envelope)}\n`);
  return envelope.ok ? 0 : 1;
}

const isEntry = isMainModule(process.argv[1], import.meta.url, import.meta.main);

// Fail-loud: user clearly invoked the binary but detection said "not entry".
// Never silently exit 0 in that case — warn to stderr and run anyway.
const forceEntry = !isEntry && shouldForceEntry(process.argv[1], ['xrelay', 'cli.js']);
if (forceEntry) {
  process.stderr.write(
    'xrelay: entry detection failed — treating as main; report at github.com/gabros20/x-relay/issues\n',
  );
}

if (isEntry || forceEntry) {
  run(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      process.stdout.write(
        `${toJson(err('cli', 'FATAL', e instanceof Error ? e.message : String(e)))}\n`,
      );
      process.exitCode = 1;
    },
  );
}
