/**
 * Renders docs/*.md into web/dist/docs/<slug>.html with a shared layout, and
 * a docs index at web/dist/docs/index.html. Runs after `vite build`, because
 * the layout is the Vite-processed web/docs.html (so its stylesheet and
 * script carry hashed asset URLs), and finishes by checking every
 * site-internal link and anchor in every built HTML page. A dead link fails
 * the build.
 *
 *   npm run build:docs
 */
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Marked, type Tokens } from 'marked'
import { DOC_SLUG, docSlug, isSiteRoute, trimPath } from '../src/api/site-routes.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DOCS_DIR = join(ROOT, 'docs')
const DIST = join(ROOT, 'web', 'dist')
const TEMPLATE = join(DIST, 'docs.html')
const OUT = join(DIST, 'docs')
const REPO = 'https://github.com/nirholas/hood-oracle'

/** Sidebar groups, in order. A doc not listed here lands under "More". */
const GROUPS: { label: string; slugs: string[] }[] = [
  { label: 'Protocol', slugs: ['litepaper'] },
  { label: 'Engine', slugs: ['architecture', 'oracle', 'guardrails', 'arming', 'multi-tenant'] },
  { label: 'Agents', slugs: ['mcp', 'sdk', 'x402'] },
  { label: 'Reference', slugs: ['api', 'contracts', 'deploy', 'site-build'] },
]

interface Doc {
  slug: string
  title: string
  description: string
  html: string
  headings: { id: string; depth: number; text: string }[]
  ids: Set<string>
}

// ── markdown ─────────────────────────────────────────────────────────────────

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)

const slugify = (s: string): string =>
  s
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/&[a-z]+;/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/[\s-]+/g, '-')

