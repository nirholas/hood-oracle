# Architecture

hood-oracle is one long-running Node 24 process. It holds the Robinhood Chain
sequencer feed open, scores every launch with a conviction model that re-fits
itself from realized outcomes, and executes through hard guardrails. The HTTP
control plane (Hono) and the dashboard (Vite) live in the same container so an
arm change is visible to the engine on the next tick, not the next deploy.

```
sequencer feed ─┐                                          ┌─ Hono API + SSE
log watchers ───┼─▶ launch intake ─▶ 90s observation ─▶ features ─▶ oracle score
                │                                          │
                │        arms (DB) ─▶ entry gate ─▶ guards ─▶ firewall ─▶ executor
                │                                                          │
                └───────────── positions sweep ◀── exit ladder ◀── positions (DB)
                                     │
                    realized labels ─▶ refit (promotion gate) ─▶ active model
```

## Directory map

| Path | Owns | Notes |
|---|---|---|
| `src/types.ts` | every shared domain type and the cross-module interfaces | the contract; extend, never fork |
| `src/config.ts` | env parsing | fail at boot, not mid-trade |
| `src/db/schema.ts` | Drizzle schema | wei as `numeric(40,0)`, never float |
| `src/chain/` | viem client (fallback transport), sequencer feed, launchpad watchers, prices, nonce manager, parallel raw-tx submit, contract ABIs | the only place that talks RPC |
| `src/engine/` | launch intake, observation window, feature extraction, scoring pipeline, executor, positions sweep, exit ladder, journal, alerts, jobs scheduler | the trading loop |
| `src/oracle/` | conviction model (pure), fitter (pure), model store, calibration, labels, refit job, narrative classifier, bootstrap model | feature-in / score-out, no I/O in the pure parts |
| `src/guards/` | risk engine, kill switch, earned autonomy, optimizer, firewall | fail closed |
| `src/api/` | Hono app, routes, auth, SSE, static dashboard | operator token on writes |
| `web/` | Vite dashboard: oracle board, arm page, positions tape | vanilla TS modules, no framework |
| `scripts/` | backfill, fit, score CLIs | same modules as the engine |
| `tests/` | vitest | pure logic is unit-tested; chain code has integration tests behind `RPC_URLS` |

## Process shape

`src/index.ts` boots in this order and refuses to start if any step fails:

1. `loadConfig()`
2. DB connect + pending-migration check (exit 4 if pending; never auto-apply in prod)
3. model store: load the active model row, else the bootstrap prior
4. chain client + wallet (live signing only when `TRADER_PRIVATE_KEY` is set AND an arm is live)
5. kill switch armed (SIGINT/SIGTERM, `KILL` file, `POST /api/kill`, `GLOBAL_KILL` env)
6. engine: feed, watchers, observation windows, scorer, executor, positions sweep (2s)
7. jobs: realized labels (30m), calibration (6h), refit (6h), optimizer (6h), equity marks (60s)
8. Hono API on `PORT`, serving `web/dist`

## Latency path

A fill is: sequencer frame decoded (roughly 100 to 300ms before the block is
queryable), factory calldata matched, launch confirmed by log, 0 to 90s of
observation (the arm's `buy_delay_ms`), score, guards, firewall simulation,
pre-built swap, raw tx broadcast to every RPC in parallel. Nothing on that path
touches HTTP routing, which is why the choice of web framework is irrelevant to
fill speed.

## Money rules

- `simulate` is the default mode for every arm. Live is opt-in per arm and
  additionally requires `TRADER_PRIVATE_KEY`.
- Every arm has a stop loss. The API refuses to arm without one.
- Guards fail closed: an unpriceable impact, an unreadable balance, an RPC gap
  all refuse the buy. Exits are exempt from spend caps (a cap must never trap a
  losing position) but still honor the kill switch.
- The kill switch halts new risk. It never market-sells on its own.
- The firewall runs a real simulated buy-then-sell round trip before every live
  buy. A token that can be bought but not sold is blocked, not flagged.

## Learning loop

1. Every launch gets a 90-second feature snapshot and a score under the active model.
2. Labels resolve 24h later from chain history (price-independent: win means it
   ran AND a first-sight holder is still up; rug means down more than half; moon
   means it ran at all). Our own closed positions override chart labels for
   tokens we traded.
3. The refit job fits three logistic heads on bucketed features with a
   time-split holdout and runs a promotion gate: absolute AUC floor, calibration,
   feature-set integrity, and it must beat the incumbent by more than fit noise.
   Losing candidates are archived with the reason.
4. Earned autonomy: an arm's realized record sets its tier, and the tier bounds
   what the optimizer may change and how far.

## Bootstrap prior

The shipped model was fitted on the three.ws pump.fun corpus (296k launches).
It is a prior, not a claim about Robinhood Chain: SOL-denominated bucket edges
are re-denominated to ETH at fit-time rates and its provenance is displayed on
the dashboard until the first promoted refit replaces it. `npm run
oracle:backfill` reconstructs features and labels from chain history so that
first refit can happen on day one.
