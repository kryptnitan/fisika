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
- [ ] 3. Venue adapters + price graph + router (core done, unit-tested; fork tests pending CI)
- [ ] 4. Executor contract
- [ ] 5. Arb engine (PAPER)
- [ ] 6. Paid API + ERC-8004
- [ ] 7. Web swap app (replaces the Telegram bot)
- [ ] 8. Dashboard
- [ ] 9. Go-live checklist + threat model
