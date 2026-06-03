#!/usr/bin/env node
// ─── x-relay-mcp MCP shim ─────────────────────────────────────────────────
// Thin @modelcontextprotocol/sdk stdio server exposing the same commands as MCP
// tools. No business logic — delegates to the command runners over one lazily
// created Engine (cookies auto-extracted from the local browser).
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { runBookmarks, runSearch, runThread, runUser, runUserPosts } from './commands/index.ts';
import { type Engine, createEngine } from './engine/index.ts';
import type { SearchProduct } from './engine/ops.ts';
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

  server.registerTool(
    'bookmarks',
    {
      description: 'Your saved posts (live).',
      inputSchema: { limit: z.number().int().positive().optional() },
    },
    async (args) =>
      wrap(
        await runBookmarks(getEngine(), {
          ...(args.limit !== undefined ? { limit: Number(args.limit) } : {}),
        }),
      ),
  );

  return server;
}

export async function main(): Promise<void> {
  const server = buildServer();
  await server.connect(new StdioServerTransport());
}

const isEntry =
  import.meta.main === true ||
  (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]);

if (isEntry) void main();
