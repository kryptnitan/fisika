# fisika PAPER run — BNB Chain

2026-11-23T11:26:34.856Z · block 135262759 · gas 0.05 gwei · BNB $556.4117 · rpc 2/2 vetted

RPC requests (pool discovery + two full refreshes, batched): 10. Batch stats: {"aggregates":10,"fallbacks":0,"reads":130,"lastError":""}

v3 pools discovered: uniswap-v3 4, pancake-v3 7. Textile: yes. Graph edges: 20.

| Venue | Pass 1 | Pass 2 |
|---|---|---|
| uniswap-v3 | 4 edges | 8 edges, 872 ms |
| pancake-v3 | 5 edges | 10 edges, 871 ms |
| textile | 2 edges | 2 edges, 272 ms |

## FX board

Rate = output per 1 unit of input at that size, after venue fees, before the fisika service fee. "—" = no route has the depth.

| Corridor | $10 | $100 | $1000 | Venues ($100) | Execution ($100) |
|---|---|---|---|---|---|
| USDT→cNGN | 1447.39 | 506.47 | 0.000662 | pancake-v3 + textile | multi-tx (2 tx) |
| cNGN→USDT | 0.000691 | 0.000691 | 0.000691 | textile | textile-direct |

<details><summary>Route breakdown per corridor and size</summary>

- USDT→cNGN $10: textile[USDT→cNGN 10→14473.875219]
- USDT→cNGN $100: pancake-v3[USDT→cNGN 65→0.043038] + textile[USDT→cNGN 35→50646.520055]
- USDT→cNGN $1000: pancake-v3[USDT→cNGN 1000→0.662141]
- cNGN→USDT $10: textile[cNGN→USDT 0.006621→0.000004571899136056]
- cNGN→USDT $100: textile[cNGN→USDT 0.066214→0.000045721753420154]
- cNGN→USDT $1000: textile[cNGN→USDT 0.66214→0.000457217534201545]

</details>

## Arbitrage scan (PAPER)

0 cycle(s) with positive net profit on graph prices.
