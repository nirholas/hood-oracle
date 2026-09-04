# HTTP API

Base URL: `http://localhost:8080` locally, the Cloud Run URL in production.
Every route is under `/api`. The dashboard is served from `/`.

**Auth.** Reads are public. Every `POST`, `PATCH`, `PUT` and `DELETE` needs
`Authorization: Bearer <OPERATOR_TOKEN>`. With no `OPERATOR_TOKEN` configured,
writes answer `503 operator_token_unset` rather than opening up. A wrong token
answers `401 unauthorized`.

**Wire format.** JSON. Wei values are decimal strings (`"10000000000000000"`),
dates are ISO 8601, addresses are checksummed hex. Every error is:

```json
{ "error": "validation", "message": "perTradeWei: expected a decimal wei string", "detail": { "issues": ["..."] } }
```

with a meaningful status: 400 validation, 401 unauthorized, 404 not found,
409 conflict (with a specific `error` code), 502 the engine failed the action,
503 not configured.

In the examples below:

```bash
export HOOD=http://localhost:8080
export TOKEN=...
auth() { curl -sS -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" "$@"; }
```

## Status

### `GET /api/health`

Liveness. What the container `HEALTHCHECK` and Cloud Run probe.

```bash
curl -s $HOOD/api/health
```
```json
{ "ok": true, "uptimeSeconds": 8123, "startedAt": "2026-09-03T10:00:00.000Z", "now": "2026-09-03T12:15:23.000Z" }
```

### `GET /api/status`

Engine health, model provenance and table counts.

```json
{
  "ok": true,
  "network": "mainnet",
  "chainId": 4663,
  "explorerUrl": "https://robinhoodchain.blockscout.com",
  "operatorTokenSet": true,
  "engine": {
    "network": "mainnet", "chainId": 4663, "headBlock": 1842211,
    "feed": { "connected": true, "lastSequence": 90211, "secondsSinceFrame": 0 },
    "wallet": { "address": "0xAbC...", "ethWei": "48210000000000000", "live": true },
    "killed": false, "killReason": null,
    "arms": { "total": 3, "enabled": 2, "live": 1 },
    "positions": { "open": 1 },
    "model": { "version": "v3-2026-08-28T06:00:00.000Z", "provenance": "three.ws pump.fun corpus, re-denominated ...", "trainingRows": 296113, "fittedAt": "2026-08-28T06:00:00.000Z" },
    "startedAt": "2026-09-03T10:00:00.000Z"
  },
  "model": { "version": "...", "provenance": "...", "trainingRows": 296113, "fittedAt": "...", "source": "bootstrap" },
  "counts": { "arms": { "total": 3, "enabled": 2, "live": 1 }, "positions": { "open": 1, "closed": 41 }, "launches": 612, "launches24h": 19, "scores": 612, "scores24h": 19, "trades": 84, "decisions": 1931 }
}
```

`model.source` is `bootstrap` until the first refit is promoted.

## Arms

An arm's wire shape is the `Arm` type in `src/types.ts` with wei as strings
and dates as ISO. Input accepts every knob in the README table; the wei
fields also accept `perTradeEth` / `dailyBudgetEth` as numbers. `null` clears
an optional filter, omitting a key leaves it alone, and an unknown key is a
`400`.

### `GET /api/arms`

```json
{ "arms": [ { "id": "3f2b...", "label": "lean-noxa", "enabled": true, "mode": "simulate", "perTradeWei": "10000000000000000", "...": "...", "summary": { "open": 1, "closed": 12, "wins": 5, "realizedPnlWei": "2130000000000000", "lastTradeAt": "2026-09-03T11:58:02.000Z" } } ], "count": 1 }
```

### `POST /api/arms`

```bash
auth -X POST $HOOD/api/arms -d '{ "label": "lean-noxa", "launchpads": ["noxa"], "perTradeEth": 0.01, "dailyBudgetEth": 0.05, "minOracleScore": 56, "stopLossPct": 30, "enabled": true }'
```

`201 { "arm": { ... } }`. With `enabled: true` the armability check runs and a
failure answers `409 unarmable` with `detail.problems`.

### `GET /api/arms/:id`

`{ "arm": { ..., "summary": { ... } } }`. `404 not_found` for an unknown id;
`400` for a malformed uuid.

### `PATCH /api/arms/:id`

```bash
auth -X PATCH $HOOD/api/arms/3f2b... -d '{ "minOracleScore": 72, "takeProfitPct": 60, "trailingStopPct": null }'
```

`{ "arm": { ... } }`. If the arm is (or becomes) enabled, the merged result
must still pass the armability check: patching `stopLossPct` to 0 on a live
arm is refused, not stored. Setting `enabled: true` also clears the per-arm
kill switch.

