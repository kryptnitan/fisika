'use client';

type Eip1193 = { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> };

declare global {
  interface Window {
    ethereum?: Eip1193;
  }
}

import { currentChain } from './chain';

/** Connect and make sure the wallet is on the chain selected in the dashboard. */
export async function connect(): Promise<string> {
  const c = currentChain();
  const eth = window.ethereum;
  if (!eth) throw new Error('No wallet found. Open fisika in MiniPay, Valora or a browser with an EVM wallet.');
  const [account] = (await eth.request({ method: 'eth_requestAccounts' })) as string[];
  if (!account) throw new Error('The wallet returned no account.');
  const chain = (await eth.request({ method: 'eth_chainId' })) as string;
  if (chain.toLowerCase() !== c.chainIdHex) {
    try {
      await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: c.chainIdHex }] });
    } catch {
      await eth.request({
        method: 'wallet_addEthereumChain',
        params: [{ chainId: c.chainIdHex, chainName: c.name, nativeCurrency: { name: c.nativeSymbol, symbol: c.nativeSymbol, decimals: 18 }, rpcUrls: [c.rpc], blockExplorerUrls: [c.explorer] }],
      });
    }
    const now = (await eth.request({ method: 'eth_chainId' })) as string;
    if (now.toLowerCase() !== c.chainIdHex) throw new Error(`Switch your wallet to ${c.name} to swap here.`);
  }
  return account.toLowerCase();
}

export async function sendTx(from: string, tx: { to: string; data: string; value: string }): Promise<string> {
  const eth = window.ethereum;
  if (!eth) throw new Error('No wallet found.');
  return (await eth.request({ method: 'eth_sendTransaction', params: [{ from, to: tx.to, data: tx.data, value: `0x${BigInt(tx.value).toString(16)}` }] })) as string;
}

export async function waitForTx(hash: string, timeoutMs = 90_000): Promise<'success' | 'reverted'> {
  const eth = window.ethereum;
  if (!eth) throw new Error('No wallet found.');
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const r = (await eth.request({ method: 'eth_getTransactionReceipt', params: [hash] })) as { status?: string } | null;
    if (r?.status) return r.status === '0x1' ? 'success' : 'reverted';
    await new Promise((res) => setTimeout(res, 1500));
  }
  throw new Error(`The transaction was not mined within 90 seconds. Check it on ${currentChain().explorer.replace('https://', '')}.`);
}
