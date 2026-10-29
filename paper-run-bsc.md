# fisika PAPER run — BNB Chain

2026-10-29T07:07:25.399Z · block 130430404 · gas 0.05 gwei · BNB $752.5809 · rpc 2/2 vetted

RPC requests (pool discovery + two full refreshes, batched): 10. Batch stats: {"aggregates":10,"fallbacks":0,"reads":130,"lastError":""}

v3 pools discovered: uniswap-v3 4, pancake-v3 7. Textile: yes. Graph edges: 20.

| Venue | Pass 1 | Pass 2 |
|---|---|---|
| uniswap-v3 | 4 edges | 8 edges, 489 ms |
| pancake-v3 | 5 edges | 10 edges, 489 ms |
| textile | 2 edges | 2 edges, 150 ms |

## FX board

Rate = output per 1 unit of input at that size, after venue fees, before the fisika service fee. "—" = no route has the depth.

| Corridor | $10 | $100 | $1000 | Venues ($100) | Execution ($100) |
|---|---|---|---|---|---|
| USDT→cNGN | 1383.02 | 1383.02 | 1383.02 | textile | textile-direct |
| cNGN→USDT | 0.000723 | 0.000723 | 0.000723 | textile | textile-direct |

<details><summary>Route breakdown per corridor and size</summary>

- USDT→cNGN $10: textile[USDT→cNGN 10→13830.181718]
- USDT→cNGN $100: textile[USDT→cNGN 100→138301.817189]
- USDT→cNGN $1000: textile[USDT→cNGN 1000→1383018.171907]
- cNGN→USDT $10: textile[cNGN→USDT 13830.181719→9.99521166985990667]
- cNGN→USDT $100: textile[cNGN→USDT 138301.817189→99.94920846093890458]
- cNGN→USDT $1000: textile[cNGN→USDT 1383018.17189→999.479432501283225774]

</details>

## Arbitrage scan (PAPER)

0 cycle(s) with positive net profit on graph prices.
