# fisika PAPER run — BNB Chain

2026-11-06T15:37:34.059Z · block 132033975 · gas 0.05 gwei · BNB $693.9167 · rpc 2/2 vetted

RPC requests (pool discovery + two full refreshes, batched): 10. Batch stats: {"aggregates":10,"fallbacks":0,"reads":130,"lastError":""}

v3 pools discovered: uniswap-v3 4, pancake-v3 7. Textile: yes. Graph edges: 20.

| Venue | Pass 1 | Pass 2 |
|---|---|---|
| uniswap-v3 | 4 edges | 8 edges, 417 ms |
| pancake-v3 | 5 edges | 10 edges, 417 ms |
| textile | 2 edges | 2 edges, 95 ms |

## FX board

Rate = output per 1 unit of input at that size, after venue fees, before the fisika service fee. "—" = no route has the depth.

| Corridor | $10 | $100 | $1000 | Venues ($100) | Execution ($100) |
|---|---|---|---|---|---|
| USDT→cNGN | 1377.02 | 1377.02 | 1377.02 | textile | textile-direct |
| cNGN→USDT | 0.000726 | 0.000726 | 0.000726 | textile | textile-direct |

<details><summary>Route breakdown per corridor and size</summary>

- USDT→cNGN $10: textile[USDT→cNGN 10→13770.174467]
- USDT→cNGN $100: textile[USDT→cNGN 100→137701.744497]
- USDT→cNGN $1000: textile[USDT→cNGN 1000→1377017.444799]
- cNGN→USDT $10: textile[cNGN→USDT 13770.17445→9.994004925345992095]
- cNGN→USDT $100: textile[cNGN→USDT 137701.744497→99.940049250297078814]
- cNGN→USDT $1000: textile[cNGN→USDT 1377017.44497→999.400492501985261545]

</details>

## Arbitrage scan (PAPER)

0 cycle(s) with positive net profit on graph prices.