### `DELETE /api/arms/:id`

`{ "ok": true, "id": "..." }`. Cascades to the arm's positions, trades and
equity points; decisions keep their rows with `armId` nulled.

### `POST /api/arms/:id/arm`

Enable. Checks: `stopLossPct > 0`, `perTradeWei > 0`,
`dailyBudgetWei >= perTradeWei`, and for `mode: "live"` a live wallet.

```json
{ "error": "wallet_not_live", "message": "Live mode needs a signing wallet: set TRADER_PRIVATE_KEY on the server and fund it with ETH, or arm in simulate mode.", "detail": { "problems": [ { "code": "wallet_not_live", "message": "..." } ] } }
```

### `POST /api/arms/:id/disarm`

`enabled: false`. Exits on open positions keep managing.

### `POST /api/arms/:id/kill`

`enabled: false, killSwitch: true`. The risk engine refuses this arm's buys
with `disarmed` until the next `/arm`.

## Kill switch

### `GET /api/kill`

`{ "killed": false, "reason": null }`

### `POST /api/kill`

```bash
auth -X POST $HOOD/api/kill -d '{ "reason": "pool depth looks wrong on odyssey" }'
```
`{ "killed": true, "reason": "operator: pool depth looks wrong on odyssey" }`

Halts every new buy across every arm. Exits keep managing. Never sells.

### `DELETE /api/kill`

Clears an API kill: `{ "killed": false, "reason": null, "cleared": true }`.
A kill from a signal, the `KILL` file or `GLOBAL_KILL` answers:

```json
{ "error": "kill_not_clearable", "message": "This kill did not come from the API (file:/app/KILL); clear it at the source (remove the KILL file, unset GLOBAL_KILL) and restart." }
```

## Oracle

### `GET /api/oracle/feed`

Latest score per token, joined to its launch and 90s feature snapshot, newest
first. Query: `tier` (`prime`..`avoid`), `launchpad` (`noxa`/`odyssey`),
`since` (ISO or unix seconds), `limit` (default 100, max 500).

```bash
curl -s "$HOOD/api/oracle/feed?tier=strong&limit=20"
```
```json
{
  "items": [ {
    "token": "0x9a1...", "launchpad": "noxa", "venue": "pool", "pool": "0x4c0...", "creator": "0x77e...",
    "name": "Hood Frog", "symbol": "HFROG", "firstSeenAt": "2026-09-03T11:40:12.000Z", "feedLeadMs": 212,
    "score": { "score": 78, "tier": "strong", "rugRisk": 0.09, "probabilities": { "win": 0.31, "rug": 0.09, "moon": 0.52 }, "pillars": { "structure": 71, "momentum": 84, "pedigree": 60, "narrative": 55 }, "hits": [ ... ], "reasons": [ "40+ early buyers: 80% of similar launches worked (6.8x base rate)" ], "confidence": 0.92, "modelVersion": "v3-...", "scoredAt": "..." },
    "features": { "unique_buyers": 47, "buy_volume_eth": 0.41, "...": "..." },
    "missing": [], "observedAt": "2026-09-03T11:41:42.000Z"
  } ],
  "count": 1,
  "filters": { "tier": "strong", "launchpad": null, "since": null, "limit": 20 },
  "generatedAt": "..."
}
```

### `GET /api/oracle/coin/:token`

Everything about one launch: the launch row, the feature snapshot, the latest
verdict and every prior one, firewall assessments, positions (with arm
labels), decisions, the creator's record, and the resolved outcome once the
24h label exists.

```json
{ "launch": { ... }, "features": { ... }, "latest": { ... }, "scores": [ ... ], "firewall": [ { "verdict": "allow", "score": 96, "roundTripLossPct": 0.021, "checks": [ ... ] } ], "positions": [ ... ], "decisions": [ ... ], "creator": { "launches": 3, "wins": 1, "rugs": 0, "lastLaunchAt": "..." }, "outcome": { "win": true, "rug": false, "moon": true, "athMultiple": 3.1, "realizedWin": true, "realizedPnlPct": 42.5, "resolvedAt": "..." } }
```

### `GET /api/oracle/model`

The active model: version, provenance, `source` (`bootstrap`/`promoted`),
training rows, the score head, per-head intercept and base rate, tier
anchors, holdout metrics, and every feature with its edges and bucket counts.

### `GET /api/oracle/models`

Every fitted candidate, newest first, with `status` (`active`, `candidate`,
`archived`), the promotion `reason`, `checks`, and holdout metrics. Query
`limit` (default 50).

### `GET /api/oracle/calibration`

