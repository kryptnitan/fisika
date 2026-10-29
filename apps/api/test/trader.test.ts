import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sizesUpTo } from '../src/live/trader.ts';

describe('live trade sizes', () => {
  it('a $100 wallet with a $100 cap can make one full-size trade', () => {
    // $100 of USDT, 98% usable → $98 cap.
    assert.deepEqual(sizesUpTo([10, 25, 50, 100], 98), [10, 25, 50, 98]);
    assert.deepEqual(sizesUpTo([10, 25, 50, 100], 100), [10, 25, 50, 100]);
  });
  it('never exceeds the cap and adds nothing below the smallest size', () => {
    assert.deepEqual(sizesUpTo([10, 25], 9), []);
    assert.ok(sizesUpTo([10, 25, 50, 100, 250], 61.7).every((x) => x <= 61.7));
  });
});
