/**
 * The hood-oracle MCP server: the oracle feed, arms, positions, the ledger
 * and the kill switch as tools, plus status, the feed and the docs as
 * resources. Transport-agnostic; ./stdio.ts and ../api/routes/mcp.ts mount it.
 *
 * Every write tool is gated by `isOperator(extra)`. Over the in-process HTTP
 * transport that is the operator bearer token on the request; over stdio the
 * backend carries OPERATOR_TOKEN to the API, which enforces it.
 */
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { ARM_CREATE_SCHEMA, ARM_PATCH_SCHEMA } from '../api/arm-schema.js'
import { ApiError } from '../api/errors.js'
import { stringify } from '../api/json.js'
import { TIERS } from '../api/handlers/oracle.js'
import { POSITION_STATUSES } from '../api/handlers/positions.js'
import { ALL_LAUNCHPADS } from '../chain/launchpads.js'
import type { Launchpad } from '../types.js'
import type { OracleBackend } from './backend.js'

export const MCP_SERVER_NAME = 'hood-oracle'
export const MCP_SERVER_VERSION = '0.1.0'
export const OPERATOR_SCOPE = 'operator'

export interface McpServerOptions {
  backend: OracleBackend
  /** Whether the caller of a write tool holds the operator token. */
  isOperator: (extra: { authInfo?: { scopes: string[] } }) => boolean
  /** Message shown when a write is refused. */
  unauthorizedMessage?: string
}

export const WRITE_TOOLS = ['arm_create', 'arm_update', 'arm_enable', 'arm_disable', 'arm_kill', 'kill_switch', 'position_close'] as const
export const READ_TOOLS = ['engine_status', 'oracle_feed', 'oracle_score', 'oracle_model', 'arms_list', 'arm_get', 'positions_list', 'trades_list', 'decisions_list'] as const
export const ALL_TOOLS = [...READ_TOOLS, ...WRITE_TOOLS] as const

const DEFAULT_UNAUTHORIZED = 'This tool changes engine state and needs the operator token. Over HTTP send `Authorization: Bearer <OPERATOR_TOKEN>` on the MCP request; over stdio set OPERATOR_TOKEN in the server environment.'

function ok(body: unknown): CallToolResult {
  const text = stringify(body)
  return { content: [{ type: 'text', text }], structuredContent: JSON.parse(text) as Record<string, unknown> }
}

function fail(err: unknown): CallToolResult {
  const body =
    err instanceof ApiError
      ? { status: err.status, ...err.toJSON() }
      : { status: 500, error: 'internal', message: err instanceof Error ? err.message : String(err) }
  return { isError: true, content: [{ type: 'text', text: stringify(body) }], structuredContent: body }
}

async function run(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return ok(await fn())
  } catch (err) {
    return fail(err)
  }
}

