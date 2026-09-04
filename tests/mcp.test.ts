/**
 * The MCP server against the real DB-backed harness: over the SDK's
 * in-memory transport (tools, resources, the write gate) and over the real
 * /mcp Streamable HTTP route inside the Hono app (sessions, bearer auth).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { createMcpServer, ALL_TOOLS, WRITE_TOOLS, READ_TOOLS } from '../src/mcp/server.js'
import { directBackend } from '../src/mcp/backend.js'
import { log } from '../src/log.js'
import { cleanupArms, cleanupTokens, createHarness, seedScoredLaunch, type Harness } from './api-helpers.js'

let h: Harness
const armIds: string[] = []
const tokens: string[] = []

type ToolResult = { isError?: boolean; content: { type: string; text?: string }[]; structuredContent?: Record<string, unknown> }
const parse = (r: ToolResult) => JSON.parse(r.content[0]!.text!) as Record<string, any>

async function inMemoryClient(isOperator: boolean) {
  const silent = log.child({ test: true })
  silent.level = 'silent'
  const backend = directBackend({ config: h.config, db: h.db, log: silent, engine: h.engine, model: h.model, bus: h.bus }, new Date(), 'docs')
  const server = createMcpServer({ backend, isOperator: () => isOperator })
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await server.connect(serverSide)
  const client = new Client({ name: 'mcp-test', version: '0.0.0' })
  await client.connect(clientSide)
  return { client, close: async () => { await client.close(); await server.close() } }
}

beforeAll(async () => {
  h = await createHarness()
})

afterAll(async () => {
  await cleanupArms(h, armIds)
  await cleanupTokens(h, tokens)
  await h.close()
})

describe('in-memory transport', () => {
  it('lists every tool with a JSON schema, and the arm tools carry the real arm knobs', async () => {
    const { client, close } = await inMemoryClient(false)
    try {
      const { tools } = await client.listTools()
      const names = tools.map((t) => t.name).sort()
      expect(names).toEqual([...ALL_TOOLS].sort())
      expect(ALL_TOOLS).toHaveLength(READ_TOOLS.length + WRITE_TOOLS.length)
      const create = tools.find((t) => t.name === 'arm_create')!
      const props = create.inputSchema.properties as Record<string, unknown>
      expect(create.inputSchema.required).toEqual(['label'])
      for (const knob of ['perTradeEth', 'dailyBudgetWei', 'stopLossPct', 'launchpads', 'minOracleScore', 'mode', 'enabled']) expect(props).toHaveProperty(knob)
      expect(create.inputSchema.additionalProperties).toBe(false)
      const feed = tools.find((t) => t.name === 'oracle_feed')!
      expect((feed.inputSchema.properties as Record<string, any>).tier.enum).toContain('prime')
      expect(feed.annotations?.readOnlyHint).toBe(true)
      const kill = tools.find((t) => t.name === 'kill_switch')!
      expect((kill.inputSchema.properties as Record<string, any>).action.enum).toEqual(['status', 'trip', 'clear'])
      expect(kill.annotations?.destructiveHint).toBe(true)
    } finally {
      await close()
    }
  })

  it('oracle_feed returns scored launches; oracle_score returns the coin detail; engine_status matches /api/status', async () => {
    const { token } = await seedScoredLaunch(h, { uniqueBuyers: 65, symbol: 'MCP' })
    tokens.push(token)
    const { client, close } = await inMemoryClient(false)
    try {
      const feed = parse((await client.callTool({ name: 'oracle_feed', arguments: { limit: 5 } })) as ToolResult)
      expect(feed.count).toBeGreaterThanOrEqual(1)
      expect(feed.items[0]).toHaveProperty('score.tier')
      expect(feed.filters.limit).toBe(5)
      const bad = (await client.callTool({ name: 'oracle_feed', arguments: { tier: 'legendary' } })) as ToolResult
      expect(bad.isError).toBe(true)
      const coin = parse((await client.callTool({ name: 'oracle_score', arguments: { token } })) as ToolResult)
      expect(coin.launch.symbol).toBe('MCP')
      expect(coin.latest.token.toLowerCase()).toBe(token.toLowerCase())
      const missing = (await client.callTool({ name: 'oracle_score', arguments: { token: '0x' + '1'.repeat(40) } })) as ToolResult
      expect(missing.isError).toBe(true)
      expect(parse(missing).error).toBe('not_found')
      const status = parse((await client.callTool({ name: 'engine_status', arguments: {} })) as ToolResult)
      expect(status.chainId).toBe(4663)
      expect(status.model.provenance).toContain('test prior')
      const model = parse((await client.callTool({ name: 'oracle_model', arguments: {} })) as ToolResult)
      expect(model.features.map((f: { key: string }) => f.key)).toContain('unique_buyers')
    } finally {
      await close()
    }
  })

  it('write tools are refused without the operator token and succeed with it, through the same validation as the API', async () => {
    const anon = await inMemoryClient(false)
    try {
      const refused = (await anon.client.callTool({ name: 'arm_create', arguments: { label: 'mcp-anon', perTradeEth: 0.01, dailyBudgetEth: 0.1 } })) as ToolResult
      expect(refused.isError).toBe(true)
      expect(parse(refused).error).toBe('unauthorized')
      const killRefused = (await anon.client.callTool({ name: 'kill_switch', arguments: { action: 'trip', reason: 'nope' } })) as ToolResult
      expect(parse(killRefused).error).toBe('unauthorized')
      expect(parse((await anon.client.callTool({ name: 'kill_switch', arguments: { action: 'status' } })) as ToolResult).killed).toBe(false)
    } finally {
      await anon.close()
    }

    const op = await inMemoryClient(true)
    try {
      const created = (await op.client.callTool({ name: 'arm_create', arguments: { label: 'mcp-arm', perTradeEth: 0.01, dailyBudgetEth: 0.1, stopLossPct: 25, minOracleScore: 60, maxBundleScore: 40 } })) as ToolResult
      expect(created.isError).toBeFalsy()
      const arm = parse(created).arm
      armIds.push(arm.id)
      expect(arm.perTradeWei).toBe('10000000000000000')
      expect(arm.minOracleScore).toBe(60)
      expect(arm.enabled).toBe(false)
      expect(created.structuredContent).toHaveProperty('arm.id', arm.id)

      const updated = parse((await op.client.callTool({ name: 'arm_update', arguments: { id: arm.id, patch: { takeProfitPct: 80, maxBundleScore: null, minOracleScore: null } } })) as ToolResult)
      expect(updated.arm.takeProfitPct).toBe(80)
      expect(updated.arm.maxBundleScore).toBeNull()
      // The oracle gate has a tier floor: null becomes the floor and is reported as clamped, exactly as over HTTP.
      expect(updated.clamped.find((c: { knob: string }) => c.knob === 'minOracleScore')).toMatchObject({ from: null, to: updated.arm.minOracleScore })

      const badPatch = (await op.client.callTool({ name: 'arm_update', arguments: { id: arm.id, patch: { bogus: 1 } } })) as ToolResult
      expect(badPatch.isError).toBe(true)

      const enabled = parse((await op.client.callTool({ name: 'arm_enable', arguments: { id: arm.id } })) as ToolResult)
      expect(enabled.arm.enabled).toBe(true)
      const list = parse((await op.client.callTool({ name: 'arms_list', arguments: {} })) as ToolResult)
      expect(list.arms.some((a: { id: string }) => a.id === arm.id)).toBe(true)
      const one = parse((await op.client.callTool({ name: 'arm_get', arguments: { id: arm.id } })) as ToolResult)
      expect(one.arm.summary).toEqual({ open: 0, closed: 0, wins: 0, realizedPnlWei: '0', lastTradeAt: null })

      const disabled = parse((await op.client.callTool({ name: 'arm_disable', arguments: { id: arm.id } })) as ToolResult)
      expect(disabled.arm.enabled).toBe(false)
      const killed = parse((await op.client.callTool({ name: 'arm_kill', arguments: { id: arm.id } })) as ToolResult)
      expect(killed.arm.killSwitch).toBe(true)

      const live = (await op.client.callTool({ name: 'arm_update', arguments: { id: arm.id, patch: { mode: 'live', enabled: true } } })) as ToolResult
      expect(live.isError).toBe(true)
      expect(parse(live).error).toBe('wallet_not_live')

      const trip = parse((await op.client.callTool({ name: 'kill_switch', arguments: { action: 'trip', reason: 'mcp test' } })) as ToolResult)
      expect(trip.killed).toBe(true)
      expect(trip.reason).toBe('operator: mcp test')
      const clear = parse((await op.client.callTool({ name: 'kill_switch', arguments: { action: 'clear' } })) as ToolResult)
      expect(clear).toMatchObject({ killed: false, cleared: true })

      const positions = parse((await op.client.callTool({ name: 'positions_list', arguments: { arm: arm.id } })) as ToolResult)
      expect(positions.count).toBe(0)
      const trades = parse((await op.client.callTool({ name: 'trades_list', arguments: { arm: arm.id } })) as ToolResult)
      expect(trades.count).toBe(0)
      const decisions = parse((await op.client.callTool({ name: 'decisions_list', arguments: { limit: 5 } })) as ToolResult)
      expect(decisions.chain).toHaveProperty('ok')
      const closeMissing = (await op.client.callTool({ name: 'position_close', arguments: { id: '00000000-0000-4000-8000-000000000000' } })) as ToolResult
      expect(parse(closeMissing).error).toBe('not_found')
    } finally {
      await op.close()
    }
  })

  it('serves status, the feed and the docs as resources', async () => {
    const { client, close } = await inMemoryClient(false)
    try {
      const { resources } = await client.listResources()
      const uris = resources.map((r) => r.uri)
      expect(uris).toContain('hood-oracle://status')
      expect(uris).toContain('hood-oracle://oracle/feed')
      expect(uris).toContain('hood-oracle://docs/api')
      const status = await client.readResource({ uri: 'hood-oracle://status' })
      expect(JSON.parse((status.contents[0] as { text: string }).text).chainId).toBe(4663)
      const doc = await client.readResource({ uri: 'hood-oracle://docs/api' })
      expect(doc.contents[0]!.mimeType).toBe('text/markdown')
      expect((doc.contents[0] as { text: string }).text).toContain('# HTTP API')
      await expect(client.readResource({ uri: 'hood-oracle://docs/does-not-exist' })).rejects.toThrow(/no doc named/)
      const { resourceTemplates } = await client.listResourceTemplates()
      expect(resourceTemplates.map((t) => t.uriTemplate)).toContain('hood-oracle://docs/{slug}')
    } finally {
      await close()
    }
  })
})

describe('streamable http at /mcp', () => {
  const connect = async (auth: boolean) => {
    const transport = new StreamableHTTPClientTransport(new URL('http://hood.test/mcp'), {
      fetch: ((input: string | URL | Request, init?: RequestInit) => h.app.request(input instanceof Request ? input : String(input), init)) as typeof fetch,
      requestInit: auth ? { headers: { authorization: h.authHeaders.authorization } } : {},
    })
    const client = new Client({ name: 'http-test', version: '0.0.0' })
    await client.connect(transport)
    return { client, transport }
  }

  it('opens a session, lists tools, gates writes on the bearer token, and closes on DELETE', async () => {
    const anon = await connect(false)
    try {
      expect(anon.transport.sessionId).toMatch(/^[0-9a-f-]{36}$/)
      const { tools } = await anon.client.listTools()
      expect(tools.map((t) => t.name)).toContain('oracle_feed')
      const feed = (await anon.client.callTool({ name: 'oracle_feed', arguments: { limit: 1 } })) as ToolResult
      expect(feed.isError).toBeFalsy()
      const refused = (await anon.client.callTool({ name: 'kill_switch', arguments: { action: 'trip', reason: 'http anon' } })) as ToolResult
      expect(refused.isError).toBe(true)
      expect(parse(refused).message).toContain('Authorization: Bearer')
    } finally {
      await anon.transport.terminateSession()
      await anon.client.close()
    }

    const op = await connect(true)
    try {
      const created = (await op.client.callTool({ name: 'arm_create', arguments: { label: 'mcp-http', perTradeEth: 0.02, dailyBudgetEth: 0.2 } })) as ToolResult
      expect(created.isError).toBeFalsy()
      const arm = parse(created).arm
      armIds.push(arm.id)
      expect(arm.perTradeWei).toBe('20000000000000000')
      const viaApi = await h.app.request(`/api/arms/${arm.id}`)
      expect(viaApi.status).toBe(200)
    } finally {
      await op.transport.terminateSession()
      await op.client.close()
    }

    const stale = await h.app.request('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-session-id': 'nope' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })
    expect(stale.status).toBe(404)
    const noSession = await h.app.request('/mcp', { method: 'GET', headers: { accept: 'text/event-stream' } })
    expect(noSession.status).toBe(400)
  })
})
