# fisika PAPER run — BNB Chain

2026-11-19T12:17:14.222Z · block 134501824 · gas 0.05 gwei · BNB $591.0340 · rpc 2/2 vetted

RPC requests (pool discovery + two full refreshes, batched): 10. Batch stats: {"aggregates":10,"fallbacks":0,"reads":136,"lastError":""}

v3 pools discovered: uniswap-v3 4, pancake-v3 7. Textile: yes. Graph edges: 21.

| Venue | Pass 1 | Pass 2 |
|---|---|---|
| uniswap-v3 | 4 edges | 8 edges, 679 ms |
| pancake-v3 | 6 edges | 11 edges, 679 ms |
| textile | 2 edges | 2 edges, 223 ms |

## FX board

Rate = output per 1 unit of input at that size, after venue fees, before the fisika service fee. "—" = no route has the depth.

| Corridor | $10 | $100 | $1000 | Venues ($100) | Execution ($100) |
|---|---|---|---|---|---|
| USDT→cNGN | 1449.57 | 1449.40 | 224.62 | textile | textile-direct |
| cNGN→USDT | 0.000690 | 0.000690 | 0.000690 | textile | textile-direct |

<details><summary>Route breakdown per corridor and size</summary>

- USDT→cNGN $10: textile[USDT→cNGN 10→14495.653913]
- USDT→cNGN $100: textile[USDT→cNGN 100→144940.148729]
- USDT→cNGN $1000: pancake-v3[USDT→cNGN 850→7296.586776] + textile[USDT→cNGN 150→217327.985475]
- cNGN→USDT $10: textile[cNGN→USDT 14494.014873→9.999803915187190749]
- cNGN→USDT $100: textile[cNGN→USDT 144940.148729→99.997724534281217778]
- cNGN→USDT $1000: textile[cNGN→USDT 1449401.48729→999.976930725911412085]

</details>

## Arbitrage scan (PAPER)

0 cycle(s) with positive net profit on graph prices.
