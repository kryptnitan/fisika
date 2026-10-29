# fisika PAPER run — BNB Chain

2026-10-29T06:54:45.437Z · block 130428749 · gas 0.05 gwei · BNB $752.6382 · rpc 2/2 vetted

RPC requests (pool discovery + two full refreshes, batched): 10. Batch stats: {"aggregates":10,"fallbacks":0,"reads":130,"lastError":""}

v3 pools discovered: uniswap-v3 4, pancake-v3 7. Textile: yes. Graph edges: 20.

| Venue | Pass 1 | Pass 2 |
|---|---|---|
| uniswap-v3 | 4 edges | 8 edges, 4065 ms |
| pancake-v3 | 5 edges | 10 edges, 4065 ms |
| textile | 2 edges | 2 edges, 154 ms |

## FX board

Rate = output per 1 unit of input at that size, after venue fees, before the fisika service fee. "—" = no route has the depth.

| Corridor | $10 | $100 | $1000 | Venues ($100) | Execution ($100) |
|---|---|---|---|---|---|
| USDT→cNGN | 1383.38 | 1383.38 | 1383.38 | textile | textile-direct |
| cNGN→USDT | 0.000723 | 0.000723 | 0.000722 | textile | textile-direct |

<details><summary>Route breakdown per corridor and size</summary>

- USDT→cNGN $10: textile[USDT→cNGN 10→13833.836381]
- USDT→cNGN $100: textile[USDT→cNGN 100→138338.363818]
- USDT→cNGN $1000: textile[USDT→cNGN 1000→1383383.63819]
- cNGN→USDT $10: textile[cNGN→USDT 13833.836382→9.995293040404560519]
- cNGN→USDT $100: textile[cNGN→USDT 138338.363818→99.949621010283304596]
- cNGN→USDT $1000: textile[cNGN→USDT 1383383.63818→999.481810676627198476]

</details>

## Arbitrage scan (PAPER)

0 cycle(s) with positive net profit on graph prices.
