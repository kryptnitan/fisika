# fisika PAPER run — BNB Chain

2026-11-05T08:01:45.671Z · block 131781259 · gas 0.05 gwei · BNB $712.7868 · rpc 2/2 vetted

RPC requests (pool discovery + two full refreshes, batched): 10. Batch stats: {"aggregates":10,"fallbacks":0,"reads":130,"lastError":""}

v3 pools discovered: uniswap-v3 4, pancake-v3 7. Textile: yes. Graph edges: 20.

| Venue | Pass 1 | Pass 2 |
|---|---|---|
| uniswap-v3 | 4 edges | 8 edges, 621 ms |
| pancake-v3 | 5 edges | 10 edges, 622 ms |
| textile | 2 edges | 2 edges, 177 ms |

## FX board

Rate = output per 1 unit of input at that size, after venue fees, before the fisika service fee. "—" = no route has the depth.

| Corridor | $10 | $100 | $1000 | Venues ($100) | Execution ($100) |
|---|---|---|---|---|---|
| USDT→cNGN | 1381.72 | 1381.72 | 1381.72 | textile | textile-direct |
| cNGN→USDT | 0.000723 | 0.000723 | 0.000723 | textile | textile-direct |

<details><summary>Route breakdown per corridor and size</summary>

- USDT→cNGN $10: textile[USDT→cNGN 10→13817.243294]
- USDT→cNGN $100: textile[USDT→cNGN 100→138172.432947]
- USDT→cNGN $1000: textile[USDT→cNGN 1000→1381724.329484]
- cNGN→USDT $10: textile[cNGN→USDT 13817.243295→9.996729618237698017]
- cNGN→USDT $100: textile[cNGN→USDT 138172.432947→99.960789098785449211]
- cNGN→USDT $1000: textile[cNGN→USDT 1381724.32947→999.601383906433294206]

</details>

## Arbitrage scan (PAPER)

0 cycle(s) with positive net profit on graph prices.
