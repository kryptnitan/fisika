# fisika PAPER run — BNB Chain

2026-10-29T06:37:14.322Z · block 130426417 · gas 0.05 gwei · BNB $753.9856 · rpc 2/2 vetted

RPC requests (pool discovery + two full refreshes, batched): 10. Batch stats: {"aggregates":10,"fallbacks":0,"reads":130,"lastError":""}

v3 pools discovered: uniswap-v3 4, pancake-v3 7. Textile: yes. Graph edges: 20.

| Venue | Pass 1 | Pass 2 |
|---|---|---|
| uniswap-v3 | 4 edges | 8 edges, 5287 ms |
| pancake-v3 | 5 edges | 10 edges, 5287 ms |
| textile | 2 edges | 2 edges, 36 ms |

## FX board

Rate = output per 1 unit of input at that size, after venue fees, before the fisika service fee. "—" = no route has the depth.

| Corridor | $10 | $100 | $1000 | Venues ($100) | Execution ($100) |
|---|---|---|---|---|---|
| USDT→cNGN | 1383.43 | 1383.43 | 1383.43 | textile | textile-direct |
| cNGN→USDT | 0.000722 | 0.000722 | 0.000722 | textile | textile-direct |

<details><summary>Route breakdown per corridor and size</summary>

- USDT→cNGN $10: textile[USDT→cNGN 10→13834.257461]
- USDT→cNGN $100: textile[USDT→cNGN 100→138342.574618]
- USDT→cNGN $1000: textile[USDT→cNGN 1000→1383425.746188]
- cNGN→USDT $10: textile[cNGN→USDT 13834.257462→9.995199240329733318]
- cNGN→USDT $100: textile[cNGN→USDT 138342.574618→99.949015943204442159]
- cNGN→USDT $1000: textile[cNGN→USDT 1383425.74618→999.477212592762025534]

</details>

## Arbitrage scan (PAPER)

0 cycle(s) with positive net profit on graph prices.
