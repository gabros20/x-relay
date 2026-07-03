# x-relay

A **read + archive + write tool for X/Twitter** for AI agents — a TypeScript **CLI** (`xrelay`), an **MCP server**
(`x-relay-mcp`), and a **Claude Code skill**. Cast a wide net with live search, rank candidates cheaply on
engagement metadata, and read full threads only for the finalists — plus a **local, incrementally-synced cache**
of your own bookmarks and posts, **full-fidelity archiving** (bookmarks / user timelines / lists / likes /
feed to rich JSON), and **write operations** (post / reply / quote / like / bookmark / retweet / follow /
delete). **No paid X API**: a from-scratch engine on X's private GraphQL surface using your login cookies.

> **Status:** complete read + archive + write surface. Design and engine research are in
> [`PLAN.md`](./PLAN.md) and [`docs/ENGINE-RESEARCH.md`](./docs/ENGINE-RESEARCH.md). Built in the spirit
> of its sibling [`youtube-relay-mcp`](../youtube-context): atomic capabilities, the agent composes the
> strategy, a generated `SKILL.md` teaches the funnel.

## Why a CLI + skill (not just an MCP server)

The task is a search/fetch/rank pipeline. An agent shells out to `xrelay`, taught by the bundled `SKILL.md`.
The MCP shim is provided for parity and non-CLI hosts.

## Agent ergonomics

- **`xrelay doctor [--offline]`** — run it first when a call prints nothing, errors oddly, or comes back empty.
  It checks the install/entry, cookie resolution, live auth, and a test search, and reports what's actually
  wrong. `--offline` diagnoses install/config with no network.
- **Corpus building** — `xrelay batch --file queries.txt --out corpus.json` runs many query variants strictly
  serialized (with a `--delay` between calls), deduped by tweet id into one archive; `xrelay dedupe <files…>
  --out merged.json [--sort engagement]` merges/ranks passes offline. Don't fire parallel searches — serialize
  with 2–5s gaps and respect `error.retryAfterMs` on `RATE_LIMITED`; `batch` handles that pacing for you.
- **Compact search output** — `--compact` returns flat rows, `--fields a,b,c` projects chosen columns, and
  `--sort engagement` ranks by `likes + replies*3 + bookmarks*2` — far cheaper on context for ranking passes.
  Over MCP the `search` tool returns compact rows by default (`compact: false` for the full envelope).

## License

MIT © Tamas Gabor
