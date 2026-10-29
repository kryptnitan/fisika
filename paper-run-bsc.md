# fisika PAPER run — BNB Chain

2026-10-29T07:12:49.040Z · block 130431123 · gas 0.05 gwei · BNB $751.2600 · rpc 2/2 vetted

RPC requests (pool discovery + two full refreshes, batched): 10. Batch stats: {"aggregates":10,"fallbacks":0,"reads":130,"lastError":""}

v3 pools discovered: uniswap-v3 4, pancake-v3 7. Textile: yes. Graph edges: 20.

| Venue | Pass 1 | Pass 2 |
|---|---|---|
| uniswap-v3 | 4 edges | 8 edges, 709 ms |
| pancake-v3 | 5 edges | 10 edges, 709 ms |
| textile | 2 edges | 2 edges, 123 ms |

## FX board

Rate = output per 1 unit of input at that size, after venue fees, before the fisika service fee. "—" = no route has the depth.

| Corridor | $10 | $100 | $1000 | Venues ($100) | Execution ($100) |
|---|---|---|---|---|---|
| USDT→cNGN | 1383.03 | 1383.03 | 1383.03 | textile | textile-direct |
| cNGN→USDT | 0.000723 | 0.000723 | 0.000723 | textile | textile-direct |

<details><summary>Route breakdown per corridor and size</summary>

- USDT→cNGN $10: textile[USDT→cNGN 10→13830.334754]
- USDT→cNGN $100: textile[USDT→cNGN 100→138303.347551]
- USDT→cNGN $1000: textile[USDT→cNGN 1000→1383033.475521]
- cNGN→USDT $10: textile[cNGN→USDT 13830.334755→9.99523297514318687]
- cNGN→USDT $100: textile[cNGN→USDT 138303.347551→99.949332334531632222]
- cNGN→USDT $1000: textile[cNGN→USDT 1383033.47551→999.480283461724132505]

</details>

## Arbitrage scan (PAPER)

0 cycle(s) with positive net profit on graph prices.
