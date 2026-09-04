# hood-oracle litepaper

hood-oracle is an autonomous launch trader for Robinhood Chain (chain id
4663): a conviction oracle that scores every new token launch, from any of
the 17 launchpads its intake registers, in its first ninety seconds and learns from what those launches actually did, a set of
guardrails that no strategy, model or optimizer can loosen past what the
operator bounded, an execution path that starts on the sequencer feed rather
than on a block, and a set of on-chain contracts that move the guardrails
into a per-user account so the engine can trade for you without ever holding
your funds. This document is the whole protocol in one place, written for an
investor and for a builder who has never opened the repository. Everything it
quotes is a number in the code, a threshold in a gate, or a rule the
documentation already enforces; where a number is not yet real, the text says
what is measured instead.

## The problem

**Launch-day markets on a new L2 are information-asymmetric, and the
asymmetry is structural.** When a token launches on Robinhood Chain, through
NOXA, The Odyssey, one of the v4 hook launchers, or as a bare pool, the first
ninety seconds decide
most of the outcome and almost nobody watching has the tape: who bought, how
correlated those buyers are, whether the deployer is already selling, whether
supply was bundled in the deploy block, whether the wallets are fresh or
funded by one source. The people who do have it are the ones who built the
launch. Everyone else is trading a chart.

**Bots without a learning loop decay.** A sniper that ships with a fixed rule
set is fitted, implicitly, to whatever the market looked like the week it
was written. Launch mechanics change, bundlers adapt to the last filter that
caught them, a launchpad locks its liquidity and the meaning of "deployer
still holds 10%" flips. A bot that does not re-fit itself from realized
outcomes gets worse every week and cannot tell you it is getting worse,
because it never measured its own claims.

**Custodial bots are one key away from ruin.** The convenient way to run a
trading agent is to hand it a hot wallet. That makes the agent's server, its
operator, its dependencies and its bugs the security boundary for every
dollar in the wallet. A cap enforced by the same process that signs is a cap
the process can violate. The market can take your money; so can the software
meant to protect you from the market.

hood-oracle is the answer to those three problems in that order: an oracle
that measures, a learning loop that keeps it honest, guardrails that fail
closed, and contracts that hold the guardrails where the engine cannot reach
them.

## The launch surface

Robinhood Chain is not one launchpad with a stable shape. The intake registry
in `src/chain/launchpads.ts` recognises **17** launchpads today: NOXA and The
Odyssey, pool creations with no registered launcher recorded as `direct`, the
named v4 launchers (RWA launchpad, LongLauncher, CashCat, Forge, PairV4,
Pons, Rialto, DontBlink, Lunch, TokenSelect, RamenPad), and three launcher
contracts identified by address until somebody names them. A launchpad the
registry has never seen still produces a scored launch through the `direct`
path, so a new venue does not make the engine blind.

**Uniswap v4 is live on 4663.** The PoolManager singleton at
`0x8366a39CC670B4001A1121B8F6A443A643e40951` is deployed, and hook-based
launchpads initializing pools behind it account for most of the
launch-shaped activity on the chain. This matters to the design in two ways.
First, a launch detector keyed only on v3 factory calls would miss the
majority of the market, which is why intake matches a registry of contracts
and hooks rather than one factory. Second, the oracle scores a v4 launch
(venue `v4`) exactly as it scores a v3 one, because every feature is read
from the tape rather than from pool internals, while the executor trades what
it can prove it can sell: v3 pools today, with v4 routing on the roadmap
below. Observing more than you route is deliberate. A score the engine cannot
act on is still a label the model learns from, and a token the engine cannot
sell is one the firewall was always going to block.

## The product

### The oracle

