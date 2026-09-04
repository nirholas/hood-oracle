# MCP server

hood-oracle speaks the Model Context Protocol, so Claude Code, Claude
Desktop, Cursor, or any MCP client can read the oracle feed, inspect a
launch, manage arms, close positions and trip the kill switch with the same
validation and the same operator gate as the HTTP API. Two transports:

| Transport | Where it runs | How it reaches the engine | Auth |
|---|---|---|---|
| **stdio** (`npx hood-oracle-mcp`, `npm run mcp`) | a local process the MCP client launches | over HTTP to a running engine (`HOOD_ORACLE_URL`, default `http://localhost:8080`) | `OPERATOR_TOKEN` in the process env is forwarded on write tools |
| **Streamable HTTP** (`POST/GET/DELETE /mcp`) | inside the engine process | in-process, the same handler functions the routes call | `Authorization: Bearer <OPERATOR_TOKEN>` on the HTTP request unlocks write tools |

Reads are free on both. A write tool without the token answers an
`isError` result carrying `{ status: 401, error: "unauthorized", message }`;
with `OPERATOR_TOKEN` unset on the server it carries the same 503
`operator_token_unset` explanation as the REST routes.

The stdio server talks to the running engine rather than opening the
database itself on purpose: a kill switch or an arm change has to land on the
live trading loop, and only the engine process holds it.

## Install

### Claude Code

```bash
claude mcp add hood-oracle \
  -e HOOD_ORACLE_URL=http://localhost:8080 \
  -e OPERATOR_TOKEN=<your operator token> \
  -- npx -y hood-oracle-mcp
```

From a checkout of this repo, `-- npm run --prefix /path/to/hood-oracle mcp`
works the same way. Leave `OPERATOR_TOKEN` out for a read-only connection.

### Claude Desktop

`claude_desktop_config.json` (Settings, Developer, Edit Config):

```json
{
  "mcpServers": {
    "hood-oracle": {
      "command": "npx",
      "args": ["-y", "hood-oracle-mcp"],
      "env": {
        "HOOD_ORACLE_URL": "https://hood-oracle-xxxxx-uc.a.run.app",
        "OPERATOR_TOKEN": "<your operator token>"
      }
    }
  }
}
```

### Any Streamable HTTP client

Point it at `/mcp` on the running engine. Cursor, for example
(`.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "hood-oracle": {
      "url": "https://hood-oracle-xxxxx-uc.a.run.app/mcp",
      "headers": { "Authorization": "Bearer <your operator token>" }
    }
  }
}
```

The server issues an `Mcp-Session-Id` on `initialize`; clients send it back
on every request and `DELETE /mcp` closes the session. Sessions are held in
memory in the one always-on instance.

### Programmatic (the official SDK)

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const client = new Client({ name: 'my-agent', version: '1.0.0' })
await client.connect(new StreamableHTTPClientTransport(new URL('http://localhost:8080/mcp'), {
  requestInit: { headers: { authorization: `Bearer ${process.env.OPERATOR_TOKEN}` } },
}))
const feed = await client.callTool({ name: 'oracle_feed', arguments: { tier: 'strong', limit: 10 } })
```

## Tools

Every tool returns the same JSON the corresponding HTTP route returns, as
`content[0].text` and as `structuredContent`. Wei values are decimal
strings, dates are ISO 8601. A failure is `isError: true` with
`{ status, error, message, detail? }`, the API's error body plus its HTTP
status.

### Reads (no token)

| Tool | Arguments | Returns |
|---|---|---|
| `engine_status` | none | `GET /api/status`: engine health, model provenance, counts |
| `oracle_feed` | `limit` (1..500, default 100), `tier` (`prime`/`strong`/`lean`/`watch`/`avoid`), `launchpad`, `since` (ISO, epoch ms, or `24h`) | latest verdict per token with launch and features |
| `oracle_score` | `token` (0x address) | `GET /api/oracle/coin/:token`: launch, features, every verdict, firewall runs, positions, decisions, creator record, outcome |
| `oracle_model` | none | the active model: heads, tier anchors, holdout, features |
| `arms_list` | none | every arm with its summary |
| `arm_get` | `id` (uuid) | one arm with its summary |
| `positions_list` | `status` (`open`/`closed`/`reconcile_pending`), `arm` (uuid), `limit` | positions, open first |
| `trades_list` | `arm`, `token`, `limit` | trades, newest first |
| `decisions_list` | `arm`, `token`, `limit` | the hash-chained journal with a chain verification |

### Writes (operator token)

| Tool | Arguments | What happens |
|---|---|---|
| `arm_create` | every arm knob (the tool's input schema IS the API's arm schema: `label` required, `perTradeEth`/`perTradeWei`, `dailyBudgetEth`/`dailyBudgetWei`, `stopLossPct`, `minOracleScore`, `launchpads`, `mode`, `enabled`, ...) | `POST /api/arms`. Unknown keys are rejected; with `enabled: true` the armability gate runs |
| `arm_update` | `id`, `patch` (any subset of the knobs; `null` clears an optional filter) | `PATCH /api/arms/:id`. An arm that is or becomes enabled must still pass the gate |
| `arm_enable` | `id` | `POST /api/arms/:id/arm`. Refused without a stop loss, a size, a covering budget, or (live) a live wallet |
| `arm_disable` | `id` | `POST /api/arms/:id/disarm`. Exits keep managing |
| `arm_kill` | `id` | `POST /api/arms/:id/kill`. Disables and sets the arm's own kill switch |
| `kill_switch` | `action` (`status`/`trip`/`clear`), `reason` (required for `trip`) | `status` is free. `trip` halts every new buy and never sells. `clear` only clears an API kill; signal, file and env kills answer 409 |
| `position_close` | `id` | `POST /api/positions/:id/close`: market sell now, exit reason `manual` |

## Resources

| URI | Content |
|---|---|
| `hood-oracle://status` | `application/json`, the status body |
| `hood-oracle://oracle/feed` | `application/json`, the latest 100 verdicts |
| `hood-oracle://docs/{slug}` | `text/markdown`, one file from `docs/` (`api`, `architecture`, `arming`, `guardrails`, `oracle`, `deploy`, `mcp`, `sdk`, `x402`). Listing the template enumerates the slugs |

## Testing

`tests/mcp.test.ts` runs the server against the real database over the
SDK's in-memory transport (tool list and schemas, `oracle_feed`,
`arm_create` through the shared validation, the write gate, resources) and
over the real `/mcp` route (session lifecycle, bearer auth).

```bash
npx vitest run tests/mcp.test.ts
```
