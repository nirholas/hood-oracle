/**
 * MCP over Streamable HTTP, mounted inside the Hono app at /mcp.
 *
 *   POST /mcp    JSON-RPC (initialize opens a session; Mcp-Session-Id after)
 *   GET  /mcp    the session's server-to-client SSE stream
 *   DELETE /mcp  close the session
 *
 * One McpServer + transport per session, kept in memory and dropped when the
 * client sends DELETE or the transport closes. Reads are free; a write tool
 * needs the operator bearer token on the HTTP request, which the transport
 * hands to the tool as `authInfo` so the gate is per request, not per
 * session. With OPERATOR_TOKEN unset on the server every write tool answers
 * 503, the same as the REST routes.
 */
import { Hono } from 'hono'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js'
import type { AppDeps } from '../deps.js'
import { extractBearer, OPERATOR_TOKEN_UNSET_MESSAGE } from '../auth.js'
import { respond } from '../json.js'
import { createMcpServer, OPERATOR_SCOPE } from '../../mcp/server.js'
import { directBackend } from '../../mcp/backend.js'
import { findDocsDir } from '../../mcp/stdio.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

export const MCP_SESSION_HEADER = 'mcp-session-id'

function tokenMatches(presented: string | null, expected: string | null): boolean {
  if (!presented || !expected) return false
  const a = Buffer.from(presented, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}

interface Session {
  transport: WebStandardStreamableHTTPServerTransport
  server: McpServer
  createdAt: number
}

export function mcpRoutes(deps: AppDeps): Hono {
  const app = new Hono()
  const { config, log } = deps
  const startedAt = new Date()
  const sessions = new Map<string, Session>()
  const docsDir = findDocsDir()

  function authInfo(header: string | undefined): AuthInfo | undefined {
    const presented = extractBearer(header)
    if (!tokenMatches(presented, config.operatorToken)) return undefined
    return { token: presented!, clientId: 'operator', scopes: [OPERATOR_SCOPE] }
  }

  const unauthorizedMessage = config.operatorToken
    ? 'This tool changes engine state and needs the operator token: send `Authorization: Bearer <OPERATOR_TOKEN>` on the MCP HTTP request.'
    : OPERATOR_TOKEN_UNSET_MESSAGE

  async function openSession(): Promise<Session> {
    const backend = directBackend(deps, startedAt, docsDir)
    const server = createMcpServer({
      backend,
      isOperator: (extra) => Boolean(config.operatorToken) && (extra.authInfo?.scopes.includes(OPERATOR_SCOPE) ?? false),
      unauthorizedMessage,
    })
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, session)
        log.info({ sessionId: id, sessions: sessions.size }, 'mcp session opened')
      },
      onsessionclosed: (id) => {
        sessions.delete(id)
        log.info({ sessionId: id, sessions: sessions.size }, 'mcp session closed')
      },
    })
    const session: Session = { transport, server, createdAt: Date.now() }
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId)
    }
    await server.connect(transport)
    return session
  }

  app.post('/', async (c) => {
    const id = c.req.header(MCP_SESSION_HEADER)
    const auth = authInfo(c.req.header('authorization'))
    if (id) {
      const session = sessions.get(id)
      if (!session) return respond(c, { error: 'mcp_session_not_found', message: `MCP session ${id} is not open here; send initialize again without Mcp-Session-Id.` }, 404)
      return session.transport.handleRequest(c.req.raw, { authInfo: auth })
    }
    const session = await openSession()
    return session.transport.handleRequest(c.req.raw, { authInfo: auth })
  })

  const requireSession = async (c: import('hono').Context) => {
    const id = c.req.header(MCP_SESSION_HEADER)
    if (!id) return respond(c, { error: 'mcp_session_required', message: 'Mcp-Session-Id is required: initialize with POST /mcp first.' }, 400)
    const session = sessions.get(id)
    if (!session) return respond(c, { error: 'mcp_session_not_found', message: `MCP session ${id} is not open here; initialize again.` }, 404)
    return session.transport.handleRequest(c.req.raw, { authInfo: authInfo(c.req.header('authorization')) })
  }
  app.get('/', requireSession)
  app.delete('/', requireSession)

  return app
}