`{ "key": "oracle:calibration", "value": { ...bands... }, "updatedAt": "..." }`.
`value` is null until the first calibration job has run.

### `GET /api/oracle/stream`

SSE. Only `launch`, `features` and `score` events. See streams below.

## Positions

### `GET /api/positions`

Open positions first, then closed by newest. Query: `status`
(`open`/`closed`/`reconcile_pending`), `arm` (uuid), `limit` (default 200).

```json
{ "positions": [ { "id": "...", "armId": "...", "armLabel": "lean-noxa", "token": "0x9a1...", "symbol": "HFROG", "name": "Hood Frog", "venue": "pool", "mode": "live", "status": "open", "entryWei": "10000000000000000", "tokenAmount": "128400000000000000000000", "buyTx": "0x...", "sellTx": null, "openedAt": "...", "closedAt": null, "peakValueWei": "16200000000000000", "lastValueWei": "15100000000000000", "initialsRecovered": false, "realizedPnlWei": null, "realizedPnlPct": null, "exitReason": null, "oracleScoreAtEntry": 78 } ], "count": 1 }
```

### `POST /api/positions/:id/close`

Close an open position at market now, exit reason `manual`.

```bash
auth -X POST $HOOD/api/positions/<id>/close
```
`{ "trade": { ... }, "position": { ..., "status": "closed", "exitReason": "manual" } }`

`409 position_not_open` if it is not open; `502 close_failed` with the
engine's message if the sell could not be executed.

## Ledger

### `GET /api/trades`

Newest first. Query: `arm`, `token`, `limit` (default 100).

```json
{ "trades": [ { "id": "...", "armId": "...", "armLabel": "lean-noxa", "positionId": "...", "token": "0x9a1...", "symbol": "HFROG", "side": "buy", "mode": "live", "venue": "pool", "amountIn": "10000000000000000", "amountOut": "128400000000000000000000", "txHash": "0x...", "gasWei": "61000000000000", "priceImpactPct": 2.4, "slippageBps": 300, "at": "..." } ], "count": 1 }
```

### `GET /api/decisions`

The hash-chained journal, newest first, with a verification of the whole
chain. Query: `arm`, `token`, `limit` (default 100).

```json
{
  "items": [
    { "id": "...", "armId": "...", "armLabel": "lean-noxa", "token": "0x9a1...", "kind": "refused", "reason": "price_impact", "detail": { "message": "Price impact 14.20% is over the 10% ceiling: the pool is too thin for this size." }, "prevHash": "e3b0...", "entryHash": "9f86...", "at": "..." },
    { "id": "...", "armId": "...", "armLabel": "lean-noxa", "token": null, "kind": "observe", "reason": "auto_optimize", "detail": { "rationale": "Realized wins concentrate at oracle score >= 72 over 14 trades: raise the conviction floor to buy where this arm actually wins.", "patch": { "minOracleScore": 61 } }, "prevHash": "...", "entryHash": "...", "at": "..." }
  ],
  "chain": { "ok": true, "rows": 1931, "breaks": [], "verifiedAt": "..." }
}
```

`kind` is one of `buy`, `sell`, `skip`, `refused`, `observe`, `alert`,
`error`.

### `GET /api/equity`

Per-arm equity series, oldest first. Query: `arm`, `limit` points per arm
(default 1000).

```json
{ "series": [ { "armId": "...", "armLabel": "lean-noxa", "points": [ { "at": "...", "realizedWei": "2130000000000000", "openValueWei": "15100000000000000", "equityWei": "17230000000000000" } ] } ] }
```

## Streams

### `GET /api/stream`

Server-sent events. On connect: a `hello` frame, then a replay of the bus
ring buffer (the last few hundred events, so a dashboard opened late has a
tape), then live events. A `ping` every 15 seconds keeps proxies from idling
the socket.

```
event: hello
data: {"at":1756900000000,"network":"mainnet","chainId":4663,"replay":212,"heartbeatMs":15000}

event: launch
data: {"kind":"launch","at":1756900001234,"launch":{...}}

event: score
data: {"kind":"score","at":1756900091234,"verdict":{...}}

event: decision
data: {"kind":"decision","at":...,"decision":{...}}

event: kill
data: {"kind":"kill","at":...,"reason":"operator: ..."}
```

Event names are the `EngineEvent.kind` values: `launch`, `features`, `score`,
`decision`, `trade`, `position`, `graduation`, `status`, `kill`.

```js
const es = new EventSource('/api/stream')
es.addEventListener('score', (e) => console.log(JSON.parse(e.data).verdict))
```

### `GET /api/oracle/stream`

The same stream filtered to `launch`, `features` and `score`.
