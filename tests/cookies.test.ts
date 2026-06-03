import { describe, expect, test } from 'bun:test';
import { createCipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';
import { decryptCookieValue, deriveKey, pickAuthCookies } from '../src/engine/cookies.ts';

// Replicate Chrome's macOS v10 scheme to produce a value our decryptor must recover.
function encryptV10(plaintext: Buffer, key: Buffer): Buffer {
  const iv = Buffer.alloc(16, ' ');
  const cipher = createCipheriv('aes-128-cbc', key, iv);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from('v10'), body]);
}

describe('deriveKey', () => {
  test('is a deterministic 16-byte AES key (PBKDF2 saltysalt/1003/sha1)', () => {
    const k1 = deriveKey('peanuts');
    const k2 = deriveKey('peanuts');
    expect(k1.length).toBe(16);
    expect(k1.equals(k2)).toBe(true);
    expect(k1.equals(pbkdf2Sync('peanuts', 'saltysalt', 1003, 16, 'sha1'))).toBe(true);
  });
});

describe('decryptCookieValue', () => {
  const key = deriveKey('test-secret');

  test('round-trips a v10-encrypted value', () => {
    const enc = encryptV10(Buffer.from('abc123token'), key);
    expect(decryptCookieValue(enc, key)).toBe('abc123token');
  });

  test('strips the 32-byte domain-hash prefix newer Chrome prepends', () => {
    const enc = encryptV10(Buffer.concat([randomBytes(32), Buffer.from('ct0value')]), key);
    expect(decryptCookieValue(enc, key)).toBe('ct0value');
  });

  test('returns plaintext for an unencrypted (non-v10) value', () => {
    expect(decryptCookieValue(Buffer.from('plainvalue'), key)).toBe('plainvalue');
  });
});

describe('pickAuthCookies', () => {
  test('selects auth_token + ct0 and builds a full cookie string', () => {
    const rows = [
      { hostKey: '.x.com', name: 'auth_token', value: 'AAA' },
      { hostKey: '.x.com', name: 'ct0', value: 'BBB' },
      { hostKey: '.x.com', name: 'guest_id', value: 'GGG' },
    ];
    const got = pickAuthCookies(rows);
    expect(got?.authToken).toBe('AAA');
    expect(got?.ct0).toBe('BBB');
    expect(got?.extra?.guest_id).toBe('GGG');
  });

  test('returns null when auth_token or ct0 is missing', () => {
    expect(pickAuthCookies([{ hostKey: '.x.com', name: 'auth_token', value: 'AAA' }])).toBeNull();
  });
});
