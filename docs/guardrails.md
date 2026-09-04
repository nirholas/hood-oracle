# Guardrails

The guard layer lives in `src/guards/` and sits between the entry gate and the
executor. It exists so that no strategy, no LLM verdict and no optimizer run
can take on more risk than the operator bounded, and so that every refusal is
explained in words a dashboard can show. Everything in it **fails closed**: a
number the guard cannot read refuses the buy rather than assuming the best.

```
entry gate (oracle score, filters)
   │
   ▼
RiskEngine.check(ctx)         src/guards/risk.ts      pure, ordered, fail closed
   │
   ▼
firewall (real buy→sell sim)   src/guards/firewall.ts  block / warn / off per arm
   │
   ▼
executor
```

## The risk engine, check by check

`RiskEngine.check(ctx)` returns `{ ok, reason?, detail }`. The reasons are the
`RefusalReason` union in `src/types.ts`; the detail is plain language. Checks
run in this order, cheapest and most fatal first, so the journaled reason is
the most meaningful one ("killed" rather than "over budget" when both hold).

| # | Check | Reason | Applies to | Refuses when |
|---|---|---|---|---|
| 1 | Global kill switch | `kill_switch` | buy and sell | `ctx.killed` is true. |
| 2 | Amount | `zero_amount` | buy and sell | `amountWei <= 0`. |
| 3 | Slippage bound | `slippage_bound` | buy and sell | `ctx.slippageBps > arm.slippageBps`. |
| 4 | Cooldown | `cooldown` | buy and sell | `now - lastTradeAt < cooldownSeconds * 1000`. The detail says how many seconds remain. |
| 5 | Arm state | `disarmed` | buy | `!arm.enabled` or `arm.killSwitch`. |
| 6 | Concurrency | `concurrency` | buy | `openPositions >= maxConcurrentPositions`. |
| 7 | Per-trade cap | `per_trade_cap` | buy | `perTradeWei` is 0, or `amountWei > perTradeWei`. |
| 8 | Daily budget | `daily_budget` | buy | `dailyBudgetWei` is 0, or `spentTodayWei + amountWei > dailyBudgetWei`. |
| 9 | Daily loss breaker | `daily_loss` | buy | `realizedLossTodayWei >= dailyBudgetWei * 0.5`. |
| 10 | Wallet floor | `wallet_floor` | buy | `walletWei` is null, or `walletWei - amountWei < minWalletWei + GAS_HEADROOM_WEI`. |
| 11 | Price impact | `price_impact` | buy | `priceImpactPct` is null or not finite, or `> maxPriceImpactPct`. |

A sell that clears 1 through 4 is allowed with the detail "Exit allowed: sells
are exempt from exposure caps."

### Why sells are exempt from the caps

The caps bound how much risk an arm takes **on**. A stop loss, a trailing stop
or a timeout is risk coming **off**. Refusing an exit because the arm is over
its daily budget, or because the wallet is under its floor, would trap a
losing position, which is the exact outcome the stop exists to prevent. This
is a lesson the three.ws sniper learned with real money, and it is why the
per-arm `disarm` and `kill` routes disable new buys while the positions sweep
keeps managing exits.

Sells still honor three things. The global kill switch, because an operator
who hit the panic button wants everything to stop until they have looked. The
cooldown, so an exit ladder cannot machine-gun a thin pool. The slippage
bound, because a sell that executes at any price is a rug of your own making.

### Why the guard fails closed on nulls

Two nulls are refused explicitly and both come from production incidents on
the Solana sniper:

- **A null price impact** (`price_impact`). A quote that returns no impact
  figure is a quote against a pool with no depth to measure, and the executor
  once treated "unknown" as "fine" and bought into it. Now unknown impact is
  refused: "Price impact could not be quoted: refusing to buy into unknown
  depth."
- **A null wallet balance** (`wallet_floor`). An RPC gap made a balance read
  fail; the executor attempted the buy, paid the failed transaction fee,
  retried on the next candidate, and repeated until the wallet was drained by
  fees alone. Now an unreadable balance is refused: "refusing to buy blind."

### The wallet floor and gas headroom

Two floors apply and they are different numbers:

- `MIN_WALLET_ETH` (default 0.005 ETH, `minWalletWei` in the context) is the
  operator's reserve. The engine never spends below it. It is what pays for
  the exit, the firewall probe and tomorrow's gas.
