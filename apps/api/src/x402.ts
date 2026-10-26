import { CELO_TOKENS, X402 } from '@fisika/core';
import { HTTPFacilitatorClient, type RoutesConfig } from '@x402/core/server';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { paymentMiddleware, x402ResourceServer } from '@x402/hono';
import type { MiddlewareHandler } from 'hono';
import type { ApiConfig } from './config.ts';

const USDC = CELO_TOKENS.find((t) => t.symbol === 'USDC')!.address;

/**
 * x402 payment gate for the paid routes, settled by Celo's hosted facilitator (docs.celo.org/build/agents/x402).
 * Accepts USDC on Celo. USDT is also settled by that facilitator, but its EIP-712 domain (name/version) must be
 * read on-chain before it can be offered; until then only USDC is advertised.
 *
 * When the facilitator key or payout address is missing, paid routes answer 503 rather than serving for free.
 */
export function makePaymentGate(cfg: ApiConfig): { gate: MiddlewareHandler; server: x402ResourceServer | null } {
  const { apiKey, payTo, facilitatorUrl } = cfg.x402;
  if (!apiKey || !payTo) {
    const gate: MiddlewareHandler = async (c) => c.json({ error: 'paid endpoints are not configured on this server (X402_API_KEY / X402_PAY_TO)' }, 503);
    return { gate, server: null };
  }
  const facilitator = new HTTPFacilitatorClient({
    url: facilitatorUrl,
    createAuthHeaders: async () => {
      const h = { 'X-API-Key': apiKey };
      return { verify: h, settle: h, supported: h };
    },
  });
  const server = new x402ResourceServer(facilitator).register(X402.network, new ExactEvmScheme());
  const accepts = (amount: string) => ({
    scheme: 'exact',
    network: X402.network,
    payTo,
    price: { amount, asset: USDC, extra: { name: 'USDC', version: '2' } },
  });
  const routes = {
    'POST /v1/quote': {
      accepts: accepts(cfg.x402.quotePriceAtomic),
      description:
        'Best-execution quote for any Celo stablecoin pair (USD, NGN, KES, GHS, XOF, ZAR, BRL, ARS, COP, EUR): split and multi-hop across Mento, Uniswap v3 and Textile FX, net of fees and gas.',
      mimeType: 'application/json',
    },
    'POST /v1/build': {
      accepts: accepts(cfg.x402.buildPriceAtomic),
      description: 'Unsigned, non-custodial swap transactions for a quote: approve + one atomic executor call from your own wallet.',
      mimeType: 'application/json',
    },
  } as unknown as RoutesConfig;
  return { gate: paymentMiddleware(routes, server) as unknown as MiddlewareHandler, server };
}
