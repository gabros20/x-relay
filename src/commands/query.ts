// Pure builder: fold typed search flags into X's raw advanced-search string.
// X parses operators inside the query itself, so we just concatenate them.

export interface SearchQueryFlags {
  query: string;
  from?: string;
  to?: string;
  since?: string;
  until?: string;
  lang?: string;
  minFaves?: number;
  minRetweets?: number;
  /** `filter:<v>`; a leading `-` becomes `-filter:<v>` (exclude). e.g. media, replies, links. */
  filter?: string[];
}

export function buildSearchQuery(flags: SearchQueryFlags): string {
  const parts: string[] = [];
  const base = flags.query.trim();
  if (base) parts.push(base);

  if (flags.from) parts.push(`from:${flags.from}`);
  if (flags.to) parts.push(`to:${flags.to}`);
  if (flags.since) parts.push(`since:${flags.since}`);
  if (flags.until) parts.push(`until:${flags.until}`);
  if (flags.lang) parts.push(`lang:${flags.lang}`);
  if (flags.minFaves !== undefined) parts.push(`min_faves:${flags.minFaves}`);
  if (flags.minRetweets !== undefined) parts.push(`min_retweets:${flags.minRetweets}`);

  for (const f of flags.filter ?? []) {
    const v = f.trim();
    if (!v) continue;
    parts.push(v.startsWith('-') ? `-filter:${v.slice(1)}` : `filter:${v}`);
  }

  return parts.join(' ');
}
