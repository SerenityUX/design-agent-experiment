const { createContext } = require('./context')

/**
 * Render a single frame to { body, css }.
 *
 * Called once per HTTP request so the output always reflects the current
 * data store values.
 *
 * @param {{ name: string, templateFn: Function, css: string }} frameDef
 * @param {{ dataStore: import('./dataStore').DataStore, componentRegistry: import('./componentRegistry').ComponentRegistry }} deps
 * @returns {{ body: string, css: string }}
 */
function renderFrame(frameDef, { dataStore, componentRegistry }) {
  const used = new Set()
  const ctx  = createContext(dataStore, componentRegistry, used)

  const body = typeof frameDef.templateFn === 'function'
    ? frameDef.templateFn(ctx)
    : String(frameDef.templateFn)

  // Collect each used component's CSS once (in definition order, de-duped by Set)
  const compCSS = [...used]
    .map(n => componentRegistry.get(n)?.css ?? '')
    .filter(Boolean)
    .join('\n')

  return { body, css: (frameDef.css ? frameDef.css + '\n' : '') + compCSS }
}

module.exports = { renderFrame }
