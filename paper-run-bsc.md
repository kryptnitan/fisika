# fisika PAPER run — BNB Chain

2026-11-13T08:30:22.529Z · block 133320049 · gas 0.05 gwei · BNB $630.5855 · rpc 2/2 vetted

RPC requests (pool discovery + two full refreshes, batched): 10. Batch stats: {"aggregates":10,"fallbacks":0,"reads":130,"lastError":""}

v3 pools discovered: uniswap-v3 4, pancake-v3 7. Textile: yes. Graph edges: 20.

| Venue | Pass 1 | Pass 2 |
|---|---|---|
| uniswap-v3 | 4 edges | 8 edges, 411 ms |
| pancake-v3 | 5 edges | 10 edges, 411 ms |
| textile | 2 edges | 2 edges, 193 ms |

## FX board

Rate = output per 1 unit of input at that size, after venue fees, before the fisika service fee. "—" = no route has the depth.

| Corridor | $10 | $100 | $1000 | Venues ($100) | Execution ($100) |
|---|---|---|---|---|---|
| USDT→cNGN | 1409.57 | 1409.57 | 1409.57 | textile | textile-direct |
| cNGN→USDT | 0.000710 | 0.000710 | 0.000710 | textile | textile-direct |

<details><summary>Route breakdown per corridor and size</summary>

- USDT→cNGN $10: textile[USDT→cNGN 10→14095.667252]
- USDT→cNGN $100: textile[USDT→cNGN 100→140956.67253]
- USDT→cNGN $1000: textile[USDT→cNGN 1000→1409566.725304]
- cNGN→USDT $10: textile[cNGN→USDT 14095.667253→10.002622980523699627]
- cNGN→USDT $100: textile[cNGN→USDT 140956.67253→100.012220677673661607]
- cNGN→USDT $1000: textile[cNGN→USDT 1409566.7253→1000.108871802008961339]

</details>

## Arbitrage scan (PAPER)

1 cycle(s) with positive net profit on graph prices.

| Cycle | Size | Net bps | Net $ | Txs | Indicative legs |
|---|---|---|---|---|---|
| USDT→cNGN→USDT via textile,textile | $1000 | 0.89 | 0.0893 | 2 | 2 |

Engine tick (live re-quote of each leg, then risk gate):

- skipped (edge_bps_below_min): net 0.89 bps / $0.0893