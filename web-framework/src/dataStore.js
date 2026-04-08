/**
 * DataStore — persistent, file-backed JSON key/value store shared across all frames.
 *
 * Architecture
 * ─────────────
 * The store is an in-memory plain object that is optionally bound to a JSON file on
 * disk.  Every write is immediately flushed to the file so the data survives server
 * restarts and can be read / edited externally (e.g. by a tool or AI agent).
 *
 * Usage in app.js
 * ───────────────
 *   const { createApp } = require('frame-framework')
 *   const app = createApp()
 *
 *   // Inline data (no file)
 *   app.data('products', [{ name: 'Notebook', price: 12 }])
 *
 *   // File-backed data (reads + auto-saves to data.json)
 *   app.loadData('./data.json')
 *
 * Usage in frame / component templates
 * ──────────────────────────────────────
 *   app.frame('home', ctx => {
 *     const products = ctx.data('products')   // read
 *     return `<ul>${ctx.map(products, p => `<li>${p.name}</li>`)}</ul>`
 *   })
 */

const fs   = require('fs')
const path = require('path')

function createDataStore(initialData = {}) {
  // Internal state — plain object, JSON-serialisable values only.
  const store = { ...initialData }

  // Path to the backing file, or null for in-memory only.
  let filePath = null

  // ── Helpers ────────────────────────────────────────────────────────────────

  function flush() {
    if (!filePath) return
    try {
      fs.writeFileSync(filePath, JSON.stringify(store, null, 2) + '\n', 'utf-8')
    } catch (err) {
      process.stderr.write(`[frame-framework] DataStore: could not write "${filePath}": ${err.message}\n`)
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  const ds = {
    /**
     * Get a value from the store.
     * @param {string} key
     * @returns {unknown}
     */
    get(key) {
      return store[key]
    },

    /**
     * Set (or replace) a value. Immediately persisted if a file is bound.
     * Value must be JSON-serialisable.
     * @param {string} key
     * @param {unknown} value
     */
    set(key, value) {
      store[key] = value
      flush()
    },

    /**
     * Delete a key. Immediately persisted if a file is bound.
     * @param {string} key
     */
    delete(key) {
      delete store[key]
      flush()
    },

    /**
     * Return a shallow copy of the whole store.
     * @returns {Record<string, unknown>}
     */
    all() {
      return { ...store }
    },

    /** All keys currently in the store. @returns {string[]} */
    keys() {
      return Object.keys(store)
    },

    /**
     * Bind to a JSON file.  If the file exists its contents are loaded and merged
     * on top of any data already set with `set()`.  Every subsequent `set()` /
     * `delete()` call will flush the updated store to this file.
     *
     * @param {string} fp  Path to the JSON file (resolved relative to cwd).
     */
    load(fp) {
      filePath = path.resolve(fp)
      if (fs.existsSync(filePath)) {
        try {
          const raw  = fs.readFileSync(filePath, 'utf-8').trim()
          const disk = JSON.parse(raw)
          if (disk && typeof disk === 'object' && !Array.isArray(disk)) {
            Object.assign(store, disk)
          } else {
            process.stderr.write(
              `[frame-framework] DataStore: "${filePath}" must contain a JSON object at the root.\n`,
            )
          }
        } catch (err) {
          process.stderr.write(
            `[frame-framework] DataStore: could not parse "${filePath}": ${err.message}\n`,
          )
        }
      } else {
        // File does not exist yet — write the current in-memory state now.
        flush()
      }
    },

    /**
     * Explicitly save to a given path (or the bound file if omitted).
     * Useful for one-off exports or migrations.
     * @param {string} [fp]
     */
    save(fp) {
      const target = fp ? path.resolve(fp) : filePath
      if (!target) throw new Error('[frame-framework] DataStore.save(): no file path bound or provided.')
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, JSON.stringify(store, null, 2) + '\n', 'utf-8')
    },

    /** @returns {string | null} Bound file path, or null if in-memory only. */
    get filePath() { return filePath },
  }

  return ds
}

module.exports = { createDataStore }
