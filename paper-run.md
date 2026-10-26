# fisika PAPER run

2026-10-26T07:44:59.324Z · block 81099943 · gas 202.5 gwei · CELO $0.0769

Uniswap v3 pools discovered: 39. Mento v2 exchanges between tracked tokens: USDm/GHSm, USDm/XOFm, USDm/ZARm, USDm/BRLm, USDm/NGNm, USDm/KESm, USDm/COPm. Graph edges: 93.

| Venue | Pass 1 | Pass 2 |
|---|---|---|
| uniswap-v3 | 37 edges | 57 edges, 3364 ms |
| mento | 5 edges | 6 edges, 3988 ms |
| mento-v2 | 7 edges | 14 edges, 3988 ms |
| textile | 16 edges | 16 edges, 315 ms |

## FX board

Rate = output per 1 unit of input at that size, after venue fees, before the fisika service fee. "—" = no route has the depth.

| Corridor | $10 | $100 | $1000 | Venues ($100) | Execution ($100) |
|---|---|---|---|---|---|
| USDT→USDC | 0.998860 | 0.998859 | 0.998845 | uniswap-v3 | atomic |
| USDC→USDT | 1.000940 | 1.000939 | 1.000924 | uniswap-v3 | atomic |
| USDT→USDm | 0.998723 | 0.998723 | 0.998720 | uniswap-v3 | atomic |
| USDm→USDT | 1.001079 | 1.001078 | 1.001282 | uniswap-v3 | atomic |
| USDC→USDm | 0.999558 | 0.999558 | 0.999644 | mento | atomic |
| USDT→cNGN | 1379.09 | 1370.40 | 1366.83 | textile + uniswap-v3 | multi-tx (2 tx) |
| cNGN→USDT | 0.000731 | 0.000731 | 0.000731 | uniswap-v3 | atomic |
| USDT→NGNm | 1335.03 | 1334.89 | 1333.47 | uniswap-v3 | atomic |
| NGNm→USDT | 0.000749 | 0.000749 | 0.000748 | uniswap-v3 | atomic |
| USDT→KESm | 129.33 | 129.33 | 129.31 | uniswap-v3 | atomic |
| KESm→USDT | 0.007635 | 0.007645 | 0.007637 | uniswap-v3 + mento-v2→uniswap-v3 | atomic |
| USDT→GHSm | 11.663327 | 11.526286 | 11.487283 | uniswap-v3 | atomic |
| USDT→XOFm | 572.92 | 573.59 | 572.78 | uniswap-v3→uniswap-v3 + mento→mento-v2 | atomic |
| USDT→wBRL | 5.357186 | 5.357185 | 5.357185 | textile | textile-direct |
| wBRL→USDT | 0.186441 | 0.186441 | 0.186441 | textile | textile-direct |
| USDT→wARS | 1637.70 | 1635.18 | 1633.28 | uniswap-v3 | atomic |
| wARS→USDT | 0.000611 | 0.000611 | 0.000610 | uniswap-v3 | atomic |
| USDT→BRLA | 5.303853 | 5.299194 | 5.253048 | uniswap-v3 | atomic |
| USDT→COPM | 3666.54 | 3619.57 | 3208.50 | uniswap-v3 | atomic |
| cNGN→KESm | 0.094547 | 0.094541 | 0.094486 | uniswap-v3→uniswap-v3 | atomic |
| wBRL→wARS | 160.86 | 304.87 | 304.51 | textile→uniswap-v3 | multi-tx (2 tx) |
| cNGN→NGNm | 0.975998 | 0.975846 | 0.974325 | uniswap-v3→uniswap-v3 | atomic |

## Arbitrage scan (PAPER)

2 cycle(s) with positive net profit on graph prices.

| Cycle | Size | Net bps | Net $ | Txs | Indicative legs |
|---|---|---|---|---|---|
| USDT→USAT→USDT via textile,uniswap-v3 | $1000 | 4.72 | 0.4728 | 2 | 1 |
| USDT→cNGN→USDT via textile,uniswap-v3 | $10 | 74.66 | 0.0747 | 2 | 1 |

Engine tick (live re-quote of each leg, then risk gate):

- skipped (edge_bps_below_min): net 4.72 bps / $0.4728
- filled: net 74.66 bps / $0.0747