/** DOM-level edits to frame body HTML at a given child path from document.body. */

export type ElementPatch = {
  innerHTML?: string
  style?: string
  /** Set attribute (null / empty string removes) */
  attributes?: Record<string, string | null | undefined>
}

/** Separator between base inline CSS and stacked “effect” fragments (valid in style="" values). */
const EFFECT_SEP = '; /*__effect__*/ '

function walkToNode(body: string, path: number[] | null): { root: HTMLDivElement; node: Element | null } {
  const root = document.createElement('div')
  root.innerHTML = body
  if (!path?.length) return { root, node: root.firstElementChild }
  let node: Element | null = root
  for (const idx of path) {
    const child: Element | undefined = node?.children[idx]
    if (!child) return { root, node: null }
    node = child
  }
  return { root, node }
}

export function applyElementPatch(body: string, path: number[] | null, patch: ElementPatch): string {
  const { root, node } = walkToNode(body, path)
  if (!node || node === root) return body

  if (patch.innerHTML !== undefined) node.innerHTML = patch.innerHTML

  if (patch.style !== undefined) {
    if (patch.style.trim()) node.setAttribute('style', patch.style)
    else node.removeAttribute('style')
  }

  if (patch.attributes) {
    for (const [name, val] of Object.entries(patch.attributes)) {
      if (val === null || val === undefined || val === '') node.removeAttribute(name)
      else node.setAttribute(name, val)
    }
  }

  return root.innerHTML
}

export function parseInlineStyle(styleAttr: string): Record<string, string> {
  const out: Record<string, string> = {}
  if (!styleAttr.trim()) return out
  for (const part of styleAttr.split(';')) {
    const idx = part.indexOf(':')
    if (idx === -1) continue
    const key = part.slice(0, idx).trim().toLowerCase()
    const val = part.slice(idx + 1).trim()
    if (key) out[key] = val
  }
  return out
}

export function serializeInlineStyle(props: Record<string, string>): string {
  return Object.entries(props)
    .filter(([, v]) => v.trim() !== '')
    .map(([k, v]) => `${k}: ${v}`)
    .join('; ')
}

/** Split inline style into base + effect layers (each fragment after EFFECT_SEP). */
export function splitStyleEffects(style: string): { base: string; effects: string[] } {
  const s = style.trim()
  if (!s.includes('/*__effect__*/')) {
    return { base: s, effects: [] }
  }
  const parts = s.split(EFFECT_SEP)
  const base = (parts[0] ?? '').trim()
  const effects = parts.slice(1).map(p => p.trim()).filter(Boolean)
  return { base, effects }
}

export function mergeStyleEffects(base: string, effects: string[]): string {
  const b = base.trim()
  const fx = effects.map(e => e.trim()).filter(Boolean)
  if (!fx.length) return b
  return b + fx.map(e => EFFECT_SEP + e).join('')
}

export type ElemDetail = {
  tag: string
  innerHTML: string
  style: string
  className: string
  id: string
  dataNavigate: string
}

export function parseElemDetail(outerHtml: string): ElemDetail | null {
  if (!outerHtml.trim()) return null
  const tmp = document.createElement('div')
  tmp.innerHTML = outerHtml
  const el = tmp.firstElementChild
  if (!el) return null
  return {
    tag: el.tagName.toLowerCase(),
    innerHTML: el.innerHTML,
    style: el.getAttribute('style') ?? '',
    className: el.getAttribute('class') ?? '',
    id: el.getAttribute('id') ?? '',
    dataNavigate: el.getAttribute('data-navigate') ?? '',
  }
}

/** Append or replace a simple class rule in frame CSS (dev UX helper). */
export function upsertClassRule(css: string, className: string, declarations: string): string {
  const sel = `.${className.replace(/[^a-zA-Z0-9_-]/g, '')}`
  const block = `${sel} {\n  ${declarations.trim()}\n}\n`
  const re = new RegExp(
    `${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{[^}]*\\}`,
    'm',
  )
  const trimmed = css.trim()
  if (re.test(trimmed)) return trimmed.replace(re, block.trim())
  return trimmed ? `${trimmed}\n\n${block}` : block
}
