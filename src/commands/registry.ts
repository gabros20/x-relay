// Single source of truth for command definitions. Drives CLI help/dispatch and
// is available to the skill generator. Keep in sync with the runners below.

export interface CommandDef {
  name: string;
  /** Funnel cost hint shown in help + skill. */
  cost: string;
  summary: string;
  usage: string;
}

export const COMMANDS: CommandDef[] = [
  {
    name: 'search',
    cost: 'cheap — the net',
    summary: 'Live X search. Cast a wide net; rank on engagement/recency metadata.',
    usage:
      'xrelay search "<query>" [--limit N] [--product Top|Latest|Media|People]\n' +
      '       [--from <h>] [--to <h>] [--since YYYY-MM-DD] [--until YYYY-MM-DD]\n' +
      '       [--lang xx] [--min-faves N] [--min-retweets N] [--filter media|links|replies|-replies ...]',
  },
  {
    name: 'user',
    cost: '1 call',
    summary: 'Profile lookup: bio, followers, verified, counts, joined.',
    usage: 'xrelay user <handle|url>',
  },
  {
    name: 'user-posts',
    cost: 'medium',
    summary: "A user's timeline (optionally including replies).",
    usage: 'xrelay user-posts <handle|url> [--replies] [--limit N]',
  },
  {
    name: 'thread',
    cost: 'expensive — full read',
    summary: 'A tweet plus its reply thread. Read only the finalists.',
    usage: 'xrelay thread <id|url>',
  },
  {
    name: 'bookmarks',
    cost: 'cheap — local cache',
    summary: 'Search your saved posts in the local cache. --sync to refresh, --live to hit X.',
    usage:
      'xrelay bookmarks [-q "<query>"] [--limit N] [--sort relevance|newest|likes|views|bookmarks]\n' +
      '       [--sync] [--repair] [--live]',
  },
  {
    name: 'my-posts',
    cost: 'cheap — local cache',
    summary: 'Search your own posts in the local cache. --sync to refresh, --live to hit X.',
    usage:
      'xrelay my-posts [-q "<query>"] [--limit N] [--sort ...] [--handle <you>] [--sync] [--live]',
  },
  {
    name: 'sync',
    cost: 'medium — incremental',
    summary: 'Pull only NEW bookmarks/posts since the last sync into the local cache.',
    usage: 'xrelay sync bookmarks|posts|all [--handle <you>] [--repair]',
  },
  {
    name: 'list',
    cost: 'medium',
    summary: 'Tweets from a Twitter List (curated sources).',
    usage: 'xrelay list <list-id> [--limit N]',
  },
  {
    name: 'user-media',
    cost: 'medium',
    summary: "A user's media posts only (images/videos) — visual evidence.",
    usage: 'xrelay user-media <handle|url> [--limit N]',
  },
  {
    name: 'followers',
    cost: 'medium',
    summary: "A user's followers (network mapping).",
    usage: 'xrelay followers <handle|url> [--limit N]',
  },
  {
    name: 'following',
    cost: 'medium',
    summary: 'Who a user follows.',
    usage: 'xrelay following <handle|url> [--limit N]',
  },
  {
    name: 'retweeters',
    cost: 'medium',
    summary: 'Who retweeted a tweet (amplification graph).',
    usage: 'xrelay retweeters <id|url> [--limit N]',
  },
  {
    name: 'likers',
    cost: 'medium',
    summary: 'Who liked a tweet (engagement graph).',
    usage: 'xrelay likers <id|url> [--limit N]',
  },
  {
    name: 'quoters',
    cost: 'medium',
    summary: 'Tweets quoting a tweet (reactions/discourse; recency-windowed).',
    usage: 'xrelay quoters <id|url> [--limit N]',
  },
  {
    name: 'trends',
    cost: 'cheap',
    summary: "What's trending now — a zoomed-out entry point.",
    usage: 'xrelay trends [--woeid N] [--limit N]   # woeid 1 = worldwide (default)',
  },
  {
    name: 'article',
    cost: 'medium',
    summary: 'Fetch a long-form X Article and render it to Markdown.',
    usage: 'xrelay article <id|url>',
  },
  {
    name: 'media',
    cost: 'medium',
    summary: "A tweet's image/video assets (URLs); --out <dir> downloads the files.",
    usage: 'xrelay media <id|url> [--out <dir>]',
  },
  {
    name: 'community',
    cost: 'medium',
    summary: "A community's tweet feed (a topical, moderated sub-network).",
    usage: 'xrelay community <community-id> [--limit N]',
  },
  {
    name: 'community-info',
    cost: '1 call',
    summary: 'Community metadata: name, description, member/mod counts, rules, topic, creator.',
    usage: 'xrelay community-info <community-id>',
  },
];

export const commandNames: string[] = COMMANDS.map((c) => c.name);
