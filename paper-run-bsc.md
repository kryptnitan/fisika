# fisika PAPER run — BNB Chain

2026-11-11T05:47:06.422Z · block 132914814 · gas 0.05 gwei · BNB $681.1820 · rpc 2/2 vetted

RPC requests (pool discovery + two full refreshes, batched): 10. Batch stats: {"aggregates":10,"fallbacks":0,"reads":130,"lastError":""}

v3 pools discovered: uniswap-v3 4, pancake-v3 7. Textile: yes. Graph edges: 20.

| Venue | Pass 1 | Pass 2 |
|---|---|---|
| uniswap-v3 | 4 edges | 8 edges, 4865 ms |
| pancake-v3 | 5 edges | 10 edges, 4865 ms |
| textile | 2 edges | 2 edges, 221 ms |

## FX board

Rate = output per 1 unit of input at that size, after venue fees, before the fisika service fee. "—" = no route has the depth.

| Corridor | $10 | $100 | $1000 | Venues ($100) | Execution ($100) |
|---|---|---|---|---|---|
| USDT→cNGN | 1390.78 | 1390.78 | 1390.78 | textile | textile-direct |
| cNGN→USDT | 0.000719 | 0.000719 | 0.000719 | textile | textile-direct |

<details><summary>Route breakdown per corridor and size</summary>

- USDT→cNGN $10: textile[USDT→cNGN 10→13907.823323]
- USDT→cNGN $100: textile[USDT→cNGN 100→139078.23324]
- USDT→cNGN $1000: textile[USDT→cNGN 1000→1390782.332407]
- cNGN→USDT $10: textile[cNGN→USDT 13907.823324→10.001187780874117515]
- cNGN→USDT $100: textile[cNGN→USDT 139078.23324→100.01187780456802824]
- cNGN→USDT $1000: textile[cNGN→USDT 1390782.3324→1000.118778040895964923]

</details>

## Arbitrage scan (PAPER)

1 cycle(s) with positive net profit on graph prices.

| Cycle | Size | Net bps | Net $ | Txs | Indicative legs |
|---|---|---|---|---|---|
| USDT→cNGN→USDT via textile,textile | $1000 | 0.97 | 0.0977 | 2 | 2 |

Engine tick (live re-quote of each leg, then risk gate):

- skipped (edge_bps_below_min): net 0.97 bps / $0.0977