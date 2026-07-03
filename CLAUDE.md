# x-relay

A deep-research tool for X/Twitter — a TypeScript CLI (`xrelay`) + a thin MCP shim (`x-relay-mcp`) + a
Claude Code skill. An agent shells out to search X live, look up profiles, read threads, and search an
incrementally-synced local cache of the user's bookmarks and posts. **No paid X API** — a from-scratch engine
on X's private GraphQL surface, authenticated with the user's login cookies. Published to npm.

Sibling project to `../youtube-context` (`youtube-relay-mcp`); same stack, shape, and philosophy.

## Dev Commands

- `bun run check` — full CI: typecheck + lint + test
- `bun test` / `bun test --watch` — tests / TDD watch mode
- `bun run typecheck` / `bun run lint` / `bun run lint:fix`
- `bun run build` — generate skill + build to dist/ via tsup
- `bun run dev` — generate skill + run the CLI from source

## Architecture

- `src/cli.ts` — CLI entry (`xrelay`); parses args, dispatches a command, prints a JSON envelope to stdout.
- `src/mcp-shim.ts` — MCP server entry (`x-relay-mcp`); read-only subset of commands as MCP tools. Thin, no business logic.
- `src/entry.ts` — pure main-module detection (`shouldRunAsEntry`); resolves symlinks so the npm bin shim runs
  instead of silently exiting, and fails loud when detection is ambiguous. Used by both entry points.
- `src/index.ts` — library exports.
- `src/engine/` — the ONLY place that talks to X's network. `xctid/` (vendored + ported
  x-client-transaction-id), `auth.ts` (header builder), `ops.ts` (externalized queryId + features config),
  `client.ts` (request driver + 429/404/336 resilience), `parse.ts` (deep-search + dual core/legacy normalize +
  cursor/end-detection), `index.ts` (Engine interface + createEngine). Network lives here so commands stay
  testable.
- `src/cache/` — independent local store under `~/.xrelay` + snowflake-watermark incremental sync.
- `src/commands/registry.ts` — single source of truth for command definitions; drives CLI + SKILL generation.
  `commands/` also holds each runner plus the multi-step `doctor.ts` (setup diagnostics) and `batch.ts`
  (serialized multi-query sweep + dedupe).
- `src/format.ts` — pure presentation helpers: engagement scoring, `--compact` flat rows, `--fields` projection.
- `src/progress.ts` — stderr progress reporter for long-running commands (`--quiet` silences it; stdout stays JSON-only).
- `src/ids.ts` / `src/output.ts` / `src/types.ts` — pure helpers + envelope + domain types. No I/O.
- `scripts/generate-skill.ts` — reads `.claude/skills/x-relay/SKILL.md`, emits `src/generated/*`.

The grounded engine research — auth headers, GraphQL endpoints, the transaction-id algorithm, parsing, and the
incremental-sync design — lives in `docs/ENGINE-RESEARCH.md`. Build from it; don't reinvent X's surface blind.

## Testing Rules

Test **behavior** — parse normalization on captured GraphQL fixtures, cursor/end-detection, the transaction-id
math (deterministic given a fixed clock + key), tweet-id/handle extraction, arg parsing, envelope shape, the
watermark early-break logic. Do NOT test what `tsc`/Biome already enforce (types, field presence). Network is
wrapped in `engine/`; keep any live smoke test out of unit CI.

## Engineering Workflow

- **TDD is mandatory** for production code (see the `test-driven-development` skill): failing test first, watch
  it fail, minimal code to pass.
- **Conventional Commits** — required; `semantic-release` derives the version + CHANGELOG. `feat:`→minor,
  `fix:`→patch, `feat!:`/`BREAKING CHANGE:`→major; `docs:`/`chore:`/`ci:`/`test:`/`refactor:` don't release.
- **Small commits** — one logical unit per commit; commit promptly so any change is cleanly revertible. Releases
  run from `main` (prereleases from `beta`) via GitHub Actions. Never bump version / edit CHANGELOG by hand.

## Constraints

- Read + archive + write tool. Reads (search, profiles, threads, metadata, local cache, archiving) plus confirmed
  write commands on the CLI (post/reply/quote/like/unlike/bookmark/unbookmark/retweet/unretweet/follow/unfollow,
  and `delete` behind `--confirm`). The MCP tool surface stays read-only by design; `dedupe` is CLI-only.
- Auth is cookie-based (`auth_token` + `ct0`) via `XRELAY_COOKIES` env / cookie file / browser extract. The
  password `login()` onboarding flow (Castle.io + JS instrumentation) is deferred — it's the fragile part.
- Query-ids and the `features` blob ROTATE — they live in `src/engine/ops.ts` config, never hardcoded in logic,
  and a `(336) features cannot be null` response must fail loudly ("refresh ops config"), not silently.
- The transaction-id init scrapes X's web bundle; re-init on a timer and on the first 403/404.
- Assumes a residential IP (local agent); datacenter/cloud IPs get blocked. Any account used can be
  rate-limited or banned — single-account, read-only, jittered. Document the risk; never promise safety.

## Key Reference Documentation

- docs/ENGINE-RESEARCH.md — grounded internals (auth, GraphQL ops, transaction-id, parsing, sync)
- x-client-transaction-id — https://github.com/Lqm1/x-client-transaction-id (vendor + port)
- twscrape (resilience/pool reference) — https://github.com/vladkens/twscrape
- the-convocation/twitter-scraper (TS patterns) — https://github.com/the-convocation/twitter-scraper
- MCP Protocol docs — https://modelcontextprotocol.io/llms.txt
- semantic-release — https://semantic-release.gitbook.io/semantic-release/
