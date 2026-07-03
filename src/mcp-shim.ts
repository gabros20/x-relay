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
import { type Engine, createEngine } from './engine/index.ts';
import type { SearchProduct } from './engine/ops.ts';
import { isMainModule, shouldForceEntry } from './entry.ts';
import { extractHandle, extractTweetId } from './ids.ts';
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

function buildServer(): McpServer {
  const require = createRequire(import.meta.url);
  // biome-ignore lint/suspicious/noExplicitAny: dynamic require of package.json
  const pkg = require('../package.json') as any;
  const server = new McpServer({ name: 'x-relay-mcp', version: String(pkg.version) });

  server.registerTool(
    'search',
    {
      description:
        'Live X/Twitter search — the wide net. Returns enriched tweet summaries (author, verified, likes/retweets/replies/quotes/bookmarks, views, date). Rank on this metadata before reading threads.',
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
      },
    },
    async (args) =>
      wrap(
        await runSearch(getEngine(), {
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
        }),
      ),
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
    async (args) =>
      wrap(
        await runThread(
          getEngine(),
          extractTweetId(String(args.target ?? '')) ?? String(args.target ?? ''),
        ),
      ),
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
  const t = (v: unknown) => extractTweetId(String(v ?? '')) ?? String(v ?? '');
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

  return server;
}

export async function main(): Promise<void> {
  const server = buildServer();
  await server.connect(new StdioServerTransport());
}

const isEntry = isMainModule(process.argv[1], import.meta.url, import.meta.main);

// Fail-loud: user clearly invoked the binary but detection said "not entry".
// Never silently exit 0 in that case — warn to stderr and run anyway.
const forceEntry = !isEntry && shouldForceEntry(process.argv[1], ['x-relay-mcp', 'mcp-shim.js']);
if (forceEntry) {
  process.stderr.write(
    'x-relay-mcp: entry detection failed — treating as main; report at github.com/gabros20/x-relay/issues\n',
  );
}

if (isEntry || forceEntry) void main();
