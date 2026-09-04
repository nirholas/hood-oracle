# Deploying to Google Cloud Run

Production is one always-on Cloud Run instance in `us-central1` of project
`aerial-vehicle-466722-p5`. One instance, never zero and never more than one:
the engine holds the sequencer websocket open, owns the wallet nonce, and runs
the positions sweep, so a second instance would double-trade and a scaled-to-
zero one would miss every launch. CPU is always allocated
(`--no-cpu-throttling`) so the feed decoder is never paused between requests.

Everything below assumes `gcloud` is authenticated against the project.

```bash
export PROJECT=aerial-vehicle-466722-p5
export REGION=us-central1
gcloud config set project $PROJECT
```

## 1. One-time setup

### Artifact Registry

```bash
gcloud artifacts repositories create hood-oracle \
  --repository-format=docker --location=$REGION \
  --description="hood-oracle engine images"
```

### Service accounts

The project's default compute service account was deleted. Builds run as
`three-ws-build@` and the service runs as `three-ws@`; both already exist.
`cloudbuild.yaml` pins the build account and the deploy step pins the runtime
account, and a build without either fails before its first step. The runtime
account needs to read the secrets:

```bash
for s in database-url trader-private-key operator-token llm-api-key telegram-bot-token; do
  gcloud secrets add-iam-policy-binding hood-oracle-$s \
    --member="serviceAccount:three-ws@$PROJECT.iam.gserviceaccount.com" \
    --role="roles/secretmanager.secretAccessor"
done
```

(Run after the secrets exist; see the next step.)

### Secrets

Every credential is a Secret Manager reference, never a literal on the
service. Only the first two are required: the deploy mounts exactly the set
named by the `_SECRETS` substitution in `cloudbuild.yaml`, whose default is
`DATABASE_URL` and `OPERATOR_TOKEN`, so a first simulate-only deploy needs no
funded trading key to exist. Naming a secret that has not been created fails
the deploy, so create a secret before you add it to `_SECRETS`.

Create each one from a file or stdin so the value never lands in shell
history:

```bash
# Postgres. Neon, Cloud SQL, or any reachable Postgres 15+.
printf '%s' 'postgres://user:pass@host:5432/hood_oracle?sslmode=require' | \
  gcloud secrets create hood-oracle-database-url --data-file=- --replication-policy=automatic

# Operator bearer token for every write route. Required.
openssl rand -hex 32 | tr -d '\n' | \
  gcloud secrets create hood-oracle-operator-token --data-file=- --replication-policy=automatic

# Optional, and only once you intend to trade live: the signing key. Use a
# fresh wallet funded with only what you are prepared to lose.
printf '%s' '0x<64 hex chars>' | \
  gcloud secrets create hood-oracle-trader-private-key --data-file=- --replication-policy=automatic

# LLM key for narrative classification and the llm decision mode (Anthropic by default).
printf '%s' 'sk-ant-...' | \
  gcloud secrets create hood-oracle-llm-api-key --data-file=- --replication-policy=automatic

# Telegram alerts. Both halves are needed for an alert to send.
printf '%s' '123456:ABC...' | \
  gcloud secrets create hood-oracle-telegram-bot-token --data-file=- --replication-policy=automatic
printf '%s' '-1001234567890' | \
  gcloud secrets create hood-oracle-telegram-chat-id --data-file=- --replication-policy=automatic
```

Mount the optional ones by extending the substitution on the submit:

```bash
gcloud builds submit --config cloudbuild.yaml --region us-central1 \
  --project aerial-vehicle-466722-p5 \
  --substitutions=SHORT_SHA=manual$(date +%s),_SECRETS='DATABASE_URL=hood-oracle-database-url:latest,OPERATOR_TOKEN=hood-oracle-operator-token:latest,TRADER_PRIVATE_KEY=hood-oracle-trader-private-key:latest,LLM_API_KEY=hood-oracle-llm-api-key:latest,TELEGRAM_BOT_TOKEN=hood-oracle-telegram-bot-token:latest,TELEGRAM_CHAT_ID=hood-oracle-telegram-chat-id:latest'
```

