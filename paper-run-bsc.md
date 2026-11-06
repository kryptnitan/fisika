# fisika PAPER run — BNB Chain

2026-11-06T14:02:05.209Z · block 132021248 · gas 0.05 gwei · BNB $694.9782 · rpc 2/2 vetted

RPC requests (pool discovery + two full refreshes, batched): 10. Batch stats: {"aggregates":10,"fallbacks":0,"reads":130,"lastError":""}

v3 pools discovered: uniswap-v3 4, pancake-v3 7. Textile: yes. Graph edges: 20.

| Venue | Pass 1 | Pass 2 |
|---|---|---|
| uniswap-v3 | 4 edges | 8 edges, 499 ms |
| pancake-v3 | 5 edges | 10 edges, 499 ms |
| textile | 2 edges | 2 edges, 73 ms |

## FX board

Rate = output per 1 unit of input at that size, after venue fees, before the fisika service fee. "—" = no route has the depth.

| Corridor | $10 | $100 | $1000 | Venues ($100) | Execution ($100) |
|---|---|---|---|---|---|
| USDT→cNGN | 1376.26 | 1376.23 | 1376.22 | textile | textile-direct |
| cNGN→USDT | 0.000726 | 0.000726 | 0.000726 | textile | textile-direct |

<details><summary>Route breakdown per corridor and size</summary>

- USDT→cNGN $10: textile[USDT→cNGN 10→13762.643764]
- USDT→cNGN $100: textile[USDT→cNGN 100→137622.845154]
- USDT→cNGN $1000: textile[USDT→cNGN 1000→1376224.859045]
- cNGN→USDT $10: textile[cNGN→USDT 13762.284515→9.996033966602059843]
- cNGN→USDT $100: textile[cNGN→USDT 137622.845154→99.960339668691783029]
- cNGN→USDT $1000: textile[cNGN→USDT 1376228.45154→999.603396686683673424]

</details>

## Arbitrage scan (PAPER)

0 cycle(s) with positive net profit on graph prices.
