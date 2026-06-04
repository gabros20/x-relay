import { describe, expect, test } from 'bun:test';
import { assignProxies, makeFetch, parseAccounts, parseProxyList } from '../src/engine/pool.ts';

describe('parseProxyList', () => {
  test('splits on commas and newlines, trimming blanks', () => {
    expect(parseProxyList('http://a:1 , http://b:2\n http://c:3 \n\n')).toEqual([
      'http://a:1',
      'http://b:2',
      'http://c:3',
    ]);
  });

  test('empty input yields an empty list', () => {
    expect(parseProxyList('')).toEqual([]);
    expect(parseProxyList('   \n ')).toEqual([]);
  });
});

describe('parseAccounts', () => {
  test('parses a newline list of cookie strings into one spec each', () => {
    const specs = parseAccounts('auth_token=a1; ct0=b1\nauth_token=a2; ct0=b2');
    expect(specs).toHaveLength(2);
    expect(specs[0]?.cookies).toEqual({ authToken: 'a1', ct0: 'b1' });
    expect(specs[1]?.cookies).toEqual({ authToken: 'a2', ct0: 'b2' });
    expect(specs[0]?.proxy).toBeUndefined();
  });

  test('parses a JSON array with per-account proxies and labels', () => {
    const raw = JSON.stringify([
      { cookies: 'auth_token=a1; ct0=b1', proxy: 'http://p1:1', label: 'main' },
      { cookies: 'auth_token=a2; ct0=b2' },
    ]);
    const specs = parseAccounts(raw);
    expect(specs).toHaveLength(2);
    expect(specs[0]).toEqual({
      cookies: { authToken: 'a1', ct0: 'b1' },
      proxy: 'http://p1:1',
      label: 'main',
    });
    expect(specs[1]?.proxy).toBeUndefined();
    expect(specs[1]?.label).toBe('acct2');
  });

  test('accepts a JSON array of bare cookie strings', () => {
    const specs = parseAccounts('["auth_token=a1; ct0=b1", "auth_token=a2; ct0=b2"]');
    expect(specs.map((s) => s.cookies.authToken)).toEqual(['a1', 'a2']);
  });

  test('blank input yields no specs', () => {
    expect(parseAccounts('')).toEqual([]);
    expect(parseAccounts('  \n ')).toEqual([]);
  });
});

describe('assignProxies', () => {
  const spec = (authToken: string, proxy?: string) => ({
    cookies: { authToken, ct0: 'x' },
    label: authToken,
    ...(proxy ? { proxy } : {}),
  });

  test('round-robins proxies onto specs that lack one', () => {
    const out = assignProxies([spec('a'), spec('b'), spec('c')], ['http://p1', 'http://p2']);
    expect(out.map((s) => s.proxy)).toEqual(['http://p1', 'http://p2', 'http://p1']);
  });

  test('never overrides an explicitly-pinned proxy', () => {
    const out = assignProxies([spec('a', 'http://pinned'), spec('b')], ['http://p1']);
    expect(out.map((s) => s.proxy)).toEqual(['http://pinned', 'http://p1']);
  });

  test('with no proxies the specs pass through unchanged', () => {
    const specs = [spec('a'), spec('b')];
    expect(assignProxies(specs, [])).toEqual(specs);
  });
});

describe('makeFetch', () => {
  test('without a proxy returns the base fetch unchanged (no undici load)', () => {
    const base = (async () => new Response('x')) as unknown as typeof fetch;
    expect(makeFetch(undefined, base)).toBe(base);
  });

  test('with a proxy returns a distinct wrapper', () => {
    const base = (async () => new Response('x')) as unknown as typeof fetch;
    expect(makeFetch('http://proxy:8080', base)).not.toBe(base);
  });
});