Rotate with `gcloud secrets versions add <name> --data-file=-`; the deploy
references `:latest`, so the next deploy (or `gcloud run services update
--update-secrets`) picks it up.

`RPC_URLS` and `MIN_WALLET_ETH` are not secrets and are set as plain env
vars (below). Listing an accelerator endpoint first in `RPC_URLS` is the
single biggest latency win and keeps the public endpoint as a last rung; the
public RPC rate-limits per address and will throttle a busy engine.

### The database

Apply migrations from your machine against the production database before
the first deploy and after any change under `src/db/migrations/`. The engine
checks for pending migrations at boot and exits 4 rather than running new code
over an old schema.

```bash
DATABASE_URL="$(gcloud secrets versions access latest --secret=hood-oracle-database-url)" npm run db:status
DATABASE_URL="$(gcloud secrets versions access latest --secret=hood-oracle-database-url)" npm run db:migrate
```

## 2. Build and deploy

```bash
gcloud builds submit --config cloudbuild.yaml --region $REGION --project $PROJECT \
  --substitutions=SHORT_SHA=manual$(date +%s)
```

The build: `docker build` of the multi-stage `Dockerfile` (Vite dashboard
then `tsc`, runtime image with production deps only, non-root `node` user,
`HEALTHCHECK` on `/api/health`), a push to
`us-central1-docker.pkg.dev/aerial-vehicle-466722-p5/hood-oracle/engine:<sha>`,
then `gcloud run deploy hood-oracle` with:

| Flag | Value | Why |
|---|---|---|
| `--service-account` | `three-ws@aerial-vehicle-466722-p5.iam.gserviceaccount.com` | The default compute SA is gone. |
| `--min-instances` / `--max-instances` | `1` / `1` | Exactly one engine. |
| `--no-cpu-throttling` | | The feed decoder runs between requests. |
| `--cpu` / `--memory` | `2` / `2Gi` | Feed decoding plus a refit in the same process. |
| `--timeout` | `3600` | SSE streams stay open. |
| `--port` | `8080` | |
| `--allow-unauthenticated` | | The dashboard and reads are public; writes are gated by the operator token. |
| `--set-secrets` | `${_SECRETS}` | Defaults to the two required secrets; extend the substitution to mount more. |
| `--set-env-vars` | `NODE_ENV`, `HOOD_NETWORK`, `LOG_LEVEL`, `KILL_FILE`, `WEB_DIST`, `LLM_PROVIDER`, `TRUST_PROXY` | Non-secret config. `TRUST_PROXY=1` is set by the deploy because Cloud Run fronts the container. |

Build logs go to Cloud Logging only (`options.logging: CLOUD_LOGGING_ONLY`),
which is required when the build account has no bucket access.

After the first deploy, set the non-secret env once (merging, never
replacing: `--update-env-vars` merges, `--set-env-vars` on a live service
replaces the whole set):

```bash
gcloud run services update hood-oracle --region $REGION \
  --update-env-vars TELEGRAM_CHAT_ID=-1001234567890,MIN_WALLET_ETH=0.005
```

### Hardening and x402 env

All plain env vars (none are secrets), merged with `--update-env-vars`:

| Var | Production value | Why |
|---|---|---|
| `TRUST_PROXY` | `1` | Cloud Run terminates TLS and forwards the client address in `X-Forwarded-For`; without this every caller shares one rate-limit bucket and x402 resource URLs are built as `http://`. |
| `CORS_ORIGINS` | usually empty | The dashboard is same-origin. Add an origin only if another site must call the API from a browser; a `*` entry opens reads and never writes. |
| `X402_PAY_TO` | an address you control | Enables `GET /api/x402/score/:token`; USDG payments land here. Unset keeps the route at 503. |
| `X402_SCORE_PRICE_USDG` | `0.05` | Price per verdict in USDG. |
| `X402_FACILITATOR_URL` | `https://facilitator.hood402.dev` | The hood402 facilitator that verifies and settles. Self-host from the hood402 repo's `facilitator/` for full control. |

