# x-relay

A **deep-research tool for X/Twitter** for AI agents — a TypeScript **CLI** (`xrelay`), an **MCP server**
(`x-relay-mcp`), and a **Claude Code skill**. Cast a wide net with live search, rank candidates cheaply on
engagement metadata, and read full threads only for the finalists — plus a **local, incrementally-synced cache**
of your own bookmarks and posts. **No paid X API**: a from-scratch engine on X's private GraphQL surface using
your login cookies.

> **Status:** scaffolding. Design and grounded engine research are in [`PLAN.md`](./PLAN.md) and
> [`docs/ENGINE-RESEARCH.md`](./docs/ENGINE-RESEARCH.md). Built in the spirit of its sibling
> [`youtube-relay-mcp`](../youtube-context): atomic capabilities, the agent composes the strategy, a generated
> `SKILL.md` teaches the funnel.

## Why a CLI + skill (not just an MCP server)

The task is a search/fetch/rank pipeline. An agent shells out to `xrelay`, taught by the bundled `SKILL.md`.
The MCP shim is provided for parity and non-CLI hosts.

## License

MIT © Tamas Gabor

## Optional Hermes Tweet backend

`xrelay` defaults to its local browser-cookie engine. If a deployment cannot
use local X cookies, route `search` and `user` through Hermes Tweet/Xquik while
leaving the rest of the command surface on the default engine:

```bash
export XRELAY_BACKEND=hermes-tweet
export HERMES_TWEET_API_KEY="xq_..."
# Optional, defaults to https://xquik.com
export HERMES_TWEET_BASE_URL="https://xquik.com"
```

`XQUIK_API_KEY` and `XQUIK_BASE_URL` are also accepted. Xquik keys are sent with
`x-api-key`; other tokens use bearer auth. `search` forwards `q`, `limit`, and
`Top`/`Latest` sort preference to `/api/v1/x/tweets/search`, then normalizes the
response into the existing `xrelay` tweet envelope. `user` calls
`/api/v1/x/users/{handle}`. Unsupported commands continue through the normal
local backend.
