# fisika PAPER run — BNB Chain

2026-11-19T12:06:50.951Z · block 134500446 · gas 0.05 gwei · BNB $591.4565 · rpc 2/2 vetted

RPC requests (pool discovery + two full refreshes, batched): 10. Batch stats: {"aggregates":10,"fallbacks":0,"reads":136,"lastError":""}

v3 pools discovered: uniswap-v3 4, pancake-v3 7. Textile: yes. Graph edges: 21.

| Venue | Pass 1 | Pass 2 |
|---|---|---|
| uniswap-v3 | 4 edges | 8 edges, 3973 ms |
| pancake-v3 | 6 edges | 11 edges, 3973 ms |
| textile | 2 edges | 2 edges, 145 ms |

## FX board

Rate = output per 1 unit of input at that size, after venue fees, before the fisika service fee. "—" = no route has the depth.

| Corridor | $10 | $100 | $1000 | Venues ($100) | Execution ($100) |
|---|---|---|---|---|---|
| USDT→cNGN | 1454.69 | 1454.52 | 225.43 | textile | textile-direct |
| cNGN→USDT | 0.000687 | 0.000687 | 0.000687 | textile | textile-direct |

<details><summary>Route breakdown per corridor and size</summary>

- USDT→cNGN $10: textile[USDT→cNGN 10→14546.949623]
- USDT→cNGN $100: textile[USDT→cNGN 100→145452.19368]
- USDT→cNGN $1000: pancake-v3[USDT→cNGN 850→7296.586776] + textile[USDT→cNGN 150→218135.699656]
- cNGN→USDT $10: textile[cNGN→USDT 14545.219368→9.993729051200808239]
- cNGN→USDT $100: textile[cNGN→USDT 145452.19368→99.937106976712517766]
- cNGN→USDT $1000: textile[cNGN→USDT 1454521.9368→999.37088623182961304]

</details>

## Arbitrage scan (PAPER)

0 cycle(s) with positive net profit on graph prices.
