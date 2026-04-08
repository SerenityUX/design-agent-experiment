/**
 * ComponentRegistry — named, reusable HTML snippets shared across all frames.
 *
 * Architecture
 * ─────────────
 * A component is a function that receives (props, ctx) and returns an HTML string.
 * It is registered by name and rendered inline wherever ctx.use(name, props) is
 * called from a frame or another component.
 *
 * Component CSS is automatically de-duplicated: every component's CSS is collected
 * during a render and injected into the page's <style> block exactly once,
 * regardless of how many times the component appears on that page.
 *
 * Defining a component
 * ─────────────────────
 *   app.component('badge', (props, ctx) => `
 *     <span class="badge ${props.variant ?? ''}">${props.label}</span>
 *   `, `
 *     .badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 12px; background: #eee; }
 *     .badge.primary { background: #0070f3; color: #fff; }
 *   `)
 *
 * Using a component in a frame
 * ─────────────────────────────
 *   app.frame('home', ctx => `
 *     ${ctx.use('badge', { label: 'New', variant: 'primary' })}
 *     ${ctx.use('badge', { label: 'Sale' })}
 *   `)
 *
 * Nested components
 * ──────────────────
 * Components receive ctx as their second argument so they can render other
 * components and read from the data store:
 *
 *   app.component('user-card', (props, ctx) => {
 *     const user = ctx.data('user')   // read from data store
 *     return `
 *       <div class="user-card">
 *         <strong>${user.name}</strong>
 *         ${ctx.use('badge', { label: user.role })}
 *       </div>
 *     `
 *   })
 */

function createComponentRegistry() {
  // name → { templateFn: Function, css: string }
  const registry = Object.create(null)

  const cr = {
    /**
     * Register (or overwrite) a component.
     *
     * @param {string}   name        Unique identifier used in ctx.use(name, props).
     * @param {Function} templateFn  (props, ctx) => string
     * @param {string}   [css]       CSS scoped to this component's classes.
     */
    define(name, templateFn, css = '') {
      if (typeof name !== 'string' || !name.trim()) {
        throw new Error('[frame-framework] ComponentRegistry.define(): name must be a non-empty string.')
      }
      if (typeof templateFn !== 'function') {
        throw new Error(`[frame-framework] ComponentRegistry.define("${name}"): templateFn must be a function.`)
      }
      registry[name] = { templateFn, css }
    },

    /**
     * Retrieve a component definition, or undefined if not found.
     * @param {string} name
     * @returns {{ templateFn: Function, css: string } | undefined}
     */
    get(name) {
      return registry[name]
    },

    /**
     * True if a component with this name is registered.
     * @param {string} name
     */
    has(name) {
      return Object.prototype.hasOwnProperty.call(registry, name)
    },

    /**
     * Remove a component by name.  Frames that call ctx.use(name) after deletion
     * will get an HTML comment placeholder instead of throwing.
     * @param {string} name
     */
    delete(name) {
      delete registry[name]
    },

    /**
     * All registered component names in definition order.
     * @returns {string[]}
     */
    names() {
      return Object.keys(registry)
    },

    /**
     * Return a plain-object copy of the registry (used by snapshot / introspection).
     * @returns {Record<string, { templateFn: Function, css: string }>}
     */
    all() {
      return { ...registry }
    },
  }

  return cr
}

module.exports = { createComponentRegistry }