A conviction oracle scores every launch 0 to 100 and tiers it: `prime` at 86,
`strong` at 72, `lean` at 56, `watch` at 34, `avoid` below. Only `prime` and
`strong` are act signals. The score is a monotone map of the model's
P(win), and every rung is a fixed probability claim (see
[how the oracle learns](#how-the-oracle-learns)). Rug risk is published as
its own number beside the score, never blended in, and every verdict quotes
the observations that moved it in plain language. The oracle runs inside the
engine, behind the public API, in the CLI and in the agent surfaces, and it
is the same pure function everywhere, so those surfaces cannot disagree about
what "the model" means.

### The arms

An arm is one strategy: a row of knobs deciding what to buy, how much, when
to exit, and how much room the optimizer may take. Arming an arm flips it
`enabled`. Every arm starts disarmed, in simulate mode, and the API refuses
to arm anything without a stop loss, a per-trade size, and a daily budget
that covers at least one trade. Simulate mode runs the full pipeline against
live launches, live quotes and the live oracle; the only thing it does not do
is sign. Live mode is opt-in per arm and additionally needs a signing key on
the server. The walk from a first simulated arm to a live one is
[arming.md](arming.md).

### The on-chain arm contracts

The contracts in `contracts/` are four: `HoodArmAccount`, a per-owner managed
account the factory deploys as an EIP-1167 clone; `HoodArmFactory`, which
creates them and holds the protocol fee settings; `HoodOracleAttestations`,
where signed scores are posted; and `HoodFeeSplitter`, which pays out accrued
fees. You deploy your own account with a cold key, deposit ETH, and name the
engine's hot key as `operator`. The operator can buy inside the policy and
sell, and nothing else. The per-trade cap, the daily budget, the cooldown,
the concurrency limit, the allowed router, the slippage bound, the kill
switch and the oracle-score gate live in the account's policy and are
enforced by the chain: a breach reverts, with the numbers a human needs in
the error. The owner can withdraw at any time. The design, the gas table and
the full threat model are [contracts.md](contracts.md); the summary is
[security and threat model](#security-and-threat-model) below.

### The agent surfaces

The oracle is a service other agents can call. Every read on the HTTP API is
public JSON today; the agent surfaces put the same scorer behind a Model
Context Protocol server (`src/mcp`), a typed TypeScript SDK over the API and
the event stream (`packages/sdk`), and a pay-per-score endpoint
(`GET /api/x402/score/:token`) priced in USDG and settled over x402 on
Robinhood Chain, so an autonomous trader on 4663 can buy conviction instead
of building it. Each has its own doc: [mcp.md](mcp.md), [sdk.md](sdk.md),
[x402.md](x402.md).

## How the oracle learns

### Features

Every launch gets a feature snapshot over the ninety seconds after first
sight. The feature list in `src/oracle/features.ts` holds 29 definitions in
four pillars:

| Pillar | Count | What it measures |
|---|---|---|
| structure | 10 | how the launch is put together: organic share of buy volume, bundled supply, snipe ratio, coordination of early buys, timing entropy, holder concentration (top 1, 5, 10), fresh-wallet share, common-funder connectivity |
| momentum | 11 | what the tape did: unique buyers and sellers, buy/sell ratio, buy, sell and net volume in ETH, trade count, largest, mean and median buy, market cap at first sight |
| pedigree | 6 | who launched it: deployer buys and sells in the window, whether the deployer sold at all, smart-money presence, the creator's record as one categorical, the share of supply the deployer still holds |
| narrative | 2 | what the coin says it is: a classified category and how confident the classifier was |

Every feature is bucketed rather than sloped, because several of these
signals are genuinely non-monotone: a mid-range snipe ratio is demand, 70%
and above is poison; low top-10 concentration ninety seconds in usually means
nobody bought. A feature whose source was unavailable (an RPC gap, no pool
yet on an Odyssey curve) is recorded as missing and scored as the fitted null
bucket, never fabricated, and the verdict's `confidence` is the share of
features actually observed. The full list with bucket edges is
[oracle.md](oracle.md).

### Three heads

One bucketed logistic regression per head over a shared one-hot design
matrix:

| Head | Question |
|---|---|
| `win` | Did it run (2x from first sight) **and** is a first-sight holder still up? The published score anchors here. |
| `rug` | Is a first-sight holder down more than half? Published beside the score and gated per arm. |
| `moon` | Did it run at all, whatever happened next? Kept so fits stay comparable and to show give-back risk. |

"This will probably run" and "this will probably take your money" are
different questions, and one number that averages them answers neither.

### Labels that resolve 24 hours later and cannot drift with the price of ETH

Labels resolve 24 hours after first sight from chain history and are
price-independent: ratios of two readings of the same market cap, so the
price of ETH cancels out.

```
retained      = last_market_cap / ath_market_cap
hold_multiple = ath_multiple * retained

moon = graduated OR ath_multiple >= 2
rug  = NOT graduated AND hold_multiple <= 0.5
win  = moon AND hold_multiple >= 1
```

This rule exists because the first labeler in the three.ws lineage compared
market caps to a dollar threshold, and for weeks its rug rate tracked the
price of SOL rather than any property of the coins. A position the engine
actually closed overrides the chart label for that token: what we got out is
a better teacher than what a chart says a holder could have got.

### The fit

Rows arrive oldest first; the newest slice is held out. Each head is fitted
by stochastic gradient descent on the older slice to earn an honest holdout
number, then refitted on everything for the weights that ship. Two rules keep
a small corpus honest, both constants in `src/oracle/fit.ts`:

- **Shrinkage.** Every weight is pulled toward zero in proportion to its
  evidence, `w * n / (n + 50)`. A bucket with 50 rows keeps half its fitted
  weight; one with 5 keeps 9%. Applied before evaluation, so the holdout
  numbers describe the weights that actually ship.
- **Degenerate features drop themselves.** A feature whose runner-up bucket
  holds fewer than 10 rows cannot support a second weight and is dropped, by
  name, into the report.

The thresholds are sized for a young chain: a fit needs at least 400 labeled
rows with at least 100 held out. At a 5% base rate that leaves about five
positives in the holdout, which is the floor at which an AUC of 0.70 is
distinguishable from 0.50 at all. Below it every candidate would be judged on
noise and the gate would be theatre.

### The promotion gate

Every six hours the refit job fits a candidate and judges it. The candidate
is stored either way, with its status, its reason and every check; the live
model is replaced only when all of these hold (`src/oracle/refit.ts`):

| Check | Fails when |
|---|---|
| `fit_complete` | the fit ran out of time before its last epoch |
| `absolute_auc` | the `win` holdout AUC is under 0.70 |
| `tier_honesty` | any tier band with at least 20 holdout rows observes less than 70% of the probability it claims |
| `feature_set` | the candidate carries more than three fewer features than the incumbent (a signal source is probably broken) |
| `no_regression_rug`, `no_regression_moon` | either other head regressed by more than 0.01 AUC |
| `auc_gain` | the `win` AUC did not beat the incumbent by at least 0.004, the difference two fits on the same data show from ordering alone |

The first model fitted on this chain's labels promotes on the absolute checks
alone. A losing candidate is archived with the sentence explaining why, so
"why is the model from the 14th still live" is answered by the row, not by a
log that has rolled over.

### The tier ladder is a public contract

The tiers claim fixed probabilities (`TIER_PROBABILITY_ANCHORS` in
`src/oracle/conviction.ts`):

| Tier | Score | Claims |
|---|---|---|
| prime | 86+ | P(win) at least 45% |
| strong | 72+ | P(win) at least 25% |
| lean | 56+ | P(win) at least 12% |
| watch | 34+ | P(win) at least 5% |
| avoid | 0+ | below that |

The anchors are held fixed across refits. What moves is the weight behind
them, and `tier_honesty` refuses a candidate whose bands stop earning their
claim. A score of 86 claims a 45% chance, not an 86% one.

### Calibration, and the prior

Every six hours a calibration job compares, per score band, the probability
the active model claimed against what actually happened on Robinhood Chain
launches that have resolved, and publishes the table (`GET
/api/oracle/calibration`). The model's own holdout reliability curve answers
"how did this model do on launches it never saw at fit time"; the calibration
table answers "how is it doing on this chain, live". Both are real and they
answer different questions.

Until the first refit is promoted, a cold boot scores with a **bootstrap
prior** fitted on the three.ws pump.fun corpus: 296k launches, held out on
74k the model never saw, with holdout AUCs of 0.840 for `win`, 0.918 for
`rug` and 0.892 for `moon`. It is a prior, not a claim about Robinhood
Chain: its SOL-denominated volume buckets are re-denominated to ETH at a
recorded rate, two features have no prior weight at all, and the dashboard,
`GET /api/status` and the landing page show `source: "bootstrap"` with the
provenance string until a promoted refit replaces it. `npm run
oracle:backfill` reconstructs features and labels from chain history so that
first refit can happen on day one instead of a month in.

## Guardrails and the kill-switch philosophy

The guard layer (`src/guards/`) sits between the entry gate and the executor
and exists so that no strategy, no LLM verdict and no optimizer run can take
on more risk than the operator bounded. Everything in it **fails closed**: a
number the guard cannot read refuses the buy rather than assuming the best.
Every buy passes fourteen checks in a fixed order, cheapest and most fatal
first: the global kill switch, a zero amount, the slippage bound, the
cooldown, the arm's own state, concurrency, the per-trade cap, the daily
budget, the daily loss breaker, the wallet floor, price impact, the firewall,
the oracle gate, and the entry filters. Each refusal is journaled with its
reason and a sentence a dashboard can show. The full table and every rule is
[guardrails.md](guardrails.md).

Four decisions in that layer are worth stating as principles:

**Sells are exempt from the exposure caps.** The caps bound how much risk an
arm takes on. A stop loss, a trailing stop or a timeout is risk coming off.
Refusing an exit because the arm is over budget would trap a losing position,
which is the outcome the stop exists to prevent. Sells still honor the kill
switch, the cooldown and the slippage bound.

**Unknown is refused.** A quote with no impact figure is a quote against a
pool with no depth to measure; an unreadable balance is a buy made blind.
Both came from real incidents on the Solana engine (one bought into unknown
depth, one drained a wallet on failed-transaction fees during an RPC gap),
and both are refused by name now.

**The floors are two different numbers.** `MIN_WALLET_ETH` (default 0.005
ETH) is the operator's reserve that pays for exits and tomorrow's gas.
`GAS_HEADROOM_WEI` (0.001 ETH) is what one round trip costs at the 2 gwei
base fee an Orbit chain reaches under congestion, reserved on top of the
reserve so the reserve never pays for the exit. The daily loss breaker fires
when realized 24-hour loss reaches half the daily budget, so a proven bleed
stops early instead of spending the rest of its budget one losing entry at a
time.

**A kill halts new risk and never sells.** The kill switch (SIGINT or
SIGTERM, a `KILL` file, `GLOBAL_KILL=1`, or `POST /api/kill`) refuses every
new buy and keeps managing exits: stops, trails, ladders and timeouts all
still fire. It never market-sells on its own, because a forced exit into thin
launch liquidity during whatever caused the panic is usually worse than
holding, and a human can always close one position with one explicit call.
Only an API kill is clearable at runtime; a file, signal or environment kill
is cleared where it was set, so a dashboard button can never override an
out-of-band operator action.

Above the checks sits **earned autonomy**: an arm's realized live record sets
its tier, and the tier bounds what the optimizer may change and how far.
`trusted` needs a size-weighted net edge of at least +0.5% over 12 closed
live trades with drawdown under 35%; `autonomous` needs +5% over 40 with
drawdown under 25%; an arm at or below -0.5% over 15 closed trades goes on
`probation`. Simulated fills never earn a tier. No tier can touch the kill
switch, the wallet floor, the loss breaker, the impact ceiling, concurrency,
slippage or the firewall, and every tier keeps a stop loss that can never be
unset. The optimizer itself proposes at most one bounded knob change per arm
every six hours, from the arm's own record, and journals it beside the trades
it learned from.

## The execution edge

Three things make a fill on this engine faster and safer than a fill that
starts from a block:

**Sequencer feed lead.** The engine holds the Robinhood Chain sequencer feed
open and decodes frames roughly 100 to 300 milliseconds before the block is
queryable over RPC. Factory calldata is matched on the frame; the launch is
then confirmed by its log. Every launch row records `feedLeadMs`, the
measured lead for that launch, so the edge is a number on the dashboard
rather than a claim in this document.

**Simulate first.** Before every live buy, the firewall runs a real simulated
buy followed by a simulated sell of what the buy would return, against the
live pool or curve. A token that can be bought but not sold is blocked, not
flagged. The risk engine runs before the firewall because the risk engine
costs nothing and the firewall costs an `eth_call` round trip.

**Parallel broadcast.** The swap is pre-built while the observation window
runs, and the signed raw transaction is broadcast to every configured RPC at
once. Nothing on the path from frame to broadcast touches HTTP routing, which
is why the choice of web framework is irrelevant to fill speed.

## The economics

There is **no token**. hood-oracle's economics are fees on value it
demonstrably produced and prices on data it demonstrably computed. Any token
layer would be a separate decision, made later, on its own merits, and
nothing in the protocol depends on one existing.

**Performance fee, at the contract level.** An arm account charges a
performance fee only on realized P&L above a per-position high-water mark:
a partial exit at a gain followed by one at a loss is never charged twice,
and a loss is fully recovered before the next fee. Nothing is charged on
deposits, losses or withdrawals. Each account snapshots the factory's rate at
creation, the protocol ceiling is 20% (2000 bps), and a rate change waits 24
hours in the open and never touches accounts that already exist. Because the
fee is computed by the account contract itself, an operator cannot charge a
fee the chain did not witness.

**Protocol fee split.** Accrued fees are released through `HoodFeeSplitter`,
a pull-based splitter with fixed payees and shares set at construction, so
the split between the protocol and whoever operates a given engine is
contract state anyone can read, not a line in a server config.

**Pay-per-score oracle data.** `GET /api/x402/score/:token` answers `402
Payment Required` until the request carries a signed USDG payment on
Robinhood Chain, then returns the verdict, the feature snapshot and the
firewall round trip: no account, no API key, and no gas for the buyer, who
signs an EIP-3009 authorization once. The price is set per engine and
published at `GET /api/x402/pricing`. The free public reads (the feed, the
coin page, the model, the streams) stay free; what is sold is one verdict on
demand for a caller that does not run an engine. Details: [x402.md](x402.md).

## Security and threat model

The threat model separates the market, the engine, and the keys.

**The market.** Most new launches go to zero; thin pools move against size;
a curve can be bought but not sold. This is what the guardrails, the
firewall, the stop loss and simulate mode address. They reduce risk; they do
not remove it, and every surface of the product says so.

**The engine.** The engine holds a hot key when an arm is live. The
server-side guardrails bound what that key does, but they run in the same
process that signs, so a bug, a dependency, or an operator error is inside
the boundary. Mitigations that exist today: simulate is the default, live
needs both a server key and an explicit per-arm write, the wallet is meant to
be funded with only what the operator can lose, the decisions journal is
hash-chained and verified on every read so an edited ledger says so, and the
kill switch has four independent triggers, three of which the engine cannot
clear.

**The keys.** The on-chain arm contracts move the boundary. In the account
model the engine's key is an `operator` that can only buy inside the policy
and sell; the caps, the allowed router, the slippage bound, the kill switch
and the oracle gate are policy on the account and revert on breach; a change
that tightens the policy applies at once while any loosening queues for an
hour in the open; the owner can withdraw at any time; and the quote token
cannot change while positions are open. Oracle attestations are EIP-712
structs with an observation time and an expiry, replay of a stale score is
refused, and revoking the signer makes every attestation that key ever posted
read as absent, at which point an account with an oracle floor refuses every
buy rather than opening up. So a leaked operator key buys at most one
capped trade per cooldown, up to the daily budget, in at most the allowed
number of positions, only through the allowed router, only above the oracle
floor, and can never withdraw or change policy; the owner sees the `Buy`
events, kills, and rotates the operator. The revert names mirror the
`RefusalReason` vocabulary the off-chain risk engine already journals, so the
dashboard maps a revert selector straight onto the reason an operator already
knows.

What the contracts do not protect against: a policy the owner set too loose
(the caps are the loss budget for a compromised key, not a trading
preference), a leaked owner key, a router that is itself compromised, or a
pool that is honest for the buy and manipulated for the sell by an attacker
who also holds the operator key. The firewall simulation still runs off-chain
before every buy for that last case, and the caps still bound it. The
contracts are written and unit-tested against a live-pool fork; they are not
deployed and not audited. The roadmap below states the order in which that
changes, and [contracts.md](contracts.md) has the threat model in full.

## Roadmap

Phased, and each phase is a state you can check rather than a date:

1. **Simulate fleet live.** The engine runs against the mainnet sequencer
   feed with simulated arms, the oracle board is public, and the labeler and
   calibration jobs are producing rows.
2. **First promoted refit.** The refit job passes the promotion gate on
   Robinhood Chain labels and `GET /api/status` reports `model.source:
   "promoted"`. From here the score is a measured claim about this chain.
3. **Contracts audited and deployed.** The arm account, its factory, the
   attestation verifier and the fee splitter are audited and deployed on
   4663, with addresses recorded in the contracts documentation.
4. **On-chain arms open to the public.** Anyone can deploy an account, set a
   policy, deposit, and name the engine as operator; the dashboard shows
   on-chain refusals beside off-chain ones.
5. **Oracle attestations consumed by third-party contracts.** The signed
   verdict is a primitive other Robinhood Chain contracts read: a launchpad
   gate, a vault's entry rule, an agent's own account.
6. **v4 routing.** The engine already observes and scores v4 launches, which
   is where most launch-shaped activity on 4663 now happens, and already
   registers 17 launchpads. What remains is routing: swapping through the v4
   PoolManager behind a hook the registry has read and verified, with the
   same firewall round trip gating every buy.

## Relationship to three.ws

hood-oracle is a sibling of [three.ws](https://three.ws). The conviction
oracle (three heads, the bucketed logistic fit, the promotion gate, the
price-independent labels) and the guardrail layer (the ordered risk engine,
the kill switch semantics, earned autonomy, the bounded optimizer) were
extracted from the three.ws Solana sniper, the engine behind
[three.ws/oracle](https://three.ws/oracle), and re-fitted for an EVM chain.
What changed in the port: wei instead of lamports, ETH gas headroom instead
of rent, Uniswap v3 and Odyssey curves instead of pump.fun, a sequencer feed
instead of a Geyser stream, and fit thresholds sized for a chain that
launches a few dozen tokens a week rather than a few thousand a day. The
lessons that shaped the guardrails were learned there with real money, which
is why this document can name the incident behind each rule.

## Further reading

- [architecture.md](architecture.md): the process, the boot order, the money rules
- [oracle.md](oracle.md): every feature, the heads, labels, fit, gate, calibration, backfill
- [guardrails.md](guardrails.md): every check, the kill switch, autonomy, the optimizer
- [arming.md](arming.md): simulate, read the ledger, go live, earn autonomy
- [contracts.md](contracts.md): the on-chain arm, its four contracts, gas and the threat model
- [api.md](api.md): every route with examples
- [site-build.md](site-build.md): how this site is built and served
