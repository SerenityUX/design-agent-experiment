/** Layer tree for UI AST view — DOM elements only (no style/script/etc.). */

export type LayerKind =
  | 'frame'
  | 'group'
  | 'text'
  | 'button'
  | 'image'
  | 'input'
  | 'list'
  | 'link'
  | 'other'

export type LayerNode = {
  kind: LayerKind
  label: string
  /**
   * Child indices from that page’s `document.body`.
   * `null` = page group row (whole page) or synthetic root.
   */
  path: number[] | null
  /** Which page/frame this node belongs to; `null` only for the synthetic root row. */
  frameName: string | null
  children: LayerNode[]
}

/** Not shown and not descended into (non-UI or non-HTML surface). */
const SKIP_SUBTREE = new Set([
  'script',
  'style',
  'link',
  'meta',
  'base',
  'title',
  'head',
  'noscript',
  'template',
  'source',
  'track',
  'param',
])

const GROUP_TAGS = new Set([
  'div',
  'section',
  'main',
  'article',
  'header',
  'footer',
  'nav',
  'aside',
  'form',
  'figure',
])

const TEXT_TAGS = new Set([
  'span',
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'label',
  'blockquote',
  'figcaption',
  'strong',
  'em',
  'b',
  'i',
  'small',
  'code',
  'pre',
])

function tagToKind(tag: string): LayerKind {
  if (GROUP_TAGS.has(tag)) return 'group'
  if (TEXT_TAGS.has(tag)) return 'text'
  if (tag === 'ul' || tag === 'ol') return 'list'
  if (tag === 'li') return 'group'
  if (tag === 'button') return 'button'
  if (tag === 'a') return 'link'
  if (tag === 'img' || tag === 'picture' || tag === 'svg') return 'image'
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return 'input'
  if (tag === 'br' || tag === 'hr') return 'other'
  return 'other'
}

function elementLabel(el: Element, tag: string): string {
  const id = el.id?.trim()
  if (id) return `#${id}`
  const cls = el.getAttribute('class')?.trim()
  if (cls) {
    const first = cls.split(/\s+/)[0]
    if (first) return first
  }
  const dataNav = el.getAttribute('data-navigate')
  if (dataNav) return `→ ${dataNav}`
  if (tag === 'div') return 'div'
  return tag
}

function isForeignOrSvg(el: Element): boolean {
  return el.namespaceURI === 'http://www.w3.org/2000/svg' ||
    el.namespaceURI === 'http://www.w3.org/1998/Math/MathML'
}

/** One visual row; do not walk subtree (embedded doc or vector internals). */
function isLeafUiContainer(tag: string): boolean {
  return tag === 'svg' || tag === 'iframe' || tag === 'object' || tag === 'embed'
}

function walk(el: Element, path: number[], frameName: string): LayerNode | null {
  if (isForeignOrSvg(el) && el.tagName.toLowerCase() !== 'svg') return null

  const tag = el.tagName.toLowerCase()
  if (SKIP_SUBTREE.has(tag)) return null

  if (tag === 'svg' || isLeafUiContainer(tag)) {
    return {
      kind: tagToKind(tag),
      label: elementLabel(el, tag),
      path: [...path],
      frameName,
      children: [],
    }
  }

  const children: LayerNode[] = []
  for (let j = 0; j < el.children.length; j++) {
    const c = walk(el.children[j], [...path, j], frameName)
    if (c) children.push(c)
  }

  return {
    kind: tagToKind(tag),
    label: elementLabel(el, tag),
    path: [...path],
    frameName,
    children,
  }
}

/** One page’s DOM as a top-level group (label = page name). */
function buildPageGroup(bodyHtml: string, pageName: string): LayerNode {
  const wrapped = `<!DOCTYPE html><html><body>${bodyHtml}</body></html>`
  const doc = new DOMParser().parseFromString(wrapped, 'text/html')
  const body = doc.body

  const children: LayerNode[] = []
  for (let i = 0; i < body.children.length; i++) {
    const n = walk(body.children[i], [i], pageName)
    if (n) children.push(n)
  }

  return {
    kind: 'group',
    label: pageName,
    path: null,
    frameName: pageName,
    children,
  }
}

/**
 * Single tree: synthetic root → one **group** per page (in JSON order), then that page’s elements.
 */
export function buildUnifiedLayerRoot(
  orderedPageNames: string[],
  contents: Record<string, { body: string }>,
): LayerNode {
  const pageNodes: LayerNode[] = []
  for (const name of orderedPageNames) {
    const def = contents[name]
    if (!def) continue
    pageNodes.push(buildPageGroup(def.body, name))
  }

  return {
    kind: 'group',
    label: 'Pages',
    path: null,
    frameName: null,
    children: pageNodes,
  }
}

/** Stable key for expand/collapse (unique across all pages). */
export function layerNodeKey(frameName: string | null, path: number[] | null): string {
  if (frameName === null) return '__root__'
  if (path === null) return `${frameName}::__page__`
  return `${frameName}::${path.join(':')}`
}

/** Keys for every node that has children (default: all expanded). */
export function collectExpandableKeys(root: LayerNode): string[] {
  const keys: string[] = []
  function visit(n: LayerNode) {
    if (n.children.length > 0) {
      keys.push(layerNodeKey(n.frameName, n.path))
      for (const c of n.children) visit(c)
    }
  }
  visit(root)
  return keys
}

export function pathsEqual(a: number[] | null, b: number[] | null): boolean {
  if (a === null && b === null) return true
  if (a === null || b === null) return false
  if (a.length !== b.length) return false
  return a.every((v, i) => v === b[i])
}

export type LayerPick = { frame: string; path: number[] | null }

function pickEqual(a: LayerPick | null, b: LayerPick | null): boolean {
  if (a === null && b === null) return true
  if (a === null || b === null) return false
  return a.frame === b.frame && pathsEqual(a.path, b.path)
}

export { pickEqual }

/** Find the layer node matching frame + body path. */
export function findLayerNodeByPick(root: LayerNode, pick: LayerPick): LayerNode | null {
  function visit(n: LayerNode): LayerNode | null {
    if (
      n.frameName !== null &&
      n.frameName === pick.frame &&
      pathsEqual(n.path, pick.path)
    ) {
      return n
    }
    for (const c of n.children) {
      const r = visit(c)
      if (r) return r
    }
    return null
  }
  return visit(root)
}

/**
 * Map a raw DOM path from the live iframe to a pick that exists in the layer tree
 * (trim to an ancestor if the tree skipped nodes or parsing differs slightly).
 */
export function snapLayerPick(root: LayerNode, frame: string, path: number[] | null): LayerPick {
  const tries: LayerPick[] = []
  if (path !== null && path.length > 0) {
    for (let len = path.length; len >= 0; len--) {
      tries.push({ frame, path: len === 0 ? null : path.slice(0, len) })
    }
  } else {
    tries.push({ frame, path: null })
  }
  for (const t of tries) {
    if (findLayerNodeByPick(root, t)) return t
  }
  return { frame, path: null }
}

/** `path === null` → body `innerHTML` for that page; else that element’s `outerHTML`. */
export function outerHtmlAtBodyPath(bodyHtml: string, path: number[] | null): string {
  const wrapped = `<!DOCTYPE html><html><body>${bodyHtml}</body></html>`
  const doc = new DOMParser().parseFromString(wrapped, 'text/html')
  if (path === null) {
    return doc.body.innerHTML.trim()
  }
  let el: Element | null = doc.body
  for (const idx of path) {
    el = el.children[idx] ?? null
    if (!el) return ''
  }
  return el.outerHTML
}
