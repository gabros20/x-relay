# x-relay — plan

A **deep-research tool for X/Twitter** for AI agents — a TypeScript **CLI** (`xrelay`), an **MCP server**
(`x-relay-mcp`), and a **Claude Code skill**. Same stack, shape, and philosophy as
[`youtube-relay-mcp`](../youtube-context): atomic capabilities, the agent composes the strategy, a generated
`SKILL.md` teaches the recommended funnel. **No paid X API** — a from-scratch TS engine on X's private GraphQL
surface, using the user's login cookies, grounded in [`docs/ENGINE-RESEARCH.md`](./docs/ENGINE-RESEARCH.md).

## Goal

The best CLI-based X/Twitter **search + deep-research** tool for agents:
- **Live global search** — cast a wide net, rank cheaply on engagement/recency metadata, read full threads only
  for finalists. The headline.
- **Local cache** for *my bookmarks* + *my posts* with **clever incremental sync** — fetch only what's new
  (snowflake-id watermark + newest-first early-break), patch broken records, never refetch everything.
- Atomic, composable commands; a unified JSON envelope; an agent SKILL that teaches the funnel across live X +
  the local cache.

## Stack (mirror youtube-context)

TS + ESM · Bun (pm + test) · tsup (`splitting:false`) · Biome · semantic-release · GitHub Actions CI+Release ·
Conventional Commits. Bins: `xrelay` → `dist/cli.js`, `x-relay-mcp` → `dist/mcp-shim.js`. Published to npm.
`scripts/generate-skill.ts` emits `src/generated/*` from `.claude/skills/x-relay/SKILL.md` + the command registry.

## Auth

Cookie-based: `auth_token` + `ct0` via `XRELAY_COOKIES` env / cookie file / browser auto-extract. Password
`login()` (Castle.io + JS-instrumentation onboarding) is the fragile part — **deferred to a later phase**.

## Architecture

```
src/
  engine/
    xctid/        # vendored + ported x-client-transaction-id (Lqm1 → node:crypto + linkedom)
    auth.ts       # header builder (bearer2, x-csrf-token=ct0, x-twitter-* , sec-fetch, cookies)
    ops.ts        # EXTERNALIZED queryId + features config (hot-swappable) + refresher
    client.ts     # request driver: txid attach, GET param encode, 429/404/336 resilience, per-op limits
    parse.ts      # find_dict deep-search + dual core/legacy normalize + cursor/end-detection
    index.ts      # Engine interface + createEngine()   (the ONLY network layer)
  cache/          # local store + snowflake-watermark incremental sync (bookmarks, my-posts)
  commands/       # one file per command; registry.ts = single source of truth
  ids.ts output.ts types.ts cli.ts mcp-shim.ts index.ts
```

Envelope (same as ytrelay): `{ ok:true, command, data }` / `{ ok:false, command, error:{code,message,hint?} }`.
Engine + cache are dependency-injected so command logic is testable without network.

## Command surface (atomic)

| command | cost | what |
|---|---|---|
| `search "<q>"` | cheap, broad — **the net** | live global search; raw advanced-operator passthrough + typed flags (`--from --since --until --lang --filter --min-faves --product Top\|Latest\|Media\|People`), `--limit`, `--sort`. Enriched tweet summaries (author, verified, followers, likes/RTs/replies/quotes/bookmarks, views, date, snippet, url). |
| `user <handle>` | 1 call | profile: bio, followers, verified, counts. |
| `user-posts <handle>` | medium | a user's timeline (`--replies`/`--media`). |
| `thread <id\|url>` | expensive | a tweet + its replies (TweetDetail) — full read of a finalist. |
| `bookmarks "<q>"` | cheap (local) | search the local bookmark cache; `--sync` pulls fresh delta first, `--live` hits X directly. |
| `my-posts "<q>"` | cheap (local) | same, over my own posts. |
| `sync [bookmarks\|posts]` | medium | incremental delta sync into the cache; `--repair` patches broken records. |

## Funnel (the SKILL)

`GATE 1` cast wide — several `search` query/operator variants, dedupe by id, rank on engagement+recency+author
metadata (no thread reads). → `GATE 2` enrich finalists with `user` / peek `user-posts`. → `GATE 3` `thread`
only the survivors. Plus: the local cache (`bookmarks`/`my-posts`) as a parallel "what have I already saved"
source the agent fuses with live results. Protect the context window — never bulk-read threads during
exploration.

## Phases

- **0 — Scaffold** *(this commit)*: folder, git, grounded `ENGINE-RESEARCH.md`, this plan. Then toolchain
  (package.json, tsconfig, tsup, biome, CI) mirrored from youtube-context.
- **1 — Engine**: `xctid` (vendor+port, TDD the pure math), `auth`, `ops`, `client` (resilience), `parse`
  (TDD the normalizer + cursor/end-detection on fixtures). The core, hardest, novel work.
- **2 — Commands + CLI + MCP + SKILL**: `search`/`user`/`user-posts`/`thread`, registry-driven CLI, MCP shim,
  generated funnel SKILL.
- **3 — Cache + sync**: an **independent** local store under `~/.xrelay` (sqlite/jsonl), optionally *seeded*
  from the existing `agentic-engineer-bookmarks` archive but separate going forward. Snowflake-watermark
  incremental sync, `bookmarks`/`my-posts`/`sync`, own keyword+metadata ranking (semantic layer optional later).
- **4 — Ship**: CI/CD, semantic-release, npm publish, live smoke tests, README.

## Testing rules (mirror ytrelay)

Test **behavior** — parse normalization on captured GraphQL fixtures, cursor/end-detection, the txid math
(deterministic given a fixed clock + key), arg parsing, envelope shape, watermark early-break logic. Don't test
types/field-presence TS already enforces. Network is wrapped in `engine/`; keep any live smoke test out of unit
CI.

## Risks

- **Query-id / features drift** — externalized config + a bundle-scraping refresher + loud `(336)` failure.
- **txid bundle rotation** — re-init on a timer + on 403/404; vendor the regexes to patch fast.
- **Account safety** — any account used with cookies can be limited/banned; single-account, read-only,
  jittered, residential-IP. Document the risk.
- **Residential IP** — like ytrelay, datacenter IPs get blocked; this is a local-agent tool.
