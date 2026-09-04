# hood-oracle

An autonomous launch trader for **Robinhood Chain** (chain id 4663, an Arbitrum
Orbit L2). It holds the chain's sequencer feed open, watches every token that
launches on **NOXA** and **The Odyssey**, scores each one in its first ninety
seconds with a conviction oracle that re-fits itself from realized outcomes, and
executes through hard guardrails on behalf of the strategies ("arms") an
operator has armed. One Node 24 process: the trading loop, the HTTP control
plane and the live dashboard run in the same container, so an arm change is
visible to the engine on the next tick.

The oracle and the guardrails were extracted from the three.ws Solana sniper
(the engine behind [three.ws/oracle](https://three.ws/oracle)) and re-fitted
for an EVM chain where gas is ETH, liquidity lives in Uniswap v3 pools or on an
Odyssey bonding curve, and launches arrive a few dozen a week rather than a few
thousand a day. Every number the model publishes is one it earned on launches
it never saw, and the same purely functional scorer runs in the engine, the API
and the CLI, so they can never disagree about what "the model" means.

> ## Risk disclaimer
> This software can autonomously sign and broadcast **real transactions with
> real funds** when an arm is in live mode. Trading is risky. **Most new token
> launches go to zero.** Thin pools move against you, a bonding curve can be
> bought but not sold, and software has bugs. There are no guarantees, no
> warranty, and no recovery for funds lost to a bug, a bad market, or a
> misconfigured guardrail. **Simulate mode is the default for every arm and
> touches no funds.** Live mode requires `TRADER_PRIVATE_KEY` on the server
> **and** an explicit per-arm `mode: "live"` write, and the API refuses to arm
> anything without a stop loss. Start in simulate mode. Use a wallet you can
> afford to lose. You are responsible for every transaction this software signs
> on your behalf.

## Quickstart

Local Postgres in Docker, the engine on your machine. Node 24 or newer.

```bash
git clone https://github.com/nirholas/hood-oracle.git
cd hood-oracle
cp .env.example .env            # DATABASE_URL already matches the compose db
docker compose up -d db         # Postgres 17 on localhost:5432
npm install
npm run db:migrate              # applies src/db/migrations
npm run oracle:backfill -- --days 30   # rebuild features + labels from chain history
npm run dev                     # tsx watch src/index.ts
```

Open <http://localhost:8080>. The dashboard is live: the oracle board fills as
launches are scored, the arm page is where you create and arm strategies, and
the positions tape shows every open and closed position with its exit reason.

The whole stack in Docker instead:

```bash
docker compose up --build
```

Writes (creating, arming, killing) need `OPERATOR_TOKEN` in `.env`; generate
one with `openssl rand -hex 32`. Reads and the dashboard are public.

## Architecture

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

A fill is: sequencer frame decoded (100 to 300ms before the block is
queryable), factory calldata matched, launch confirmed by log, 0 to 90s of
observation (the arm's `buyDelayMs`), score, guards, firewall simulation,
pre-built swap, raw transaction broadcast to every RPC in parallel. Nothing on
that path touches HTTP routing. The full map of directories, the boot order
and the money rules are in [docs/architecture.md](docs/architecture.md).

## Arms: the knobs

An arm is one strategy: a row of knobs deciding what to buy, how much, and when
to exit. Arming flips it `enabled`. Wei fields are sent as decimal wei strings
or through the `perTradeEth` / `dailyBudgetEth` spellings.

| Knob | Unit | Default | Protects against |
|---|---|---|---|
| `label` | text | required | Nothing; it names the arm in every journal row and alert. |
| `network` | `mainnet` / `testnet` | server `HOOD_NETWORK` | Arming a testnet strategy on mainnet by accident. |
| `enabled` | bool | `false` | Every arm starts disarmed. |
| `killSwitch` | bool | `false` | Per-arm halt on new buys; exits keep managing. Set by `POST /api/arms/:id/kill`. |
| `mode` | `simulate` / `live` | `simulate` | Real signing. Live additionally needs `TRADER_PRIVATE_KEY` and a funded wallet. |
| `trigger` | `new_launch` / `graduation` / `oracle_crossing` | `new_launch` | Which event opens a position: first sight, an Odyssey curve graduating to a pool, or a re-score crossing `minOracleScore`. |
| `launchpads` | list of `noxa` / `odyssey` | both | Restricting the universe to one launchpad's mechanics. |
| `perTradeWei` | wei | `0` | Position size. A `0` refuses every buy (fail closed). |
| `dailyBudgetWei` | wei | `0` | Total buys in a rolling 24h. The real spend ceiling; a per-trade size may equal it, never exceed it. |
| `maxConcurrentPositions` | count | `1` | Correlated exposure across simultaneous launches. |
| `cooldownSeconds` | seconds | `0` | Machine-gunning entries into a launch storm. Applies to sells too. |
| `slippageBps` | basis points | `500` | The maximum slippage an order may execute with. |
| `maxPriceImpactPct` | percent | `10` | Buying into a pool too thin for the size. A quote with no impact is refused, not assumed. |
| `firewallLevel` | `block` / `warn` / `off` | `block` | Whether a failed buy-then-sell simulation blocks the buy, annotates it, or is ignored. |
| `buyDelayMs` | ms | `0` | How much of the 90s observation window to wait before buying; more tape, less edge on speed. |
| `minOracleScore` | 0..100 or null | null | Entering below a conviction floor. Tiers: watch 34, lean 56, strong 72, prime 86. |
| `maxRugRisk` | 0..1 or null | null | Entering when the rug head says a first-sight holder is likely down more than half. |
| `minUniqueBuyers` | count or null | null | Launches nobody bought. |
| `maxCreatorLaunches` | count or null | null | Serial launchers. |
| `maxDeployerPct` | percent or null | null | A deployer still holding enough supply to dump on you. |
| `maxBundleScore` | 0..100 or null | null | Bundled supply. |
| `maxConcentrationTop1` | 0..1 or null | null | One wallet holding the float. |
| `minMarketCapEth` / `maxMarketCapEth` | ETH or null | null | Entering outside the band where this arm actually wins. |
| `requireSocials` | bool | `false` | Launches with no website, X or Telegram in metadata. |
| `avoidDevDump` | bool | `true` | Launches where the developer sold inside the observation window. |
| `allowedCategories` | list or null | null | Narratives this arm does not trade (`meme`, `ai`, `tech`, ...). |
| `stopLossPct` | percent | `30` | The loss the position is closed at. Required above 0 to arm; no tier can unset it. |
| `takeProfitPct` | percent or null | null | Winners expiring unrealized. |
| `trailingStopPct` | percent or null | null | Giving a run back. Measured from the peak value. |
| `maxHoldSeconds` | seconds | `1800` | Holding a dead position forever. |
| `liquidityDecaySeconds` | seconds or null | null | Sitting in a pool whose value has been stale for this long. |
| `initialsOutMultiple` | multiple or null | null | The take-initials ladder: recover the stake at this multiple and let the rest ride. |
| `moonbagMinPct` | percent | `15` | How much of a winner keeps riding after the initials come out. |
| `moonbagAlways` | bool | `false` | Never fully selling a winner, ladder or no ladder. |
| `decisionMode` | `rules` / `llm` | `rules` | Whether an LLM judge gets a vote after the rules pass. |
| `llmMinConfidence` | 0..1 or null | null | Acting on a low-confidence LLM verdict. |
| `autoOptimize` | bool | `false` | Opt-in to the 6h optimizer moving this arm's knobs. |
| `autonomyTier` | `probation` / `standard` / `trusted` / `autonomous` | `standard` | How wide the optimizer may search; recomputed from the live record. |
| `telegramChatId` | chat id or null | null | Alerts for this arm go to a different chat. |
| `experimentGroup` | text or null | null | Grouping arms for A/B reads. |

The walkthrough from a first simulated arm to a live one is
[docs/arming.md](docs/arming.md).

## Guardrails

Every buy passes these in this order before the executor sees it. A refusal is
journaled with its reason and shown on the dashboard in plain language. Sells
are exempt from the exposure caps (a cap must never trap a losing position)
but still honor the kill switch, cooldown and slippage bound.

| Check | Refusal | Fails closed when |
|---|---|---|
| Global kill switch | `kill_switch` | Tripped by SIGINT/SIGTERM, the `KILL` file, `GLOBAL_KILL=1`, or `POST /api/kill`. |
| Amount | `zero_amount` | The order is 0 wei. |
| Slippage bound | `slippage_bound` | The order's slippage exceeds `slippageBps`. |
| Cooldown | `cooldown` | Less than `cooldownSeconds` since this arm's last trade. |
| Arm state | `disarmed` | The arm is disabled or its own kill switch is set. |
| Concurrency | `concurrency` | `maxConcurrentPositions` are already open. |
| Per-trade cap | `per_trade_cap` | The buy exceeds `perTradeWei`, or `perTradeWei` is 0. |
| Daily budget | `daily_budget` | 24h spend plus this buy exceeds `dailyBudgetWei`, or the budget is 0. |
| Daily loss breaker | `daily_loss` | Realized 24h loss reaches half the daily budget. |
| Wallet floor | `wallet_floor` | The balance could not be read, or the buy would leave less than `MIN_WALLET_ETH` plus 0.001 ETH gas headroom. |
| Price impact | `price_impact` | The quote has no impact figure, or impact exceeds `maxPriceImpactPct`. |
| Firewall | `firewall` | A real simulated buy-then-sell round trip fails or loses too much. |
| Oracle gate | `oracle_gate` | Score below `minOracleScore` or rug risk above `maxRugRisk`. |
| Entry filters | `entry_filter` | Any of the structural, pedigree or narrative filters above. |

The full write-up, including what the kill switch will and will not clear, is
[docs/guardrails.md](docs/guardrails.md).

## How the oracle learns

1. Every launch gets a 90-second feature snapshot (26 EVM-native features
   across structure, momentum, pedigree and narrative) and a score under the
   active model.
2. **Labels resolve 24h later** from chain history and are price-independent:
   `moon` means it ran at all, `rug` means a first-sight holder is down more
   than half, `win` means it ran **and** a first-sight holder is still up. A
   position we actually closed overrides the chart label for that token.
3. **The refit job** (every 6h) fits three logistic heads on bucketed
   features with a time-split holdout and runs a **promotion gate**: an
   absolute AUC floor, every tier band still earning at least 70% of the
   probability it claims, no collapse of the feature set, and a gain over the
   incumbent bigger than fit noise. A losing candidate is archived with the
   reason and the live model is untouched.
4. **The bootstrap prior** shipped in `src/oracle/bootstrap-model.json` was
   fitted on the three.ws pump.fun corpus (296k launches). It is a prior, not
   a claim about Robinhood Chain: its SOL-denominated bucket edges are
   re-denominated to ETH at a recorded exchange rate, and the dashboard shows
   its provenance as `bootstrap` until the first promoted refit replaces it.
   `npm run oracle:backfill` reconstructs features and labels from chain
   history so that first refit can happen on day one.

Feature definitions, the heads, tiers, fit and calibration are in
[docs/oracle.md](docs/oracle.md).

## API

Reads are public. Writes need `Authorization: Bearer <OPERATOR_TOKEN>`. Wei
serializes as decimal strings, dates as ISO 8601, and every error is
`{ "error": code, "message": text }`. Examples for every route are in
[docs/api.md](docs/api.md).

| Route | What it does |
|---|---|
| `GET /api/health` | Liveness: uptime, start time. The container HEALTHCHECK. |
| `GET /api/status` | Engine health (feed, head block, wallet, kill state), model provenance, table counts. |
| `GET /api/arms` | Every arm with its open/closed/wins/P&L summary. |
| `POST /api/arms` | Create an arm (optionally enabled). |
| `GET /api/arms/:id` | One arm. |
| `PATCH /api/arms/:id` | Update knobs. Unknown keys are rejected. |
| `DELETE /api/arms/:id` | Delete an arm and its positions. |
| `POST /api/arms/:id/arm` | Enable. Refused without a stop loss, a per-trade size, a budget that covers one trade, or (live) a live wallet. |
| `POST /api/arms/:id/disarm` | Disable new buys; exits keep managing. |
| `POST /api/arms/:id/kill` | Disable and set the arm's own kill switch. |
| `GET /api/auth/nonce` | Issue an EIP-4361 nonce for wallet sign-in. |
| `POST /api/auth/verify` | Verify the signed message and open a session. |
| `GET /api/auth/me` | The signed-in address and the accounts it owns. |
| `POST /api/auth/logout` | Revoke the session. |
| `GET /api/accounts` | On-chain arm accounts this wallet owns, re-synced from the factory. |
| `POST /api/accounts/prepare` | Unsigned calldata that clones an account under a policy. |
| `POST /api/accounts/register` | Record an account from its create transaction. |
| `GET /api/accounts/:address` | Cached row, live chain state, bound arms, realized record. |
| `POST /api/accounts/:address/policy/prepare` | Unsigned `setPolicy` calldata; says whether it lands now or queues an hour. |
| `POST /api/accounts/:address/refresh` | Re-read one account from the chain now. |
| `GET /api/kill` | Global kill state and reason. |
| `POST /api/kill` | Trip the global kill switch with a reason. |
| `DELETE /api/kill` | Clear an API kill. Signal, file and env kills answer 409. |
| `GET /api/oracle/feed` | Latest score per token joined to its launch and features. Filters: `tier`, `launchpad`, `since`, `limit`. |
| `GET /api/oracle/coin/:token` | Everything about one launch: features, score history, firewall runs, positions, decisions, creator record, outcome. |
| `GET /api/oracle/model` | The active model: heads, tier anchors, holdout metrics, features with bucket counts. |
| `GET /api/oracle/models` | Every fitted candidate with its promotion checks and reason. |
| `GET /api/oracle/calibration` | The latest realized calibration table. |
| `GET /api/oracle/stream` | SSE: launches, features and scores as they happen. |
| `GET /api/positions` | Positions, open first. Filters: `status`, `arm`, `limit`. |
| `POST /api/positions/:id/close` | Close an open position at market now. |
| `GET /api/trades` | Trades. Filters: `arm`, `token`, `limit`. |
| `GET /api/decisions` | The hash-chained journal, with a chain verification result. |
| `GET /api/equity` | Realized, open and total equity curves per arm. |
| `GET /api/stream` | SSE: every engine event, with a replay of the recent ring buffer on connect. |
| `GET /api/ready` | Readiness (engine startup, database, data path, model), distinct from liveness. 503 with reasons while the engine is still starting. |
| `GET /api/metrics` | Prometheus text: process, event-loop lag, HTTP by route, engine gauges and bus counters. |
| `GET /api/x402/pricing` | Free: what a paid verdict costs (USDG on 4663) and how to pay. |
| `GET /api/x402/score/:token` | Paid over x402: the latest verdict, features and firewall for one token. See [docs/x402.md](docs/x402.md). |
| `POST` / `GET` / `DELETE /mcp` | The MCP server over Streamable HTTP. See [docs/mcp.md](docs/mcp.md). |

Every response carries security headers and an `X-Request-Id`; reads are
rate-limited at 600 per minute per client and writes at 30, bodies are
capped at 64KB, and CORS is same-origin unless `CORS_ORIGINS` opens it. The
details are in [docs/api.md](docs/api.md#hardening).

## Non-custodial accounts

Anyone with a wallet can trade this engine without handing it a key. Sign in
at `/app/connect` with one EIP-4361 signature, deploy a `HoodArmAccount` from
your own wallet, fund it, and point an arm at it. The engine is only the
account's **operator**: the contract lets it call `buy` and `sell` inside the
per-trade cap, daily budget, cooldown, concurrency, slippage bound and oracle
gate you wrote on chain, and lets it do nothing else. Withdrawal, policy
changes, operator rotation and the kill switch stay with the owner. Loosening
a bound queues for an hour; tightening one lands immediately; rotating the
operator away disarms every arm bound to the account within a minute.

Every buy is pre-flighted with an `eth_call` of the exact account call, so a
policy refusal is journaled as `per_trade_cap` or `cooldown` instead of
costing gas to learn. [docs/multi-tenant.md](docs/multi-tenant.md).

## Agents: MCP, SDK, x402

**MCP.** `npx hood-oracle-mcp` (or `npm run mcp`) is an MCP server over
stdio for Claude Code, Claude Desktop and any MCP client; the engine also
serves the same tools over Streamable HTTP at `/mcp`. Tools: `engine_status`,
`oracle_feed`, `oracle_score`, `oracle_model`, `arms_list`, `arm_get`,
`arm_create`, `arm_update`, `arm_enable`, `arm_disable`, `arm_kill`,
`kill_switch`, `positions_list`, `position_close`, `trades_list`,
`decisions_list`; resources `hood-oracle://status`, `hood-oracle://oracle/feed`
and `hood-oracle://docs/{slug}`. Writes need the operator token. Setup and
every tool's arguments: [docs/mcp.md](docs/mcp.md).

**SDK.** [`@hood-oracle/sdk`](packages/sdk) is a typed client for every
route with an async iterator over the SSE stream, `waitForScore`, and an
x402 helper. [docs/sdk.md](docs/sdk.md).

**x402.** `GET /api/x402/score/:token` sells one verdict for USDG on
Robinhood Chain over the hood402 rail; set `X402_PAY_TO` to enable it.
[docs/x402.md](docs/x402.md).

## Deploying

Production runs on Google Cloud Run as one always-on instance (the engine
holds a websocket open and must never be scaled to zero or CPU-throttled).
`cloudbuild.yaml` builds the image, pushes it to Artifact Registry and deploys
with every credential read from Secret Manager:

```bash
gcloud builds submit --config cloudbuild.yaml --region us-central1 \
  --project aerial-vehicle-466722-p5 \
  --substitutions=SHORT_SHA=manual$(date +%s)
```

The runbook with the secret creation commands, the Alchemy accelerator RPC
setup (the single biggest fill-latency win) and rollback is
[docs/deploy.md](docs/deploy.md).

## Relationship to three.ws

hood-oracle is a sibling of [three.ws](https://github.com/nirholas/three.ws).
The conviction oracle (three heads, bucketed logistic fit, the promotion gate,
the price-independent labels) and the guardrail layer (the ordered risk
engine, the kill switch semantics, earned autonomy, the bounded optimizer) were
extracted from the three.ws Solana sniper and re-fitted for Robinhood Chain.
The live Solana engine is at [three.ws/oracle](https://three.ws/oracle). What
changed in the port: wei instead of lamports, ETH gas headroom instead of
rent, Uniswap v3 and Odyssey curves instead of pump.fun, a sequencer feed
instead of a Geyser stream, and fit thresholds sized for a young chain.

## Repository map

| Path | What lives there |
|---|---|
| `src/types.ts` | Every shared domain type. The contract. |
| `src/config.ts` | Environment parsing; fails at boot, not mid-trade. |
| `src/db/` | Drizzle schema, client, migrations. Wei is `numeric(40,0)`, never float. |
| `src/chain/` | viem client, sequencer feed, launchpad watchers, ABIs. |
| `src/engine/` | Intake, observation window, scoring pipeline, executor, positions sweep, journal. |
| `src/oracle/` | Features, conviction engine, fitter, bootstrap prior. |
| `src/guards/` | Risk engine, kill switch, earned autonomy, optimizer. |
| `src/accounts/` | Wallet sign-in (EIP-4361), sessions, the on-chain account registry, the policy codec. |
| `src/api/` | Hono routes, shared handlers, middleware (headers, request ids, rate limit, CORS), metrics, operator auth, SSE, x402, static dashboard. |
| `src/mcp/` | The MCP server: tools and resources over stdio and Streamable HTTP. |
| `packages/sdk/` | `@hood-oracle/sdk`, the typed TypeScript client. |
| `web/` | The Vite dashboard. |
| `scripts/` | Backfill, fit and bootstrap-conversion CLIs, the house-rules checker. |
| `tests/` | Vitest. `npm test`. |
| `docs/` | Architecture, guardrails, oracle, arming, multi-tenant accounts, API, deploy, MCP, SDK, x402. |

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Engine + API with reload. |
| `npm run dev:web` | Dashboard dev server against the running API. |
| `npm run build` | Vite build, `tsc`, then the SDK; what the Dockerfile runs. |
| `npm run build:sdk` / `sync:sdk-contract` | Build `@hood-oracle/sdk`; refresh its copy of the API contract types. |
| `npm run mcp` | The MCP server over stdio against a running engine (`HOOD_ORACLE_URL`, `OPERATOR_TOKEN`). |
| `npm start` | `node dist/src/index.js`. |
| `npm test` | Every vitest suite. |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm run db:migrate` / `db:status` / `db:generate` | Apply, preview, or generate migrations. |
| `npm run oracle:backfill -- --days 30` | Rebuild features and labels from chain history. |
| `npm run oracle:fit` | Fit a candidate from the labeled rows and print the promotion verdict. |
| `npm run check:rules` | House rules: no dash characters, no to-do markers, no stubs, no sample arrays. |

## License

Apache-2.0. Copyright 2026 nirholas.
