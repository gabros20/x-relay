import { describe, expect, test } from 'bun:test';
import { buildMcpArchiveOpts } from '../src/mcp-shim.ts';

// The MCP archive tool is read-only and never streams the archive back, so the
// arg→opts mapping must always carry `out` (required) and never set `stdout`.
// These tests pin that mapping — the part most likely to drift from runArchive's
// CLI surface — without starting the stdio server.
describe('buildMcpArchiveOpts', () => {
  test('passes target and out through, never sets stdout', () => {
    const opts = buildMcpArchiveOpts({ target: 'bookmarks', out: '/tmp/a.json' });
    expect(opts.target).toBe('bookmarks');
    expect(opts.out).toBe('/tmp/a.json');
    expect(opts.stdout).toBeUndefined();
  });

  test('normalizes a @handle / URL to a bare handle (user target)', () => {
    const opts = buildMcpArchiveOpts({
      target: 'user',
      out: '/tmp/u.json',
      handle: 'https://x.com/jack',
    });
    expect(opts.handle).toBe('jack');
  });

  test('carries the search-target fields (query, product) and coerces limit', () => {
    const opts = buildMcpArchiveOpts({
      target: 'search',
      out: '/tmp/s.json',
      query: 'from:jack ai',
      product: 'Latest',
      limit: 50,
    });
    expect(opts.query).toBe('from:jack ai');
    expect(opts.product).toBe('Latest');
    expect(opts.limit).toBe(50);
  });

  test('forwards list / feed / incremental flags', () => {
    const list = buildMcpArchiveOpts({ target: 'list', out: '/tmp/l.json', listId: '12345' });
    expect(list.listId).toBe('12345');

    const feed = buildMcpArchiveOpts({ target: 'feed', out: '/tmp/f.json', following: true });
    expect(feed.following).toBe(true);

    const inc = buildMcpArchiveOpts({
      target: 'user',
      out: '/tmp/u.json',
      handle: 'jack',
      full: true,
      since: '2024-01-01',
      replies: true,
    });
    expect(inc.full).toBe(true);
    expect(inc.since).toBe('2024-01-01');
    expect(inc.replies).toBe(true);
  });

  test('omits absent optional fields (no undefined keys leaking through)', () => {
    const opts = buildMcpArchiveOpts({ target: 'feed', out: '/tmp/f.json' });
    expect(opts.handle).toBeUndefined();
    expect(opts.query).toBeUndefined();
    expect(opts.listId).toBeUndefined();
    expect(opts.limit).toBeUndefined();
    expect(opts.following).toBeUndefined();
  });
});