/** `guardrails.md#x` -> `/docs/guardrails#x`; other relative paths -> the file on GitHub; absolute and anchor links pass through. */
function rewriteHref(href: string, slug: string): string {
  if (/^(https?:|mailto:|#|\/)/.test(href)) return href
  const [path, hash] = href.split('#')
  const clean = path.replace(/^\.\//, '')
  const md = /^([a-z0-9-]+)\.md$/.exec(clean)
  if (md) return `/docs/${md[1]}${hash ? '#' + hash : ''}`
  if (/^\.\.\/README\.md$/i.test(clean)) return `${REPO}#readme`
  const rel = clean.startsWith('../') ? clean.slice(3) : `docs/${clean}`
  if (!clean) return `/docs/${slug}${hash ? '#' + hash : ''}`
  return `${REPO}/blob/main/${rel}${hash ? '#' + hash : ''}`
}

function renderDoc(slug: string, markdown: string): Doc {
  const headings: Doc['headings'] = []
  const ids = new Set<string>()
  const uniqueId = (base: string): string => {
    let id = base || 'section'
    let n = 2
    while (ids.has(id)) id = `${base}-${n++}`
    ids.add(id)
    return id
  }
  const marked = new Marked({
    gfm: true,
    renderer: {
      heading({ tokens, depth }: Tokens.Heading) {
        const inner = this.parser.parseInline(tokens)
        const text = inner.replace(/<[^>]+>/g, '')
        if (depth === 1) return `<h1>${inner}</h1>\n`
        const id = uniqueId(slugify(text))
        headings.push({ id, depth, text })
        return `<h${depth} id="${id}"><a class="anchor" href="#${id}" aria-label="Link to ${escapeHtml(text)}">#</a>${inner}</h${depth}>\n`
      },
      link({ href, title, tokens }: Tokens.Link) {
        const inner = this.parser.parseInline(tokens)
        const target = rewriteHref(href, slug)
        const external = /^https?:/.test(target)
        return `<a href="${escapeHtml(target)}"${title ? ` title="${escapeHtml(title)}"` : ''}${external ? ' rel="noopener"' : ''}>${inner}</a>`
      },
      code({ text, lang }: Tokens.Code) {
        const language = (lang ?? '').trim().split(/\s+/)[0]
        return `<div class="codeblock">${language ? `<span class="lang">${escapeHtml(language)}</span>` : ''}<button type="button" class="btn xs copy" aria-label="Copy code">copy</button><pre><code${language ? ` class="language-${escapeHtml(language)}"` : ''}>${escapeHtml(text)}</code></pre></div>\n`
      },
    },
  })
  let html = marked.parse(markdown, { async: false })
  html = html.replace(/<table>/g, '<div class="twrap"><table>').replace(/<\/table>/g, '</table></div>')
  const title = /^#\s+(.+)$/m.exec(markdown)?.[1]?.replace(/[`*_]/g, '').trim() ?? slug
  const description = firstParagraph(markdown)
  return { slug, title, description, html, headings, ids }
}

function firstParagraph(markdown: string): string {
  const lines = markdown.split('\n')
  let i = 0
  while (i < lines.length && (lines[i].startsWith('#') || !lines[i].trim() || lines[i].startsWith('>') || lines[i].startsWith('|') || lines[i].startsWith('```'))) i++
  const para: string[] = []
  while (i < lines.length && lines[i].trim() && !lines[i].startsWith('#') && !lines[i].startsWith('```')) para.push(lines[i++])
  const text = para
    .join(' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[`*_]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > 180 ? text.slice(0, 177).replace(/\s+\S*$/, '') + '…' : text
}

// ── layout ───────────────────────────────────────────────────────────────────

function orderedSlugs(all: string[]): string[] {
  const listed = GROUPS.flatMap((g) => g.slugs).filter((s) => all.includes(s))
  const rest = all.filter((s) => !listed.includes(s)).sort()
  return [...listed, ...rest]
}

function sidebar(docs: Map<string, Doc>, current: string): string {
  const groups = GROUPS.map((g) => ({ label: g.label, slugs: g.slugs.filter((s) => docs.has(s)) })).filter((g) => g.slugs.length)
  const listed = new Set(groups.flatMap((g) => g.slugs))
  const more = [...docs.keys()].filter((s) => !listed.has(s)).sort()
  if (more.length) groups.push({ label: 'More', slugs: more })
  const link = (slug: string) => {
    const d = docs.get(slug)!
    const href = slug === 'litepaper' ? '/litepaper' : `/docs/${slug}`
    return `<a href="${href}"${slug === current ? ' class="on" aria-current="page"' : ''}>${escapeHtml(d.title)}</a>`
  }
  return [`<div class="side-group"><b>Docs</b><a href="/docs"${current === 'index' ? ' class="on" aria-current="page"' : ''}>Overview</a></div>`]
    .concat(groups.map((g) => `<div class="side-group"><b>${g.label}</b>${g.slugs.map(link).join('')}</div>`))
    .join('\n')
}

function toc(doc: Doc): string {
  const items = doc.headings.filter((h) => h.depth <= 3)
  if (!items.length) return ''
  return `<b>On this page</b>` + items.map((h) => `<a href="#${h.id}"${h.depth === 3 ? ' class="h3"' : ''}>${escapeHtml(h.text)}</a>`).join('')
}

function prevNext(order: string[], docs: Map<string, Doc>, slug: string): string {
  const i = order.indexOf(slug)
  const href = (s: string) => (s === 'litepaper' ? '/litepaper' : `/docs/${s}`)
  const prev = i > 0 ? order[i - 1] : null
  const next = i >= 0 && i < order.length - 1 ? order[i + 1] : null
  return [
    prev ? `<a class="prev" href="${href(prev)}"><small>Previous</small><b>${escapeHtml(docs.get(prev)!.title)}</b></a>` : '',
    next ? `<a class="next" href="${href(next)}"><small>Next</small><b>${escapeHtml(docs.get(next)!.title)}</b></a>` : '',
  ].join('')
}

function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k: string) => {
    if (!(k in vars)) throw new Error(`template placeholder {{${k}}} has no value`)
    return vars[k]
  })
}

function indexPage(docs: Map<string, Doc>): Doc {
  const groups = GROUPS.map((g) => ({ label: g.label, slugs: g.slugs.filter((s) => docs.has(s)) })).filter((g) => g.slugs.length)
  const listed = new Set(groups.flatMap((g) => g.slugs))
  const more = [...docs.keys()].filter((s) => !listed.has(s)).sort()
  if (more.length) groups.push({ label: 'More', slugs: more })
  const cards = groups
    .map(
      (g) =>
        `<span class="grp">${g.label}</span><div class="doc-index">${g.slugs
          .map((s) => {
            const d = docs.get(s)!
            return `<a href="${s === 'litepaper' ? '/litepaper' : `/docs/${s}`}"><b>${escapeHtml(d.title)}</b><span>${escapeHtml(d.description)}</span></a>`
          })
          .join('')}</div>`,
    )
    .join('')
  const html = `<h1>hood-oracle documentation</h1>
<p>Everything in the engine is written up here: the architecture and boot order, the conviction oracle and how it learns, every guardrail and what it fails closed on, the walk from a first simulated arm to a live one, the HTTP API route by route, the deploy runbook, and the litepaper for the protocol as a whole. The docs are rendered from <code>docs/*.md</code> in the repository at build time, so what you read is what the code carries.</p>
${cards}`
  return { slug: 'index', title: 'Documentation', description: 'Architecture, the oracle, guardrails, arming, the API, deploying, and the litepaper for hood-oracle.', html, headings: [], ids: new Set() }
}

// ── link check ───────────────────────────────────────────────────────────────

interface LinkProblem {
  page: string
  href: string
  why: string
}

async function walkHtml(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await walkHtml(p)))
    else if (entry.name.endsWith('.html')) out.push(p)
  }
  return out
}

function idsIn(html: string): Set<string> {
  const ids = new Set<string>()
  for (const m of html.matchAll(/\sid="([^"]+)"/g)) ids.add(m[1])
  return ids
}

