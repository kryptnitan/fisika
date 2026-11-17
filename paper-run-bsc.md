# fisika PAPER run — BNB Chain

2026-11-17T05:47:05.280Z · block 134066058 · gas 0.05 gwei · BNB $594.4301 · rpc 2/2 vetted

RPC requests (pool discovery + two full refreshes, batched): 10. Batch stats: {"aggregates":10,"fallbacks":0,"reads":130,"lastError":""}

v3 pools discovered: uniswap-v3 4, pancake-v3 7. Textile: yes. Graph edges: 20.

| Venue | Pass 1 | Pass 2 |
|---|---|---|
| uniswap-v3 | 4 edges | 8 edges, 327 ms |
| pancake-v3 | 5 edges | 10 edges, 327 ms |
| textile | 2 edges | 2 edges, 72 ms |

## FX board

Rate = output per 1 unit of input at that size, after venue fees, before the fisika service fee. "—" = no route has the depth.

| Corridor | $10 | $100 | $1000 | Venues ($100) | Execution ($100) |
|---|---|---|---|---|---|
| USDT→cNGN | 1426.21 | 1426.21 | 1426.21 | textile | textile-direct |
| cNGN→USDT | 0.000701 | 0.000701 | 0.000701 | textile | textile-direct |

<details><summary>Route breakdown per corridor and size</summary>

- USDT→cNGN $10: textile[USDT→cNGN 10→14262.116521]
- USDT→cNGN $100: textile[USDT→cNGN 100→142621.165218]
- USDT→cNGN $1000: textile[USDT→cNGN 1000→1426211.652185]
- cNGN→USDT $10: textile[cNGN→USDT 14262.116522→9.994286694937964786]
- cNGN→USDT $100: textile[cNGN→USDT 142621.165218→99.940386203234845647]
- cNGN→USDT $1000: textile[cNGN→USDT 1426211.65218→999.401381287605130828]

</details>

## Arbitrage scan (PAPER)

0 cycle(s) with positive net profit on graph prices.
