# fisika PAPER run — BNB Chain

2026-11-16T19:26:19.924Z · block 133983308 · gas 0.05 gwei · BNB $590.5028 · rpc 2/2 vetted

RPC requests (pool discovery + two full refreshes, batched): 10. Batch stats: {"aggregates":10,"fallbacks":0,"reads":130,"lastError":""}

v3 pools discovered: uniswap-v3 4, pancake-v3 7. Textile: yes. Graph edges: 20.

| Venue | Pass 1 | Pass 2 |
|---|---|---|
| uniswap-v3 | 4 edges | 8 edges, 844 ms |
| pancake-v3 | 5 edges | 10 edges, 844 ms |
| textile | 2 edges | 2 edges, 1254 ms |

## FX board

Rate = output per 1 unit of input at that size, after venue fees, before the fisika service fee. "—" = no route has the depth.

| Corridor | $10 | $100 | $1000 | Venues ($100) | Execution ($100) |
|---|---|---|---|---|---|
| USDT→cNGN | 1425.67 | 1425.58 | 1425.57 | textile | textile-direct |
| cNGN→USDT | 0.000701 | 0.000701 | 0.000701 | textile | textile-direct |

<details><summary>Route breakdown per corridor and size</summary>

- USDT→cNGN $10: textile[USDT→cNGN 10→14256.730751]
- USDT→cNGN $100: textile[USDT→cNGN 100→142558.319801]
- USDT→cNGN $1000: textile[USDT→cNGN 1000→1425574.210297]
- cNGN→USDT $10: textile[cNGN→USDT 14255.83198→9.994226116736980166]
- cNGN→USDT $100: textile[cNGN→USDT 142558.319801→99.940930273079533356]
- cNGN→USDT $1000: textile[cNGN→USDT 1425583.19801→999.407971835804013343]

</details>

## Arbitrage scan (PAPER)

0 cycle(s) with positive net profit on graph prices.