- `GAS_HEADROOM_WEI` (0.001 ETH) is what one round trip costs with margin.
  Robinhood Chain is an Arbitrum Orbit L2 paying gas in ETH. An approve is
  about 50k gas, a launchpad buy (curve or Uniswap v3 `exactInputSingle`)
  about 200k, the eventual sell another 200k: 500k end to end with margin.
  Orbit chains floor the L2 base fee at 0.1 gwei, which makes that round trip
  0.00005 ETH on a quiet chain; a launch storm is exactly when the base fee
  spikes, and 2 gwei is the heavy-congestion figure Arbitrum-family chains
  reach. 500,000 gas at 2 gwei is 0.001 ETH.

The headroom is reserved on top of the reserve, so the reserve never pays for
the exit. `resolveEntrySize(walletWei, wantWei, minWalletWei, gasHeadroomWei)`
uses the same floors to decide what a wallet can actually fund: the full
size, a smaller size (down to `MIN_ENTRY_WEI`, 0.0001 ETH, because a learning
fill beats no fill), or sitting out with `wallet_floor` so the executor stops
re-attempting on every candidate until the wallet is topped up.

### The daily loss breaker

The budget already bounds how much can be spent in a day. The breaker exists
to stop an arm **earlier** once the day is a proven bleed, so it cannot spend
the rest of its budget one losing entry at a time. It fires when the realized
net loss in the trailing 24h reaches `DAILY_LOSS_FRACTION_OF_BUDGET` (0.5) of
`dailyBudgetWei`. A profitable or break-even day never trips it. The fraction
is a `RiskEngine` constructor option.

## The firewall

`src/guards/firewall.ts` (owned by the engine) runs a **real** simulated buy
followed by a simulated sell of what the buy would return, against the live
pool or curve, before every live buy. A token that can be bought but not sold
is blocked, not flagged. `firewallLevel` on the arm decides what a failed
assessment does: `block` refuses the buy (`firewall`), `warn` lets it through
with the assessment attached to the decision, `off` skips it. `block` is the
default and the recommended setting for anything in live mode; the assessment
is stored in `firewall_decisions` either way and shown on the coin page.

## The kill switch

`KillSwitch` in `src/guards/kill.ts`. **A kill halts new risk. It never sells,
unwinds or cancels anything on its own.** A forced market exit into thin
launch liquidity during whatever caused the panic is usually worse than
holding, and an operator can always close a position by hand from the
dashboard (`POST /api/positions/:id/close`). While killed, the engine refuses
every buy and keeps managing exits: stops, trailing stops, ladders and
timeouts all still fire.

### Triggers

| Trigger | Reason string | How |
|---|---|---|
| Signal | `signal:SIGINT`, `signal:SIGTERM` | Ctrl-C, `docker compose stop`, a Cloud Run shutdown. A second signal of the same kind force-exits (130 / 143). |
| Kill file | `file:<path>` | The file at `KILL_FILE` (default `KILL` in the working directory, `/app/KILL` in the container) exists. Polled every second; checked once at boot. `touch KILL` from a shell, a volume, or `gcloud run services proxy` plus a shell. |
| Environment | `env:GLOBAL_KILL` | The process booted with `GLOBAL_KILL=1`. The deploy itself is the kill. |
| API | `operator: <reason>` | `POST /api/kill { "reason": "..." }` with the operator token. Also what the dashboard's kill button sends. |

### What is clearable, and why

Only an API kill is clearable at runtime, with `DELETE /api/kill`
(`KillSwitch.clearApiKill()`). The other three are refused on purpose:

- A **signal** means shutdown is already in progress. There is nothing to
  resume into; the process is leaving.
- A **file** kill would be re-tripped by the next one-second poll for as long
  as the file exists. The person who dropped the file is the one who should
  remove it, and then restart the process. Clearing it from a dashboard would
  let a button override an out-of-band operator action, which is the opposite
  of what a panic button is for.
- An **env** kill is a deployment decision. It is undone by deploying without
  `GLOBAL_KILL`.

`DELETE /api/kill` answers `409 kill_not_clearable` with the reason and the
instruction ("remove the KILL file, unset GLOBAL_KILL, and restart") when the
kill is not an API kill.

### Per-arm kill

`POST /api/arms/:id/kill` sets `enabled: false, killSwitch: true` on one arm.
The risk engine refuses that arm's buys with `disarmed` ("has its own kill
switch set") while every other arm keeps trading. `POST /api/arms/:id/arm`
clears it (`killSwitch: false`) after the armability check passes again.

## Earned autonomy

`src/guards/autonomy.ts`. An arm's realized record decides how wide a space
the optimizer may search on its behalf. The tier is recomputed from scratch
on every optimizer pass (every 6h) from **live** fills only; simulated fills
never earn a tier, because a paper record carries no slippage, no failed
transactions and no real adversary.

