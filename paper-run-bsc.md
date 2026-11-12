# fisika PAPER run — BNB Chain

2026-11-12T22:07:14.854Z · block 133237129 · gas 0.05 gwei · BNB $654.2578 · rpc 2/2 vetted

RPC requests (pool discovery + two full refreshes, batched): 10. Batch stats: {"aggregates":10,"fallbacks":0,"reads":130,"lastError":""}

v3 pools discovered: uniswap-v3 4, pancake-v3 7. Textile: yes. Graph edges: 20.

| Venue | Pass 1 | Pass 2 |
|---|---|---|
| uniswap-v3 | 4 edges | 8 edges, 580 ms |
| pancake-v3 | 5 edges | 10 edges, 580 ms |
| textile | 2 edges | 2 edges, 156 ms |

## FX board

Rate = output per 1 unit of input at that size, after venue fees, before the fisika service fee. "—" = no route has the depth.

| Corridor | $10 | $100 | $1000 | Venues ($100) | Execution ($100) |
|---|---|---|---|---|---|
| USDT→cNGN | 1405.08 | 1405.08 | 1405.08 | textile | textile-direct |
| cNGN→USDT | 0.000712 | 0.000712 | 0.000712 | textile | textile-direct |

<details><summary>Route breakdown per corridor and size</summary>

- USDT→cNGN $10: textile[USDT→cNGN 10→14050.77899]
- USDT→cNGN $100: textile[USDT→cNGN 100→140507.789903]
- USDT→cNGN $1000: textile[USDT→cNGN 1000→1405077.899033]
- cNGN→USDT $10: textile[cNGN→USDT 14050.77899→10.002512093867653469]
- cNGN→USDT $100: textile[cNGN→USDT 140507.789903→100.01234696515104415]
- cNGN→USDT $1000: textile[cNGN→USDT 1405077.89903→1000.111466052100544997]

</details>

## Arbitrage scan (PAPER)

1 cycle(s) with positive net profit on graph prices.

| Cycle | Size | Net bps | Net $ | Txs | Indicative legs |
|---|---|---|---|---|---|
| USDT→cNGN→USDT via textile,textile | $1000 | 0.91 | 0.0912 | 2 | 2 |

Engine tick (live re-quote of each leg, then risk gate):

- skipped (edge_bps_below_min): net 0.91 bps / $0.0912