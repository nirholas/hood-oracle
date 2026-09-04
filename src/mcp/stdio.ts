#!/usr/bin/env node
/**
 * hood-oracle MCP server over stdio, for Claude Desktop, Claude Code and any
 * MCP client that launches a local process. It talks to a RUNNING engine
 * over HTTP (HOOD_ORACLE_URL, default http://localhost:8080) so every tool
 * acts on the live engine; OPERATOR_TOKEN in this process's environment is
 * forwarded as the bearer token on write tools.
 *
 *   npm run mcp
 *   npx hood-oracle-mcp
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { httpBackend } from './backend.js'
import { createMcpServer } from './server.js'

/** docs/ next to package.json, whether running from src/ (tsx) or dist/src/ (node). */
export function findDocsDir(from = dirname(fileURLToPath(import.meta.url))): string {
  let dir = from
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'docs'))) return join(dir, 'docs')
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return join(from, '..', '..', 'docs')
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const baseUrl = env.HOOD_ORACLE_URL?.trim() || 'http://localhost:8080'
  const operatorToken = env.OPERATOR_TOKEN?.trim() || null
  const backend = httpBackend({ baseUrl, operatorToken, docsDir: findDocsDir() })
  const server = createMcpServer({
    backend,
    // The API enforces the token on every write; the tool only needs to explain a missing one.
    isOperator: () => operatorToken != null,
    unauthorizedMessage: 'This tool changes engine state and needs the operator token: set OPERATOR_TOKEN in the environment of the MCP server (the `env` block of your MCP client config) to the same value the engine runs with.',
  })
  const transport = new StdioServerTransport()
  await server.connect(transport)
  process.stderr.write(`hood-oracle mcp: stdio up, engine ${baseUrl}, operator token ${operatorToken ? 'set' : 'unset (read tools only)'}\n`)
  const stop = async () => {
    await server.close().catch(() => undefined)
    process.exit(0)
  }
  process.on('SIGINT', () => void stop())
  process.on('SIGTERM', () => void stop())
}

const invokedDirectly = process.argv[1] != null && fileURLToPath(import.meta.url) === process.argv[1]
if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write(`hood-oracle mcp: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`)
    process.exit(1)
  })
}
