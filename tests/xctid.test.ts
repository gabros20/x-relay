import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import Cubic from '../src/engine/xctid/cubic.ts';
import { InterpolationInputError } from '../src/engine/xctid/errors.ts';
import { interpolate } from '../src/engine/xctid/interpolate.ts';
import { convertRotationToMatrix } from '../src/engine/xctid/rotation.ts';
import { assembleTransactionId } from '../src/engine/xctid/transaction.ts';
import { floatToHex, handleXMigration, isOdd } from '../src/engine/xctid/utils.ts';

describe('isOdd', () => {
  test('odd -> -1, even -> 0', () => {
    expect(isOdd(1)).toBe(-1);
    expect(isOdd(3)).toBe(-1);
    expect(isOdd(0)).toBe(0);
    expect(isOdd(2)).toBe(0);
  });
});

describe('floatToHex', () => {
  test('integer values', () => {
    expect(floatToHex(0)).toBe('');
    expect(floatToHex(255)).toBe('FF');
    expect(floatToHex(16)).toBe('10');
  });
  test('fractional values keep a hex fraction', () => {
    expect(floatToHex(1.5)).toBe('1.8');
  });
});

describe('interpolate', () => {
  test('numeric midpoint', () => {
    expect(interpolate([0, 0, 0], [10, 20, 30], 0.5)).toEqual([5, 10, 15]);
  });
  test('endpoints', () => {
    expect(interpolate([2], [8], 0)).toEqual([2]);
    expect(interpolate([2], [8], 1)).toEqual([8]);
  });
  test('throws a typed error on length mismatch', () => {
    expect(() => interpolate([1], [1, 2], 0.5)).toThrow(InterpolationInputError);
  });
});

describe('convertRotationToMatrix', () => {
  test('0 degrees is identity', () => {
    const m = convertRotationToMatrix(0);
    expect(m[0]).toBeCloseTo(1, 6);
    expect(m[1]).toBeCloseTo(0, 6);
    expect(m[2]).toBeCloseTo(0, 6);
    expect(m[3]).toBeCloseTo(1, 6);
  });
  test('90 degrees rotates', () => {
    const m = convertRotationToMatrix(90);
    expect(m[0]).toBeCloseTo(0, 6);
    expect(m[1]).toBeCloseTo(-1, 6);
    expect(m[2]).toBeCloseTo(1, 6);
    expect(m[3]).toBeCloseTo(0, 6);
  });
});

describe('Cubic.getValue', () => {
  // Control points (1/3,1/3),(2/3,2/3) trace the identity line y=x.
  const c = new Cubic([1 / 3, 1 / 3, 2 / 3, 2 / 3]);
  test('clamps at 0 and 1', () => {
    expect(c.getValue(0)).toBeCloseTo(0, 6);
    expect(c.getValue(1)).toBeCloseTo(1, 6);
  });
  test('midpoint ~ identity', () => {
    expect(c.getValue(0.5)).toBeCloseTo(0.5, 3);
  });
});

describe('assembleTransactionId', () => {
  test('XOR-cloaks [keyBytes | timeBytes(LE) | sha256(data)[0:16] | 3] behind a random head byte', async () => {
    const keyBytes = [1, 2, 3, 4, 5, 6, 7, 8];
    const animationKey = 'abc';
    const method = 'GET';
    const path = '/i/api/graphql/foo/Bar';
    const timeNow = 1000;
    const randomNum = 42;

    const id = await assembleTransactionId(
      keyBytes,
      animationKey,
      method,
      path,
      timeNow,
      randomNum,
    );
    const bytes = [...Buffer.from(id, 'base64')];

    // Head byte is the random cloak; the rest is XOR'd with it.
    expect(bytes[0]).toBe(randomNum);
    const payload = bytes.slice(1).map((b) => b ^ randomNum);

    // keyBytes first
    expect(payload.slice(0, 8)).toEqual(keyBytes);
    // little-endian time bytes: 1000 = 0x03E8 -> [0xE8, 0x03, 0, 0]
    expect(payload.slice(8, 12)).toEqual([0xe8, 0x03, 0, 0]);
    // first 16 bytes of sha256 of the exact data string
    const data = `${method}!${path}!${timeNow}obfiowerehiring${animationKey}`;
    const expectedHash = [...createHash('sha256').update(data, 'utf8').digest()].slice(0, 16);
    expect(payload.slice(12, 28)).toEqual(expectedHash);
    // trailing ADDITIONAL_RANDOM_NUMBER
    expect(payload[28]).toBe(3);
    // no base64 padding
    expect(id).not.toContain('=');
  });

  test('omitting randomNum still produces a decodable id of the right length', async () => {
    const id = await assembleTransactionId([0, 0], 'k', 'POST', '/x', 5);
    const bytes = [...Buffer.from(id, 'base64')];
    // 1 head + 2 key + 4 time + 16 hash + 1 trailing = 24
    expect(bytes.length).toBe(24);
  });
});

