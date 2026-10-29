# fisika — Deliverable 9: Go-live checklist and threat model

Status: draft v1, 26 Oct 2026. It covers what exists in the repo today: core router, the three venue adapters, FisikaExecutor, the PAPER arb engine, the x402 API and the web app.

## Part A — Go-live checklist

Work top to bottom. Each stage needs every item ticked before moving on. **LIVE is not a single switch.** It goes in four stages, each with its own exposure:

| Stage | Name | What it allows |
|---|---|---|
| 1 | Paper | Live data, nothing signed |
| 2 | Quotes for sale | Paid quotes over x402; still no trades |
| 3 | Client swaps | Clients execute through the executor from their own wallets |
| 4 | Live arbitrage | fisika trades its own capital |

### Stage 0 — Decisions only you can make

- [ ] **Legal scope for the paid API and client swaps.** Nigeria's SEC VASP rules, and any other jurisdiction you serve, decide whether charging per quote and taking an in-swap fee needs registration. Until this is settled, `EXECUTION_ENABLED=false` keeps the deployment quote-only.
- [x] **RPC for paper mode:** two free endpoints, Forno (run by cLabs) then PublicNode, each vetted for chain id, reachability and lag at start and every 10 minutes. Reads are batched through Multicall3, so a full price refresh costs about 15–20 requests instead of ~400.
- [ ] **Paid Celo RPC before LIVE** (two providers for failover). Free endpoints have no uptime guarantee.
- [ ] **Key custody plan:**
  - executor owner: hardware wallet or Safe
  - guardian: hot, pause-only
  - arb wallet: hot, holds capital only
  - fee recipient
  - x402 payout
  - ERC-8004 identity owner: cold

  No key does two jobs.
- [ ] **Textile.** Get a self-serve live key now (app → profile → API keys). Request the `rfq:aggregator` key using the text in research report §5, and get written confirmation that resale through the paid API is within their terms.

### Stage 1 — Paper (running in CI today)

