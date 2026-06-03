import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import Cubic from '../src/engine/xctid/cubic.ts';
import { InterpolationInputError } from '../src/engine/xctid/errors.ts';
import { interpolate } from '../src/engine/xctid/interpolate.ts';
import { convertRotationToMatrix } from '../src/engine/xctid/rotation.ts';
import { assembleTransactionId } from '../src/engine/xctid/transaction.ts';
import { floatToHex, isOdd } from '../src/engine/xctid/utils.ts';

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
