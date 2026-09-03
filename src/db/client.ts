import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema.js'

export type Db = ReturnType<typeof createDb>['db']

/**
 * One connection pool per process. `postgres` (postgres.js) over TCP: the
 * engine is a long-running process, so a real pool beats an HTTP driver.
 * numeric(40,0) columns come back as strings; use {@link toBigInt} at the edge.
 */
export function createDb(databaseUrl: string, { max = 8 }: { max?: number } = {}) {
  const client = postgres(databaseUrl, { max, prepare: false, idle_timeout: 30, connect_timeout: 10 })
  const db = drizzle(client, { schema })
  return { db, client, close: () => client.end({ timeout: 5 }) }
}

export const toBigInt = (v: string | number | bigint | null | undefined): bigint =>
  v == null ? 0n : typeof v === 'bigint' ? v : BigInt(String(v).split('.')[0] || '0')

export const toBigIntOrNull = (v: string | number | bigint | null | undefined): bigint | null =>
  v == null ? null : toBigInt(v)

export const weiStr = (v: bigint): string => v.toString()

export { schema }
