import type { Address } from './types.ts';

/**
 * Token registry for Celo mainnet (42220). Keyed by address, never by symbol: Celo has two naira tokens
 * (regulated cNGN and Mento's NGNm), and Mento renamed cUSD/cKES/cGHS to USDm/KESm/GHSm.
 *
 * Sources: docs.celo.org stablecoin contracts page; decimals marked `source: 'textile-docs'` come from the
 * Textile FX address book. `decimals: null` means "not stated by any official source we found": the
 * on-chain check (scripts/verify-onchain.ts) must fill it before the token can be used.
 */
export interface TokenInfo {
  symbol: string;
  legacySymbol?: string;
  address: Address;
  decimals: number | null;
  issuer: string;
  /** ISO currency this token tracks. */
  fiat: string;
  /** True for USD-pegged tokens used as the pricing numeraire. */
  usd: boolean;
  tier: 1 | 2 | 0;
}

const T = (t: TokenInfo): TokenInfo => ({ ...t, address: t.address.toLowerCase() as Address });

export const CELO_TOKENS: readonly TokenInfo[] = [
  T({ symbol: 'USDT', address: '0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e', decimals: 6, issuer: 'Tether', fiat: 'USD', usd: true, tier: 1 }),
  T({ symbol: 'USDC', address: '0xcebA9300f2b948710d2653dD7B07f33A8B32118C', decimals: 6, issuer: 'Circle', fiat: 'USD', usd: true, tier: 1 }),
  T({ symbol: 'USDm', legacySymbol: 'cUSD', address: '0x765DE816845861e75A25fCA122bb6898B8B1282a', decimals: null, issuer: 'Mento', fiat: 'USD', usd: true, tier: 1 }),
  T({ symbol: 'USAT', address: '0xD2ab3C9A02DBBAB236BfEC45D1d755DF4267F771', decimals: null, issuer: 'Anchorage', fiat: 'USD', usd: true, tier: 2 }),
  T({ symbol: 'cNGN', address: '0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f', decimals: 6, issuer: 'Africa Stablecoin Consortium', fiat: 'NGN', usd: false, tier: 1 }),
  T({ symbol: 'NGNm', address: '0xE2702Bd97ee33c88c8f6f92DA3B733608aa76F71', decimals: null, issuer: 'Mento', fiat: 'NGN', usd: false, tier: 2 }),
  T({ symbol: 'KESm', legacySymbol: 'cKES', address: '0x456a3D042C0DbD3db53D5489e98dFb038553B0d0', decimals: null, issuer: 'Mento', fiat: 'KES', usd: false, tier: 2 }),
  T({ symbol: 'GHSm', legacySymbol: 'cGHS', address: '0xfAeA5F3404bbA20D3cc2f8C4B0A888F55a3c7313', decimals: null, issuer: 'Mento', fiat: 'GHS', usd: false, tier: 2 }),
  T({ symbol: 'XOFm', legacySymbol: 'eXOF', address: '0x73F93dcc49cB8A239e2032663e9475dd5ef29A08', decimals: null, issuer: 'Mento', fiat: 'XOF', usd: false, tier: 2 }),
  T({ symbol: 'ZARm', legacySymbol: 'cZAR', address: '0x4c35853A3B4e647fD266f4de678dCc8fEC410BF6', decimals: null, issuer: 'Mento', fiat: 'ZAR', usd: false, tier: 2 }),
  T({ symbol: 'wBRL', address: '0xd76f5faf6888e24d9f04bf92a0c8b921fe4390e0', decimals: 18, issuer: 'Ripio', fiat: 'BRL', usd: false, tier: 1 }),
  T({ symbol: 'wARS', address: '0x0dc4f92879b7670e5f4e4e6e3c801d229129d90d', decimals: 18, issuer: 'Ripio', fiat: 'ARS', usd: false, tier: 1 }),
  T({ symbol: 'BRLm', legacySymbol: 'cREAL', address: '0xe8537a3d056DA446677B9E9d6c5dB704EaAb4787', decimals: null, issuer: 'Mento', fiat: 'BRL', usd: false, tier: 2 }),
  T({ symbol: 'BRLA', address: '0xfecb3f7c54e2caae9dc6ac9060a822d47e053760', decimals: null, issuer: 'BRLA Digital', fiat: 'BRL', usd: false, tier: 2 }),
  T({ symbol: 'COPM', address: '0xC92E8Fc2947E32F2B574CCA9F2F12097A71d5606', decimals: null, issuer: 'Minteo', fiat: 'COP', usd: false, tier: 2 }),
  T({ symbol: 'COPm', address: '0x8A567e2aE79CA692Bd748aB832081C45de4041eA', decimals: null, issuer: 'Mento', fiat: 'COP', usd: false, tier: 2 }),
  T({ symbol: 'EURm', legacySymbol: 'cEUR', address: '0xD8763CBa276a3738E6DE85b4b3bF5FDed6D6cA73', decimals: null, issuer: 'Mento', fiat: 'EUR', usd: false, tier: 2 }),
];

export class TokenRegistry {
  private byAddr = new Map<string, TokenInfo>();

  constructor(tokens: readonly TokenInfo[] = CELO_TOKENS) {
    for (const t of tokens) this.byAddr.set(t.address.toLowerCase(), { ...t });
  }

  get(address: string): TokenInfo | undefined {
    return this.byAddr.get(address.toLowerCase());
  }

  require(address: string): TokenInfo {
    const t = this.get(address);
    if (!t) throw new Error(`unknown token ${address}`);
    return t;
  }

  /** Decimals, refusing to guess. */
  decimals(address: string): number {
    const t = this.require(address);
    if (t.decimals === null) throw new Error(`decimals for ${t.symbol} not verified on-chain yet`);
    return t.decimals;
  }

  /** Resolve a user-typed symbol (current or legacy) to exactly one token. Ambiguity is an error. */
  bySymbol(symbol: string): TokenInfo {
    const s = symbol.trim().toLowerCase();
    const hits = [...this.byAddr.values()].filter(
      (t) => t.symbol.toLowerCase() === s || t.legacySymbol?.toLowerCase() === s,
    );
    if (hits.length !== 1) throw new Error(hits.length ? `ambiguous symbol ${symbol}` : `unknown symbol ${symbol}`);
    return hits[0]!;
  }

  /** Apply on-chain verified decimals. A mismatch with a configured value is fatal: it means a wrong address. */
  applyOnchainDecimals(address: string, onchain: number): void {
    const t = this.require(address);
    if (t.decimals !== null && t.decimals !== onchain) {
      throw new Error(`decimals mismatch for ${t.symbol}: configured ${t.decimals}, on-chain ${onchain}`);
    }
    t.decimals = onchain;
  }

  usable(): TokenInfo[] {
    return [...this.byAddr.values()].filter((t) => t.decimals !== null);
  }

  all(): TokenInfo[] {
    return [...this.byAddr.values()];
  }
}
