/**
 * Evaluates a frame or component template body against the live data store and
 * component registry using the same ctx helpers as the Node.js frame-framework.
 *
 * Template bodies are the *content* of a template literal — they may contain
 * `${ctx.data('key')}`, `${ctx.use('name', props)}`, `${ctx.map(arr, fn)}`,
 * `${ctx.navigate('page')}`, `${ctx.if(cond, fn)}`, `${ctx.repeat(n, fn)}`.
 *
 * Component CSS is collected during rendering (de-duplicated by component name)
 * and returned alongside the body HTML so it can be injected into the page.
 *
 * On any evaluation error the raw body is returned (backward compatible).
 */

export type EvalCtx = {
  data    : (key: string) => unknown
  use     : (name: string, props?: Record<string, unknown>) => string
  map     : (arr: unknown, fn: (item: unknown, i: number) => string) => string
  navigate: (name: string) => string
  if      : (cond: unknown, fn: () => string, elseFn?: () => string) => string
  repeat  : (n: number, fn: (i: number) => string) => string
}

type ComponentShape = {
  name          : string
  templateSource: string
  previewBody   : string
  css           : string
}

export type EvalResult = {
  body: string
  /** CSS collected from every component used during this render (de-duplicated). */
  componentCss: string
}

function buildCtx(
  dataStore    : Record<string, unknown>,
  components   : ComponentShape[],
  usedCss      : Map<string, string>,   // component name → css, populated as side-effect
): EvalCtx {
  const ctx: EvalCtx = {
    data: (key) => dataStore[key],

    use: (name, props = {}) => {
      const comp = components.find(c => c.name === name)
      if (!comp) return `<!-- component "${name}" not found -->`

      // Collect CSS once per component name
      if (!usedCss.has(name) && comp.css?.trim()) {
        usedCss.set(name, comp.css.trim())
      }

      const src = comp.templateSource?.trim()
      if (!src) return comp.previewBody ?? ''
      try {
        // eslint-disable-next-line @typescript-eslint/no-implied-eval
        const fn = new Function('props', 'ctx', `return \`${src}\``) as (
          p: Record<string, unknown>, c: EvalCtx
        ) => string
        return fn(props, ctx)
      } catch (e) {
        return `<!-- error in "${name}": ${String(e)} -->`
      }
    },

    map: (arr, fn) => {
      if (!Array.isArray(arr)) return ''
      return arr.map(fn).join('')
    },

    navigate: (name) => `data-navigate="${name}"`,

    if: (cond, fn, elseFn) => (cond ? fn() : (elseFn?.() ?? '')),

    repeat: (n, fn) => Array.from({ length: n }, (_, i) => fn(i)).join(''),
  }
  return ctx
}

/**
 * Evaluate a page template body. Returns the rendered HTML and any CSS
 * collected from components used during rendering.
 */
export function evaluateTemplate(
  body      : string,
  dataStore : Record<string, unknown>,
  components: ComponentShape[],
): EvalResult {
  if (!body.trim()) return { body: '', componentCss: '' }

  const usedCss = new Map<string, string>()
  const ctx = buildCtx(dataStore, components, usedCss)

  let renderedBody: string
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const fn = new Function('ctx', `return \`${body}\``) as (c: EvalCtx) => string
    renderedBody = fn(ctx)
  } catch {
    // Backward compat: return raw body for static HTML pages
    renderedBody = body
  }

  const componentCss = [...usedCss.values()].join('\n')
  return { body: renderedBody, componentCss }
}
