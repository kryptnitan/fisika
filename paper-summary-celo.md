# fisika paper trading record

3 sessions over 0.5 days (2.8 hours watched), 2026-10-29T12:56:17.084Z to 2026-10-30T00:12:00.290Z. Live Celo prices on free RPCs, nothing signed.

| | |
|---|---|
| Opportunities that cleared the first check | 301 |
| Paper fills (passed live re-quote and every risk limit) | 3 |
| Paper P&L | $0.2556 |
| P&L per watched hour | $0.0929 |
| RPC requests | 14,010 (1.42/s) |
| Venue refresh failures | {"textile":144} |

## Fills by cycle

| Cycle | Fills | Paper P&L | Median edge |
|---|---|---|---|
| USDT→wARS→USDT (textile, uniswap-v3) | 3 | $0.2556 | 8.6 bps |

## Why opportunities were skipped

- edge_bps_below_min: 209
- inventory_exposure: 89

## Sessions

| Start | Min | RPCs | Requests | Opps | Fills | P&L |
|---|---|---|---|---|---|---|
| 2026-10-29 23:16 | 55 | https://forno.celo.org, https://celo-rpc.publicnode.com | 4816 | 165 | 0 | $0.0000 |
| 2026-10-29 18:56 | 55 | https://forno.celo.org, https://celo-rpc.publicnode.com | 4329 | 100 | 3 | $0.2556 |
| 2026-10-29 12:56 | 55 | https://forno.celo.org, https://celo-rpc.publicnode.com | 4865 | 36 | 0 | $0.0000 |