describe('handleXMigration', () => {
  // A minimal X shell; `withRuntime` toggles whether it carries the `ondemand.s`
  // manifest the transaction-id generator needs (the legacy responsive-web shell)
  // or the newer "x-web" logged-out shell that dropped it.
  const shell = (marker: string, withRuntime: boolean): string => {
    const runtime = withRuntime ? 'chunk={"ondemand.s":1}' : 'src="entry-client-logged-out.js"';
    return `<html><head><meta name="twitter-site-verification" content="k"/><script>${runtime}</script></head><body>${marker}</body></html>`;
  };

  const fakeFetch = (routes: (url: string) => string, seen?: string[]): typeof fetch =>
    (async (url: string | URL | Request): Promise<Response> => {
      const u = typeof url === 'string' ? url : url.toString();
      seen?.push(u);
      return new Response(routes(u), { status: 200 });
    }) as unknown as typeof fetch;

  test('skips a migrated path and returns the first shell that carries the runtime', async () => {
    const seen: string[] = [];
    const fetchImpl = fakeFetch((u) => {
      if (u.endsWith('/i/flow/login')) return shell('login', false); // migrated → no runtime
      if (u.endsWith('/home')) return shell('home', true); // legacy → has runtime
      return shell('explore', true);
    }, seen);

    const doc = await handleXMigration(fetchImpl);
    expect(doc.documentElement.outerHTML).toContain('ondemand.s');
    expect(doc.documentElement.outerHTML).toContain('home');
    // stops at /home; never falls through to /explore
    expect(seen.some((u) => u.endsWith('/i/flow/login'))).toBe(true);
    expect(seen.some((u) => u.endsWith('/home'))).toBe(true);
    expect(seen.some((u) => u.endsWith('/explore'))).toBe(false);
  });

  test('returns the first shell immediately when it already carries the runtime', async () => {
    const seen: string[] = [];
    const fetchImpl = fakeFetch(() => shell('login', true), seen);
    const doc = await handleXMigration(fetchImpl);
    expect(doc.documentElement.outerHTML).toContain('ondemand.s');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.endsWith('/i/flow/login')).toBe(true);
  });

  test('falls back to the last fetched document when no path carries the runtime', async () => {
    const fetchImpl = fakeFetch((u) =>
      u.endsWith('/explore') ? shell('explore-last', false) : shell('other', false),
    );
    const doc = await handleXMigration(fetchImpl);
    // last path tried is /explore → its document is returned even without the runtime,
    // so the downstream generator throws the precise ondemand error, not a transport one.
    expect(doc.documentElement.outerHTML).toContain('explore-last');
  });

  test('rethrows when every candidate fetch fails', async () => {
    const fetchImpl = (async (): Promise<Response> =>
      new Response('nope', {
        status: 503,
        statusText: 'Service Unavailable',
      })) as unknown as typeof fetch;
    await expect(handleXMigration(fetchImpl)).rejects.toMatchObject({
      code: 'X_HOMEPAGE_FETCH_ERROR',
    });
  });
});
