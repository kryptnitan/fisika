# fisika PAPER run — BNB Chain

2026-11-11T06:49:30.897Z · block 132923123 · gas 0.05 gwei · BNB $676.9450 · rpc 2/2 vetted

RPC requests (pool discovery + two full refreshes, batched): 10. Batch stats: {"aggregates":10,"fallbacks":0,"reads":130,"lastError":""}

v3 pools discovered: uniswap-v3 4, pancake-v3 7. Textile: yes. Graph edges: 20.

| Venue | Pass 1 | Pass 2 |
|---|---|---|
| uniswap-v3 | 4 edges | 8 edges, 723 ms |
| pancake-v3 | 5 edges | 10 edges, 722 ms |
| textile | 2 edges | 2 edges, 201 ms |

## FX board

Rate = output per 1 unit of input at that size, after venue fees, before the fisika service fee. "—" = no route has the depth.

| Corridor | $10 | $100 | $1000 | Venues ($100) | Execution ($100) |
|---|---|---|---|---|---|
| USDT→cNGN | 1390.43 | 1390.43 | 1390.43 | textile | textile-direct |
| cNGN→USDT | 0.000719 | 0.000719 | 0.000719 | textile | textile-direct |

<details><summary>Route breakdown per corridor and size</summary>

- USDT→cNGN $10: textile[USDT→cNGN 10→13904.322466]
- USDT→cNGN $100: textile[USDT→cNGN 100→139043.224666]
- USDT→cNGN $1000: textile[USDT→cNGN 1000→1390432.246666]
- cNGN→USDT $10: textile[cNGN→USDT 13904.322467→10.001186475182648397]
- cNGN→USDT $100: textile[cNGN→USDT 139043.224666→100.011864748666638103]
- cNGN→USDT $1000: textile[cNGN→USDT 1390432.24666→1000.118647485534791715]

</details>

## Arbitrage scan (PAPER)

1 cycle(s) with positive net profit on graph prices.

| Cycle | Size | Net bps | Net $ | Txs | Indicative legs |
|---|---|---|---|---|---|
| USDT→cNGN→USDT via textile,textile | $1000 | 0.97 | 0.0977 | 2 | 2 |

Engine tick (live re-quote of each leg, then risk gate):

- skipped (edge_bps_below_min): net 0.97 bps / $0.0977