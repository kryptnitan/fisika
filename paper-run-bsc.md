# fisika PAPER run — BNB Chain

2026-11-06T13:36:25.144Z · block 132017828 · gas 0.05 gwei · BNB $695.4780 · rpc 2/2 vetted

RPC requests (pool discovery + two full refreshes, batched): 10. Batch stats: {"aggregates":10,"fallbacks":0,"reads":130,"lastError":""}

v3 pools discovered: uniswap-v3 4, pancake-v3 7. Textile: yes. Graph edges: 20.

| Venue | Pass 1 | Pass 2 |
|---|---|---|
| uniswap-v3 | 4 edges | 8 edges, 508 ms |
| pancake-v3 | 5 edges | 10 edges, 508 ms |
| textile | 2 edges | 2 edges, 17 ms |

## FX board

Rate = output per 1 unit of input at that size, after venue fees, before the fisika service fee. "—" = no route has the depth.

| Corridor | $10 | $100 | $1000 | Venues ($100) | Execution ($100) |
|---|---|---|---|---|---|
| USDT→cNGN | 1379.02 | 1379.02 | 1379.02 | textile | textile-direct |
| cNGN→USDT | 0.000725 | 0.000725 | 0.000725 | textile | textile-direct |

<details><summary>Route breakdown per corridor and size</summary>

- USDT→cNGN $10: textile[USDT→cNGN 10→13790.240635]
- USDT→cNGN $100: textile[USDT→cNGN 100→137902.406361]
- USDT→cNGN $1000: textile[USDT→cNGN 1000→1379024.063616]
- cNGN→USDT $10: textile[cNGN→USDT 13790.240636→9.996790018882506282]
- cNGN→USDT $100: textile[cNGN→USDT 137902.406361→99.961449117080469356]
- cNGN→USDT $1000: textile[cNGN→USDT 1379024.06361→999.608040098335234341]

</details>

## Arbitrage scan (PAPER)

0 cycle(s) with positive net profit on graph prices.
