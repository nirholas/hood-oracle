# The oracle

The conviction oracle scores every NOXA and Odyssey launch 0 to 100 in its
first ninety seconds and tiers it. It is a bucketed logistic model with three
heads, fitted from realized outcomes, re-fitted on a clock, and promoted only
through a gate it can fail. This document is the whole machine: the features,
the heads, the tiers, the labels, the fit, the promotion gate, calibration,
and the backfill that lets the first refit happen on day one.

The code is in `src/oracle/`:

| File | Role |
|---|---|
| `features.ts` | The feature list: key, pillar, bucket edges, and how each value is read. Fitter and scorer share `bucketLabel`. |
| `conviction.ts` | The pure scorer: model document in, verdict out. `TIERS`, `TIER_PROBABILITY_ANCHORS`, `createConviction`. |
| `fit.ts` | The pure fitter: labeled rows in, model out, with holdout metrics. |
| `bootstrap-model.json` | The prior a cold boot scores with until a refit is promoted. |
| `eth-edges.json` | The SOL to ETH re-denomination of the prior's volume buckets, with the rate, its source and its date. |

## What the score means

**The score is not a percentage.** It is a monotone map of P(win) onto a 0 to
100 ladder whose rungs are fixed probability claims:

| Tier | Score | Claims |
|---|---|---|
| prime | 86+ | P(win) at least 45% |
| strong | 72+ | P(win) at least 25% |
| lean | 56+ | P(win) at least 12% |
| watch | 34+ | P(win) at least 5% |
| avoid | 0+ | below that |

The anchors (`TIER_PROBABILITY_ANCHORS`) are held fixed across refits. What
moves is the weight behind them, and the promotion gate refuses any candidate
whose bands stop earning their claim. A score of 86 claims a 45% chance, not
an 86% one.

Only `prime` and `strong` are act signals. A conviction engine that likes
everything is a hype engine.

## Three heads, not one

| Head | Question |
|---|---|
| `win` | Did it run (2x from first sight), **and** is a first-sight holder still up? |
| `rug` | Is a first-sight holder down more than half? |
| `moon` | Did it run at all, whatever happened next? |

The published score anchors on `win`. Rug risk is published beside it as its
own number (`rugRisk` on every verdict, `maxRugRisk` on every arm) rather than
folded in, because "this will probably run" and "this will probably take your
money" are different questions and one number that averages them answers
neither. `moon` is kept so successive fits stay comparable, and so the coin
page can show give-back risk: `1 - P(win) / P(moon)`, how often a launch like
this hands the run straight back.

## The features

26 EVM-native features in four pillars, measured over the 90-second window
after first sight. Volumes are in ETH. Ratios are 0 to 1. A feature whose
source was unavailable (an RPC gap, no pool yet on an Odyssey curve) is
recorded in the snapshot's `missing` list and scored as the fitted null
bucket, never fabricated; `confidence` on the verdict is the share of
features actually observed.

### Structure: how the launch is put together

| Feature | Definition | Buckets |
|---|---|---|
| `organic_score` | Share of buy volume from wallets with no link to the deployer or to each other. | <0.2, 0.2-0.4, 0.4-0.6, 0.6-0.8, >=0.8 |
| `bundle_score` | Share of supply acquired in the deploy transaction or the same block by linked wallets. | <0.1, 0.1-0.3, 0.3-0.5, >=0.5 |
| `snipe_ratio` | Share of the first-block volume from bots. Mid-range beats both extremes: bots racing an open is demand; 70%+ is poison. | <0.1, 0.1-0.3, 0.3-0.7, >=0.7 |
| `coordination_score` | How synchronised the early buys are in timing and size. | <0.1, 0.1-0.3, >=0.3 |
| `timing_entropy` | Entropy of buy arrival times over the window; low means one actor. | <0.2 ... >=0.8 |
| `concentration_top1` | Supply share of the largest holder at window end. | <0.05, 0.05-0.15, 0.15-0.3, >=0.3 |
| `concentration_top5` | Supply share of the top 5. | <0.3, 0.3-0.6, 0.6-0.9, >=0.9 |
| `concentration_top10` | Supply share of the top 10. Non-monotone: low concentration 90s in usually means nobody bought. | <0.3, 0.3-0.9, >=0.9 |
| `fresh_wallet_ratio` | Share of buyers whose address has no prior history. | <0.2, 0.2-0.5, 0.5-0.8, >=0.8 |
| `bubblemap_connectivity` | Share of holders connected through a common funder. | <0.1, 0.1-0.3, 0.3-0.6, >=0.6 |

### Momentum: what the first 90 seconds of tape did

