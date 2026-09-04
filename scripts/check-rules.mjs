#!/usr/bin/env node
// House-rule scanner. Walks every text file in the repo (tracked or not) and
// fails on the four things that never ship here: em-dash and en-dash
// characters, to-do and fix-me markers in comments, "not implemented" throws,
// and hardcoded sample arrays. Exits 1 with file:line for every hit.
//
//   npm run check:rules
//   node scripts/check-rules.mjs src docs   (scope to paths)
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.vite', 'coverage', 'data', 'dependencies', 'out', 'cache', 'broadcast', 'lib'])
const SKIP_FILES = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml'])
const TEXT_EXT = new Set([
  '.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.md', '.yaml', '.yml', '.sql', '.html', '.css',
  '.txt', '.toml', '.env', '.example', '.sh', '.svg', '',
])

// Built from pieces so this file never trips its own scan.
const DASHES = new RegExp(`[${String.fromCharCode(0x2014)}${String.fromCharCode(0x2013)}]`)
const MARKER = new RegExp(`(?:^|[^\\w])(?://|#|/\\*|\\*)\\s*(?:${'TO' + 'DO'}|${'FIX' + 'ME'})\\b`)
const NOT_IMPL = new RegExp(`throw\\s+new\\s+Error\\(\\s*['"\`]${'not' + ' implemented'}`, 'i')
const SAMPLE_ARRAY = new RegExp(`\\b(?:const|let|var)\\s+${'sample'}[A-Z]\\w*\\s*=\\s*\\[`)
const NUL = String.fromCharCode(0)

const RULES = [
  { name: 'em-dash or en-dash', test: (line) => DASHES.test(line) },
  { name: 'to-do marker', test: (line) => MARKER.test(line) },
  { name: 'not-implemented throw', test: (line) => NOT_IMPL.test(line) },
  { name: 'sample fallback array', test: (line) => SAMPLE_ARRAY.test(line) },
]

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      if (relative(ROOT, path) === join('web', 'dist')) continue
      yield* walk(path)
      continue
    }
    if (!entry.isFile()) continue
    if (SKIP_FILES.has(entry.name)) continue
    if (!TEXT_EXT.has(extname(entry.name))) continue
    yield path
  }
}

function targets(args) {
  if (!args.length) return [...walk(ROOT)]
  const out = []
  for (const arg of args) {
    const path = resolve(ROOT, arg)
    const st = statSync(path)
    if (st.isDirectory()) out.push(...walk(path))
    else out.push(path)
  }
  return out
}

const hits = []
for (const file of targets(process.argv.slice(2))) {
  const rel = relative(ROOT, file)
  if (rel === join('scripts', 'check-rules.mjs')) continue
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    continue
  }
  if (text.includes(NUL)) continue
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    for (const rule of RULES) {
      if (rule.test(lines[i])) hits.push(`${rel}:${i + 1}: ${rule.name}`)
    }
  }
}

if (hits.length) {
  console.error(hits.join('\n'))
  console.error(`\n${hits.length} rule violation${hits.length === 1 ? '' : 's'}`)
  process.exit(1)
}
console.log('check:rules: clean')
