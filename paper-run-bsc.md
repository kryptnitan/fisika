# fisika PAPER run — BNB Chain

2026-11-12T20:51:17.666Z · block 133227003 · gas 0.05 gwei · BNB $654.9691 · rpc 2/2 vetted

RPC requests (pool discovery + two full refreshes, batched): 10. Batch stats: {"aggregates":10,"fallbacks":0,"reads":130,"lastError":""}

v3 pools discovered: uniswap-v3 4, pancake-v3 7. Textile: yes. Graph edges: 20.

| Venue | Pass 1 | Pass 2 |
|---|---|---|
| uniswap-v3 | 4 edges | 8 edges, 487 ms |
| pancake-v3 | 5 edges | 10 edges, 487 ms |
| textile | 2 edges | 2 edges, 234 ms |

## FX board

Rate = output per 1 unit of input at that size, after venue fees, before the fisika service fee. "—" = no route has the depth.

| Corridor | $10 | $100 | $1000 | Venues ($100) | Execution ($100) |
|---|---|---|---|---|---|
| USDT→cNGN | 1407.83 | 1407.83 | 1407.83 | textile | textile-direct |
| cNGN→USDT | 0.000710 | 0.000710 | 0.000710 | textile | textile-direct |

<details><summary>Route breakdown per corridor and size</summary>

- USDT→cNGN $10: textile[USDT→cNGN 10→14078.280191]
- USDT→cNGN $100: textile[USDT→cNGN 100→140782.801911]
- USDT→cNGN $1000: textile[USDT→cNGN 1000→1407828.019116]
- cNGN→USDT $10: textile[cNGN→USDT 14078.280191→10.002114479482174921]
- cNGN→USDT $100: textile[cNGN→USDT 140782.801911→100.01196824727618392]
- cNGN→USDT $1000: textile[cNGN→USDT 1407828.01911→1000.111059346897920661]

</details>

## Arbitrage scan (PAPER)

1 cycle(s) with positive net profit on graph prices.

| Cycle | Size | Net bps | Net $ | Txs | Indicative legs |
|---|---|---|---|---|---|
| USDT→cNGN→USDT via textile,textile | $1000 | 0.90 | 0.0908 | 2 | 2 |

Engine tick (live re-quote of each leg, then risk gate):

- skipped (edge_bps_below_min): net 0.90 bps / $0.0908