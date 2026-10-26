import { ERC8004 } from '@fisika/core';
import type { ApiConfig } from './config.ts';

/**
 * ERC-8004 registration file (docs.celo.org/build/agents/8004). Served at /.well-known/agent-registration.json and
 * referenced by the Identity Registry entry. `registrations` can only list the agentId after registering, so the
 * flow is: publish, register, set AGENT_ID, redeploy.
 */
export function registrationFile(cfg: ApiConfig) {
  return {
    type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
    name: cfg.agent.name,
    description:
      'fisika is a best-execution stablecoin FX desk on Celo. It routes any pair of Celo stablecoins (USD, NGN, KES, GHS, XOF, ZAR, BRL, ARS, COP, EUR) across Mento, Uniswap v3 and Textile FX, splitting orders and taking multi-hop paths for the best net rate after gas and fees. Quotes and ready-to-sign, non-custodial swap transactions are sold per call over x402 (USDC on Celo).',
    image: cfg.agent.image,
    services: [
      { name: 'web', endpoint: cfg.webUrl },
      { name: 'fx-api', endpoint: `${cfg.publicUrl}/v1`, version: '1' },
      { name: 'openapi', endpoint: `${cfg.publicUrl}/openapi.json` },
      ...(cfg.agent.wallet ? [{ name: 'agentWallet', endpoint: `eip155:42220:${cfg.agent.wallet}` }] : []),
    ],
    x402Support: true,
    active: true,
    registrations: cfg.agent.id ? [{ agentId: Number(cfg.agent.id), agentRegistry: `eip155:42220:${ERC8004.identityRegistry}` }] : [],
    supportedTrust: ['reputation'],
  };
}
