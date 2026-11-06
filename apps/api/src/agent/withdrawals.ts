/**
 * Withdrawals from the bot wallet, done by the only process that holds its key: the live trader.
 *
 * The console (API) never signs anything. It pauses the chain and drops a request file into that chain's data
 * directory: which token, how much. The trader picks requests up at the start of a tick, which is always between
 * trades, so an in-flight loop has finished by then. It sends to WITHDRAW_ADDRESS from its OWN environment; a request
 * cannot name a destination, so a compromised website or API can at worst move funds to the owner.
 *
 * A request is sent at most once: it is marked "sending" before the transaction goes out, and a request found still
 * "sending" after a restart is marked failed for a person to check on the explorer, never retried blindly.
 */
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { erc20Abi, formatUnits, parseUnits, type Hex } from 'viem';
import type { Address, TokenRegistry } from '@fisika/core';
import { chainTrades, logEvent, readControl, setControl } from './control.ts';

export interface WithdrawRequest {
  id: string;
  chain: string;
  /** Token symbol, or 'native' for the gas token (CELO, BNB). */
  token: string;
  /** Decimal amount in token units, or 'max'. */
  amount: string;
  requestedAt: string;
  by: string;
  status: 'requested' | 'sending' | 'sent' | 'failed';
  to?: string;
  sentAmount?: string;
  txHash?: string;
  error?: string;
  doneAt?: string;
}

export const withdrawDir = (dataDir: string) => `${dataDir}/withdrawals`;
const idOk = (id: string) => /^w_[0-9a-z-]{8,64}$/.test(id);

