export type Address = `0x${string}`;

export type VenueId = 'mento' | 'uniswap-v3' | 'textile';

/** One sampled point of a liquidity curve, in atomic units. amountOut is net of the venue fee. */
export interface CurvePoint {
  amountIn: bigint;
  amountOut: bigint;
}

/** A directed, size-aware edge in the price graph: "venue X turns tokenIn into tokenOut along this curve". */
export interface Edge {
  venue: VenueId;
  /** Pool address, exchange id, or a venue-level id such as 'textile-rfq'. */
  poolId: string;
  tokenIn: Address;
  tokenOut: Address;
  /** Ascending by amountIn. Output between points is interpolated linearly (conservative for concave curves). */
  points: CurvePoint[];
  /** Gas for this hop only, excluding transaction base cost. */
  gasUnits: bigint;
  feeBps: number;
  /** true = executable at this price for the current block; false = indicative (Textile ladder). */
  firm: boolean;
  asOfMs: number;
  asOfBlock?: bigint;
  meta?: Record<string, string | number | boolean>;
}

export interface Quote {
  amountOut: bigint;
  gasEstimate: bigint;
  /** Unix ms after which this quote must not be used. */
  expiry: number;
  firm: boolean;
  feeBps: number;
  source: string;
}

export interface EdgeContext {
  nowMs: number;
  /** Token amounts (atomic) to sample for a given input token, e.g. the $10/$100/$1k/$10k equivalents. */
  sampleAmounts(token: Address): bigint[] | null;
}

export interface VenueAdapter {
  readonly id: VenueId;
  /** Produce fresh edges for every pair this venue serves. Must not throw for a single bad pool. */
  fetchEdges(ctx: EdgeContext): Promise<Edge[]>;
  /** Point quote at an exact size. Returns null when the venue cannot fill it. */
  quote(tokenIn: Address, tokenOut: Address, amountIn: bigint): Promise<Quote | null>;
}
