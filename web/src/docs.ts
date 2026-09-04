/**
 * Behaviour for the pre-rendered docs pages: copy buttons on code blocks,
 * the mobile sidebar toggle, and a scroll-spy that marks the current
 * heading in the on-page table of contents. The content itself is static
 * HTML written by scripts/build-docs.ts.
 */
import { $$, copyText, maybe } from './dom'

for (const btn of $$<HTMLButtonElement>('.codeblock .copy')) {
  btn.addEventListener('click', () => {
    const code = btn.parentElement?.querySelector('code')
    if (code) void copyText(code.textContent ?? '')
  })
}

const menu = maybe<HTMLButtonElement>('#docsMenu')
const side = maybe('#docsSide')
if (menu && side) {
  menu.addEventListener('click', () => {
    const open = side.classList.toggle('open')
    menu.setAttribute('aria-expanded', String(open))
    menu.textContent = open ? 'Close menu' : 'Docs menu'
  })
}

const tocLinks = $$<HTMLAnchorElement>('.docs-toc a[href^="#"]')
if (tocLinks.length) {
  const byId = new Map(tocLinks.map((a) => [decodeURIComponent(a.getAttribute('href')!.slice(1)), a]))
  const headings = [...byId.keys()].map((id) => document.getElementById(id)).filter((el): el is HTMLElement => el != null)
  let current: HTMLAnchorElement | null = null
  const mark = (id: string) => {
    const a = byId.get(id)
    if (!a || a === current) return
    current?.classList.remove('on')
    a.classList.add('on')
    current = a
  }
  const observer = new IntersectionObserver(
    (entries) => {
      const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
      if (visible.length) mark(visible[0].target.id)
    },
    { rootMargin: '-70px 0px -70% 0px', threshold: [0, 1] },
  )
  for (const el of headings) observer.observe(el)
  if (location.hash) mark(decodeURIComponent(location.hash.slice(1)))
  else if (headings[0]) mark(headings[0].id)
}
