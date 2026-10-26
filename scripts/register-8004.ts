/**
 * Register fisika in the ERC-8004 Identity Registry on Celo mainnet, or point an existing entry at a new file.
 *
 *   IDENTITY_OWNER_KEY=0x…  REGISTRATION_URL=https://api…/.well-known/agent-registration.json  node scripts/register-8004.ts
 *   … AGENT_ID=7 node scripts/register-8004.ts            # setAgentURI for an existing agent
 *   … DRY_RUN=1                                           # simulate only
 *
 * The sending address owns the identity NFT: use a dedicated cold key, not the executor or arb key.
 * Gas is paid in USDC through Celo fee abstraction (adapter address, not the token), so the key needs no CELO.
 * Flow (docs.celo.org/build/agents/8004): publish the file → register → set AGENT_ID on the API → redeploy so the
 * file's `registrations` lists the agentId.
 */
import { createWalletClient, http, parseEventLogs, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { celo } from 'viem/chains';
import { ERC8004, FEE_CURRENCY_ADAPTERS } from '../packages/core/src/addresses.ts';
import { makeClient } from '../packages/core/src/chain/viem.ts';

const identityAbi = [
  { type: 'function', name: 'register', stateMutability: 'nonpayable', inputs: [{ name: 'agentURI', type: 'string' }], outputs: [{ name: 'agentId', type: 'uint256' }] },
  { type: 'function', name: 'setAgentURI', stateMutability: 'nonpayable', inputs: [{ name: 'agentId', type: 'uint256' }, { name: 'newURI', type: 'string' }], outputs: [] },
  {
    type: 'event',
    name: 'Registered',
    inputs: [
      { name: 'agentId', type: 'uint256', indexed: true },
      { name: 'agentURI', type: 'string', indexed: false },
      { name: 'owner', type: 'address', indexed: true },
    ],
  },
] as const;

const key = process.env.IDENTITY_OWNER_KEY as Hex | undefined;
const uri = process.env.REGISTRATION_URL;
if (!key || !uri) throw new Error('IDENTITY_OWNER_KEY and REGISTRATION_URL are required');
if (!uri.startsWith('https://') && !uri.startsWith('ipfs://') && !uri.startsWith('data:')) throw new Error('REGISTRATION_URL must be https://, ipfs:// or data:');

const rpcs = (process.env.CELO_RPC_URLS ?? 'https://forno.celo.org').split(',').map((s) => s.trim());
const pub = makeClient(rpcs);
const account = privateKeyToAccount(key);
const wallet = createWalletClient({ account, chain: celo, transport: http(rpcs[0]) });

// The registry must be able to fetch a valid file before we point at it.
if (uri.startsWith('https://')) {
  const file = (await fetch(uri).then((r) => r.json())) as { type?: string; x402Support?: boolean };
  if (file.type !== 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1') throw new Error(`registration file at ${uri} has the wrong type`);
}

const agentId = process.env.AGENT_ID ? BigInt(process.env.AGENT_ID) : null;
const req = agentId === null
  ? await pub.simulateContract({ account, address: ERC8004.identityRegistry, abi: identityAbi, functionName: 'register', args: [uri] })
  : await pub.simulateContract({ account, address: ERC8004.identityRegistry, abi: identityAbi, functionName: 'setAgentURI', args: [agentId, uri] });
console.log(`owner ${account.address} · ${agentId === null ? 'register' : `setAgentURI(${agentId})`} → ${uri}`);
if (process.env.DRY_RUN) {
  console.log('dry run: simulation succeeded, nothing sent');
  process.exit(0);
}

const hash = await wallet.writeContract({ ...req.request, feeCurrency: FEE_CURRENCY_ADAPTERS.USDC } as Parameters<typeof wallet.writeContract>[0]);
const receipt = await pub.waitForTransactionReceipt({ hash });
if (receipt.status !== 'success') throw new Error(`transaction reverted: ${hash}`);
if (agentId === null) {
  // Read the id from the event, not the return value: another registration can land first.
  const [ev] = parseEventLogs({ abi: identityAbi, logs: receipt.logs, eventName: 'Registered' });
  if (!ev) throw new Error('no Registered event');
  console.log(`registered agentId ${ev.args.agentId} · https://celoscan.io/tx/${hash}`);
  console.log(`next: set AGENT_ID=${ev.args.agentId} on the API, redeploy, then run again with AGENT_ID to refresh the URI if it changed`);
} else {
  console.log(`updated · https://celoscan.io/tx/${hash}`);
}