export async function saveRequest(dir: string, r: WithdrawRequest): Promise<void> {
  if (!idOk(r.id)) throw new Error('bad withdrawal id');
  await mkdir(dir, { recursive: true });
  const tmp = `${dir}/.${r.id}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(r, null, 2));
  await rename(tmp, `${dir}/${r.id}.json`);
}

export async function readRequest(dir: string, id: string): Promise<WithdrawRequest | null> {
  if (!idOk(id)) return null;
  try {
    return JSON.parse(await readFile(`${dir}/${id}.json`, 'utf8')) as WithdrawRequest;
  } catch {
    return null;
  }
}

export async function listRequests(dir: string): Promise<WithdrawRequest[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const out: WithdrawRequest[] = [];
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    const r = await readRequest(dir, n.slice(0, -5));
    if (r) out.push(r);
  }
  return out.sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
}

export interface WithdrawContext {
  chainKey: string;
  pub: { getBalance(a: { address: Address }): Promise<bigint>; readContract(a: unknown): Promise<unknown>; waitForTransactionReceipt(a: { hash: Hex; timeout?: number }): Promise<{ status: string }>; getGasPrice(): Promise<bigint> };
  wallet: { sendTransaction(a: unknown): Promise<Hex>; writeContract(a: unknown): Promise<Hex>; account?: unknown; chain?: unknown };
  account: Address;
  tokens: TokenRegistry;
  nativeSymbol: string;
  /** Owner address from the trader's own environment. No address, no withdrawals. */
  withdrawTo: Address | null;
  /** Gas token kept back on "Max" so the wallet can still pay for transactions. */
  nativeReserve: bigint;
  dir: string;
  controlFile: string;
  eventsFile: string;
}

/** Process every pending request. Called by the trader only when no trade is in flight. */
export async function processWithdrawals(c: WithdrawContext): Promise<WithdrawRequest[]> {
  const done: WithdrawRequest[] = [];
  for (const r of await listRequests(c.dir)) {
    if (r.chain !== c.chainKey) continue;
    if (r.status === 'sending') {
      // Interrupted after it may have been broadcast: never send twice.
      done.push(await finish(c, r, 'failed', { error: 'interrupted while sending; check the wallet on the explorer before requesting again' }));
      continue;
    }
    if (r.status !== 'requested') continue;
    done.push(await sendOne(c, r));
  }
  return done;
}

async function finish(c: WithdrawContext, r: WithdrawRequest, status: 'sent' | 'failed', extra: Partial<WithdrawRequest>): Promise<WithdrawRequest> {
  const next: WithdrawRequest = { ...r, ...extra, status, doneAt: new Date().toISOString() };
  await saveRequest(c.dir, next);
  await logEvent(c.eventsFile, {
    type: status === 'sent' ? 'withdraw_sent' : 'withdraw_failed',
    chain: c.chainKey,
    id: r.id,
    token: r.token === 'native' ? c.nativeSymbol : r.token,
    amount: next.sentAmount ?? r.amount,
    txHash: next.txHash,
    note: next.error,
    by: r.by,
  });
  console.log(`[withdraw] ${status} ${r.id} ${next.sentAmount ?? r.amount} ${r.token}${next.txHash ? ` tx ${next.txHash}` : ''}${next.error ? ` · ${next.error}` : ''}`);
  return next;
}

async function sendOne(c: WithdrawContext, r: WithdrawRequest): Promise<WithdrawRequest> {
  if (!c.withdrawTo) return finish(c, r, 'failed', { error: 'WITHDRAW_ADDRESS is not set for this trader' });
  // Belt and braces: the console pauses the chain first; make sure it stays paused while funds leave.
  if (chainTrades(await readControl(c.controlFile), c.chainKey)) await setControl(c.controlFile, c.chainKey as 'celo' | 'bsc', false, 'withdrawal', c.eventsFile);

  const native = r.token === 'native';
  let t: ReturnType<TokenRegistry['bySymbol']> | null = null;
  if (!native) {
    try {
      t = c.tokens.bySymbol(r.token);
    } catch {
      t = null;
    }
  }
  if (!native && (!t || t.decimals === null)) return finish(c, r, 'failed', { error: `unknown token ${r.token}` });
  const decimals = native ? 18 : t!.decimals!;
  const bal = native ? await c.pub.getBalance({ address: c.account }) : ((await c.pub.readContract({ address: t!.address, abi: erc20Abi, functionName: 'balanceOf', args: [c.account] })) as bigint);

  let amount: bigint;
  if (r.amount === 'max') {
    if (native) {
      const gas = (await c.pub.getGasPrice()) * 21_000n * 2n;
      amount = bal - c.nativeReserve - gas;
    } else amount = bal;
  } else {
    try {
      amount = parseUnits(r.amount, decimals);
    } catch {
      return finish(c, r, 'failed', { error: 'amount is not a number' });
    }
  }
  if (amount <= 0n) return finish(c, r, 'failed', { error: native ? `nothing to send after keeping the gas reserve (${formatUnits(c.nativeReserve, 18)} ${c.nativeSymbol})` : 'balance is zero' });
  if (amount > bal) return finish(c, r, 'failed', { error: `amount ${formatUnits(amount, decimals)} is more than the balance ${formatUnits(bal, decimals)}` });

  await saveRequest(c.dir, { ...r, status: 'sending', to: c.withdrawTo });
  let hash: Hex;
  try {
    hash = native
      ? await c.wallet.sendTransaction({ account: c.wallet.account, chain: c.wallet.chain, to: c.withdrawTo, value: amount })
      : await c.wallet.writeContract({ account: c.wallet.account, chain: c.wallet.chain, address: t!.address, abi: erc20Abi, functionName: 'transfer', args: [c.withdrawTo, amount] });
  } catch (e) {
    // Nothing was broadcast (the wallet simulates before sending).
    return finish(c, r, 'failed', { to: c.withdrawTo, error: `not sent: ${(e as { shortMessage?: string }).shortMessage ?? (e as Error).message.split('\n')[0]}` });
  }
  const rec = await c.pub.waitForTransactionReceipt({ hash, timeout: 120_000 }).catch(() => null);
  if (!rec) return finish(c, r, 'failed', { to: c.withdrawTo, txHash: hash, error: 'sent but no receipt within 2 minutes; check the explorer' });
  if (rec.status !== 'success') return finish(c, r, 'failed', { to: c.withdrawTo, txHash: hash, error: 'transaction reverted' });
  return finish(c, r, 'sent', { to: c.withdrawTo, txHash: hash, sentAmount: formatUnits(amount, decimals) });
}
