# RATEWISE — Deliverable 1: Research Report

*Celo mainnet (chain 42220) · researched 26 Oct 2026*

Every address in this report was taken from an official source (docs.celo.org, docs.uniswap.org, docs.mento.org, docs.textilecredit.com), and the source is named beside it. Nothing here has been checked on-chain yet. My sandbox's network policy blocks Celo RPC endpoints (`forno.celo.org` was refused), so `eth_getCode`, `decimals()`, pool reserves and fee tiers are listed in §9 as **must-verify-on-chain**. That is the first job of deliverable 3, run against your RPC.

---

## 1. What changes from the brief

These findings change the design, so they come first.

1. **Mento renamed its tokens.** cUSD is now **USDm**, cKES is **KESm**, cGHS is **GHSm**, cREAL is **BRLm**, and cEUR is **EURm**. The contract addresses did not change.

2. **"cNGN" refers to two different tokens on Celo.**
   - **cNGN** is the regulated naira issued by WrappedCBDC / Africa Stablecoin Consortium. It has 6 decimals, address `0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f`, and trades on Textile.
   - **NGNm** is Mento's naira at `0xE2702Bd97ee33c88c8f6f92DA3B733608aa76F71`.
   - I found no venue that swaps one directly into the other. Both connect to the rest of the graph only through USD.
   - The token registry must key on address, never on symbol.

3. **Local-currency liquidity is very thin.** Celo supply per DefiLlama:

   | Token | Supply on Celo |
   |---|---|
   | KESm | ~$68k |
   | NGNm | ~$21k |
   | GHSm | ~$23k |
   | COPm | ~$32k |

   The deep liquidity is in USD stables: USDT ~$84m, USDC ~$15.5m, USDm ~$13.4m. Among non-USD tokens, **wBRL, wARS and cNGN** have real flow, mainly through Textile and Uniswap.

4. **The example cycle `USDT → cNGN → cKES → USDT` has no venue for its middle edge.** No pool or RFQ market for cNGN↔KESm exists. The cycles that do exist are listed in §7.

5. **Textile firm quotes are bound to a taker address and lock maker inventory.** They cannot feed a price graph. The graph has to use Textile's public ladder (`/v2/rfq/levels`) and only request a firm quote at execution time. Atomic multi-venue execution through our executor contract also needs a **hand-issued aggregator key**. §5 covers the request.

6. **x402 on Celo is live.** Celo Core Co. runs a hosted facilitator that settles USDC and USDT. Coinbase's discovery catalog only lists Base and Solana resources, though. To appear there, we would also need to accept Base USDC.

---

## 2. Tokens (verified addresses, decimals where a source states them)

