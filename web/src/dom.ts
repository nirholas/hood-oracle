export const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T => {
  const el = root.querySelector<T>(sel)
  if (!el) throw new Error(`missing element ${sel}`)
  return el
}
export const $$ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T[] => [...root.querySelectorAll<T>(sel)]
export const maybe = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T | null => root.querySelector<T>(sel)

export const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)

/** Marks a string as already-safe HTML for the `h` template. */
export class Raw {
  constructor(public readonly html: string) {}
  toString(): string {
    return this.html
  }
}
export const raw = (s: string): Raw => new Raw(s)

/** HTML template tag: every interpolation is escaped unless it is a Raw (or an array of them). */
export function h(strings: TemplateStringsArray, ...values: unknown[]): Raw {
  let out = ''
  for (let i = 0; i < strings.length; i++) {
    out += strings[i]
    if (i < values.length) out += render(values[i])
  }
  return new Raw(out)
}

function render(v: unknown): string {
  if (v == null || v === false) return ''
  if (v instanceof Raw) return v.html
  if (Array.isArray(v)) return v.map(render).join('')
  return esc(v)
}

export function setHtml(el: Element, content: Raw | string): void {
  el.innerHTML = content instanceof Raw ? content.html : esc(content)
}

export function tierClass(tier: string | null | undefined): string {
  return `tp-${tier || 'watch'}`
}

export function tierPill(tier: string | null | undefined): Raw {
  return h`<span class="tierpill ${tierClass(tier)}">${tier || 'unscored'}</span>`
}

export function skeletonRows(n: number, widths: number[] = [40, 15, 15, 12]): Raw {
  const row = h`<div class="sk-row">${widths.map((w) => raw(`<span class="sk" style="height:13px;width:${w}%"></span>`))}</div>`
  return raw(`<div class="sk-rows">${row.html.repeat(n)}</div>`)
}

export interface StateOpts {
  title: string
  body?: string
  action?: { label: string; onClick: () => void }
  href?: { label: string; url: string }
  kind?: 'empty' | 'error'
  compact?: boolean
}

export function stateBlock(el: Element, o: StateOpts): void {
  setHtml(
    el,
    h`<div class="state ${o.kind === 'error' ? 'error' : ''} ${o.compact ? 'compact' : ''}"><b>${o.title}</b>${o.body ?? ''}${
      o.action ? h`<div><button type="button" class="btn sm" data-state-action>${o.action.label}</button></div>` : ''
    }${o.href ? h`<div><a class="btn sm" href="${o.href.url}">${o.href.label}</a></div>` : ''}</div>`,
  )
  if (o.action) maybe('[data-state-action]', el)?.addEventListener('click', o.action.onClick)
}

const toastHost = (): HTMLElement => {
  let host = maybe('.toasts')
  if (!host) {
    host = document.createElement('div')
    host.className = 'toasts'
    host.setAttribute('aria-live', 'polite')
    document.body.appendChild(host)
  }
  return host
}

/** At most this many toasts are on screen; the oldest goes when a new one arrives. */
const MAX_TOASTS = 4
const toastTimers = new WeakMap<HTMLElement, number>()

function dismissToast(el: HTMLElement, ms: number): void {
  const existing = toastTimers.get(el)
  if (existing != null) clearTimeout(existing)
  toastTimers.set(
    el,
    window.setTimeout(() => {
      el.style.transition = 'opacity .25s'
      el.style.opacity = '0'
      setTimeout(() => el.remove(), 260)
    }, ms),
  )
}

/**
 * A toast. `key` collapses repeats: a recurring event (a watcher retrying, a
 * feed reconnecting) updates the toast it already has instead of stacking a
 * new one over the page, which is what a failing RPC used to do.
 */
export function toast(message: string, kind: 'ok' | 'bad' | 'warn' | 'info' = 'info', ms = 4200, key?: string): void {
  const host = toastHost()
  const existing = key ? host.querySelector<HTMLElement>(`.toast[data-key="${CSS.escape(key)}"]`) : null
  if (existing) {
    existing.className = `toast ${kind}`
    existing.textContent = message
    existing.style.opacity = ''
    dismissToast(existing, ms)
    return
  }
  const el = document.createElement('div')
  el.className = `toast ${kind}`
  el.textContent = message
  if (key) el.dataset.key = key
  host.appendChild(el)
  for (const stale of [...host.children].slice(0, -MAX_TOASTS)) stale.remove()
  dismissToast(el, ms)
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    toast('Copied', 'ok', 1400)
    return true
  } catch {
    toast('Copy failed: select and copy manually', 'warn')
    return false
  }
}

export function pillarBars(pillars: Record<string, number> | null | undefined, mini = false): Raw {
  const order = ['structure', 'momentum', 'pedigree', 'narrative']
  return h`<div class="pillars ${mini ? 'mini' : ''}">${order.map((k) => {
    const v = pillars ? Math.max(0, Math.min(100, Number(pillars[k] ?? 0))) : 0
    return h`<div class="pil ${k}" title="${k} ${Math.round(v)}"><div class="lab"><span>${k.slice(0, 3)}</span><b>${Math.round(v)}</b></div><div class="track"><div class="fill" style="width:${v}%"></div></div></div>`
  })}</div>`
}

/** Wire a `.seg` group: buttons carry data-v; returns a getter/setter. */
export function segmented(root: HTMLElement, onChange?: (value: string) => void): { get(): string; set(v: string): void } {
  const buttons = $$<HTMLButtonElement>('button[data-v]', root)
  const set = (v: string) => {
    for (const b of buttons) b.classList.toggle('on', b.dataset.v === v)
    root.classList.toggle('live-on', v === 'live')
  }
  root.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-v]')
    if (!b || b.disabled) return
    set(b.dataset.v as string)
    onChange?.(b.dataset.v as string)
  })
  return { get: () => buttons.find((b) => b.classList.contains('on'))?.dataset.v ?? '', set }
}

/** Wire a `.sw` switch button (role=switch). */
export function switchControl(el: HTMLElement, onChange?: (on: boolean) => void): { get(): boolean; set(on: boolean): void } {
  const set = (on: boolean) => {
    el.classList.toggle('on', on)
    el.setAttribute('aria-checked', String(on))
  }
  el.addEventListener('click', () => {
    if ((el as HTMLButtonElement).disabled) return
    const on = !el.classList.contains('on')
    set(on)
    onChange?.(on)
  })
  return { get: () => el.classList.contains('on'), set }
}

export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number): (...a: A) => void {
  let t: number | null = null
  return (...a: A) => {
    if (t != null) clearTimeout(t)
    t = window.setTimeout(() => fn(...a), ms)
  }
}
