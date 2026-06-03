# x-relay

A **deep-research tool for X/Twitter** for AI agents — a CLI (`xrelay`), an MCP server, and this skill. Cast a
wide net with live search, rank candidates cheaply on engagement/recency metadata, and read full threads only
for the finalists — plus search a local, incrementally-synced cache of your own bookmarks and posts.

> **Status:** scaffolding — the engine and commands are under construction. This skill will teach the full
> funnel once the command surface lands. See `PLAN.md` and `docs/ENGINE-RESEARCH.md`.

The tool is **atomic** (search / user / user-posts / thread / bookmarks / my-posts / sync). YOU compose the
strategy. Protect your context window: never bulk-read threads during exploration — rank on cheap metadata
first, peek, then full-read only the handful that survive.
