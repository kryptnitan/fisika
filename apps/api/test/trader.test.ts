import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sizesUpTo } from '../src/live/trader.ts';
import { LegError, receivedFromLogs } from '../src/live/legs.ts';
import { encodeAbiParameters, encodeEventTopics, parseAbi, type Log } from 'viem';

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

describe('leg fill confirmation', () => {
  const wallet = '0x27BA209163C1D8e7B19C69144B46eE7A2B91C0B4' as const;
  const wars = '0x1111111111111111111111111111111111111111' as const;
  const usdt = '0x2222222222222222222222222222222222222222' as const;
  const transfer = (token: `0x${string}`, to: `0x${string}`, value: bigint) =>
    ({
      address: token,
      topics: encodeEventTopics({ abi: parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)']), eventName: 'Transfer', args: { from: '0x3333333333333333333333333333333333333333', to } }),
      data: encodeAbiParameters([{ type: 'uint256' }], [value]),
    }) as unknown as Log;

  it('reads what the swap paid from the receipt, not from a balance that may lag', () => {
    const logs = [transfer(usdt, '0x3333333333333333333333333333333333333333', 98_000000n), transfer(wars, wallet, 163_206_285698n), transfer(wars, '0x4444444444444444444444444444444444444444', 5n)];
    assert.equal(receivedFromLogs(logs, wars, wallet), 163_206_285698n, 'only Transfers of the output token into our wallet count');
    assert.equal(receivedFromLogs(logs, usdt, wallet), null, 'no Transfer of that token to us: unknown, fall back to a balance read');
    assert.equal(receivedFromLogs(undefined, wars, wallet), null);
  });

  it('a sent transaction travels on the error, so a filled leg is never booked as "aborted before spend"', () => {
    const e = new LegError('received 0, below minimum 162667895904107081119947', false, [{ hash: '0xabc', gasUsed: 1n, effectiveGasPrice: 1n }]);
    assert.equal(e.retryable, false);
    assert.equal(e.sent.length, 1);
  });
});
