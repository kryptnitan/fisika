# fisika paper trading record

100 sessions over 28.4 days (91.7 hours watched), 2026-10-29T12:56:17.084Z to 2026-11-26T23:14:28.297Z. Live Celo prices on free RPCs, nothing signed.

| | |
|---|---|
| Opportunities that cleared the first check | 16083 |
| Paper fills (passed live re-quote and every risk limit) | 490 |
| Paper P&L | $167.8490 |
| P&L per watched hour | $1.8311 |
| RPC requests | 455,738 (1.38/s) |
| Venue refresh failures | {"textile":150} |

## Fills by cycle

| Cycle | Fills | Paper P&L | Median edge |
|---|---|---|---|
| USDT→COPM→USDT (uniswap-v3, textile) | 436 | $159.9933 | 40.6 bps |
| USDT→wARS→USDT (uniswap-v3, textile) | 30 | $5.7314 | 13.5 bps |
| USDT→wARS→USDT (textile, uniswap-v3) | 21 | $1.6661 | 6.9 bps |
| USDT→wARS→USDT (textile, textile) | 2 | $0.3783 | 30.5 bps |
| USDT→wBRL→USDT (textile, textile) | 1 | $0.0798 | 8.0 bps |

## Why opportunities were skipped

- edge_bps_below_min: 14137
- inventory_exposure: 800
- edge_usd_below_min: 633
- after_requote: edge_bps_below_min: 23

## Sessions

