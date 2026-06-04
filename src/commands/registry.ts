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
];

export const commandNames: string[] = COMMANDS.map((c) => c.name);
