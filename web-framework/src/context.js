/**
 * Context — the `ctx` object passed into every frame and component template.
 *
 * Every helper returns a plain string so templates can embed ctx calls
 * directly inside template literals with ${ }.
 *
 * createContext(dataStore, componentRegistry) is called once per HTTP request.
 * The returned ctx is scoped to that request and tracks which component CSS
 * needs to be injected into the page (via ctx._usedComponents()).
 */

function createContext(dataStore, componentRegistry, _used = new Set()) {
  const ctx = {

    // ── ctx.data(key) ──────────────────────────────────────────────────────────
    // Read a value from the shared data store.
    //
    //   const user     = ctx.data('user')
    //   const products = ctx.data('products')   // could be an array
    //
    data(key) {
      return dataStore.get(key)
    },

    // ── ctx.use(name, props?) ──────────────────────────────────────────────────
    // Render a registered component by name.
    // Returns an HTML string.  If the component is not found, returns an HTML
    // comment so the page renders without throwing.
    //
    //   ctx.use('nav-bar')
    //   ctx.use('product-row', { name: 'Notebook', price: 12, stock: 40 })
    //   ctx.use('badge', { label: user.role, variant: 'primary' })
    //
    use(name, props = {}) {
      const comp = componentRegistry.get(name)
      if (!comp) return `<!-- component "${name}" not found -->`
      _used.add(name)
      // Sub-context inherits the same data store, registry, and _used set so
      // nested components also register their CSS.
      const sub = createContext(dataStore, componentRegistry, _used)
      return typeof comp.templateFn === 'function'
        ? comp.templateFn(props, sub)
        : String(comp.templateFn)
    },

    // ── ctx.map(array, fn) ─────────────────────────────────────────────────────
    // Render each item in an array with a template function and join the results.
    // Returns an empty string for non-arrays.
    //
    //   ctx.map(products, p => `<li>${p.name} — $${p.price}</li>`)
    //   ctx.map(products, p => ctx.use('product-row', p))
    //
    map(arr, fn) {
      if (!Array.isArray(arr)) return ''
      return arr.map((item, i) => fn(item, i)).join('')
    },

    // ── ctx.navigate(frameName) ────────────────────────────────────────────────
    // Emit a data-navigate attribute string.
    // The desktop app and runtime use this to wire up prototype navigation.
    //
    //   <button ${ctx.navigate('about')}>About</button>
    //   <a ${ctx.navigate('home')}>Home</a>
    //
    navigate(frameName) {
      return `data-navigate="${frameName}"`
    },

    // ── ctx.if(condition, fn, elseFn?) ─────────────────────────────────────────
    // Conditional rendering.
    //
    //   ctx.if(user.isAdmin, () => `<a href="/admin">Admin Panel</a>`)
    //   ctx.if(items.length > 0, () => `<ul>…</ul>`, () => `<p>No items.</p>`)
    //
    if(condition, fn, elseFn) {
      if (condition) return typeof fn === 'function' ? fn() : String(fn)
      if (elseFn)   return typeof elseFn === 'function' ? elseFn() : String(elseFn)
      return ''
    },

    // ── ctx.repeat(n, fn) ─────────────────────────────────────────────────────
    // Repeat a template function n times, passing the zero-based index.
    //
    //   ctx.repeat(5, i => `<li>Item ${i + 1}</li>`)
    //
    repeat(n, fn) {
      return Array.from({ length: n }, (_, i) => fn(i)).join('')
    },

    // ── Internal ──────────────────────────────────────────────────────────────
    // Returns the names of all components rendered during this ctx's lifetime.
    // Used by renderFrame to collect component CSS.
    _usedComponents() { return [..._used] },
  }

  return ctx
}

module.exports = { createContext }