| Start | Min | RPCs | Requests | Opps | Fills | P&L |
|---|---|---|---|---|---|---|
| 2026-11-26 22:19 | 55 | https://forno.celo.org, https://celo-rpc.publicnode.com | 4482 | 147 | 0 | $0.0000 |
| 2026-11-26 12:24 | 55 | https://forno.celo.org, https://celo-rpc.publicnode.com | 4785 | 67 | 4 | $0.5195 |
| 2026-11-26 02:49 | 55 | https://forno.celo.org, https://celo-rpc.publicnode.com | 4886 | 7 | 4 | $0.2874 |
| 2026-11-25 19:55 | 55 | https://forno.celo.org, https://celo-rpc.publicnode.com | 4488 | 41 | 12 | $4.0245 |
| 2026-11-25 09:49 | 55 | https://forno.celo.org, https://celo-rpc.publicnode.com | 5068 | 74 | 1 | $0.0831 |
| 2026-11-25 00:40 | 55 | https://forno.celo.org, https://celo-rpc.publicnode.com | 4512 | 47 | 0 | $0.0000 |
| 2026-11-24 15:50 | 55 | https://forno.celo.org, https://celo-rpc.publicnode.com | 5005 | 267 | 1 | $0.0798 |
| 2026-11-24 04:45 | 55 | https://forno.celo.org, https://celo-rpc.publicnode.com | 4544 | 66 | 0 | $0.0000 |
| 2026-11-23 20:10 | 55 | https://forno.celo.org, https://celo-rpc.publicnode.com | 4992 | 55 | 2 | $0.1132 |
| 2026-11-23 07:46 | 55 | https://forno.celo.org, https://celo-rpc.publicnode.com | 4466 | 69 | 0 | $0.0000 |
| 2026-11-23 00:17 | 55 | https://forno.celo.org, https://celo-rpc.publicnode.com | 4722 | 19 | 0 | $0.0000 |
| 2026-11-22 18:32 | 55 | https://forno.celo.org, https://celo-rpc.publicnode.com | 4535 | 72 | 1 | $0.0567 |
| 2026-11-22 11:16 | 55 | https://forno.celo.org, https://celo-rpc.publicnode.com | 4547 | 28 | 0 | $0.0000 |
| 2026-11-22 03:07 | 55 | https://forno.celo.org, https://celo-rpc.publicnode.com | 4265 | 45 | 0 | $0.0000 |
| 2026-11-21 23:11 | 55 | https://forno.celo.org, https://celo-rpc.publicnode.com | 4618 | 59 | 0 | $0.0000 |
| 2026-11-21 17:28 | 55 | https://forno.celo.org, https://celo-rpc.publicnode.com | 4483 | 67 | 0 | $0.0000 |
| 2026-11-21 09:45 | 55 | https://forno.celo.org, https://celo-rpc.publicnode.com | 4543 | 170 | 0 | $0.0000 |
| 2026-11-21 01:29 | 55 | https://forno.celo.org, https://celo-rpc.publicnode.com | 4320 | 3 | 0 | $0.0000 |
| 2026-11-20 20:10 | 55 | https://forno.celo.org, https://celo-rpc.publicnode.com | 4470 | 43 | 0 | $0.0000 |
| 2026-11-20 11:31 | 55 | https://forno.celo.org, https://celo-rpc.publicnode.com | 4206 | 4 | 0 | $0.0000 |
| 2026-11-20 03:09 | 55 | https://forno.celo.org, https://celo-rpc.publicnode.com | 4490 | 2 | 0 | $0.0000 |
| 2026-11-19 21:29 | 55 | https://forno.celo.org, https://celo-rpc.publicnode.com | 4952 | 79 | 0 | $0.0000 |
| 2026-11-19 12:59 | 55 | https://forno.celo.org, https://celo-rpc.publicnode.com | 4799 | 189 | 0 | $0.0000 |
| 2026-11-19 03:22 | 55 | https://forno.celo.org, https://celo-rpc.publicnode.com | 4925 | 273 | 0 | $0.0000 |
| 2026-11-18 21:24 | 55 | https://forno.celo.org, https://celo-rpc.publicnode.com | 4467 | 62 | 0 | $0.0000 |
| 2026-11-18 13:05 | 55 | https://forno.celo.org, https://celo-rpc.publicnode.com | 4733 | 187 | 4 | $0.6481 |
| 2026-11-18 04:15 | 55 | https://forno.celo.org, https://celo-rpc.publicnode.com | 4805 | 277 | 1 | $0.0720 |
| 2026-11-17 22:18 | 55 | https://forno.celo.org, https://celo-rpc.publicnode.com | 4895 | 25 | 0 | $0.0000 |
| 2026-11-17 13:18 | 55 | https://forno.celo.org, https://celo-rpc.publicnode.com | 4725 | 255 | 217 | $87.7762 |
| 2026-11-17 03:49 | 55 | https://forno.celo.org, https://celo-rpc.publicnode.com | 4449 | 9 | 5 | $0.4806 |
| 2026-11-16 20:25 | 55 | https://forno.celo.org, https://celo-rpc.publicnode.com | 4930 | 60 | 6 | $0.6658 |
| 2026-11-16 09:36 | 55 | https://forno.celo.org, https://celo-rpc.publicnode.com | 4464 | 42 | 4 | $0.4494 |
| 2026-11-16 02:00 | 55 | https://forno.celo.org, https://celo-rpc.publicnode.com | 4725 | 13 | 0 | $0.0000 |
| 2026-11-15 21:45 | 55 | https://forno.celo.org, https://celo-rpc.publicnode.com | 4262 | 361 | 4 | $0.5279 |
| 2026-11-15 17:05 | 55 | https://forno.celo.org, https://celo-rpc.publicnode.com | 4505 | 249 | 0 | $0.0000 |
| 2026-11-15 09:19 | 55 | https://forno.celo.org, https://celo-rpc.publicnode.com | 4844 | 35 | 1 | $0.0734 |
| 2026-11-15 01:52 | 55 | https://forno.celo.org, https://celo-rpc.publicnode.com | 4541 | 123 | 4 | $0.4606 |
| 2026-11-14 21:27 | 55 | https://forno.celo.org, https://celo-rpc.publicnode.com | 4208 | 296 | 2 | $0.1642 |
| 2026-11-14 17:03 | 55 | https://forno.celo.org, https://celo-rpc.publicnode.com | 4704 | 500 | 0 | $0.0000 |
| 2026-11-14 10:19 | 55 | https://forno.celo.org, https://celo-rpc.publicnode.com | 4421 | 270 | 6 | $0.4422 |
| 2026-11-14 02:24 | 55 | https://forno.celo.org, https://celo-rpc.publicnode.com | 4210 | 232 | 5 | $0.5700 |
| 2026-11-13 21:58 | 55 | https://forno.celo.org, https://celo-rpc.publicnode.com | 4752 | 381 | 2 | $0.3187 |
| 2026-11-13 15:22 | 55 | https://forno.celo.org, https://celo-rpc.publicnode.com | 5023 | 451 | 184 | $68.5760 |
| 2026-11-13 06:39 | 55 | https://forno.celo.org, https://celo-rpc.publicnode.com | 4489 | 271 | 0 | $0.0000 |
| 2026-11-12 23:40 | 55 | https://forno.celo.org, https://celo-rpc.publicnode.com | 4847 | 249 | 2 | $0.1381 |
| 2026-11-12 18:16 | 55 | https://forno.celo.org, https://celo-rpc.publicnode.com | 4755 | 40 | 1 | $0.0812 |
| 2026-11-12 09:46 | 55 | https://forno.celo.org, https://celo-rpc.publicnode.com | 4435 | 5 | 0 | $0.0000 |
| 2026-11-12 01:30 | 55 | https://forno.celo.org, https://celo-rpc.publicnode.com | 4489 | 60 | 0 | $0.0000 |