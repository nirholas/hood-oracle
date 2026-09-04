# TypeScript SDK

`@hood-oracle/sdk` (in [`packages/sdk`](../packages/sdk)) is a typed client
for every route of the HTTP API, an async iterator over the SSE streams, a
`waitForScore` helper, and an x402 helper that pays for a score with USDG
on Robinhood Chain. It has no runtime dependency beyond `fetch`
(`hood402` and `viem` are optional peers, loaded only by the x402 helper).

Its wire types are a generated copy of the server's `src/api/contract.ts`
and `src/types.ts`: `npm run sync:sdk-contract` refreshes them (and
`npm run build:sdk` does so before every build), so the published package
never drifts from the server it was cut from.

## Install

```bash
npm install @hood-oracle/sdk
npm install hood402 viem   # only for x402 payments
```

## Client

```ts
import { createClient } from '@hood-oracle/sdk'

const hood = createClient({
  baseUrl: 'http://localhost:8080',
  operatorToken: process.env.OPERATOR_TOKEN, // writes only
})
```

| Method | Route | Notes |
|---|---|---|
| `health()` | `GET /api/health` | liveness |
| `ready()` | `GET /api/ready` | resolves on 200 and 503; read `ok` and `checks` |
| `status()` | `GET /api/status` | engine health, model, counts |
| `metrics()` | `GET /api/metrics` | Prometheus text |
| `arms.list()` / `arms.get(id)` | `GET /api/arms[/:id]` | with summaries |
| `arms.create(input)` / `arms.update(id, patch)` / `arms.delete(id)` | `POST` / `PATCH` / `DELETE /api/arms[/:id]` | `ArmInput` accepts `perTradeEth` / `dailyBudgetEth` |
| `arms.enable(id)` / `arms.disable(id)` / `arms.kill(id)` | `POST /api/arms/:id/arm` / `disarm` / `kill` | |
| `kill.get()` / `kill.trip(reason)` / `kill.clear()` | `GET` / `POST` / `DELETE /api/kill` | |
| `oracle.feed(q)` | `GET /api/oracle/feed` | `tier`, `launchpad`, `since`, `limit` |
| `oracle.coin(token)` | `GET /api/oracle/coin/:token` | |
| `oracle.model()` / `oracle.models(limit)` / `oracle.calibration()` | `GET /api/oracle/model` / `models` / `calibration` | |
| `positions.list(q)` / `positions.close(id)` | `GET /api/positions`, `POST /api/positions/:id/close` | |
| `trades(q)` / `decisions(q)` / `equity(q)` | `GET /api/trades` / `decisions` / `equity` | |
| `x402.pricing()` | `GET /api/x402/pricing` | free |
| `x402.score(token, signer)` | `GET /api/x402/score/:token` | pays the 402, see below |
| `stream(opts)` | `GET /api/stream` or `/api/oracle/stream` | async iterator |
| `waitForScore(token, opts)` | coin lookup + oracle stream | resolves on the verdict |
| `request(method, path, body?)` / `raw(...)` | anything | auth and error mapping included |

Every non-2xx answer throws `HoodOracleError` with `status`, `code` (the
server's `error`), `message`, `detail` and `requestId` (the `X-Request-Id`
the server echoed, for log correlation). A transport failure throws with
`status: 0` and `code: "network"`.

## Streams

```ts
for await (const event of hood.stream({ kinds: ['launch', 'score'] })) {
  if (event.kind === 'hello') console.log(event.chainId, 'replaying', event.replay)
  if (event.kind === 'score') console.log(event.verdict.token, event.verdict.tier)
}
```

`stream()` yields the `hello` frame, the server's ring-buffer replay, then
live events, plus a `ping` every 15 seconds. `kinds` filters engine events
(`hello` and `ping` always come through); `oracleOnly: true` uses
`/api/oracle/stream`; `signal` closes the connection. Node and browsers both
use fetch streaming, never `EventSource`, so the operator token and custom
headers can travel with the request.

```ts
const verdict = await hood.waitForScore('0x9a1...', { timeoutMs: 120_000 })
```

`waitForScore` first reads `oracle.coin(token)` and resolves immediately if
a verdict exists; otherwise it subscribes to the oracle stream and resolves
on the matching `score` event. The stream replays its ring buffer on
connect, so a score landing between the lookup and the subscription is not
missed. It rejects with `code: "timeout"` after `timeoutMs` (default 120s).

## x402

```ts
import { privateKeyToAccount } from 'viem/accounts'

const account = privateKeyToAccount(process.env.PAYER_PRIVATE_KEY as `0x${string}`)
const { data, paid, settlement, spentUsdg } = await hood.x402.score('0x9a1...', {
  account,                // or { walletClient, address } in the browser
  maxSpendUsdg: '0.50',   // hard cap per origin; the client refuses to sign above it
})
```

The helper loads `hood402/client`, signs the EIP-3009 authorization the 402
asks for, retries with `X-PAYMENT`, and returns the verdict with the decoded
`X-PAYMENT-RESPONSE` receipt (`settlement.transaction`). The full protocol
is in [x402.md](x402.md).

## Testing against your own app

`createClient` accepts a `fetch`; passing a Hono app's `request` runs every
call in-process. `tests/sdk.test.ts` does exactly that against the real
database-backed harness.

```ts
const hood = createClient({ baseUrl: 'http://hood.test', fetch: (input, init) => app.request(input, init) })
```

## Building and publishing

```bash
npm run build:sdk        # sync the contract copy, then tsc -> packages/sdk/dist
cd packages/sdk && npm publish --access public
```

`npm run build` at the repo root builds the dashboard, the server and the
SDK. The package ships ESM plus `.d.ts` under `exports`.
