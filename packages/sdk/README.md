# @hood-oracle/sdk

Typed TypeScript client for a [hood-oracle](https://github.com/nirholas/hood-oracle)
engine: the Robinhood Chain (chain id 4663) launch oracle, arms, positions,
the ledger, the live SSE stream, and x402 pay-per-score with USDG.

Zero runtime dependencies beyond `fetch`. Node 18+ and every modern browser.
The wire types are a generated copy of the server's `src/api/contract.ts`,
so a renamed field on the server fails your typecheck instead of rendering
`undefined`.

## Install

```bash
npm install @hood-oracle/sdk
# only if you will pay for scores over x402:
npm install hood402 viem
```

## Use

```ts
import { createClient, HoodOracleError } from '@hood-oracle/sdk'

const hood = createClient({
  baseUrl: 'http://localhost:8080',          // or the Cloud Run URL
  operatorToken: process.env.OPERATOR_TOKEN, // only needed for writes
})

// Reads are public.
const status = await hood.status()
console.log(status.engine.feed.connected, status.model.source)

const feed = await hood.oracle.feed({ tier: 'strong', limit: 20 })
for (const item of feed.items) console.log(item.symbol, item.score.score, item.score.tier)

// Writes need the operator token. Every arm needs a stop loss to be armed.
const { arm } = await hood.arms.create({
  label: 'lean-noxa',
  launchpads: ['noxa'],
  perTradeEth: 0.01,
  dailyBudgetEth: 0.05,
  minOracleScore: 56,
  stopLossPct: 30,
})
await hood.arms.enable(arm.id)

// Errors carry the server's code, message, detail and request id.
try {
  await hood.arms.get('00000000-0000-4000-8000-000000000000')
} catch (err) {
  if (err instanceof HoodOracleError) console.error(err.status, err.code, err.message, err.requestId)
}
```

### Streams

```ts
const controller = new AbortController()
for await (const event of hood.stream({ kinds: ['launch', 'score'], signal: controller.signal })) {
  if (event.kind === 'hello') console.log('replaying', event.replay, 'events')
  if (event.kind === 'score') console.log(event.verdict.token, event.verdict.score)
}
```

`stream()` opens `/api/stream` (`oracleOnly: true` opens `/api/oracle/stream`),
yields the `hello` frame, then the server's ring-buffer replay, then live
events, with `ping` heartbeats every 15 seconds. Break out of the loop or
abort the signal to close the connection.

```ts
// Resolves the moment the oracle scores the token (about 90s after first sight).
const verdict = await hood.waitForScore('0x9a1...', { timeoutMs: 120_000 })
```

### Pay for a score with x402

`GET /api/x402/score/:token` costs a few cents of USDG on Robinhood Chain,
paid gaslessly with an EIP-3009 signature. The payer needs USDG, never ETH.

```ts
import { privateKeyToAccount } from 'viem/accounts'

const account = privateKeyToAccount(process.env.PAYER_PRIVATE_KEY as `0x${string}`)
const { data, settlement, spentUsdg } = await hood.x402.score('0x9a1...', { account, maxSpendUsdg: '0.50' })
console.log(data.verdict.score, data.firewall?.verdict, settlement?.transaction, spentUsdg)
```

In the browser pass `{ walletClient, address }` (a viem `WalletClient` over
an injected wallet) instead of `account`. `hood.x402.pricing()` is free and
tells you the price, network, asset and pay-to address before you sign.

## Surface

| Method | Route |
|---|---|
| `health()` / `ready()` / `status()` / `metrics()` | `GET /api/health`, `/api/ready`, `/api/status`, `/api/metrics` |
| `arms.list()` / `get(id)` / `create(input)` / `update(id, patch)` / `delete(id)` | `/api/arms` |
| `arms.enable(id)` / `disable(id)` / `kill(id)` | `POST /api/arms/:id/arm`, `/disarm`, `/kill` |
| `kill.get()` / `trip(reason)` / `clear()` | `/api/kill` |
| `oracle.feed(q)` / `coin(token)` / `model()` / `models()` / `calibration()` | `/api/oracle/*` |
| `positions.list(q)` / `close(id)` | `/api/positions` |
| `trades(q)` / `decisions(q)` / `equity(q)` | `/api/trades`, `/api/decisions`, `/api/equity` |
| `stream(opts)` / `waitForScore(token, opts)` | `/api/stream`, `/api/oracle/stream` |
| `x402.pricing()` / `x402.score(token, signer)` | `/api/x402/pricing`, `/api/x402/score/:token` |
| `request(method, path, body)` / `raw(...)` | anything else, with auth and error mapping |

Every response type is exported: `StatusResponse`, `FeedResponse`,
`CoinResponse`, `ArmWire`, `PositionListItem`, `EngineEventWire`, and so on.

## Testing against your own app

`createClient` accepts a `fetch`; hand it a Hono app's `request` and every
call runs in-process with no socket:

```ts
const hood = createClient({ baseUrl: 'http://hood.test', fetch: (input, init) => app.request(input, init) })
```

## License

Apache-2.0
