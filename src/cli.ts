#!/usr/bin/env node
// ─── xrelay CLI ───────────────────────────────────────────────────────────
// Parses args, dispatches a command against the Engine, prints a JSON envelope
// to stdout. Errors print an error envelope to stdout and exit non-zero.
import { fileURLToPath } from 'node:url';
import type { CacheSort } from './cache/index.ts';
import {
  type CacheViewOpts,
  type SearchCommandOpts,
  runArticle,
  runBookmarks,
  runCommunity,
  runCommunityInfo,
  runFollowers,
  runFollowing,
  runLikers,
  runList,
  runMedia,
  runMyPosts,
  runQuoters,
  runRetweeters,
  runSearch,
  runSync,
  runThread,
  runTrends,
  runUser,
  runUserMedia,
  runUserPosts,
} from './commands/index.ts';
import { COMMANDS, commandNames } from './commands/registry.ts';
import { createEngineFromEnv } from './engine/hermes-tweet.ts';
import type { Engine } from './engine/index.ts';
import type { SearchProduct } from './engine/ops.ts';
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
]);
const BOOL_FLAGS = new Set(['replies', 'sync', 'live', 'repair']);
/** Single-dash aliases. */
const SHORT_FLAGS: Record<string, string> = { q: 'query' };

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
 * The simple target-based read endpoints (one id/handle + an optional limit).
 * Split out of dispatch() to keep each switch small. Returns null when the
 * command isn't one of these, so dispatch() can fall through to UNKNOWN_COMMAND.
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
    case 'bookmarks':
      return runBookmarks(engine, buildCacheOpts(parsed));
    case 'my-posts':
      return runMyPosts(engine, {
        ...buildCacheOpts(parsed),
        ...(first(parsed, 'handle') ? { handle: first(parsed, 'handle') } : {}),
      });
    case 'sync': {
      const source = target === 'posts' || target === 'all' ? target : 'bookmarks';
      return runSync(engine, {
        source,
        ...(first(parsed, 'handle') ? { handle: first(parsed, 'handle') } : {}),
        repair: parsed.bools.has('repair'),
        ...(num(parsed, 'max') !== undefined ? { max: num(parsed, 'max') } : {}),
      });
    }
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
  if (!commandNames.includes(parsed.command)) {
    process.stdout.write(
      `${toJson(err('cli', 'UNKNOWN_COMMAND', `unknown command: ${parsed.command}`))}\n`,
    );
    return 2;
  }
  const eng = engine ?? createEngineFromEnv({});
  const envelope = await dispatch(parsed, eng);
  process.stdout.write(`${toJson(envelope)}\n`);
  return envelope.ok ? 0 : 1;
}

const isEntry =
  import.meta.main === true ||
  (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]);

if (isEntry) {
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
