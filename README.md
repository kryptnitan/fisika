# fisika

Agent-native stablecoin FX desk on Celo (chain 42220): a best-execution router, a paid x402 API for agents and apps with an ERC-8004 identity, an arbitrage engine on the same price graph, and a web app.

| Path | What |
|---|---|
| `docs/01-research-report.md` | Verified venues, addresses, decimals, liquidity, Textile taker flow, x402 status, corridors |
| `docs/02-architecture.md` | Architecture, profit math, executor spec, risk controls |
| `packages/core` | Token registry, venue adapters (Mento, Uniswap v3, Textile), price graph, router |
| `scripts/verify-onchain.ts` | Checks every address, decimals, pools and venue ABIs against Celo mainnet |

## Run

```bash
pnpm install
pnpm test                                   # unit tests, no chain needed
CELO_RPC_URLS=https://forno.celo.org pnpm verify:onchain
```

Default mode is `PAPER`: everything live except signing. `LIVE` requires `MODE=LIVE`, `LIVE_ACK=i-accept-risk`, a paid RPC and every risk cap set (see `.env.example`).

## Status

- [x] 1. Research report
- [x] 2. Architecture
- [ ] 3. Venue adapters + price graph + router (done; CI green, on-chain checks pass)
- [x] 4. Executor contract (14 unit + 4 Celo-fork tests)
- [x] 5. Arb engine (PAPER) — live scan runs in CI, results on the `verification` branch
- [x] 6. Paid API + ERC-8004 (apps/api: Hono + x402, quote/build/receipts; scripts/register-8004.ts)
- [x] 7. Web swap app (apps/web, replaces the Telegram bot)
- [x] 8. Dashboard (rates board, liquidity heatmap, arb panel, agent API panel, trade log, kill switch)
- [ ] 9. Go-live checklist + threat model