export function createMcpServer(opts: McpServerOptions): McpServer {
  const { backend } = opts
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    {
      instructions:
        'hood-oracle scores every token launch on Robinhood Chain (4663) and trades the ones an operator has armed. Read tools are free. arm_create, arm_update, arm_enable, arm_disable, arm_kill, kill_switch and position_close change engine state and need the operator token. Wei values are decimal strings; every arm needs a stop loss before it can be enabled; the kill switch halts new buys and never sells.',
    },
  )

  const guarded = (fn: () => Promise<unknown>) => async (extra: { authInfo?: { scopes: string[] } }) => {
    if (!opts.isOperator(extra)) return fail(new ApiError(401, 'unauthorized', opts.unauthorizedMessage ?? DEFAULT_UNAUTHORIZED))
    return run(fn)
  }

  const uuid = z.string().uuid().describe('The arm id (uuid).')
  const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'a 0x-prefixed 20-byte address').describe('Token contract address.')

  // ── reads ──
  server.registerTool(
    'engine_status',
    {
      title: 'Engine status',
      description: 'Engine health (feed, head block, wallet, kill state, arms, open positions), model provenance and table counts. The same body as GET /api/status.',
      annotations: { readOnlyHint: true },
    },
    () => run(() => backend.status()),
  )

  server.registerTool(
    'oracle_feed',
    {
      title: 'Oracle feed',
      description: 'Latest oracle verdict per token joined to its launch and 90-second feature snapshot, newest first.',
      inputSchema: {
        limit: z.number().int().min(1).max(500).optional().describe('Rows to return (default 100, max 500).'),
        tier: z.enum(TIERS).optional().describe('Only this conviction tier.'),
        launchpad: z.enum(ALL_LAUNCHPADS as [Launchpad, ...Launchpad[]]).optional().describe('Only launches from this launchpad.'),
        since: z.string().optional().describe('ISO timestamp, epoch ms, or a duration such as 24h.'),
      },
      annotations: { readOnlyHint: true },
    },
    (args) => run(() => backend.feed(args)),
  )

  server.registerTool(
    'oracle_score',
    {
      title: 'Oracle score for one token',
      description: 'Everything about one launch: the launch row, feature snapshot, latest verdict and every prior one, firewall assessments, positions, decisions, the creator record and the resolved outcome once the 24h label exists.',
      inputSchema: { token: address },
      annotations: { readOnlyHint: true },
    },
    ({ token }) => run(() => backend.coin(token)),
  )

  server.registerTool(
    'oracle_model',
    {
      title: 'Active oracle model',
      description: 'The model every score is computed under: version, provenance, source (bootstrap or promoted), heads, tier anchors, holdout metrics and every feature with its bucket edges.',
      annotations: { readOnlyHint: true },
    },
    () => run(() => backend.model()),
  )

  server.registerTool(
    'arms_list',
    { title: 'List arms', description: 'Every arm with its open/closed/wins/realized P&L summary.', annotations: { readOnlyHint: true } },
    () => run(() => backend.armsList()),
  )

  server.registerTool(
    'arm_get',
    { title: 'Get one arm', description: 'One arm with its summary.', inputSchema: { id: uuid }, annotations: { readOnlyHint: true } },
    ({ id }) => run(() => backend.armGet(id)),
  )

  server.registerTool(
    'positions_list',
    {
      title: 'List positions',
      description: 'Positions, open first then closed by newest.',
      inputSchema: {
        status: z.enum(POSITION_STATUSES).optional().describe('Filter by status.'),
        arm: uuid.optional().describe('Only this arm.'),
        limit: z.number().int().min(1).max(1000).optional().describe('Rows (default 200).'),
      },
      annotations: { readOnlyHint: true },
    },
    (args) => run(() => backend.positionsList(args)),
  )

  server.registerTool(
    'trades_list',
    {
      title: 'List trades',
      description: 'Trades, newest first.',
      inputSchema: {
        arm: uuid.optional().describe('Only this arm.'),
        token: address.optional().describe('Only this token.'),
        limit: z.number().int().min(1).max(1000).optional().describe('Rows (default 100).'),
      },
      annotations: { readOnlyHint: true },
    },
    (args) => run(() => backend.tradesList(args)),
  )

  server.registerTool(
    'decisions_list',
    {
      title: 'List decisions',
      description: 'The hash-chained decision journal (buys, sells, skips, refusals with reasons, optimizer observations), newest first, with a verification of the whole chain.',
      inputSchema: {
        arm: uuid.optional().describe('Only this arm.'),
        token: address.optional().describe('Only this token.'),
        limit: z.number().int().min(1).max(1000).optional().describe('Rows (default 100).'),
      },
      annotations: { readOnlyHint: true },
    },
    (args) => run(() => backend.decisionsList(args)),
  )

  // ── writes ──
  server.registerTool(
    'arm_create',
    {
      title: 'Create an arm',
      description:
        'Create a strategy. Same validation as POST /api/arms: wei fields take decimal wei strings or the perTradeEth / dailyBudgetEth spellings, unknown keys are rejected, and with enabled: true the armability gate (stop loss above 0, per-trade size above 0, a daily budget covering one trade, a live wallet for live mode) must pass. Knobs outside the autonomy tier are clamped and reported.',
      inputSchema: ARM_CREATE_SCHEMA,
      annotations: { destructiveHint: false },
    },
    (args, extra) => guarded(() => backend.armCreate(args))(extra),
  )

  server.registerTool(
    'arm_update',
    {
      title: 'Update an arm',
      description: 'Patch knobs on an arm. null clears an optional filter; an arm that is or becomes enabled must still pass the armability gate.',
      inputSchema: { id: uuid, patch: ARM_PATCH_SCHEMA.describe('The knobs to change.') },
      annotations: { destructiveHint: false },
    },
    ({ id, patch }, extra) => guarded(() => backend.armUpdate(id, patch))(extra),
  )

  server.registerTool(
    'arm_enable',
    {
      title: 'Arm (enable)',
      description: 'Enable an arm so it starts taking positions. Refused (409) without a stop loss, a per-trade size, a budget that covers one trade, or a live wallet for live mode.',
      inputSchema: { id: uuid },
      annotations: { destructiveHint: false },
    },
    ({ id }, extra) => guarded(() => backend.armEnable(id))(extra),
  )

  server.registerTool(
    'arm_disable',
    { title: 'Disarm (disable)', description: 'Stop an arm taking new positions. Exits on its open positions keep managing.', inputSchema: { id: uuid }, annotations: { destructiveHint: false } },
    ({ id }, extra) => guarded(() => backend.armDisable(id))(extra),
  )

  server.registerTool(
    'arm_kill',
    {
      title: 'Kill one arm',
      description: 'Disable the arm and set its own kill switch: the risk engine refuses its buys with `disarmed` until the next arm_enable.',
      inputSchema: { id: uuid },
      annotations: { destructiveHint: true },
    },
    ({ id }, extra) => guarded(() => backend.armKill(id))(extra),
  )

  server.registerTool(
    'kill_switch',
    {
      title: 'Global kill switch',
      description:
        'Read, trip or clear the global kill switch. `trip` halts every new buy across every arm (exits keep managing, nothing is sold). `clear` only clears a kill that came from the API: signal, KILL-file and GLOBAL_KILL kills answer 409 and must be cleared at their source.',
      inputSchema: {
        action: z.enum(['status', 'trip', 'clear']).describe('What to do.'),
        reason: z.string().trim().min(1).max(500).optional().describe('Required for trip: why the engine is being halted.'),
      },
      annotations: { destructiveHint: true },
    },
    async ({ action, reason }, extra) => {
      if (action === 'status') return run(() => backend.killState())
      if (action === 'trip') {
        if (!reason) return fail(new ApiError(400, 'validation', 'trip needs a reason'))
        return guarded(() => backend.killTrip(reason))(extra)
      }
      return guarded(() => backend.killClear())(extra)
    },
  )

  server.registerTool(
    'position_close',
    {
      title: 'Close a position',
      description: 'Close an open position at market now with exit reason `manual`. 409 if it is not open; 502 with the engine message if the sell could not execute.',
      inputSchema: { id: z.string().uuid().describe('The position id.') },
      annotations: { destructiveHint: true },
    },
    ({ id }, extra) => guarded(() => backend.positionClose(id))(extra),
  )

  // ── resources ──
  server.registerResource(
    'status',
    'hood-oracle://status',
    { title: 'Engine status', description: 'Live engine health, model provenance and counts.', mimeType: 'application/json' },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: stringify(await backend.status()) }] }),
  )

  server.registerResource(
    'oracle-feed',
    'hood-oracle://oracle/feed',
    { title: 'Oracle feed', description: 'The latest 100 oracle verdicts with launches and features.', mimeType: 'application/json' },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: stringify(await backend.feed({})) }] }),
  )

  server.registerResource(
    'docs',
    new ResourceTemplate('hood-oracle://docs/{slug}', {
      list: async () => ({
        resources: (await backend.docs()).map((d) => ({ uri: `hood-oracle://docs/${d.slug}`, name: d.slug, title: d.title, mimeType: 'text/markdown', size: d.bytes })),
      }),
      complete: { slug: async (value) => (await backend.docs()).map((d) => d.slug).filter((s) => s.startsWith(value)) },
    }),
    { title: 'Documentation', description: 'hood-oracle docs: architecture, api, arming, guardrails, oracle, deploy, mcp, sdk, x402.', mimeType: 'text/markdown' },
    async (uri, { slug }) => {
      const doc = await backend.doc(String(slug))
      if (!doc) throw new Error(`no doc named ${String(slug)}; list hood-oracle://docs/ for the slugs`)
      return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: doc.markdown }] }
    },
  )

  return server
}
