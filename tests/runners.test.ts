import { describe, expect, test } from 'bun:test';
import { requireConfirmation } from '../src/commands/runners.ts';

describe('requireConfirmation (destructive-write guard)', () => {
  test('blocks with a CONFIRMATION_REQUIRED envelope when not confirmed', () => {
    const block = requireConfirmation('delete-tweet', {}, 'permanently delete tweet 20');
    expect(block).not.toBeNull();
    if (block === null) throw new Error('expected a block envelope');
    expect(block.ok).toBe(false);
    if (block.ok) throw new Error('expected failure envelope');
    expect(block.command).toBe('delete-tweet');
    expect(block.error.code).toBe('CONFIRMATION_REQUIRED');
    expect(block.error.message).toContain('permanently delete tweet 20');
    expect(block.error.hint).toBeDefined();
  });

  test('blocks when confirmed is explicitly false', () => {
    expect(requireConfirmation('unfollow', { confirmed: false }, 'unfollow @x')).not.toBeNull();
  });

  test('returns null (proceed) only when confirmed is exactly true', () => {
    expect(requireConfirmation('delete-tweet', { confirmed: true }, 'delete')).toBeNull();
  });
});
