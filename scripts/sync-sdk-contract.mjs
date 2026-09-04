#!/usr/bin/env node
// Copies the API wire contract (src/api/contract.ts) and the domain types it
// leans on (src/types.ts) into packages/sdk/src so the SDK is a standalone,
// publishable package whose types can never drift from the server's. Runs
// before every SDK build (`npm run build:sdk`) and on demand
// (`npm run sync:sdk-contract`). `--check` exits 1 when the copies are stale.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'packages', 'sdk', 'src')
const BANNER = (from) => `// GENERATED from ${from} by scripts/sync-sdk-contract.mjs. Do not edit; edit the source and run \`npm run sync:sdk-contract\`.\n`

function typesCopy() {
  const src = readFileSync(join(ROOT, 'src', 'types.ts'), 'utf8')
  const viemImport = "import type { Address, Hash, Hex } from 'viem'"
  if (!src.includes(viemImport)) throw new Error('src/types.ts no longer imports Address/Hash/Hex from viem; update scripts/sync-sdk-contract.mjs')
  const local = [
    '/** A 0x-prefixed 20-byte hex address (viem `Address`, spelled locally so the SDK has no runtime or type dependency on viem). */',
    'export type Address = `0x${string}`',
    '/** A 0x-prefixed 32-byte hex hash. */',
    'export type Hash = `0x${string}`',
    '/** Any 0x-prefixed hex string. */',
    'export type Hex = `0x${string}`',
  ].join('\n')
  return BANNER('src/types.ts') + src.replace(viemImport, local).replace(/\nexport type \{ Address, Hash, Hex \}\n/, '\n')
}

function contractCopy() {
  const src = readFileSync(join(ROOT, 'src', 'api', 'contract.ts'), 'utf8')
  if (!src.includes("from '../types.js'")) throw new Error("src/api/contract.ts no longer imports '../types.js'; update scripts/sync-sdk-contract.mjs")
  return BANNER('src/api/contract.ts') + src.replace("from '../types.js'", "from './types.js'")
}

const files = { 'types.ts': typesCopy(), 'contract.ts': contractCopy() }
const check = process.argv.includes('--check')
mkdirSync(OUT, { recursive: true })
let stale = 0
for (const [name, content] of Object.entries(files)) {
  const path = join(OUT, name)
  let current = null
  try {
    current = readFileSync(path, 'utf8')
  } catch {
    current = null
  }
  if (current === content) continue
  stale++
  if (check) console.error(`stale: packages/sdk/src/${name}`)
  else {
    writeFileSync(path, content)
    console.log(`wrote packages/sdk/src/${name}`)
  }
}
if (check && stale) process.exit(1)
if (!stale) console.log('packages/sdk/src contract is current')
