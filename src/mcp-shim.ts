#!/usr/bin/env node
// ─── x-relay-mcp MCP shim ─────────────────────────────────────────────────
// Thin @modelcontextprotocol/sdk stdio server exposing the same commands as MCP
// tools. No business logic — delegates to the command runners over one lazily
// created Engine (cookies auto-extracted from the local browser).
import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  type SearchCommandOpts,
  runArticle,
  runBatch,
  runBookmarks,
  runCommunity,
  runCommunityInfo,
  runDoctor,
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
import { type Engine, createEngine } from './engine/index.ts';
import type { SearchProduct } from './engine/ops.ts';
import { shouldRunAsEntry } from './entry.ts';
import { extractHandle } from './ids.ts';
import { toJson } from './output.ts';
import type { Envelope } from './types.ts';

let engine: Engine | undefined;
const getEngine = (): Engine => {
  if (engine === undefined) engine = createEngine({});
  return engine;
};

export type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

function wrap(envelope: Envelope<unknown>): ToolResult {
  const result: ToolResult = { content: [{ type: 'text', text: toJson(envelope) }] };
  if (!envelope.ok) result.isError = true;
  return result;
}

/**
 * Map the MCP search tool args to SearchCommandOpts. `compact` defaults true
 * (agents want slim output), but `--fields` and `--compact` are mutually
 * exclusive — when fields is given we forward fields and drop the implicit compact.
 */
function buildMcpSearchOpts(args: Record<string, unknown>): SearchCommandOpts {
  // A present `fields` array (even empty) forwards fields and drops the implicit
  // compact default — an empty array then surfaces as INVALID_INPUT rather than a
  // silent no-op, matching the CLI. Absent fields falls back to compact.
  const useFields = Array.isArray(args.fields);
  const outputMode = useFields
    ? { fields: (args.fields as string[]).map(String) }
    : args.compact
      ? { compact: true }
      : {};
  return {
    query: String(args.query ?? ''),
    ...(args.limit !== undefined ? { limit: Number(args.limit) } : {}),
    ...(args.product ? { product: args.product as SearchProduct } : {}),
    ...(args.from ? { from: String(args.from) } : {}),
    ...(args.to ? { to: String(args.to) } : {}),
    ...(args.since ? { since: String(args.since) } : {}),
    ...(args.until ? { until: String(args.until) } : {}),
    ...(args.lang ? { lang: String(args.lang) } : {}),
    ...(args.minFaves !== undefined ? { minFaves: Number(args.minFaves) } : {}),
    ...(args.minRetweets !== undefined ? { minRetweets: Number(args.minRetweets) } : {}),
    ...(Array.isArray(args.filter) ? { filter: args.filter.map(String) } : {}),
    ...(args.sort ? { sort: args.sort as 'engagement' } : {}),
    ...outputMode,
  };
}

