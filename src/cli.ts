#!/usr/bin/env node
// ─── xrelay CLI ───────────────────────────────────────────────────────────
// Parses args, dispatches a command against the Engine, prints a JSON envelope
// to stdout. Errors print an error envelope to stdout and exit non-zero.
import { fileURLToPath } from 'node:url';
import {
  type SearchCommandOpts,
  runBookmarks,
  runSearch,
  runThread,
  runUser,
  runUserPosts,
} from './commands/index.ts';
import { COMMANDS, commandNames } from './commands/registry.ts';
import { type Engine, createEngine } from './engine/index.ts';
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
]);
const BOOL_FLAGS = new Set(['replies']);

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
    if (token.startsWith('--')) {
      const name = token.slice(2);
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
      return runBookmarks(engine, {
        ...(num(parsed, 'limit') !== undefined ? { limit: num(parsed, 'limit') } : {}),
      });
    default:
      return err('cli', 'UNKNOWN_COMMAND', `unknown command: ${command ?? '(none)'}`);
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
  const eng = engine ?? createEngine({});
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