| Tier | Earned by | Per trade | Daily budget | Positions | Slippage | Impact | Stop range | Oracle floor |
|---|---|---|---|---|---|---|---|---|
| `probation` | net edge at or below -0.5% over 15+ closed trades | 0.0005 to 0.01 ETH | to 0.05 ETH | 1 | to 500 bps | to 5% | 10 to 40% | at least 56 (lean) |
| `standard` | the default: too few trades, or no decisive edge | to 0.05 ETH | to 0.25 ETH | to 3 | to 1000 bps | to 10% | 10 to 50% | at least 34 (watch) |
| `trusted` | net edge at least +0.5% over 12+ closed trades, drawdown under 35% | to 0.1 ETH | to 0.5 ETH | to 5 | to 1500 bps | to 15% | 10 to 60% | none |
| `autonomous` | net edge at least +5% over 40+ closed trades, drawdown under 25% | to 0.25 ETH | to 1 ETH | to 8 | to 2000 bps | to 25% | 10 to 65% | none |

**Net edge is size-weighted**: realized net P&L divided by gross ETH spent.
An unweighted average of percentages let the three.ws fleet reward an arm
whose bigger bets were its losers (a +6.4% average beside a net loss, measured
2026-07-27). Drawdown is the second axis: an arm that is profitable through a
50% hole is not one to hand more size.

What a tier changes: the bounds above (`TIER_BOUNDS`), the per-run step
(`TIER_STEP_SCALE`: 0.5x on probation up to 2.5x autonomous), which knobs the
optimizer may write at all (`BASE_WRITABLE` everywhere; `trusted` unlocks
`llmMinConfidence`, `minMarketCapEth`, `maxMarketCapEth`,
`initialsOutMultiple`, `moonbagMinPct`; `autonomous` adds
`maxCreatorLaunches`), and the budget weight a fleet allocator would apply
(`TIER_BUDGET_WEIGHT`).

`clampToTier(arm, patch, tier)` pulls any patch into a tier's range and never
widens: a value outside the range goes to the nearest edge, a null oracle gate
on a tier with a floor becomes the floor, a null stop loss is refused, and a
per-trade size above the daily budget is cut to the budget.

### What no tier can touch

The kill switch, the wallet floor and gas headroom, the daily loss breaker,
the price-impact ceiling, concurrency, slippage, the firewall. None of them is
in any tier's writable set, and a test asserts it. Every tier keeps a bounded
stop loss that can never be unset and never reach zero. The worst an
autonomous arm can do is take a firewall-vetted, stop-loss-protected,
budget-bounded trade.

## The optimizer

`src/guards/optimizer.ts`. Every 6h, for each arm with `autoOptimize: true`,
`proposeMutation(arm, record, recentPositions)` returns at most **one** knob
change: which knob, which direction, a step no larger than the tier allows,
clamped to the tier's bounds, with the evidence in the rationale. The same
inputs always produce the same proposal. `applyMutation(db, armId, patch,
rationale)` writes the arm and journals an `observe` decision with reason
`auto_optimize` in one transaction, so every tuning is auditable next to the
trades it learned from (`GET /api/decisions`).

Rules, in priority order; the first that fires wins:

| Rule | Fires when | Moves |
|---|---|---|
| W | zero wins over 6+ closes with a net loss (below the general 8-close floor) | shrink `perTradeWei` |
| O | realized wins concentrate above an oracle score band | raise `minOracleScore` toward it |
| A | 40%+ of exits are timeouts and the average P&L is positive | set or lower `takeProfitPct` |
| B | 50%+ of exits hit the stop at under a 40% win rate | raise `minOracleScore` (rules mode), then shrink size |
| C | 50%+ of exits are trailing stops | tighten the trail if runs are given back, loosen it if positions are shaken out at a loss |
| S | positive average P&L beside a net loss (the bigger bets are the losers) | shrink `perTradeWei` |
| D | proven: 60%+ win rate that is also net positive, or (trusted+) net profit at any hit rate | grow `perTradeWei` within the tier ceiling and the daily budget |
| E | under a 25% win rate with a net loss over 12+ closes | shrink `perTradeWei` |
| F | trusted+, LLM mode, net profitable | lower `llmMinConfidence` |
| G | trusted+, net profitable, a market-cap band or creator cap is set | widen the band; loosen the creator cap (autonomous) |
| H | trusted+, net profitable, best exit 25+ points above the average | turn on `initialsOutMultiple` at 2x, or raise `moonbagMinPct` |

Rules W, O, A, B, C, S and E only tighten and run for every tier. D, F, G and H
hand room back and are gated on tier and realized profit. Rule S runs before
D so an arm losing real money is never handed more size on a vanity metric.