function buildServer(): McpServer {
  const require = createRequire(import.meta.url);
  // biome-ignore lint/suspicious/noExplicitAny: dynamic require of package.json
  const pkg = require('../package.json') as any;
  const server = new McpServer({ name: 'x-relay-mcp', version: String(pkg.version) });

  server.registerTool(
    'search',
    {
      description:
        'Live X/Twitter search — the wide net. By DEFAULT (compact=true) returns slim, flat tweet rows {id,url,handle,name,date,text,likes,replies,bookmarks,views} plus a compact:true marker — far cheaper on context. Set compact=false for the full enriched envelope (nested author + all metrics). Use fields=[...] to project only the columns you need (mutually exclusive with compact). sort="engagement" ranks by likes+replies*3+bookmarks*2. Rank on this metadata before reading threads.',
      inputSchema: {
        query: z.string().describe('search text; X advanced operators inside the string also work'),
        limit: z.number().int().positive().optional(),
        product: z.enum(['Top', 'Latest', 'Media', 'People']).optional(),
        from: z.string().optional(),
        to: z.string().optional(),
        since: z.string().describe('YYYY-MM-DD').optional(),
        until: z.string().describe('YYYY-MM-DD').optional(),
        lang: z.string().optional(),
        minFaves: z.number().int().nonnegative().optional(),
        minRetweets: z.number().int().nonnegative().optional(),
        filter: z.array(z.string()).describe('e.g. media, links, -replies').optional(),
        sort: z.enum(['engagement']).describe('rank by engagement score, desc').optional(),
        compact: z
          .boolean()
          .describe('flat, context-cheap tweet rows (default true)')
          .default(true),
        fields: z
          .array(z.string())
          .describe('project only these compact fields; overrides compact')
          .optional(),
      },
    },
    async (args) => wrap(await runSearch(getEngine(), buildMcpSearchOpts(args))),
  );

  server.registerTool(
    'user',
    {
      description: 'Profile lookup: bio, followers, verified, counts, joined date.',
      inputSchema: { handle: z.string().describe('@handle, bare handle, or profile URL') },
    },
    async (args) =>
      wrap(
        await runUser(
          getEngine(),
          extractHandle(String(args.handle ?? '')) ?? String(args.handle ?? ''),
        ),
      ),
  );

  server.registerTool(
    'user-posts',
    {
      description: "A user's timeline, optionally including replies.",
      inputSchema: {
        handle: z.string(),
        replies: z.boolean().optional(),
        limit: z.number().int().positive().optional(),
      },
    },
    async (args) =>
      wrap(
        await runUserPosts(getEngine(), {
          handle: extractHandle(String(args.handle ?? '')) ?? String(args.handle ?? ''),
          ...(args.replies ? { replies: true } : {}),
          ...(args.limit !== undefined ? { limit: Number(args.limit) } : {}),
        }),
      ),
  );

  server.registerTool(
    'thread',
    {
      description: 'A tweet plus its reply thread — the full read. Use only on finalists.',
      inputSchema: { target: z.string().describe('tweet id or status URL') },
    },
    async (args) => wrap(await runThread(getEngine(), String(args.target ?? ''))),
  );

  const SORT = z.enum(['relevance', 'newest', 'oldest', 'likes', 'views', 'bookmarks']);
  const cacheInput = {
    query: z.string().describe('keyword filter over the local cache').optional(),
    limit: z.number().int().positive().optional(),
    sort: SORT.optional(),
    sync: z.boolean().describe('refresh the cache (incremental) before reading').optional(),
    live: z.boolean().describe('hit X directly, bypassing the cache').optional(),
    repair: z.boolean().optional(),
  };

  server.registerTool(
    'bookmarks',
    {
      description:
        'Search YOUR saved posts in the local cache (offline, instant). --sync refreshes only new ones; --live hits X.',
      inputSchema: cacheInput,
    },
    async (args) =>
      wrap(
        await runBookmarks(getEngine(), {
          ...(args.query ? { query: String(args.query) } : {}),
          ...(args.limit !== undefined ? { limit: Number(args.limit) } : {}),
          ...(args.sort ? { sort: args.sort as never } : {}),
          ...(args.sync ? { sync: true } : {}),
          ...(args.live ? { live: true } : {}),
          ...(args.repair ? { repair: true } : {}),
        }),
      ),
  );

  server.registerTool(
    'my-posts',
    {
      description:
        'Search YOUR own posts in the local cache. --sync refreshes; --live needs handle.',
      inputSchema: { ...cacheInput, handle: z.string().describe('your @handle').optional() },
    },
    async (args) =>
      wrap(
        await runMyPosts(getEngine(), {
          ...(args.query ? { query: String(args.query) } : {}),
          ...(args.limit !== undefined ? { limit: Number(args.limit) } : {}),
          ...(args.sort ? { sort: args.sort as never } : {}),
          ...(args.sync ? { sync: true } : {}),
          ...(args.live ? { live: true } : {}),
          ...(args.repair ? { repair: true } : {}),
          ...(args.handle ? { handle: String(args.handle) } : {}),
        }),
      ),
  );

  server.registerTool(
    'sync',
    {
      description: 'Pull only NEW bookmarks/posts since the last sync into the local cache.',
      inputSchema: {
        source: z.enum(['bookmarks', 'posts', 'all']),
        handle: z.string().describe('your @handle (required for posts)').optional(),
        repair: z.boolean().optional(),
      },
    },
    async (args) =>
      wrap(
        await runSync(getEngine(), {
          source: (args.source as 'bookmarks' | 'posts' | 'all') ?? 'bookmarks',
          ...(args.handle ? { handle: String(args.handle) } : {}),
          ...(args.repair ? { repair: true } : {}),
        }),
      ),
  );

  // ── more read tools ────────────────────────────────────────────────────────
  const N = z.number().int().positive().optional();
  const handleIn = { handle: z.string(), limit: N };
  const tweetIn = { target: z.string().describe('tweet id or status URL'), limit: N };
  const h = (v: unknown) => extractHandle(String(v ?? '')) ?? String(v ?? '');
  // Tweet-id runners validate the raw reference themselves (runners.ts), so the
  // shim forwards the raw string rather than pre-extracting.
  const t = (v: unknown) => String(v ?? '');
  const n = (v: unknown) => (v !== undefined ? Number(v) : undefined);

  server.registerTool(
    'list',
    {
      description: 'Tweets from a Twitter List (curated sources).',
      inputSchema: { listId: z.string(), limit: N },
    },
    async (a) => wrap(await runList(getEngine(), String(a.listId ?? ''), n(a.limit))),
  );
  server.registerTool(
    'user-media',
    { description: "A user's media posts only (images/videos).", inputSchema: handleIn },
    async (a) => wrap(await runUserMedia(getEngine(), h(a.handle), n(a.limit))),
  );
  server.registerTool(
    'followers',
    { description: "A user's followers (network mapping).", inputSchema: handleIn },
    async (a) => wrap(await runFollowers(getEngine(), h(a.handle), n(a.limit))),
  );
  server.registerTool(
    'following',
    { description: 'Who a user follows.', inputSchema: handleIn },
    async (a) => wrap(await runFollowing(getEngine(), h(a.handle), n(a.limit))),
  );
  server.registerTool(
    'retweeters',
    { description: 'Who retweeted a tweet (amplification graph).', inputSchema: tweetIn },
    async (a) => wrap(await runRetweeters(getEngine(), t(a.target), n(a.limit))),
  );
  server.registerTool(
    'likers',
    { description: 'Who liked a tweet (engagement graph).', inputSchema: tweetIn },
    async (a) => wrap(await runLikers(getEngine(), t(a.target), n(a.limit))),
  );
  server.registerTool(
    'quoters',
    { description: 'Tweets quoting a tweet (reactions/discourse).', inputSchema: tweetIn },
    async (a) => wrap(await runQuoters(getEngine(), t(a.target), n(a.limit))),
  );
  server.registerTool(
    'trends',
    {
      description: "What's trending now — a zoomed-out entry point.",
      inputSchema: {
        woeid: z.number().int().describe('location id; 1 = worldwide (default)').optional(),
        limit: N,
      },
    },
    async (a) =>
      wrap(
        await runTrends(getEngine(), {
          ...(a.woeid !== undefined ? { woeid: Number(a.woeid) } : {}),
          ...(a.limit !== undefined ? { limit: Number(a.limit) } : {}),
        }),
      ),
  );
  server.registerTool(
    'article',
    {
      description: 'Fetch a long-form X Article as Markdown.',
      inputSchema: { target: z.string() },
    },
    async (a) => wrap(await runArticle(getEngine(), t(a.target))),
  );
  server.registerTool(
    'media',
    {
      description: "A tweet's image/video assets (URLs); pass outDir to download files.",
      inputSchema: { target: z.string(), outDir: z.string().optional() },
    },
    async (a) =>
      wrap(await runMedia(getEngine(), t(a.target), a.outDir ? String(a.outDir) : undefined)),
  );
  server.registerTool(
    'community',
    {
      description: "A community's tweet feed (a topical, moderated sub-network).",
      inputSchema: { communityId: z.string(), limit: N },
    },
    async (a) => wrap(await runCommunity(getEngine(), String(a.communityId ?? ''), n(a.limit))),
  );
  server.registerTool(
    'community-info',
    {
      description:
        'Community metadata: name, description, member/mod counts, rules, topic, creator.',
      inputSchema: { communityId: z.string() },
    },
    async (a) => wrap(await runCommunityInfo(getEngine(), String(a.communityId ?? ''))),
  );
  server.registerTool(
    'doctor',
    {
      description:
        'Diagnose setup: entry/symlink, cookie resolution, live auth (whoami) + a 1-result test search, and usage guidance. Run this first when calls return empty or fail. offline=true skips the two live checks (no network calls).',
      inputSchema: {
        offline: z
          .boolean()
          .describe('skip the live auth + search checks (no network calls)')
          .optional(),
      },
    },
    async (a) => wrap(await runDoctor(getEngine(), { offline: Boolean(a.offline) })),
  );

  server.registerTool(
    'batch',
    {
      description:
        'Run MANY X searches from a query file, strictly serialized with a delay between calls, and merge the results — deduped by tweet id — into one archive file. One query per line; blank lines and # comments are skipped. Continue-on-error: a failed query is recorded and the run proceeds (a rate-limited query waits its retryAfterMs). Returns a summary {queries, succeeded, failed, totalUnique, out, perQuery}. `out` is required over MCP (the archive is written to disk, not streamed back).',
      inputSchema: {
        file: z.string().describe('path to a newline-delimited query file'),
        out: z.string().describe('output archive file path (required)'),
        delay: z
          .number()
          .int()
          .nonnegative()
          .describe('ms to sleep between queries (default 2000)')
          .optional(),
        limit: z.number().int().positive().describe('per-query result cap').optional(),
        product: z.enum(['Top', 'Latest', 'Media', 'People']).optional(),
      },
    },
    async (a) =>
      wrap(
        await runBatch(getEngine(), {
          file: String(a.file ?? ''),
          out: String(a.out ?? ''),
          ...(a.delay !== undefined ? { delay: Number(a.delay) } : {}),
          ...(a.limit !== undefined ? { limit: Number(a.limit) } : {}),
          ...(a.product ? { product: a.product as SearchProduct } : {}),
          quiet: true, // no stderr progress over the MCP stdio transport
        }),
      ),
  );

  return server;
}

export async function main(): Promise<void> {
  const server = buildServer();
  await server.connect(new StdioServerTransport());
}

// Fail-loud: when the runtime gives no definitive answer and the invocation
// looks like our binary, run anyway (after a stderr warning) — never silently
// exit 0 under the npm bin symlink.
const entry = shouldRunAsEntry(process.argv[1], import.meta.url, import.meta.main, [
  'x-relay-mcp',
  'mcp-shim.js',
]);
if (entry.warning !== undefined) process.stderr.write(`${entry.warning}\n`);

if (entry.run) void main();
