/**
 * frame-framework — createApp()
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  ARCHITECTURE                                                           │
 * │                                                                         │
 * │  app.data(key, value)          ← DataStore                             │
 * │  app.loadData('./data.json')   ← file-backed persistence               │
 * │                                      │                                 │
 * │  app.component(name, fn, css)  ← ComponentRegistry                     │
 * │                                      │                                 │
 * │  app.frame(name, templateFn)   ← Frame list                            │
 * │         │                                                               │
 * │         └─ templateFn(ctx) → HTML string                               │
 * │              ctx.data(key)          read from DataStore                 │
 * │              ctx.use(name, props)   render a Component                 │
 * │              ctx.map(arr, fn)       render array                        │
 * │              ctx.navigate(name)     emit data-navigate attr             │
 * │              ctx.if(cond, fn, else) conditional                         │
 * │              ctx.repeat(n, fn)      repeat n times                      │
 * │                                                                         │
 * │  On each HTTP request:                                                  │
 * │    renderFrame(frame, { dataStore, componentRegistry })                 │
 * │    → evaluates templateFn with a fresh ctx                              │
 * │    → collects component CSS used in this render                         │
 * │    → returns { body: string, css: string }                              │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

const { createContext }           = require('./context')
const { createServer }            = require('./server')
const { renderFrame: _renderFrame } = require('./render')
const { createDataStore }         = require('./dataStore')
const { createComponentRegistry } = require('./componentRegistry')

// ─── Snapshot ─────────────────────────────────────────────────────────────────
// Serialises the full app state for the UI AST desktop app.
// Produces: { schema, data, components: [{ name, css, previewBody }] }

const SNAPSHOT_PREVIEW_PROPS = {
  title: 'Preview', name: 'Sample', text: 'Preview text.',
  count: 0, value: '—', label: 'Label', price: 0, stock: 0,
}

function buildProjectSnapshot(dataStore, componentRegistry) {
  let data
  try {
    data = JSON.parse(JSON.stringify(dataStore.all()))
  } catch (err) {
    data = { _error: 'data_store_not_serializable', message: String(err) }
  }

  const components = componentRegistry.names().map(name => {
    const comp = componentRegistry.get(name)
    const ctx  = createContext(dataStore, componentRegistry)
    let previewBody = ''
    let renderError = null
    try {
      previewBody = comp.templateFn({ ...SNAPSHOT_PREVIEW_PROPS }, ctx)
    } catch (err) {
      renderError = err instanceof Error ? err.message : String(err)
      previewBody = `<!-- render error: ${renderError} -->`
    }
    return { name, css: comp.css, previewBody, ...(renderError ? { renderError } : {}) }
  })

  return { schema: 'frame-framework.projectSnapshot.v1', data, components }
}

// ─── createApp ────────────────────────────────────────────────────────────────

function createApp(options = {}) {
  const mode              = resolveMode(options.mode)
  const frames            = []                           // { name, templateFn, css }
  const dataStore         = createDataStore()
  const componentRegistry = createComponentRegistry()

  const app = {

    // ── Data store ─────────────────────────────────────────────────────────────
    //
    //   Set a value:   app.data('products', [...])
    //   Get a value:   app.data('products')
    //   Both calls return `app` so you can chain.
    //
    //   Values must be JSON-serialisable (objects, arrays, strings, numbers, booleans).
    //   Accessed inside templates via ctx.data('products').
    //
    data(key, value) {
      if (arguments.length < 2) return dataStore.get(key)
      dataStore.set(key, value)
      return app
    },

    // ── File-backed data store ─────────────────────────────────────────────────
    //
    //   Loads data from a JSON file and binds the store to that file.
    //   Every subsequent app.data(key, value) call persists the change to disk.
    //
    //   app.loadData('./data.json')   // relative to cwd
    //
    //   data.json format:
    //   {
    //     "products": [ { "name": "Notebook", "price": 12 } ],
    //     "user":     { "name": "Alice", "role": "admin" }
    //   }
    //
    loadData(filePath) {
      dataStore.load(filePath)
      return app
    },

    // ── Components ─────────────────────────────────────────────────────────────
    //
    //   Define:   app.component(name, templateFn, css?)
    //   Use:      ctx.use(name, props?)  inside any frame or component
    //
    //   templateFn signature: (props, ctx) => string
    //   - props  plain object of values passed at the call site
    //   - ctx    full context (can call ctx.data(), ctx.use(), ctx.map() etc.)
    //
    //   The component's CSS is injected once per page, regardless of how many
    //   times the component appears.
    //
    component(name, templateFn, css) {
      componentRegistry.define(name, templateFn, css ?? '')
      return app
    },

    // ── Frames (pages) ─────────────────────────────────────────────────────────
    //
    //   Define:   app.frame(name, templateFn, css?)
    //
    //   templateFn signature: (ctx) => string
    //   - ctx  context object (see Context Helpers below)
    //
    //   Each frame is rendered fresh on every HTTP request, so changes to the
    //   data store are always reflected immediately.
    //
    //   CSS passed here is scoped to this frame only.  Component CSS is collected
    //   automatically — you do not need to repeat it here.
    //
    frame(name, templateFn, css) {
      frames.push({ name, templateFn, css: css ?? '' })
      return app
    },

    // ── Server ─────────────────────────────────────────────────────────────────

    start(port = 3000) {
      const server = createServer({ frames, dataStore, componentRegistry }, mode)
      server.listen(port, () => {
        console.log(`frame  →  http://localhost:${port}  [${mode}]`)
        if (frames.length)
          console.log(`frames:     ${frames.map(f => f.name).join(', ')}`)
        if (componentRegistry.names().length)
          console.log(`components: ${componentRegistry.names().join(', ')}`)
        if (dataStore.keys().length)
          console.log(`data keys:  ${dataStore.keys().join(', ')}`)
        if (dataStore.filePath)
          console.log(`data file:  ${dataStore.filePath}`)
      })
      return server
    },

    get mode() { return mode },

    // ── Direct registry access (for tools / scripting) ─────────────────────────
    get dataStore()         { return dataStore },
    get componentRegistry() { return componentRegistry },

    // ── Snapshot ───────────────────────────────────────────────────────────────
    snapshot() {
      return buildProjectSnapshot(dataStore, componentRegistry)
    },
  }

  return app
}

// ─── Mode resolution ──────────────────────────────────────────────────────────

function resolveMode(optionMode) {
  const cliFlag = process.argv.find(a => a.startsWith('--mode='))
  if (cliFlag) {
    const val = cliFlag.split('=')[1]
    if (val === 'preview' || val === 'play') return val
  }
  if (process.env.FRAME_MODE === 'preview') return 'preview'
  if (process.env.FRAME_MODE === 'play')    return 'play'
  if (optionMode === 'preview') return 'preview'
  if (optionMode === 'play')    return 'play'
  return 'play'
}

// Re-export renderFrame for external use
const renderFrame = _renderFrame

module.exports = { createApp, renderFrame }
