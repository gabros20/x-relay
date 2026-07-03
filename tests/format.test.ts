import { describe, expect, it } from 'bun:test';
import {
  COMPACT_FIELDS,
  compactTweet,
  engagementScore,
  projectFields,
  sortByEngagement,
} from '../src/format';
import type { Tweet } from '../src/types';

// Minimal Tweet factory — only the fields format.ts reads matter.
function tweet(over: Partial<Tweet> & { id: string }): Tweet {
  return {
    url: `https://x.com/u/status/${over.id}`,
    text: 'hello',
    author: { id: 'a1', handle: 'alice', name: 'Alice', verified: false },
    metrics: {},
    ...over,
  } as Tweet;
}

describe('engagementScore', () => {
  it('computes likes + replies*3 + bookmarks*2', () => {
    const t = tweet({ id: '1', metrics: { likes: 10, replies: 2, bookmarks: 5 } });
    expect(engagementScore(t)).toBe(10 + 2 * 3 + 5 * 2);
  });

  it('treats missing metrics as 0', () => {
    expect(engagementScore(tweet({ id: '1', metrics: {} }))).toBe(0);
    expect(engagementScore(tweet({ id: '2', metrics: { replies: 4 } }))).toBe(12);
  });
});

describe('sortByEngagement', () => {
  it('returns a new array sorted descending by score', () => {
    const a = tweet({ id: 'a', metrics: { likes: 1 } });
    const b = tweet({ id: 'b', metrics: { likes: 100 } });
    const c = tweet({ id: 'c', metrics: { likes: 50 } });
    const input = [a, b, c];
    const out = sortByEngagement(input);
    expect(out).not.toBe(input);
    expect(input).toEqual([a, b, c]); // input untouched
    expect(out.map((t) => t.id)).toEqual(['b', 'c', 'a']);
  });

  it('is stable for ties (equal scores keep input order)', () => {
    const a = tweet({ id: 'a', metrics: { likes: 5 } });
    const b = tweet({ id: 'b', metrics: { likes: 5 } });
    const c = tweet({ id: 'c', metrics: { likes: 5 } });
    expect(sortByEngagement([a, b, c]).map((t) => t.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('compactTweet', () => {
  it('flattens the tweet with mapped field names and zero-defaults', () => {
    const t = tweet({
      id: '1',
      url: 'https://x.com/alice/status/1',
      text: 'hi',
      createdAt: '2026-01-01',
      author: { id: 'a1', handle: 'alice', name: 'Alice', verified: true },
      metrics: { likes: 3, replies: 1, bookmarks: 2, views: 9 },
    });
    expect(compactTweet(t)).toEqual({
      id: '1',
      url: 'https://x.com/alice/status/1',
      handle: 'alice',
      name: 'Alice',
      date: '2026-01-01',
      text: 'hi',
      likes: 3,
      replies: 1,
      bookmarks: 2,
      views: 9,
    });
  });

  it('defaults numeric fields to 0 when absent', () => {
    const c = compactTweet(tweet({ id: '1', metrics: {} }));
    expect(c.likes).toBe(0);
    expect(c.replies).toBe(0);
    expect(c.bookmarks).toBe(0);
    expect(c.views).toBe(0);
  });

  it('omits the name key entirely when absent', () => {
    const t = tweet({
      id: '1',
      author: { id: 'a1', handle: 'alice', name: '', verified: false },
    });
    expect('name' in compactTweet(t)).toBe(false);
  });

  it('leaves text of exactly 280 chars untouched', () => {
    const text = 'x'.repeat(280);
    expect(compactTweet(tweet({ id: '1', text })).text).toBe(text);
  });

  it('truncates text longer than 280 chars to 280 chars + ellipsis', () => {
    const text = 'x'.repeat(281);
    const out = compactTweet(tweet({ id: '1', text })).text;
    expect(out).toBe(`${'x'.repeat(280)}…`);
    expect([...out].length).toBe(281); // 280 chars + 1 ellipsis
  });
});

describe('projectFields', () => {
  it('picks only the requested keys from the compact shape', () => {
    const t = tweet({ id: '1', metrics: { likes: 5 } });
    expect(projectFields(t, ['id', 'likes'])).toEqual({ id: '1', likes: 5 });
  });

  it('silently ignores unknown field names', () => {
    const t = tweet({ id: '1' });
    expect(projectFields(t, ['id', 'nope' as string])).toEqual({ id: '1' });
  });

  it('exports the list of valid compact field names', () => {
    expect(COMPACT_FIELDS).toContain('id');
    expect(COMPACT_FIELDS).toContain('views');
    expect(COMPACT_FIELDS).toContain('name');
  });
});
