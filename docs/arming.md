# Arming: from a first simulated arm to live

This is the path an operator walks. Every step is a real request against the
running engine; nothing here is a mock. The API needs the operator token on
every write:

```bash
export HOOD=http://localhost:8080
export TOKEN=$(grep ^OPERATOR_TOKEN .env | cut -d= -f2)
auth() { curl -sS -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" "$@"; }
```

## 1. Simulate first

Every arm starts in `simulate` mode and disabled. A simulated arm runs the
whole pipeline against live launches, live quotes and the live oracle; the
only thing it does not do is sign. Positions, trades and decisions are
recorded with `SIMULATED` in place of a transaction hash.

```bash
auth -X POST $HOOD/api/arms -d '{
  "label": "lean-noxa",
  "launchpads": ["noxa"],
  "perTradeEth": 0.01,
  "dailyBudgetEth": 0.05,
  "maxConcurrentPositions": 2,
  "cooldownSeconds": 30,
  "minOracleScore": 56,
  "maxRugRisk": 0.5,
  "stopLossPct": 30,
  "trailingStopPct": 20,
  "maxHoldSeconds": 1800,
  "enabled": true
}'
```

The response is the arm with its id. `enabled: true` on create runs the same
armability check as `/arm`: a stop loss above 0, a per-trade size above 0, a
daily budget that covers at least one trade. Anything missing answers `409
unarmable` with every problem listed.

Watch it work on the dashboard, or on the wire:

```bash
curl -N $HOOD/api/stream
```

Every launch, feature snapshot, score, decision, trade and position change
arrives as an SSE event, with a replay of the last few minutes on connect.

## 2. Read the ledger

Give it a day or two of launches. Then read what it did and why.

```bash
auth $HOOD/api/arms/<id>                     # summary: open, closed, wins, realized P&L
auth "$HOOD/api/positions?arm=<id>"          # every position with its exit reason
auth "$HOOD/api/decisions?arm=<id>&limit=200" # buys, skips, refusals, with the reason
auth "$HOOD/api/equity?arm=<id>"             # the equity curve
```

The decisions journal is where the guardrails talk. A `refused` row carries
the `RefusalReason` and a plain-language detail: "Price impact 14.20% is over
the 10% ceiling: the pool is too thin for this size." A `skip` row says which
entry filter or oracle gate the launch failed. If the arm never buys, this is
where the answer is; if it buys and loses, the positions tape and the coin
page (`GET /api/oracle/coin/:token`) show what the oracle saw at entry and
what the label resolved to 24h later.

The journal is hash-chained (`entryHash = sha256(prevHash + row)`) and every
`GET /api/decisions` response includes a chain verification, so a ledger that
has been edited says so.

Tune from evidence, not intuition. `PATCH /api/arms/:id` accepts any subset of
knobs; unknown keys are rejected rather than silently dropped.

```bash
auth -X PATCH $HOOD/api/arms/<id> -d '{ "minOracleScore": 72, "takeProfitPct": 60 }'
```

Or let the optimizer do it: set `"autoOptimize": true` and every 6 hours it
proposes at most one bounded knob change from the arm's own record, applies
it, and journals it as an `observe` decision with reason `auto_optimize` and
the evidence in the detail. In simulate mode the optimizer learns from the
simulated record, so the knobs converge before any real money is at stake.

## 3. Go live, small

Live mode needs two things on the server: `TRADER_PRIVATE_KEY` set, and the
wallet funded above `MIN_WALLET_ETH` (0.005 ETH by default) plus room for
trades. `GET /api/status` shows `engine.wallet` with the address, the balance
and whether it is live.

```bash
auth -X PATCH $HOOD/api/arms/<id> -d '{ "mode": "live", "perTradeEth": 0.002, "dailyBudgetEth": 0.01 }'
```

The API refuses a live arm without a live wallet (`409 wallet_not_live`) and
tells you why: no key, or balance under the floor. Drop the size when you go
live; the record you earned in simulation carries no slippage, no failed
transactions and no adversary, and the first live fills are where you learn
what those cost on this chain.

### The confirmation the dashboard demands

Switching an arm to live from the arm page is a two-step confirmation, and it
is deliberately not a toggle. The dialog shows the arm's label, the per-trade
size and daily budget in ETH, the wallet address that will sign, and its
current balance, and asks you to type the arm's label before the request is
sent. The API call it makes is the `PATCH` above; the dialog adds nothing the
API does not enforce, it only makes sure the human in front of it read the
numbers. The same confirmation guards `POST /api/kill` from the dashboard
(type the reason) and `POST /api/positions/:id/close` (confirm the position).

## 4. Earn autonomy

Live fills are what earn a tier. `autonomyTier` starts at `standard` and is
recomputed on every optimizer pass from the arm's live record:

| Tier | Earned by |
|---|---|
| `trusted` | net edge at least +0.5% of gross spend over 12+ closed live trades, max drawdown under 35% |
| `autonomous` | net edge at least +5% over 40+ closed live trades, drawdown under 25% |
| `probation` | net edge at or below -0.5% over 15+ closed live trades |

A higher tier widens what the optimizer may do on the arm's behalf: bigger
per-trade and daily ceilings, faster steps, and knobs a losing arm cannot
touch (the market-cap band, the LLM confidence bar, the take-initials ladder).
It never removes a rail: the kill switch, wallet floor, loss breaker,
price-impact ceiling, concurrency, slippage and firewall are out of every
tier's reach, and every tier keeps a stop loss. Freedom is rented: an arm
that stops making money loses its tier on the next pass. The tier and its
evidence are on the arm page and in every `auto_optimize` decision.

## Stopping

| Want | Do |
|---|---|
| Stop this arm buying, keep managing its exits | `POST /api/arms/:id/disarm` |
| Stop this arm hard | `POST /api/arms/:id/kill` (clears on the next `/arm`) |
| Stop everything buying, keep managing exits | `POST /api/kill { "reason": "..." }`, or `touch KILL`, or Ctrl-C |
| Close one position now | `POST /api/positions/:id/close` |
| Resume after an API kill | `DELETE /api/kill` |

None of the stops sell on their own. Exits keep firing on their stops,
trails and timeouts, and a position you want out of right now is one
explicit close call. See [guardrails.md](guardrails.md) for what each kill
will and will not clear.