- [x] Every address, decimals value and venue ABI is verified on-chain (`scripts/verify-onchain.ts`, published on the `verification` branch).
- [x] The executor passes unit tests plus Celo-fork tests on Uniswap, Mento v3, Mento v2 and cross-venue routes, including a rollback when a later leg fails.
- [x] A live paper run publishes the FX board, arb scan and a graph snapshot on every push.
- [ ] Let the `paper` workflow run for **24 hours** (shortened from 7 days at the owner's call; a 55-minute session every hour; the record builds up in `paper-summary.md` on the `verification` branch). It records:
  - how many cycles the engine detects
  - how many survive the live re-quote
  - median edge after re-quote
  - how often the edge disappears between detection and confirmation

  Go to stage 4 only if paper P&L is positive after gas over that window. A 24-hour window covers one weekday cycle but not a weekend (Mento oracles pause) — the first live days are the rest of the test, which is why the first live caps are tiny.

### Stage 2 — Quotes for sale (x402)

- [ ] Get an x402 API key from x402.celo.org. Set `X402_API_KEY` and `X402_PAY_TO` (a dedicated payout address).
- [ ] Call `/v1/quote` unpaid and confirm it returns **402** with a `PAYMENT-REQUIRED` header. Pay once from a test wallet with `@x402/fetch` and confirm USDC arrives at `X402_PAY_TO`.
- [ ] Read USDT's EIP-712 domain on-chain before also advertising USDT as a payment asset.
- [ ] Set `INTERNAL_API_KEYS` and `ADMIN_TOKEN` (24+ random chars each). Confirm `/v1/admin/kill` answers 401 without the token.
- [ ] **ERC-8004:**
  1. Deploy the API.
  2. Run `DRY_RUN=1 node scripts/register-8004.ts`.
  3. Run it for real from the identity-owner key.
  4. Set `AGENT_ID` and redeploy, so the registration file lists the agentId.
  5. Check the entry on 8004scan.
- [ ] Put the API behind TLS with a per-IP rate limit at the edge.

### Stage 3 — Client swaps through the executor

- [ ] Deploy with `contracts/script/Deploy.s.sol`:
  - `OWNER` = hardware wallet or Safe, which then calls `acceptOwnership`
  - `GUARDIAN` = the hot pause key
- [ ] Verify the contract on Celoscan. Confirm the allowlist holds exactly SwapRouter02, the Mento Router and the Mento Broker, and **never a token**.
- [ ] Set `EXECUTOR_ADDRESS`, then `EXECUTION_ENABLED=true`. Swaps carry **no fisika fee** (`SERVICE_FEE_BPS=0`) until the legal review clears one; switching it on later needs only `FEE_TO` and the new value (the contract caps it at 100 = 1%).
- [ ] **Smoke test from a fresh wallet with $5:** quote, build, sign both transactions, then post the receipt. Confirm:
  - `realizedOut ≥ minOut`
  - the fee arrived at `FEE_TO`
  - the executor balance is zero afterwards
- [ ] **Practise the kill switch:** the guardian pauses the executor and a client swap reverts with `IsPaused`; the owner unpauses.
- [ ] Get an external review of FisikaExecutor before its usage grows. It is about 200 lines, written for this project and unaudited.

### Stage 4 — Live arbitrage (own capital)

- [ ] **A separate arb service holds the only copy of `ARB_PRIVATE_KEY`.** The API process must never have it. The arb engine in core already supports this; the service entrypoint is the remaining build item.
- [ ] Fund the arb wallet with **$100 at most**. First caps:

  | Limit | Value |
  |---|---|
  | `MAX_TRADE_USD` | 50 |
  | `DAILY_LOSS_LIMIT_USD` | 5 |
  | `MAX_TOKEN_EXPOSURE_USD` | 50 |

- [ ] **Atomic cycles only at first**, through the executor with `minOut ≥ amountIn × (1 + minEdge)`. Multi-tx cycles that include Textile stay off until the aggregator key exists.
- [ ] **Alerts** on: any revert, a loss-limit halt, the graph more than 30 s stale, an RPC failover, and a wallet balance below its floor.
- [ ] Raise caps only after **14 days** in which live results track paper results within tolerance.

## Part B — Threat model

Assets at risk:
- client funds while a swap is in flight
- arb capital
- the service fee and x402 revenue
- the keys
- fisika's reputation (its ERC-8004 record and published receipts)

| # | Threat | Where | Control in place | Residual risk / to do |
|---|---|---|---|---|
| 1 | Executor drains a user through a stray approval (arbitrary call to `token.transferFrom`) | FisikaExecutor | Calls only allowlisted targets; `setTarget` refuses the executor itself; funds are only pulled from `msg.sender`; there is a test for exactly this attack | **The owner must never allowlist a token.** Owner key on hardware or a Safe. |
| 2 | Reentrancy through a malicious token or venue | FisikaExecutor | Reentrancy lock; test with a reentrant token | — |
| 3 | Partial fill leaves a user or fisika holding the wrong token | Multi-leg routes | Everything inside one executor call is atomic, and net `minOut` is checked at the end; unspent input and intermediate tokens are swept back to the caller | **Textile legs are not atomic** without the aggregator key; multi-tx routes are not built for clients, and the arb engine caps exposure on them |
| 4 | Sandwich or MEV on a client swap | Uniswap legs | Client `minOut` = quote × (1 − slippage), default 30 bps, capped at 500; 120 s deadline | Celo's sequencer ordering limits public-mempool MEV but does not remove it; keep slippage tight |
| 5 | Stale or manipulated price makes the router or arb trade at a bad rate | Graph | Edges expire after `EDGE_MAX_AGE_MS`; every arb leg is re-quoted live before the gate; Mento pairs are dropped while breakers or market hours stop them; on-chain `minOut` is the final backstop | — |
| 6 | Textile quote expires during the approval | Textile adapter | `expiresAt` is checked before broadcast; the approval must confirm before the swap | — |
| 7 | Hitting Textile's RFQ cap or griefing makers | Textile adapter | Local cap of 4 live firm quotes; firm quotes are only requested at execution, never for pricing | Using the aggregator key raises the cap to 32 |
| 8 | Free API use or bypassing payment | API | Paid routes go through the x402 middleware; free-tier keys are capped per day and cover quotes only; internal keys stay server-side and require ≥ 24 chars; `/v1/build` checks configuration **before** taking payment, so nobody pays for a 503 | Add an edge rate limit per IP |
| 9 | Kill switch abused, or not working when needed | API / web | Admin bearer token is never stored by the web server; constant-time compare; the guardian key can pause the executor but **only the owner can unpause** | Keep the guardian key offline from the API host |
| 10 | Forged receipts | API | A receipt is only issued if the transaction carries the executor's `Executed` event with this quote's routeId; the receipt body is hashed (keccak256 of canonical JSON) | Receipts are held in memory today; persist them, and optionally commit a daily Merkle root on-chain |
| 11 | Key leak through logs or the repo | All | Keys only come from env or a secret manager; `.env` is gitignored; no code path logs a key | Add a redacting logger before LIVE |
| 12 | Address or token spoofing (wrong naira, wrong USDT) | Registry | Tokens are keyed by address; decimals are asserted at boot; symbol lookup is case-exact first (COPM vs COPm) and ambiguity is an error | — |
| 13 | RPC outage or a dishonest RPC | Graph / execution | Every endpoint is vetted (chain 42220, reachable, within 20 blocks of the others) at start and every 10 minutes; a primary that fails vetting pauses price updates so quotes go stale (503) instead of wrong; viem failover; RPC URLs are redacted in logs because paid ones carry API keys | A paid RPC is required before LIVE |
| 14 | Dependency or supply-chain compromise | Build | Code is written in-repo, small dependency set, CI runs on every push | Commit a lockfile from CI and enable Dependabot |
| 15 | ERC-8004 reputation spam | Reputation | Read feedback only from trusted client addresses (`getSummary` requires them) | — |

## Part C — Known gaps (honest list)

- **Storage.** Quotes, receipts, stats, the heatmap and arb history live in process memory, so a restart loses them. The architecture specifies Postgres and Redis. The store interfaces are in place, but the database implementations are not written yet.
- **Live arb service.** The engine is complete and tested in PAPER mode. The separate LIVE process (signing, nonce management, replacing stuck transactions) is not written. It is deliberately the last item.
- **Textile.** Both atomic Textile fills and Textile legs in client builds wait on the aggregator key.
- **Executor gas.** The executor's own gas (about 60k per transaction) is a fixed estimate. Calibrate it from the fork-test gas report.
