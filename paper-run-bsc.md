# fisika PAPER run — BNB Chain

2026-11-06T15:28:02.997Z · block 132032706 · gas 0.05 gwei · BNB $695.9829 · rpc 2/2 vetted

RPC requests (pool discovery + two full refreshes, batched): 10. Batch stats: {"aggregates":10,"fallbacks":0,"reads":130,"lastError":""}

v3 pools discovered: uniswap-v3 4, pancake-v3 7. Textile: yes. Graph edges: 20.

| Venue | Pass 1 | Pass 2 |
|---|---|---|
| uniswap-v3 | 4 edges | 8 edges, 484 ms |
| pancake-v3 | 5 edges | 10 edges, 484 ms |
| textile | 2 edges | 2 edges, 87 ms |

## FX board

Rate = output per 1 unit of input at that size, after venue fees, before the fisika service fee. "—" = no route has the depth.

| Corridor | $10 | $100 | $1000 | Venues ($100) | Execution ($100) |
|---|---|---|---|---|---|
| USDT→cNGN | 1376.49 | 1376.49 | 1376.49 | textile | textile-direct |
| cNGN→USDT | 0.000726 | 0.000726 | 0.000726 | textile | textile-direct |

<details><summary>Route breakdown per corridor and size</summary>

- USDT→cNGN $10: textile[USDT→cNGN 10→13764.866156]
- USDT→cNGN $100: textile[USDT→cNGN 100→137648.661392]
- USDT→cNGN $1000: textile[USDT→cNGN 1000→1376486.613752]
- cNGN→USDT $10: textile[cNGN→USDT 13764.866139→9.994005695100492831]
- cNGN→USDT $100: textile[cNGN→USDT 137648.661392→99.940056946184377694]
- cNGN→USDT $1000: textile[cNGN→USDT 1376486.61392→999.400569455571122738]

</details>

## Arbitrage scan (PAPER)

0 cycle(s) with positive net profit on graph prices.
