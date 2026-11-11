# fisika PAPER run — BNB Chain

2026-11-11T06:07:25.574Z · block 132917512 · gas 0.05 gwei · BNB $681.9190 · rpc 2/2 vetted

RPC requests (pool discovery + two full refreshes, batched): 10. Batch stats: {"aggregates":10,"fallbacks":0,"reads":130,"lastError":""}

v3 pools discovered: uniswap-v3 4, pancake-v3 7. Textile: yes. Graph edges: 20.

| Venue | Pass 1 | Pass 2 |
|---|---|---|
| uniswap-v3 | 4 edges | 8 edges, 487 ms |
| pancake-v3 | 5 edges | 10 edges, 487 ms |
| textile | 2 edges | 2 edges, 136 ms |

## FX board

Rate = output per 1 unit of input at that size, after venue fees, before the fisika service fee. "—" = no route has the depth.

| Corridor | $10 | $100 | $1000 | Venues ($100) | Execution ($100) |
|---|---|---|---|---|---|
| USDT→cNGN | 1390.58 | 1390.58 | 1390.58 | textile | textile-direct |
| cNGN→USDT | 0.000719 | 0.000719 | 0.000719 | textile | textile-direct |

<details><summary>Route breakdown per corridor and size</summary>

- USDT→cNGN $10: textile[USDT→cNGN 10→13905.830906]
- USDT→cNGN $100: textile[USDT→cNGN 100→139058.309072]
- USDT→cNGN $1000: textile[USDT→cNGN 1000→1390583.090732]
- cNGN→USDT $10: textile[cNGN→USDT 13905.830907→10.001200940718482113]
- cNGN→USDT $100: textile[cNGN→USDT 139058.309072→100.012009404477906664]
- cNGN→USDT $1000: textile[cNGN→USDT 1390583.09072→1000.120094040018578841]

</details>

## Arbitrage scan (PAPER)

1 cycle(s) with positive net profit on graph prices.

| Cycle | Size | Net bps | Net $ | Txs | Indicative legs |
|---|---|---|---|---|---|
| USDT→cNGN→USDT via textile,textile | $1000 | 0.98 | 0.0990 | 2 | 2 |

Engine tick (live re-quote of each leg, then risk gate):

- skipped (edge_bps_below_min): net 0.98 bps / $0.0990