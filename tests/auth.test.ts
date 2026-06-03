import { describe, expect, test } from 'bun:test';
import { BEARER_TOKEN, buildHeaders, cookieString, parseCookies } from '../src/engine/auth.ts';

describe('parseCookies', () => {
  test('parses the browser cookie string form', () => {
    const cookies = parseCookies('auth_token=abc; ct0=def; guest_id=ghi');
    expect(cookies.authToken).toBe('abc');
    expect(cookies.ct0).toBe('def');
    expect(cookies.extra).toEqual({ guest_id: 'ghi' });
  });

  test('parses the JSON object form', () => {
    const cookies = parseCookies('{"auth_token":"abc","ct0":"def","kdt":"xyz"}');
    expect(cookies.authToken).toBe('abc');
    expect(cookies.ct0).toBe('def');
    expect(cookies.extra).toEqual({ kdt: 'xyz' });
  });

  test('captures no extras when there are none', () => {
    const cookies = parseCookies('auth_token=abc; ct0=def');
    expect(cookies.extra).toBeUndefined();
  });

  test('throws naming ct0 when ct0 is missing', () => {
    expect(() => parseCookies('auth_token=abc; guest_id=ghi')).toThrow(/ct0/);
  });

  test('throws naming auth_token when auth_token is missing', () => {
    expect(() => parseCookies('ct0=def; guest_id=ghi')).toThrow(/auth_token/);
  });
});

describe('cookieString', () => {
  test('starts with auth_token= and contains ct0=', () => {
    const out = cookieString({ authToken: 'abc', ct0: 'def' });
    expect(out.startsWith('auth_token=')).toBe(true);
    expect(out).toContain('ct0=def');
  });

  test('serializes extras after the two load-bearing cookies', () => {
    const out = cookieString({ authToken: 'abc', ct0: 'def', extra: { guest_id: 'ghi' } });
    expect(out).toBe('auth_token=abc; ct0=def; guest_id=ghi');
  });
});

describe('buildHeaders', () => {
  const cookies = { authToken: 'abc', ct0: 'def', extra: { guest_id: 'ghi' } };

  test('x-csrf-token strictly equals cookies.ct0', () => {
    const h = buildHeaders({ cookies, transactionId: 'tx-1' });
    expect(h['x-csrf-token']).toBe('def');
    expect(h['x-csrf-token']).toBe(cookies.ct0);
  });

  test('authorization starts with Bearer and carries the hardcoded token', () => {
    const h = buildHeaders({ cookies, transactionId: 'tx-1' });
    expect(h.authorization.startsWith('Bearer ')).toBe(true);
    expect(h.authorization).toContain(BEARER_TOKEN);
  });

  test('sets the fixed twitter session headers', () => {
    const h = buildHeaders({ cookies, transactionId: 'tx-1' });
    expect(h['x-twitter-auth-type']).toBe('OAuth2Session');
    expect(h['x-twitter-active-user']).toBe('yes');
    expect(h['content-type']).toBe('application/json');
  });

  test('x-client-transaction-id equals the passed id', () => {
    const h = buildHeaders({ cookies, transactionId: 'tx-42' });
    expect(h['x-client-transaction-id']).toBe('tx-42');
  });

  test('cookie header contains both load-bearing tokens', () => {
    const h = buildHeaders({ cookies, transactionId: 'tx-1' });
    expect(h.cookie).toContain('auth_token=abc');
    expect(h.cookie).toContain('ct0=def');
  });

  test('client language defaults to en', () => {
    const h = buildHeaders({ cookies, transactionId: 'tx-1' });
    expect(h['x-twitter-client-language']).toBe('en');
  });

  test('clientLanguage override flows to x-twitter-client-language', () => {
    const h = buildHeaders({ cookies, transactionId: 'tx-1', clientLanguage: 'hu' });
    expect(h['x-twitter-client-language']).toBe('hu');
  });

  test('sets the Cloudflare-load-bearing fetch metadata', () => {
    const h = buildHeaders({ cookies, transactionId: 'tx-1' });
    expect(h.referer).toBe('https://x.com/');
    expect(h.origin).toBe('https://x.com');
    expect(h['sec-fetch-site']).toBe('same-site');
    expect(h['sec-fetch-mode']).toBe('cors');
    expect(h['sec-fetch-dest']).toBe('empty');
    expect(h['user-agent']).toContain('Chrome');
    expect(h.accept).toBe('*/*');
    expect(h['accept-language']).toBe('en-US,en;q=0.9');
  });
});
