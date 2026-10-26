import type { CurvePoint } from './types.ts';

/**
 * Output for `amountIn` along a sampled curve, interpolating linearly between samples and from (0,0) to the
 * first sample. For concave (AMM-like) curves both interpolations under-estimate output, which is the safe
 * direction. Returns null beyond the deepest sample: we never extrapolate depth we have not seen.
 */
export function curveOut(points: readonly CurvePoint[], amountIn: bigint): bigint | null {
  if (amountIn <= 0n) return 0n;
  let prevIn = 0n;
  let prevOut = 0n;
  for (const p of points) {
    if (amountIn <= p.amountIn) {
      const span = p.amountIn - prevIn;
      if (span === 0n) return p.amountOut;
      return prevOut + ((p.amountOut - prevOut) * (amountIn - prevIn)) / span;
    }
    prevIn = p.amountIn;
    prevOut = p.amountOut;
  }
  return null;
}

/**
 * Gas for a swap of `amountIn`: the gas measured at the smallest sample that covers it. A sparse pool can cost
 * 10x more gas at $10k than at $10 (ticks crossed), so charging one max figure for every size misprices
 * small orders.
 */
export function curveGas(points: readonly CurvePoint[], amountIn: bigint, fallback: bigint): bigint {
  for (const p of points) if (amountIn <= p.amountIn) return p.gas ?? fallback;
  return points.at(-1)?.gas ?? fallback;
}

/** Deepest input the curve has evidence for. */
export function curveCapacity(points: readonly CurvePoint[]): bigint {
  return points.length ? points[points.length - 1]!.amountIn : 0n;
}

/**
 * Sort, drop empty or non-monotonic samples. A sample whose output is lower than a smaller sample's output is
 * a stale or broken read; keeping it would let the router believe larger trades get less, then more.
 */
export function normalizeCurve(points: readonly CurvePoint[]): CurvePoint[] {
  const sorted = [...points]
    .filter((p) => p.amountIn > 0n && p.amountOut > 0n)
    .sort((a, b) => (a.amountIn < b.amountIn ? -1 : a.amountIn > b.amountIn ? 1 : 0));
  const out: CurvePoint[] = [];
  for (const p of sorted) {
    const last = out[out.length - 1];
    if (last && p.amountIn === last.amountIn) continue;
    if (last && p.amountOut < last.amountOut) continue;
    out.push(p.gas === undefined ? { amountIn: p.amountIn, amountOut: p.amountOut } : { amountIn: p.amountIn, amountOut: p.amountOut, gas: p.gas });
  }
  return out;
}