| Feature | Definition | Buckets |
|---|---|---|
| `unique_buyers` | Distinct buying addresses. | <1, 1-5, 5-15, 15-40, >=40 |
| `unique_sellers` | Distinct selling addresses. | <1, 1-3, 3-10, >=10 |
| `buy_sell_ratio` | Buy volume over sell volume. | <0.5, 0.5-1, 1-2, 2-4, >=4 |
| `buy_volume_eth` | Total ETH spent buying. | ETH edges from `eth-edges.json` |
| `sell_volume_eth` | Total ETH received selling. | ETH edges |
| `net_volume_eth` | Buy minus sell. | ETH edges |
| `trade_count` | Buys plus sells. | <3, 3-12, 12-40, >=40 |
| `largest_buy_eth` | The single largest buy. | ETH edges |
| `avg_buy_eth` | Mean buy size. | ETH edges |
| `median_buy_eth` | Median buy size. | ETH edges |
| `mc_eth_first_seen` | Market cap in ETH at first sight. The dead-on-arrival tell. | ETH edges |

### Pedigree: who launched it

| Feature | Definition | Buckets |
|---|---|---|
| `dev_buy_eth` | ETH the deployer spent buying in the window. | ETH edges |
| `dev_sell_eth` | ETH the deployer received selling in the window. | ETH edges |
| `dev_sold` | Whether the deployer sold at all in the window. | false / true |
| `smart_money_count` | Wallets with a proven record buying in the window. On the pump.fun corpus 2-4 of them meant a 55% win rate against a 3% base. | <1, 1-2, 2-4, >=4 |
| `creator_launches` / `creator_wins` | Read as one categorical `creator_record`: `unknown`, `first_launch`, `repeat_no_wins` (2-4, none won), `serial_no_wins` (5+, none won), `has_wins`. | categorical |
| `deployer_holding_pct` | Share of supply the deployer still holds at window end. NOXA locks the LP forever, so this is the cleanest dump-capacity read on this chain. Not in the prior; enters on the first refit. | <0.02, 0.02-0.1, 0.1-0.3, >=0.3 |

### Narrative: what the coin says it is

| Feature | Definition | Buckets |
|---|---|---|
| `category` | Classified from name, symbol and metadata: `meme`, `tech`, `ai`, `culture`, `community`, `political`, `news`, `animal`, `celebrity`, `utility`, `stock`, `unknown`. | categorical |
| `narrative_confidence` | How sure the classifier was. A confident `meme` and a guessed `meme` are different observations. Not in the prior. | <0.3, 0.3-0.6, 0.6-0.85, >=0.85 |

Buckets rather than slopes because several of these signals are genuinely
non-monotone, and a linear term would fight the data at both ends. Every
bucket weight ships with its sample size and observed outcome rate, and the
verdict's `reasons` quote them: "40+ early buyers: 80% of similar launches
worked (6.8x base rate)".

## The labels

Labels resolve **24 hours** after first sight from chain history (`launches`,
pool and curve state, holder balances) and they are **price-independent**:
they are ratios of two readings of the same market cap, so the price of ETH
cancels out. This matters because the first version of the three.ws labeler
compared market caps to a dollar threshold, and for weeks its "rug rate"
tracked the price of SOL rather than any property of the coins.

```
retained      = last_market_cap / ath_market_cap
hold_multiple = ath_multiple * retained      # what a first-sight holder has now

moon = graduated OR ath_multiple >= 2
rug  = NOT graduated AND hold_multiple <= 0.5
win  = moon AND hold_multiple >= 1
```

A row with no `hold_multiple` cannot answer the survival question, so it is
neither a `win` nor a `rug`; it is never read as a 100% drawdown.

**Realized outcomes override chart labels.** When one of our own positions
closed on a token, `realizedWin` and `realizedPnlPct` from that position are
the label for that token (`oracle_outcomes.realized_*`), because what we
actually got out is a better teacher than what a chart says a holder could
have got. `labelVersion` stamps which rule judged a row; the fitter trains on
the current version only.

## The fit

One bucketed logistic regression per head over a shared one-hot design
matrix, by stochastic gradient descent, in `fit.ts`. Rows arrive oldest first.
The newest slice is held out; each head is fitted on the older slice to earn
an honest holdout number, then refitted on everything for the weights that
ship.

```
z_head = intercept_head + sum(bucket weight for each observed feature)
p_head = sigmoid(z_head)
score  = piecewise-linear map of p_win through the tier anchors
```

Two things keep a small corpus honest:

- **Shrinkage.** After the fit every weight is pulled toward zero in
  proportion to its evidence: `w * n / (n + SHRINK_PRIOR)` with
  `SHRINK_PRIOR = 50`. A bucket with 50 rows keeps half its fitted weight, one
  with 500 keeps 91%, one with 5 keeps 9%. Applied before evaluation, so the
  holdout numbers describe the weights that actually ship.
- **Degenerate features drop themselves.** A feature whose runner-up bucket
  holds fewer than `MIN_MINORITY_ROWS` (10) rows cannot support a second
  weight and is dropped, by name, into the report. Deliberately not a share
  test: smart money is rare and is the strongest thing the corpus knows.

The thresholds are sized for a young chain. three.ws refuses to fit under
5,000 rows; Robinhood Chain launches a few dozen tokens a week.
`MIN_TRAINING_ROWS = 400` with `MIN_HOLDOUT_ROWS = 100` held out leaves, at a
5% base rate, about five positives in the holdout, which is the floor at which
an AUC of 0.70 is distinguishable from 0.50 at all. Below it every candidate
would be judged on noise and the gate would be theatre.