Addresses come from the [Celo stablecoin contracts page](https://docs.celo.org/build/tools/contracts/stablecoin-contracts.md). Where a decimals value is given, it comes from the [Textile address book](https://docs.textilecredit.com/protocol/address-book).

| Token | Issuer | Address | Decimals | Notes |
|---|---|---|---|---|
| USD₮ | Tether | `0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e` | 6 | Hub asset for every Textile corridor |
| USDC | Circle | `0xcebA9300f2b948710d2653dD7B07f33A8B32118C` | 6 | x402 payment asset |
| USA₮ | Anchorage | `0xD2ab3C9A02DBBAB236BfEC45D1d755DF4267F771` | verify | Uniswap USDT/USAT ~$144k |
| USDm (ex-cUSD) | Mento | `0x765DE816845861e75A25fCA122bb6898B8B1282a` | verify | Mento v3 hub |
| cNGN | Africa Stablecoin Consortium | `0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f` | 6 | Regulated naira (Textile) |
| NGNm | Mento | `0xE2702Bd97ee33c88c8f6f92DA3B733608aa76F71` | verify | Mento naira, ~$21k supply |
| KESm (ex-cKES) | Mento | `0x456a3D042C0DbD3db53D5489e98dFb038553B0d0` | verify | ~$68k supply |
| GHSm (ex-cGHS) | Mento | `0xfAeA5F3404bbA20D3cc2f8C4B0A888F55a3c7313` | verify | ~$23k supply |
| XOFm | Mento | `0x73F93dcc49cB8A239e2032663e9475dd5ef29A08` | verify | CFA franc |
| ZARm | Mento | `0x4c35853A3B4e647fD266f4de678dCc8fEC410BF6` | verify | |
| wBRL | Ripio | `0xd76f5faf6888e24d9f04bf92a0c8b921fe4390e0` | 18 | Most active LatAm corridor |
| wARS | Ripio | `0x0dc4f92879b7670e5f4e4e6e3c801d229129d90d` | 18 | |
| BRLm (ex-cREAL) | Mento | `0xe8537a3d056DA446677B9E9d6c5dB704EaAb4787` | verify | |
| BRLA | BRLA Digital | `0xfecb3f7c54e2caae9dc6ac9060a822d47e053760` | verify | DefiLlama shows $43m, which looks inflated. Check on-chain |
| COPM | Minteo | `0xC92E8Fc2947E32F2B574CCA9F2F12097A71d5606` | verify | Different from Mento's COPm |
| wMXN / wCOP / wCLP / wPEN | Ripio | see Celo docs | verify | No venue found yet |
| IDRX | IDRX | `0x18Bc5bcC660cf2B9cE3cd51a404aFe1a0cBD3C22` | 2 | On Textile, outside our corridor focus |

**Decimals rule for the code.** The token registry reads `decimals()` on-chain at startup and refuses to start if the value differs from the configured one. This catches the 2-, 6- and 18-decimal mix above.

---

## 3. Venues

### 3.1 Mento (v3 + v2)

Addresses below are from [docs.mento.org deployments](https://docs.mento.org/mento-v3/build/deployments/addresses).

| Contract | Address |
|---|---|
| Router (v3) | `0x4861840C2EfB2b98312B0aE34d86fD73E8f9B6f6` |
| FPMMFactory | `0xa849b475FE5a4B5C9C3280152c7a1945b907613b` |
| VirtualPoolFactory | `0x22abd4ADF6aab38aC1022352d496A07Acee5aCB3` |
| FactoryRegistry | `0x7b2f7d11eabD576782f77bF2CcA46a853410AdF6` |
| OracleAdapter | `0xa472fBBF4b890A54381977ac392BdF82EeC4383a` |
| MarketHoursBreaker | `0x0A18B8e7338eF8d6025529257aA5CCd5A14e0DAF` |
| BreakerBox (shared) | `0x303ED1df62Fa067659B586EbEe8De0EcE824Ab39` |
| SortedOracles (shared) | `0xefb84935239dacdecf7c5ba76d8de40b077b7b33` |
| Broker (v2) | `0x777A8255cA72412f0d706dc03C9D1987306B4CaD` |
| BiPoolManager (v2) | `0x22d9db95E6Ae61c104A7B6F6C78D7993B94ec901` |

**FPMM pools live on Celo:**

| Pool | Address |
|---|---|
| USDT/USDm | `0x0FEBa760d93423D127DE1B6ABECdB60E5253228D` |
| USDC/USDm | `0x462fe04b4FD719Cbd04C0310365D421D02AaA19E` |
| axlUSDC/USDm | `0xb285d4C7133d6f27BfB29224fb0D22E7EC3ddD2D` |
| GBPm/USDm | `0x8C0014afe032E4574481D8934504100bF23fCB56` |

**How pricing works.** FPMMs price at the oracle FX rate plus a fee. When oracles pause, for example on weekends, they fall back to AMM-like behaviour. The `MarketHoursBreaker` exists for this. Trading limits and circuit breakers can make a pair untradable at any moment, so the adapter must call the SDK's `mento.trading` status check before quoting it as firm.

**Where KESm, NGNm and GHSm actually trade is not settled.** No FPMM pool for them is listed. They most likely trade through v2 exchanges exposed via virtual pools, but the docs list only the factory, not individual virtual pools. The SDK's `mento.routes` service will tell us on a fork.

**Size.** Mento v3 holds about $0.51m TVL on Celo. Volume is about $46k per 24h, and fees about $9 per 24h, which implies an effective fee near 2 bps (DefiLlama).

**SDK.** `@mento-protocol/mento-sdk` (v3), with the services `quotes`, `routes`, `swap`, `trading` and `pools`. We use it for discovery and quoting. The executor contract calls the Router directly.

### 3.2 Uniswap

Addresses are from [Uniswap's Celo deployments](https://docs.uniswap.org/contracts/v3/reference/deployments/celo-deployments) and [docs.celo.org](https://docs.celo.org/tooling/contracts/uniswap-contracts.md).

| Contract | Address |
|---|---|
| UniswapV3Factory | `0xAfE208a311B21f13EF87E33A90049fC17A7acDEc` |
| QuoterV2 | `0x82825d0554fA07f7FC52Ab63c961F330fdEFa8E8` |
| SwapRouter02 | `0x5615CDAb10dc425a742d643d949a7F474C01abc4` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |
| v4 PoolManager | `0x288dc841A52FCA2707c6947B3A777c5E56cd87BC` |

**v4 is deployed too.** Whether any stablecoin v4 pools matter needs checking. If they do, v4 becomes a phase-2 adapter.

**Celo quirk.** CELO is both the native coin and an ERC-20 at `0x471E…a438`. The Universal Router's WRAP/UNWRAP commands revert on Celo. This does not affect stable-to-stable routing.

**Relevant v3 pools.** Figures are from [DexPaprika](https://dexpaprika.com/celo/uniswap_v3), which does not show fee tiers. Pool addresses and fee tiers must be enumerated on-chain via `factory.getPool` across the 100, 500, 3000 and 10000 tiers.

| Pair | Liquidity | 24h volume |
|---|---|---|
| USDT/USDm | ~$644k | ~$74k |
| USDT/USDC | ~$188k | ~$313k |
| USDT/"cNGN" (two pools) | ~$181k and ~$66k | Tiny |
| USDT/wBRL | ~$28k | ~$143k (very active for its size) |
| USDT/wARS | ~$107k | ~$1k |
| USDT/USAT | ~$144k | not noted |
| USDT/BRLA | ~$31k | not noted |
| USDT/cGHS | ~$21k | not noted |
| USDT/COPM | ~$24k | not noted |
| cKES/USDT | ~$11k | not noted |
| cKES/USDm | <$1k | not noted |

DexPaprika uses legacy symbols such as "cKES" and "cGHS". Whether each of the two "cNGN" pools holds the regulated cNGN or Mento's NGNm can only be settled on-chain.

### 3.3 Textile FX (RFQ)

Sources: [docs](https://docs.textilecredit.com/), [RFQ endpoints](https://docs.textilecredit.com/api/v2/rfq), [aggregators](https://docs.textilecredit.com/api/v2/aggregators.html), [auth](https://docs.textilecredit.com/api/v2/authentication), [limits](https://docs.textilecredit.com/api/v2/errors.html), [address book](https://docs.textilecredit.com/protocol/address-book).

**What it is.** Independent market makers ("fillers") quote firm prices for the exact size requested. The trade settles in one transaction on Textile's own deployment of the UniswapX LimitOrderReactor. No AMM is involved.

**Celo corridors.** cNGN↔USDT, USDC↔USDT, wARS↔USDT, wBRL↔USDT and IDRX↔USDT. Every corridor is quoted against USDT.

**Celo contracts:**

| Contract | Address |
|---|---|
| LimitOrderReactor | `0xa9AA0a64769cBed4d3B1Ceb4Df01CdE915C235b3` |
| Fee controller | `0x7b005466F905DD882A959888154587fA76cd3Ea7` (1 bps taker fee) |
| Permit2 | canonical |

**Taker flow (v2 API, base URL `https://api.textilecredit.com`):**

1. `POST /v2/rfq/preview` returns an indicative price. It needs no taker, signature or key, and reserves nothing.
2. `POST /v2/rfq/request` returns a firm quote. It **blocks up to ~750 ms typical and up to ~70 s on a cold corridor**, so the client timeout should be 75 s. The request names `taker` and takes either `sellAmount` or `buyAmount`. The response includes:
   - `takerPays`, `buyAmount`, `feeAmount` and `expiresAt` (at most 60 s away)
   - `orderDeadline`
   - the `spender` to approve
   - ready-made `transactions.approval` and `transactions.swap`

   Always broadcast `transactions.swap`, because it bundles every maker slice. A `no_quote` comes back as HTTP 200, not as an error.
3. Approve `takerPays` to the spender and wait for the approval to confirm. Then send the swap from `taker` before `expiresAt`.
4. `POST /v2/rfq/{id}/submit` with the tx hash. This step is optional, because fills are indexed on-chain anyway.

**Constraints that shape the design:**

- **A quote is executable only by the `taker` it names.** If the end user's wallet is the taker, our contract cannot fill the quote. If our contract is the taker, we need the `rfq:aggregator` scope (§5).
- **Proof of funds.** Without the aggregator scope, the taker must already hold the sell token at quote time.
- **Request limits.** At most **4 outstanding firm RFQs** per key or IP, and **60 requests per minute**. A slot stays held until the signed order's deadline, even if we cancel. Aggregator keys raise the outstanding cap to 32.
- **Price discovery.** `GET /v2/rfq/levels?chainId=42220` is public and keyless. It returns min and max size plus up to 9 indicative points per direction, fee-inclusive, cached for about 2 s. **This is the Textile edge source for the graph.** `GET /tickers` and `/historical_trades` are useful for the dashboard and for scoring realized fills.
- **Keyless callers** sign an EIP-712 `TakerControl` proof, which is valid for about 12 hours. A self-serve live key (app → profile menu → API keys) removes that step.

### 3.4 Other venues

I could not verify meaningful stablecoin liquidity on Ubeswap, Velodrome, Curve or Carbon on Celo from official sources. They are left out of v1. The adapter interface lets them be added later without changes elsewhere.

---

## 4. Chain facts that feed the profit math

- **Blocks.** 1 second block time, 30M gas limit, EIP-1559 base-fee floor of **25 gwei** ([Celo deployments spec](https://docs.celo.org/specs/deployments.md)). A 250k-gas swap at the floor costs about 0.006 CELO, which is well under $0.01 at recent CELO prices. **Gas is negligible next to spread and fees on this chain.** It is still modelled per leg.
- **Fee abstraction (CIP-64).** Gas can be paid in USDC or USDT by passing the adapter address, not the token address. The USDC adapter is `0x2F25deB3848C207fc8E0c34035B3Ba7fC157602B` ([Celo ERC-8004 page](https://docs.celo.org/build/agents/8004.md)). For the USDT adapter I have only a third-party source (`0x0e2a3e05…6f72`), so it must be checked against Celo's fee-currencies page before use.
- **Executor wallets.** These will pay gas in USDT, so they need no CELO inventory.

---

## 5. Textile access — exactly what to request

**Two tiers:**

1. **Now, self-serve.** Create a **live partner key** in the Textile app: connect a wallet, open the profile menu, choose **API keys**. This unlocks non-atomic Textile legs where the taker is an EOA we control:
   - arb wallet trades
   - a client's own wallet when the client signs the swap themselves
2. **For atomic multi-venue routes.** Email **contact@textilecredit.com** or Telegram **t.me/textileprotocol** with the request below.

> We're building RATEWISE, a best-execution stablecoin FX router and agent API on Celo (42220). We'd like an **aggregator key with the `rfq:aggregator` scope** so our executor contract can be the RFQ `taker` and fill Textile quotes inside multi-venue transactions alongside Mento and Uniswap.
>
> - Taker contract: `<executor address, after deployment>`
> - Corridors: cNGN↔USDT, wBRL↔USDT, wARS↔USDT, USDC↔USDT
> - Expected volume: `<your estimate>`
> - We'd also like:
>   - a rate-limit tier above 60/min
>   - webhooks to `<url>`
>   - written confirmation that showing your `/rfq/levels` and `/preview` prices to our paid API clients, and routing their flow to you, is within your terms. We will attribute Textile as the venue in every receipt.

Their docs don't address the last point, so it should be cleared in writing before the paid API goes live.

---

## 6. ERC-8004 and x402 status

**ERC-8004.** Confirmed on [docs.celo.org](https://docs.celo.org/build/agents/8004):

| Registry | Address |
|---|---|
| Identity Registry | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` |
| Reputation Registry | `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` |

- Your addresses match the docs exactly.
- The identity is an ERC-721, and the address that registers owns it. Register from a dedicated cold "identity owner" key, not from the executor key.
- The registration JSON uses `type: https://eips.ethereum.org/EIPS/eip-8004#registration-v1` and lists the services (HTTP API, MCP if we add one, and a wallet on `chainId 42220`). It should set `x402Support: true` and `supportedTrust: ["reputation"]`. Validation can be added later.
- **Self Agent ID** is a separate optional deployment of all three registries that adds a zero-knowledge proof-of-human. An agent can be in both. It is worth considering later as a trust signal.

**x402.** The facilitator is run by Celo Core Co. ([launch](https://www.cryptowisser.com/news/celo-core-co-launches-x402-facilitator/), [Celo x402 discovery docs](https://docs.celo.org/build-on-celo/build-with-ai/x402-get-discovered.md)):

- URL `https://api.x402.celo.org`, with endpoints `/verify`, `/settle`, `/supported` and `/health`.
- Requires an **API key** from x402.celo.org.
- Settles **USDC and USDT on Celo mainnet**. The facilitator pays gas, and there are no protocol fees.
- Server packages: `@x402/express` (Hono needs a thin adapter or `@x402/core` directly), `@x402/core` and `@x402/evm`. Network ID is `eip155:42220`.
- **Pitfall:** the Celo facilitator rejects the object-style `asset` field, so it must be sent flat ([guide](https://dev.to/emmo00/building-x402-servers-on-celo-a-getting-started-guide-498f)). A fork test will cover this.
- thirdweb also runs a Celo-capable facilitator and can serve as the failover.

**Pricing recommendation:**

- **Quote calls:** $0.001 (1,000 atomic USDC). That is about the floor where the fee stays meaningful.
- **Execution fee in bps:** don't collect this through x402. x402 charges a flat price per HTTP call. Take the bps fee **inside the swap**: the executor deducts it from output and shows it in the quote. The execute endpoint itself can cost $0.001 through x402 like any other call.
- **Free tier:** an API-key path that skips the 402 challenge, rate-limited and testnet-only. Mainnet free calls can be paper-mode quotes.

---

## 7. Corridors worth supporting

**Tier 1 — launch with these (route, quote firm, and arbitrage):**

| Corridor | Venues | Why |
|---|---|---|
| USDT ↔ USDC | Textile, Uniswap ($188k), Mento via USDm | Highest volume; three independent price sources |
| USDT/USDC ↔ USDm | Mento FPMM (oracle price), Uniswap USDT/USDm ($644k) | FPMM oracle price vs AMM price is the cleanest arb edge on the chain |
| USDT ↔ cNGN | Textile, Uniswap (two pools) | The naira corridor with real liquidity |
| USDT ↔ wBRL | Textile, Uniswap ($28k depth, high turnover) | Active flow, frequent dislocations likely |
| USDT ↔ wARS | Textile, Uniswap ($107k) | |
| wBRL ↔ wARS (2-hop via USDT) | Textile ×2 or mixed | Textile advertises this route itself; the router adds value by mixing venues |

**Tier 2 — quote and route with hard size caps (≤ ~$500), no arbitrage until depth is confirmed:**

- KESm, GHSm, NGNm, XOFm, ZARm, BRLm and COPm, through Mento and small Uniswap pools.
- **"Best rate NGN→KES"** is served as cNGN → USDT → KESm, two hops on two venues. Telling the user it is two hops is part of the answer.

**Not supported in v1:** cREAL and PUSO legacy pools, any pool under ~$10k, and IDRX (outside the focus).

**Cycles that actually exist for the arb engine:**

- **USDT → USDC → USDm → USDT** (Textile → Mento FPMM → Uniswap), plus every rotation and direction.
- **USDT → wBRL → USDT** and **USDT → cNGN → USDT**, Textile vs Uniswap. These are two-venue loops on the same pair.
- **USDT → wBRL → USDT → wARS** style loops add nothing over the separate two-venue loops. The bounded DFS will find them and discard them.

**Honest expectation.** Liquidity in the cycles is tens to hundreds of thousands of dollars. Textile makers price off external feeds and Mento FPMMs off oracles, so dislocations will be small and short-lived. Arb P&L will likely be modest. The router and paid API are where the value is, and the arb engine mainly keeps the price graph honest. PAPER mode will measure this before any capital goes in.

---

## 8. Design consequences carried into deliverables 2–3

- **Adapter quote contract.** `quote(tokenIn, tokenOut, amountIn) → {amountOut, gasEstimate, expiry, firm}` stays as specified, plus a separate `firmQuote(…, taker)` for venues where firm ≠ indicative:
  - **Mento and Uniswap** quotes are `firm: true` for the current block, with `expiry` set to the next block.
  - **Textile graph edges** come from `/rfq/levels` with `firm: false`. `firmQuote` calls `/rfq/request` only once a route has been selected.
- **Atomicity tiers:**
  - **(a)** Mento + Uniswap legs are always atomic in the executor.
  - **(b)** Textile legs are atomic only when the aggregator key is in place.
  - **(c)** Without it, a Textile leg runs as a separate first transaction from the EOA. The arb engine then accepts the inventory risk inside the per-token limits, or skips routes that would leave it.
- **Hard limit on the arb engine.** It must never hold more than 4 live Textile firm quotes. The RFQ slot accounting lives in Redis.
- **Mento tradability check.** Before every Mento leg, check tradability through the SDK, covering breakers, market hours and trading limits.
- **Token registry** is keyed by address, with on-chain decimals asserted at boot. The display layer maps legacy symbols (cUSD, cKES) to the current names.

---

## 9. Must-verify-on-chain list (blocked here; first task of deliverable 3)

1. `eth_getCode` is non-empty for every contract address above.
2. `decimals()` and `symbol()` for every token marked "verify".
3. Enumerate Uniswap v3 pools for each Tier 1 and Tier 2 pair across all four fee tiers, recording the address, fee, liquidity and `token0`/`token1`. This also resolves which "cNGN" pools are cNGN and which are NGNm.
4. Mento: `mento.routes` and `mento.trading` for KESm, NGNm, GHSm, XOFm and ZARm against USDm, to find the venue and confirm the pair is tradable. Read the fee for each FPMM pool.
5. Whether any stablecoin pools on Uniswap v4 have meaningful liquidity.
6. The USDT fee-currency adapter address, from Celo's fee-currencies page.
7. Textile `/rfq/levels?chainId=42220`: a live depth snapshot for each Celo corridor.
8. `/supported` on the Celo x402 facilitator once we hold an API key.

---

## 10. Remaining open questions for you

These are in addition to the five questions sent earlier.

- **Where should the on-chain checks in §9 run?** My workspace can't reach Celo RPC. The options:
  - a paid RPC URL that this environment is allowed to reach
  - running the check script on your machine
  - running it through a GitHub repo's CI
- **Do you want me to start the self-serve Textile live key now?** It needs a wallet you control, connected in the app, which is your action. Or should we wait for the aggregator key?
- **Is Base USDC acceptable as a second x402 asset?** It is only needed if you want listing in Coinbase's discovery catalog.

---

### Sources

- [Celo stablecoin contracts](https://docs.celo.org/build/tools/contracts/stablecoin-contracts.md)
- [Celo ERC-8004](https://docs.celo.org/build/agents/8004)
- [Celo x402 discovery](https://docs.celo.org/build-on-celo/build-with-ai/x402-get-discovered.md)
- [Celo deployments spec](https://docs.celo.org/specs/deployments.md)
- [Uniswap Celo deployments](https://docs.uniswap.org/contracts/v3/reference/deployments/celo-deployments)
- [Celo Uniswap contracts](https://docs.celo.org/tooling/contracts/uniswap-contracts.md)
- [Mento addresses](https://docs.mento.org/mento-v3/build/deployments/addresses)
- [Mento SDK](https://docs.mento.org/mento-v3/build/mento-sdk)
- [Textile docs](https://docs.textilecredit.com/)
- [Textile RFQ](https://docs.textilecredit.com/api/v2/rfq)
- [Textile aggregators](https://docs.textilecredit.com/api/v2/aggregators.html)
- [Textile auth](https://docs.textilecredit.com/api/v2/authentication)
- [Textile limits](https://docs.textilecredit.com/api/v2/errors.html)
- [Textile rates feed](https://docs.textilecredit.com/api/rates.html)
- [Textile address book](https://docs.textilecredit.com/protocol/address-book)
- [Textile fees](https://docs.textilecredit.com/fees)
- [DefiLlama Celo stablecoins](https://defillama.com/stablecoins/Celo)
- [DefiLlama Mento v3](https://defillama.com/protocol/mento-v3)
- [DexPaprika Uniswap v3 Celo](https://dexpaprika.com/celo/uniswap_v3)
- [Celo x402 facilitator launch](https://www.cryptowisser.com/news/celo-core-co-launches-x402-facilitator/)
- [x402 server guide on Celo](https://dev.to/emmo00/building-x402-servers-on-celo-a-getting-started-guide-498f)
- [cNGN on Celo](https://blog.celo.org/cngn-deploys-on-celo-bringing-the-nigerian-naira-to-the-leading-stablecoin-networks-onchain-fx-f2b570a079da)
