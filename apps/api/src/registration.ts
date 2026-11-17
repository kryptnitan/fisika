import { ERC8004 } from '@fisika/core';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ApiConfig } from './config.ts';

/** Where the console's registration flow records the agentId (AGENT_ID in the env still wins when set). */
export const agentIdFile = () => process.env.AGENT_ID_FILE ?? `${dirname(process.env.CONTROL_FILE ?? '/var/lib/fisika/control.json')}/agent-id.json`;

export function storedAgentId(): { agentId: string; owner: string; txHash: string; at: string } | null {
  try {
    return JSON.parse(readFileSync(agentIdFile(), 'utf8'));
  } catch {
    return null;
  }
}

export function currentAgentId(cfg: ApiConfig): string | null {
  return cfg.agent.id ?? storedAgentId()?.agentId ?? null;
}

/**
 * ERC-8004 registration file (docs.celo.org/build/agents/8004). Served at /.well-known/agent-registration.json and
 * referenced by the Identity Registry entry. `registrations` can only list the agentId after registering: the console's
 * Register button has the owner sign register(uri), then records the id here (no redeploy needed).
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
      ...(cfg.agent.wallet ?? storedAgentId()?.owner ? [{ name: 'agentWallet', endpoint: `eip155:42220:${cfg.agent.wallet ?? storedAgentId()?.owner}` }] : []),
    ],
    x402Support: true,
    active: true,
    registrations: currentAgentId(cfg) ? [{ agentId: Number(currentAgentId(cfg)), agentRegistry: `eip155:42220:${ERC8004.identityRegistry}` }] : [],
    supportedTrust: ['reputation'],
  };
}
