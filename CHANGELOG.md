# [1.4.0](https://github.com/gabros20/x-relay/compare/v1.3.0...v1.4.0) (2026-06-14)


### Bug Fixes

* **T8:** quote attachment_url parity — /i/status/<id> not /i/web/status/<id> ([c9315d8](https://github.com/gabros20/x-relay/commit/c9315d8072a08316617019781adb213d4d87995a))


### Features

* **archive:** add archiveSearch and archiveList engine methods + runners (T2) ([b1958d0](https://github.com/gabros20/x-relay/commit/b1958d0359c5c50405c3f9d5e188592b25c417a3))
* **archive:** full-fidelity bookmark archive branch ([56314df](https://github.com/gabros20/x-relay/commit/56314dfb165c85a0f3f1fc79671bae426e8a6a10))
* **archive:** T1 — archive user <handle> [--replies] and archive my-posts ([dde5d01](https://github.com/gabros20/x-relay/commit/dde5d01a6f7cca6d21b8b259ca6449d756f4cc88))
* **T10:** retweet / unretweet / delete / follow / unfollow write commands ([34ef699](https://github.com/gabros20/x-relay/commit/34ef699834cfe59a984e21a3965a1196beb6a592))
* **T12:** add image attachments to post/reply/quote via chunked media upload ([3aa5ac0](https://github.com/gabros20/x-relay/commit/3aa5ac04c5a53c952be3d11fc9eb166ec055a08a))
* **T3:** --since archive post-filter + whoami/status command ([09cbf4d](https://github.com/gabros20/x-relay/commit/09cbf4df676db72f2b1096d4e9e4a7e1ef3a81d4))
* **T4:** likes capability — research command + archive target ([81ada14](https://github.com/gabros20/x-relay/commit/81ada1403d68d41c5dd7269678e69421d5456521))
* **T5:** feed capability — research command + archive target ([1062307](https://github.com/gabros20/x-relay/commit/10623075e91ab6698f3fde0ea16bdfd4e650c389))
* **T6:** bookmark folders — list, per-folder timeline, and folder archive ([d28e638](https://github.com/gabros20/x-relay/commit/d28e6383f32d729f7b9356905476d8d5851faea4))
* **T7:** write foundation — POST GraphQL + CSRF + v1.1 REST + confirm guard ([14b4b48](https://github.com/gabros20/x-relay/commit/14b4b48ee4d44729863bcf1a5c3c0148777dc219))
* **T8:** post / reply / quote write commands via CreateTweet ([52cde83](https://github.com/gabros20/x-relay/commit/52cde837a741dcb627f0ccb965d9dc162042d82d))
* **T9:** like / unlike / bookmark / unbookmark reversible write toggles ([b9cf16f](https://github.com/gabros20/x-relay/commit/b9cf16fa1802da4d809026eba3a5f2e7b7ee58cf))

# [1.3.0](https://github.com/gabros20/x-relay/compare/v1.2.0...v1.3.0) (2026-06-05)


### Features

* **engine:** account pool + proxy rotation ([12e01c5](https://github.com/gabros20/x-relay/commit/12e01c521b42ce131461dce876be22908ad5ac5d))
* **engine:** communities — feed + info ([4e0c05f](https://github.com/gabros20/x-relay/commit/4e0c05f148850f0a838638d4d2fe45285708236a))

# [1.2.0](https://github.com/gabros20/x-relay/compare/v1.1.0...v1.2.0) (2026-06-04)


### Features

* add 10 read endpoints (timelines, engagement graph, trends, article, media) ([cd23305](https://github.com/gabros20/x-relay/commit/cd2330590581e97b43bf1a930c8cea84f7166dc8))

# [1.1.0](https://github.com/gabros20/x-relay/compare/v1.0.0...v1.1.0) (2026-06-04)


### Features

* **engine:** cold-start retry hardening + me() handle auto-detect ([9cbab77](https://github.com/gabros20/x-relay/commit/9cbab77a1554111ba2fe8304676f22cacf48a315))

# 1.0.0 (2026-06-04)


### Features

* **cache:** incremental local cache for bookmarks + posts (Phase 3) ([1cf0bea](https://github.com/gabros20/x-relay/commit/1cf0beaf63f448e411a91ace34b557797326ebc6))
* **cli:** commands, registry-driven CLI, MCP shim, funnel SKILL ([0e2fd55](https://github.com/gabros20/x-relay/commit/0e2fd55ceb78d7ce58ff89ae574fdef19e540ee7))
* **engine:** add ops config, auth headers, and response parser ([6c40bbc](https://github.com/gabros20/x-relay/commit/6c40bbc54b9f79f75967310878ab2f99cc96792f))
* **engine:** add resilient client + Engine wiring ([496ca3f](https://github.com/gabros20/x-relay/commit/496ca3ffe5311236c4c0de860534dd9d5916bc14))
* **engine:** automatic browser cookie extraction (macOS Keychain) ([0132775](https://github.com/gabros20/x-relay/commit/0132775fecb273394ed6dc34efa2489b8234088a))
* **engine:** vendor + port x-client-transaction-id generator ([bbc7261](https://github.com/gabros20/x-relay/commit/bbc7261b6269e9322d8f98d2b3c49e33a2068de4))