```bash
gcloud run services update hood-oracle --region $REGION \
  --update-env-vars TRUST_PROXY=1,X402_PAY_TO=0xYourAddress,X402_SCORE_PRICE_USDG=0.05
```

The rate limiter stores its buckets in process memory. With
`--max-instances 1` that is the whole limit; if you ever run more than one
instance, each enforces the limit on its own share of the traffic.

### Probes

`cloudbuild.yaml` relies on Cloud Run's default TCP startup probe, which
passes as soon as the port opens. `GET /api/ready` is the readiness signal
(database, data path, model) and `GET /api/health` is liveness; to make
Cloud Run hold traffic until the engine is actually ready, add to the deploy
step:

```
--startup-probe=httpGet.path=/api/ready,httpGet.port=8080,initialDelaySeconds=10,periodSeconds=5,failureThreshold=24
--liveness-probe=httpGet.path=/api/health,httpGet.port=8080,periodSeconds=30
```

`/api/ready` answers 503 while the sequencer feed is disconnected and the
log watchers have not advanced the head block within 60 seconds, so a boot
against an unreachable RPC never receives traffic.

## 3. The RPC: Alchemy accelerator

The single biggest fill-latency win. The public
`https://rpc.mainnet.chain.robinhood.com` endpoint is fine for reads, but the
buy broadcast is a race against every other bot on the same launch. An
Alchemy Robinhood Chain endpoint with the transaction accelerator forwards
the raw transaction straight to the sequencer and shaves the queueing that
the public gateway adds. Put it first in `RPC_URLS`; the engine broadcasts
every raw transaction to every URL in the list in parallel and the public
endpoint stays as the last rung.

```bash
gcloud run services update hood-oracle --region $REGION \
  --update-env-vars RPC_URLS=https://robinhood-mainnet.g.alchemy.com/v2/<key>
```

`RPC_URLS` is comma-separated; more than one paid provider is fine. The
sequencer feed (`FEED_URL`) is a separate websocket and needs no key.

## 4. Verify

```bash
URL=$(gcloud run services describe hood-oracle --region $REGION --format='value(status.url)')
curl -s $URL/api/health
curl -s $URL/api/status | jq '.engine.feed, .engine.wallet, .model.source, .engine.killed'
```

`feed.connected` should be true within a few seconds and `secondsSinceFrame`
should stay small. `wallet.live` is true only when the key is set and the
balance is above `MIN_WALLET_ETH`. `killed` must be false unless you deployed
with `GLOBAL_KILL=1` on purpose.

Logs:

```bash
gcloud logging read 'resource.type="cloud_run_revision" resource.labels.service_name="hood-oracle"' \
  --freshness=1h --limit=200 --format='value(textPayload,jsonPayload.msg)'
```

## 5. Kill switch in production

Three ways, none of them sell:

```bash
# From the API (clearable with DELETE /api/kill)
curl -X POST $URL/api/kill -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"reason":"halting while I check the odyssey watcher"}'

# From the deploy (undo by deploying without it)
gcloud run services update hood-oracle --region $REGION --update-env-vars GLOBAL_KILL=1

# Stop taking new risk entirely: min-instances 0 stops the process. Open
# positions are NOT managed while it is down; close them first or accept that.
gcloud run services update hood-oracle --region $REGION --min-instances 0 --max-instances 0
```

## 6. Rollback

Every deploy is a new revision and the previous one is kept. To go back:

```bash
gcloud run revisions list --service hood-oracle --region $REGION
gcloud run services update-traffic hood-oracle --region $REGION --to-revisions <previous-revision>=100
```

A rollback does not undo a migration. If the newer revision applied one that
the older code cannot run against, `db:status` on the older tree will not
show it as pending (it is applied), but the older handlers may query columns
by their old names. Prefer additive migrations so a rollback never needs one.

## 7. Local Docker

```bash
docker compose up --build
```

Postgres 17 on `localhost:5432` with a healthcheck, the engine built from the
same `Dockerfile` on `localhost:8080`, `.env` read for everything except
`DATABASE_URL` (which compose points at the `db` service). `touch KILL`
inside the container (`docker compose exec engine touch /app/KILL`) trips the
file kill.