/** Every site-internal href in every built page must land on a page this site serves, and every anchor on an id in that page. */
async function checkLinks(distDir: string, rendered: Map<string, Doc>): Promise<LinkProblem[]> {
  const problems: LinkProblem[] = []
  const pages = await walkHtml(distDir)
  const pageIds = new Map<string, Set<string>>()
  const pageHtml = new Map<string, string>()
  for (const p of pages) {
    const html = await readFile(p, 'utf8')
    pageHtml.set(p, html)
    pageIds.set(p, idsIn(html))
  }
  const docIds = (slug: string): Set<string> | null => {
    const d = rendered.get(slug)
    if (d) return d.ids
    const file = join(distDir, 'docs', `${slug}.html`)
    return pageIds.get(file) ?? null
  }
  for (const p of pages) {
    const html = pageHtml.get(p)!
    const page = p.slice(distDir.length + 1)
    for (const m of html.matchAll(/\shref="([^"]+)"/g)) {
      const href = m[1]
      if (/^(https?:|mailto:|data:|javascript:)/.test(href)) continue
      if (href.startsWith('#')) {
        const id = decodeURIComponent(href.slice(1))
        if (id && !pageIds.get(p)!.has(id)) problems.push({ page, href, why: 'no element with that id on the page' })
        continue
      }
      if (!href.startsWith('/')) {
        problems.push({ page, href, why: 'relative link; site links must be absolute' })
        continue
      }
      const [pathPart, hash] = href.split('#')
      const path = trimPath(pathPart.split('?')[0])
      if (path.startsWith('/assets/') || path.startsWith('/src/')) {
        const file = join(distDir, path)
        if (!existsSync(file) && !path.startsWith('/src/')) problems.push({ page, href, why: 'asset not in web/dist' })
        continue
      }
      const slug = docSlug(path)
      if (slug) {
        if (!rendered.has(slug) && !existsSync(join(distDir, 'docs', `${slug}.html`))) {
          problems.push({ page, href, why: `no docs/${slug}.md to render` })
          continue
        }
        if (hash) {
          const ids = docIds(slug)
          if (ids && !ids.has(decodeURIComponent(hash))) problems.push({ page, href, why: `no heading "${hash}" in docs/${slug}.md` })
        }
        continue
      }
      if (!isSiteRoute(path)) problems.push({ page, href, why: 'not a route the site serves (src/api/site-routes.ts)' })
      else if (hash && path === '/') {
        const landing = pageIds.get(join(distDir, 'landing.html'))
        if (landing && !landing.has(hash)) problems.push({ page, href, why: `no element "${hash}" on the landing page` })
      }
    }
  }
  return problems
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!existsSync(TEMPLATE)) {
    throw new Error(`${TEMPLATE} is missing: run \`vite build --config web/vite.config.ts\` first (build:web does both in order)`)
  }
  const template = await readFile(TEMPLATE, 'utf8')
  const files = (await readdir(DOCS_DIR)).filter((f) => f.endsWith('.md')).sort()
  const docs = new Map<string, Doc>()
  for (const f of files) {
    const slug = basename(f, '.md')
    if (!DOC_SLUG.test(slug)) throw new Error(`docs/${f}: file name must be lowercase letters, digits and hyphens to be a URL slug`)
    docs.set(slug, renderDoc(slug, await readFile(join(DOCS_DIR, f), 'utf8')))
  }
  if (!docs.has('litepaper')) throw new Error('docs/litepaper.md is missing; /litepaper would be a dead route')
  const order = orderedSlugs([...docs.keys()])
  const outDir = OUT
  await rm(outDir, { recursive: true, force: true })
  await mkdir(outDir, { recursive: true })

  const pages = [...docs.values(), indexPage(docs)]
  for (const doc of pages) {
    const html = fill(template, {
      title: escapeHtml(doc.title),
      description: escapeHtml(doc.description),
      slug: doc.slug,
      sidebar: sidebar(docs, doc.slug),
      content: doc.html,
      toc: toc(doc),
      prevnext: doc.slug === 'index' ? '' : prevNext(order, docs, doc.slug),
      source: doc.slug === 'index' ? `${REPO}/tree/main/docs` : `${REPO}/blob/main/docs/${doc.slug}.md`,
    })
    await writeFile(join(outDir, `${doc.slug}.html`), html)
  }

  await rm(TEMPLATE, { force: true })
  const problems = await checkLinks(DIST, docs)

  const written = pages.map((d) => d.slug).join(', ')
  if (problems.length) {
    for (const p of problems) console.error(`dead link: ${p.page}: ${p.href} (${p.why})`)
    console.error(`\nbuild:docs: ${problems.length} dead link${problems.length === 1 ? '' : 's'}; rendered ${written} but the build fails`)
    process.exit(1)
  }
  console.log(`build:docs: rendered ${pages.length} pages (${written}) into web/dist/docs; every internal link resolves`)
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
