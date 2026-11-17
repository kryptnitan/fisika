# fisika PAPER run — BNB Chain

2026-11-17T06:20:19.332Z · block 134070486 · gas 0.05 gwei · BNB $591.8302 · rpc 2/2 vetted

RPC requests (pool discovery + two full refreshes, batched): 10. Batch stats: {"aggregates":10,"fallbacks":0,"reads":130,"lastError":""}

v3 pools discovered: uniswap-v3 4, pancake-v3 7. Textile: yes. Graph edges: 20.

| Venue | Pass 1 | Pass 2 |
|---|---|---|
| uniswap-v3 | 4 edges | 8 edges, 385 ms |
| pancake-v3 | 5 edges | 10 edges, 385 ms |
| textile | 2 edges | 2 edges, 114 ms |

## FX board

Rate = output per 1 unit of input at that size, after venue fees, before the fisika service fee. "—" = no route has the depth.

| Corridor | $10 | $100 | $1000 | Venues ($100) | Execution ($100) |
|---|---|---|---|---|---|
| USDT→cNGN | 1427.17 | 1427.17 | 1427.17 | textile | textile-direct |
| cNGN→USDT | 0.000700 | 0.000700 | 0.000700 | textile | textile-direct |

<details><summary>Route breakdown per corridor and size</summary>

- USDT→cNGN $10: textile[USDT→cNGN 10→14271.736276]
- USDT→cNGN $100: textile[USDT→cNGN 100→142717.271407]
- USDT→cNGN $1000: textile[USDT→cNGN 1000→1427172.622726]
- cNGN→USDT $10: textile[cNGN→USDT 14271.727141→9.994004519177525778]
- cNGN→USDT $100: textile[cNGN→USDT 142717.271407→99.940045188221728292]
- cNGN→USDT $1000: textile[cNGN→USDT 1427172.71407→999.400451880764551274]

</details>

## Arbitrage scan (PAPER)

0 cycle(s) with positive net profit on graph prices.
