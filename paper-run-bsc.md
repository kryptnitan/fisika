# fisika PAPER run — BNB Chain

2026-11-16T19:11:42.580Z · block 133981367 · gas 0.05 gwei · BNB $590.4500 · rpc 2/2 vetted

RPC requests (pool discovery + two full refreshes, batched): 10. Batch stats: {"aggregates":10,"fallbacks":0,"reads":130,"lastError":""}

v3 pools discovered: uniswap-v3 4, pancake-v3 7. Textile: yes. Graph edges: 20.

| Venue | Pass 1 | Pass 2 |
|---|---|---|
| uniswap-v3 | 4 edges | 8 edges, 5141 ms |
| pancake-v3 | 5 edges | 10 edges, 5141 ms |
| textile | 2 edges | 2 edges, 64 ms |

## FX board

Rate = output per 1 unit of input at that size, after venue fees, before the fisika service fee. "—" = no route has the depth.

| Corridor | $10 | $100 | $1000 | Venues ($100) | Execution ($100) |
|---|---|---|---|---|---|
| USDT→cNGN | 1424.82 | 1424.73 | 1424.72 | textile | textile-direct |
| cNGN→USDT | 0.000701 | 0.000701 | 0.000701 | textile | textile-direct |

<details><summary>Route breakdown per corridor and size</summary>

- USDT→cNGN $10: textile[USDT→cNGN 10→14248.219814]
- USDT→cNGN $100: textile[USDT→cNGN 100→142473.20287]
- USDT→cNGN $1000: textile[USDT→cNGN 1000→1424723.033428]
- cNGN→USDT $10: textile[cNGN→USDT 14247.320287→9.994063573897925316]
- cNGN→USDT $100: textile[cNGN→USDT 142473.20287→99.940635738540250539]
- cNGN→USDT $1000: textile[cNGN→USDT 1424732.0287→999.40635738496350277]

</details>

## Arbitrage scan (PAPER)

0 cycle(s) with positive net profit on graph prices.
