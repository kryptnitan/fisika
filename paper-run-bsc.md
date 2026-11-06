# fisika PAPER run — BNB Chain

2026-11-06T13:12:23.871Z · block 132014626 · gas 0.05 gwei · BNB $695.2254 · rpc 2/2 vetted

RPC requests (pool discovery + two full refreshes, batched): 10. Batch stats: {"aggregates":10,"fallbacks":0,"reads":130,"lastError":""}

v3 pools discovered: uniswap-v3 4, pancake-v3 7. Textile: yes. Graph edges: 20.

| Venue | Pass 1 | Pass 2 |
|---|---|---|
| uniswap-v3 | 4 edges | 8 edges, 1126 ms |
| pancake-v3 | 5 edges | 10 edges, 1126 ms |
| textile | 2 edges | 2 edges, 223 ms |

## FX board

Rate = output per 1 unit of input at that size, after venue fees, before the fisika service fee. "—" = no route has the depth.

| Corridor | $10 | $100 | $1000 | Venues ($100) | Execution ($100) |
|---|---|---|---|---|---|
| USDT→cNGN | 1377.96 | 1377.92 | 1377.91 | textile | textile-direct |
| cNGN→USDT | 0.000725 | 0.000725 | 0.000725 | textile | textile-direct |

<details><summary>Route breakdown per corridor and size</summary>

- USDT→cNGN $10: textile[USDT→cNGN 10→13779.615528]
- USDT→cNGN $100: textile[USDT→cNGN 100→137791.897968]
- USDT→cNGN $1000: textile[USDT→cNGN 1000→1377914.722367]
- cNGN→USDT $10: textile[cNGN→USDT 13779.189797→9.99603684087280203]
- cNGN→USDT $100: textile[cNGN→USDT 137791.897968→99.960368401810490718]
- cNGN→USDT $1000: textile[cNGN→USDT 1377918.97968→999.603684012638266513]

</details>

## Arbitrage scan (PAPER)

0 cycle(s) with positive net profit on graph prices.
