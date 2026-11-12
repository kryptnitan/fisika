/**
 * Deploys FisikaExecutor on Celo from the server, signing with the Celo bot wallet (its key stays in live.env).
 *
 *   OWNER=0x… ARB_PRIVATE_KEY=… node src/deploy-executor.ts
 *
 * What it does, in order, stopping at the first failure:
 *   1. Checks the RPC is Celo mainnet and the bot wallet has gas.
 *   2. Checks there is a contract at each of the three venue addresses it will allowlist (the same ones
 *      contracts/script/Deploy.s.sol uses; verified on-chain by scripts/verify-onchain.ts).
 *   3. Deploys the contract from the committed, CI-checked artifact (contracts/artifacts/FisikaExecutor.json),
 *      with the bot wallet as temporary owner and as guardian (the guardian can only pause).
 *   4. Allowlists the venues as call targets and token spenders.
 *   5. Starts the two-step ownership handover to OWNER. The owner must then call acceptOwnership() from their
 *      wallet (the console has a button for it). Until they do, the bot wallet is still the owner.
 *   6. Writes /var/lib/fisika/executor.json and prints the address for setup.sh to put in api.env.
 *
 * Idempotent: if executor.json already names a deployed contract, it reports it and exits 0.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, formatEther, getAddress, http, isAddress, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { celo } from 'viem/chains';

const ABI = [
  { type: 'constructor', inputs: [{ type: 'address', name: 'owner_' }, { type: 'address', name: 'guardian_' }] },
  { type: 'function', name: 'setTarget', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'bool' }], outputs: [] },
  { type: 'function', name: 'setSpender', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'bool' }], outputs: [] },
  { type: 'function', name: 'transferOwnership', stateMutability: 'nonpayable', inputs: [{ type: 'address' }], outputs: [] },
  { type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'pendingOwner', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'guardian', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'allowedTarget', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'allowedSpender', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'bool' }] },
] as const;

// Celo mainnet venues — identical to contracts/script/Deploy.s.sol.
const VENUES: Record<string, Address> = {
  'Uniswap SwapRouter02': '0x5615CDAb10dc425a742d643d949a7F474C01abc4',
  'Mento router': '0x4861840C2EfB2b98312B0aE34d86fD73E8f9B6f6',
  'Mento broker': '0x777A8255cA72412f0d706dc03C9D1987306B4CaD',
};

const out = process.env.EXECUTOR_RECORD ?? '/var/lib/fisika/executor.json';
const artifactPath = process.env.EXECUTOR_ARTIFACT ?? new URL('../../../contracts/artifacts/FisikaExecutor.json', import.meta.url).pathname;
const ownerEnv = process.env.OWNER ?? '';
const key = process.env.ARB_PRIVATE_KEY as Hex | undefined;
const rpc = (process.env.CELO_RPC_URLS ?? 'https://forno.celo.org').split(',')[0]!.trim();

if (!isAddress(ownerEnv)) throw new Error('OWNER must be the owner wallet address (0x…)');
if (!key) throw new Error('ARB_PRIVATE_KEY missing (run via fisika-deploy-executor, which reads live.env)');
const owner = getAddress(ownerEnv);

if (existsSync(out)) {
  const rec = JSON.parse(readFileSync(out, 'utf8')) as { address: Address; chainId: number };
  console.log(`already deployed: ${rec.address} on chain ${rec.chainId} (${out}). Delete that file to deploy again.`);
  console.log(`EXECUTOR_ADDRESS=${rec.address}`);
  process.exit(0);
}

const artifact = JSON.parse(readFileSync(artifactPath, 'utf8')) as { bytecode: { object: Hex } };
const bytecode = artifact.bytecode.object;
if (!bytecode?.startsWith('0x') || bytecode.length < 1000) throw new Error(`no bytecode in ${artifactPath}`);

const account = privateKeyToAccount(key);
const pub = createPublicClient({ chain: celo, transport: http(rpc) });
const wallet = createWalletClient({ account, chain: celo, transport: http(rpc) });

const chainId = await pub.getChainId();
if (chainId !== 42220) throw new Error(`RPC ${rpc} is chain ${chainId}, not Celo mainnet (42220)`);
const bal = await pub.getBalance({ address: account.address });
console.log(`deployer (bot wallet) ${account.address} · ${formatEther(bal)} CELO · rpc ${rpc}`);
if (bal < 10n ** 18n) throw new Error('the bot wallet needs at least 1 CELO for deployment gas');

for (const [name, addr] of Object.entries(VENUES)) {
  const code = await pub.getCode({ address: addr });
  if (!code || code === '0x') throw new Error(`no contract at ${name} ${addr}; refusing to allowlist`);
  console.log(`venue ok: ${name} ${addr} (${(code.length - 2) / 2} bytes)`);
}

const send = async (label: string, fn: () => Promise<Hex>) => {
  const hash = await fn();
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(`${label} reverted: ${hash}`);
  console.log(`${label}: ${hash}`);
  return r;
};

const deployHash = await wallet.deployContract({ abi: ABI, bytecode, args: [account.address, account.address] });
const deployed = await pub.waitForTransactionReceipt({ hash: deployHash });
if (deployed.status !== 'success' || !deployed.contractAddress) throw new Error(`deployment reverted: ${deployHash}`);
const address = getAddress(deployed.contractAddress);
console.log(`FisikaExecutor deployed at ${address} (tx ${deployHash}, gas ${deployed.gasUsed})`);

for (const [name, v] of Object.entries(VENUES)) {
  await send(`allow target ${name}`, () => wallet.writeContract({ address, abi: ABI, functionName: 'setTarget', args: [v, true] }));
  await send(`allow spender ${name}`, () => wallet.writeContract({ address, abi: ABI, functionName: 'setSpender', args: [v, true] }));
}
await send(`transfer ownership to ${owner}`, () => wallet.writeContract({ address, abi: ABI, functionName: 'transferOwnership', args: [owner] }));

// Read back what the chain says, not what we think we did.
const [onOwner, pending, guardian] = await Promise.all([
  pub.readContract({ address, abi: ABI, functionName: 'owner' }),
  pub.readContract({ address, abi: ABI, functionName: 'pendingOwner' }),
  pub.readContract({ address, abi: ABI, functionName: 'guardian' }),
]);
for (const v of Object.values(VENUES)) {
  const [t, s] = await Promise.all([pub.readContract({ address, abi: ABI, functionName: 'allowedTarget', args: [v] }), pub.readContract({ address, abi: ABI, functionName: 'allowedSpender', args: [v] })]);
  if (!t || !s) throw new Error(`allowlist check failed for ${v}`);
}
if (getAddress(pending) !== owner) throw new Error(`pendingOwner is ${pending}, expected ${owner}`);

const record = { chainId, address, deployTx: deployHash, deployer: account.address, owner: onOwner, pendingOwner: pending, guardian, venues: VENUES, at: new Date().toISOString() };
writeFileSync(out, JSON.stringify(record, null, 2));
console.log(JSON.stringify(record, null, 2));
console.log(`\nNext: the owner ${owner} accepts ownership from their wallet (console → Fee contract → Accept ownership).`);
console.log(`EXECUTOR_ADDRESS=${address}`);