The holdout report carries, per head: AUC, Brier score, precision in the top
5%, and a reliability table (predicted vs observed per probability band).

## The promotion gate

The refit job runs every 6 hours: load labeled rows, fit a candidate, evaluate
it, and decide. A candidate is stored in `oracle_models` either way, with its
`status`, `reason` and every `check` it passed or failed, and the live model
is only replaced when all of these hold:

| Check | Fails when |
|---|---|
| `fit_complete` | The fit ran out of time before its last epoch. |
| `absolute_auc` | The `win` holdout AUC is under 0.70. |
| `tier_honesty` | Any tier band with at least 100 holdout rows observes less than 70% of the probability it claims. |
| `feature_set` | The candidate carries materially fewer features than the incumbent (a signal source is probably broken). |
| `no_regression_rug`, `no_regression_moon` | Either non-score head regressed beyond tolerance. |
| `auc_gain` | The `win` AUC did not beat the incumbent by more than fit noise (0.004). |

A losing candidate is archived with the reason. The first model on the
current label version promotes on the absolute checks alone. `GET
/api/oracle/models` lists every candidate with its checks; `GET
/api/oracle/model` is the one every score is computed under right now.

## The bootstrap prior, and why it is displayed as a prior

The shipped `bootstrap-model.json` was fitted on the three.ws pump.fun corpus
(296k launches, held out on 74k the model never saw: win AUC 0.840, rug 0.918,
moon 0.892). It is what a cold boot scores with. It is **a prior, not a claim
about Robinhood Chain**:

- Its volume buckets were fitted in SOL. `scripts/convert-bootstrap.ts`
  re-denominates every `_sol` edge to ETH at a live SOL/USD and ETH/USD rate
  (CoinGecko, keyless), rounds to three significant figures, and writes both
  `eth-edges.json` and the model, with the rate, source and fetch time in the
  model's `provenance` string. A test asserts the two files agree.
- Two features (`deployer_holding_pct`, `narrative_confidence`) have no prior
  weight at all and enter on the first refit.
- The launch mechanics differ: pump.fun's fixed curve start becomes an ETH
  market cap at first sight, and NOXA's locked LP changes what a deployer can
  do.

So the dashboard and `GET /api/status` show `model.source: "bootstrap"` with
the provenance string until the first promoted refit flips it to
`"promoted"`. A score under the prior is a reasonable starting opinion, not a
measured Robinhood Chain hit rate, and the UI says so.

## Calibration

Every 6 hours the calibration job compares, for each score band, the
probability the active model claimed against what actually happened on
Robinhood Chain launches that have resolved, and stores the table under the
`oracle:calibration` settings key (`GET /api/oracle/calibration`). The
model's own holdout reliability curve (in `GET /api/oracle/model`) answers
"how did this model do on launches it never saw at fit time"; the calibration
table answers "how is it doing on this chain, live". Both are real and they
answer different questions; any surface showing one says which.

## Backfill

```bash
npm run oracle:backfill -- --days 30
```

Walks every launchpad in the intake registry back `--days` from the head
block, plus the bare Uniswap v3 `PoolCreated` and v4 `Initialize` events that
pair a fresh token with WETH, USDG or ETH, reconstructs a launch row and a
90-second feature snapshot for every token it finds, resolves labels for
everything past the 24-hour horizon, and scores each one under the active
model so the board is populated. Idempotent: a token that already carries a
feature row is skipped and a launch that already has an outcome is not
re-labeled, so an interrupted run resumes where it stopped. The snapshot's
`missing` list is honest about what history cannot recover (holder graphs at a
past block need an archive node, and the public gateway does not serve
historical nonces at all). This is what makes the first refit possible on day
one instead of a month in.

Useful flags: `--no-scan` skips discovery and only fills in features and
labels for launches already in the database, `--no-labels` does the opposite,
and `--from-block N --to-block M` replaces the `--days` window.

**Budget real time for it.** Each label costs one `eth_getLogs` over the
token's whole 24-hour horizon plus one liquidity `eth_call`, and the public
Robinhood Chain gateway meters execution calls separately from cheap reads:
once that budget is spent it answers 429 and the client waits out a 60-second
window before continuing. A few hundred launches is minutes on an Alchemy
accelerator endpoint and hours on the public gateway. Put an accelerator first
in `RPC_URLS` before a large backfill ([deploy.md](deploy.md#3-the-rpc-alchemy-accelerator));
the run is resumable either way, so an interrupted one costs nothing but the
work it had already done.

```bash
npm run oracle:fit
```

Runs one refit through exactly the code path the scheduled job uses: fits a
candidate from the labeled rows, persists it with its promotion checks, and
**promotes it if it clears the gate**. It is not a dry run. What it prints is
what happened: `fitted`, `promoted`, the reason, the holdout metrics, and the
active model version before and after.

It refuses to fit at all below `MIN_TRAINING_ROWS` (400 rows carrying the
current `LABEL_VERSION`) and says how many it found, which is the answer to
"why did nothing happen on a fresh chain": label more history first.
