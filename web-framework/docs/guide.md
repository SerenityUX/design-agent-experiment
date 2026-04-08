# Frame Framework — Complete Guide

Frame is a Node.js framework for building multi-page interactive prototypes.
Pages are plain HTML + CSS, data lives in a shared JSON store, and components
let you reuse markup across pages.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  app.js                                                         │
│                                                                 │
│  DataStore          ComponentRegistry         Frames            │
│  ─────────          ─────────────────         ──────            │
│  app.data(k, v)     app.component(n, fn, css)  app.frame(n, fn) │
│  app.loadData(path) ────────────────┐          ───────┐         │
│       │                            │                  │         │
│       └────────────────────────────┴──────────────────┘         │
│                                    │                            │
│                           templateFn(ctx)                       │
│                                    │                            │
│       ctx.data(key)        ◄───────┘                            │
│       ctx.use(name, props)                                      │
│       ctx.map(arr, fn)                                          │
│       ctx.navigate(name)                                        │
│       ctx.if(cond, fn)                                          │
│       ctx.repeat(n, fn)                                         │
│                                                                 │
│  On each request: renderFrame → { body, css } → HTML page      │
└─────────────────────────────────────────────────────────────────┘
```

Every frame is re-rendered on each HTTP request, so changes to the data store
appear immediately without restarting the server.

---

## Quick start

```js
const { createApp } = require('frame-framework')
const app = createApp()

app.data('user', { name: 'Alice', role: 'admin' })

app.component('greeting', props => `
  <p>Hello, <strong>${props.name}</strong>!</p>
`)

app.frame('home', ctx => {
  const user = ctx.data('user')
  return `
    ${ctx.use('greeting', { name: user.name })}
    <button ${ctx.navigate('settings')}>Settings</button>
  `
})

app.frame('settings', ctx => `
  <h1>Settings</h1>
  <button ${ctx.navigate('home')}>← Back</button>
`)

app.start(3000)
```

```
npm run dev      # play mode  — navigation is live
npm run preview  # preview mode — buttons shown, disabled
```

---

## DataStore

The data store is a **shared, JSON-serialisable key/value map** that every frame
and component can read via `ctx.data(key)`.

### Define data inline

```js
app.data('company', { name: 'Acme', founded: 2020 })
app.data('products', [
  { id: 1, name: 'Widget', price: 9.99, stock: 120 },
  { id: 2, name: 'Gadget', price: 24.99, stock: 45 },
])
app.data('currentUser', { name: 'Alice', role: 'admin', loggedIn: true })
```

Values can be any JSON-serialisable type: objects, arrays, strings, numbers,
booleans. Functions and undefined are not allowed.

### File-backed persistence

Use `app.loadData('./data.json')` to bind the store to a JSON file.

```js
app.loadData('./data.json')   // loads the file; every subsequent write is auto-saved
```

`data.json` example:
```json
{
  "company": {
    "name": "Supply Co.",
    "founded": 2024,
    "mission": "Straightforward products at honest prices.",
    "team": ["Alice", "Bob", "Carol"]
  },
  "products": [
    { "name": "Notebook", "price": 12, "stock": 40 },
    { "name": "Pen Set",  "price": 8,  "stock": 120 }
  ]
}
```

- If the file exists it is read on startup and merged into the store.
- If it does not exist it is created from the current in-memory state.
- Every `app.data(key, value)` call thereafter writes the updated file to disk.

### Read in a frame or component

```js
app.frame('dashboard', ctx => {
  const company  = ctx.data('company')    // object
  const products = ctx.data('products')   // array
  return `
    <h1>${company.name}</h1>
    <p>We carry ${products.length} products.</p>
  `
})
```

`ctx.data(key)` returns whatever was stored. If the key does not exist it
returns `undefined`.

### Update data at runtime

Call `app.data(key, value)` after startup to update a value.  The change is
live on the next request and, if a file is bound, persisted to disk.

```js
app.data('products', [...newProducts])
```

---

## ComponentRegistry

Components are **named, reusable HTML snippets** shared across all frames.
Editing a component definition updates it everywhere instantly.

### Define a component

```js
app.component(name, templateFn, css?)
```

| Parameter    | Type                          | Description                                   |
|--------------|-------------------------------|-----------------------------------------------|
| `name`       | string                        | Unique identifier. Used in `ctx.use(name)`.   |
| `templateFn` | `(props, ctx) => string`      | Returns an HTML string.                       |
| `css`        | string (optional)             | CSS injected once per page that uses it.      |

```js
// Simple component — no ctx needed
app.component('tag', props => `
  <span class="tag tag--${props.color ?? 'gray'}">${props.label}</span>
`, `
  .tag { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 12px; }
  .tag--gray  { background: #eee; color: #333; }
  .tag--blue  { background: #e0f0ff; color: #0050cc; }
  .tag--green { background: #e0ffe8; color: #1a7f3c; }
`)

// Component that reads the data store
app.component('user-badge', (props, ctx) => {
  const user = ctx.data('currentUser')
  return `<span class="user-badge">${user.name} · ${props.role ?? user.role}</span>`
}, `.user-badge { font-size: 12px; color: #555; }`)

// Component that renders another component (nested)
app.component('product-card', (props, ctx) => `
  <div class="product-card">
    <strong>${props.name}</strong>
    <span>$${props.price}</span>
    ${ctx.use('tag', { label: props.stock > 10 ? 'In stock' : 'Low stock', color: props.stock > 10 ? 'green' : 'gray' })}
  </div>
`, `
  .product-card { border: 1px solid #ddd; border-radius: 8px; padding: 12px; }
  .product-card strong { display: block; margin-bottom: 4px; }
`)
```

### Use a component in a frame

```js
// Render once
ctx.use('tag', { label: 'New', color: 'blue' })

// Render for each item in an array
ctx.map(products, p => ctx.use('product-card', p))

// Component with no props
ctx.use('nav-bar')
```

### Component CSS

- CSS is automatically injected into the `<style>` block of every page that
  uses the component — **exactly once**, regardless of how many instances appear.
- You do not need to copy component CSS into frame definitions.
- CSS is scoped by the class names you choose. Use unique prefixes (e.g.
  `.product-card`, `.nav-bar`) to avoid conflicts.

---

## Frames (pages)

A frame is a page. Define one with `app.frame(name, templateFn, css?)`.

```js
app.frame('products', ctx => {
  const products = ctx.data('products')
  return `
    ${ctx.use('nav-bar')}
    <h1>Products</h1>
    <div class="product-grid">
      ${ctx.map(products, p => ctx.use('product-card', p))}
    </div>
    <button ${ctx.navigate('home')}>← Back</button>
  `
}, `
  .product-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 12px; }
`)
```

| Parameter    | Type                  | Description                                              |
|--------------|-----------------------|----------------------------------------------------------|
| `name`       | string                | URL slug (`/products`) and identifier for navigation.    |
| `templateFn` | `(ctx) => string`     | Returns body HTML. Called on every request.              |
| `css`        | string (optional)     | CSS scoped to this frame only (not shared with others).  |

Frames are re-rendered on every HTTP request, so any data store changes are
always reflected without a restart.

---

## Context helpers

All helpers are available inside frame and component template functions via `ctx`.

### `ctx.data(key)` → value
Read a value from the shared data store.
```js
const user     = ctx.data('currentUser')   // object
const products = ctx.data('products')      // array
const title    = ctx.data('siteTitle')     // string
```

### `ctx.use(name, props?)` → HTML string
Render a registered component.
```js
ctx.use('nav-bar')
ctx.use('product-card', { name: 'Notebook', price: 12, stock: 40 })
ctx.use('tag', { label: 'Sale', color: 'blue' })
```
Returns `<!-- component "name" not found -->` if the component is not registered.

### `ctx.map(array, fn)` → HTML string
Render each array item with a function and join the results.
```js
ctx.map(products, p => `<li>${p.name} — $${p.price}</li>`)
ctx.map(products, p => ctx.use('product-card', p))
ctx.map(['a', 'b', 'c'], (item, index) => `<span>${index}: ${item}</span>`)
```
Returns `''` for non-arrays.

### `ctx.navigate(frameName)` → attribute string
Emit a `data-navigate` attribute. Used for prototype navigation links.
```js
`<button ${ctx.navigate('about')}>About</button>`
`<a ${ctx.navigate('home')}>← Home</a>`
```
In **play mode** clicking navigates. In **preview mode** the element is shown with
a dashed outline but is not clickable.

### `ctx.if(condition, fn, elseFn?)` → string
Conditional rendering.
```js
ctx.if(user.loggedIn, () => `<a ${ctx.navigate('account')}>My Account</a>`)
ctx.if(products.length > 0,
  () => `<ul>${ctx.map(products, p => `<li>${p.name}</li>`)}</ul>`,
  () => `<p>No products available.</p>`,
)
```

### `ctx.repeat(n, fn)` → string
Repeat a template n times with the zero-based index.
```js
ctx.repeat(3, i => `<div class="skeleton-row">Row ${i + 1}</div>`)
```

---

## Navigation

Add `data-navigate="frameName"` (via `ctx.navigate()`) to any element to make
it a prototype navigation trigger.

```js
// Frame links
`<button ${ctx.navigate('checkout')}>Check out</button>`
`<a ${ctx.navigate('home')}>← Home</a>`
`<div ${ctx.navigate('detail')} class="card">...</div>`  // any element
```

The UI AST desktop app reads all `data-navigate` elements and draws connection
arrows between frames automatically. No configuration required.

---

## Modes

| | play | preview |
|---|---|---|
| `data-navigate` elements | clickable, navigates | visible, not clickable |
| Visual indicator | `cursor: pointer` | dashed blue outline |
| Use for | development / user testing | design reviews |
| CLI | `--mode=play` | `--mode=preview` |

Mode is resolved in this priority order:
1. `--mode=` CLI flag
2. `FRAME_MODE` environment variable
3. `createApp({ mode })` option
4. Default: `play`

---

## Full example

```js
// app.js
const { createApp } = require('frame-framework')
const app = createApp()

// ── Data store ───────────────────────────────────────────────────────────────
// Load from file (creates data.json if it doesn't exist)
app.loadData('./data.json')

// Or define inline:
// app.data('company', { name: 'Supply Co.', founded: 2024, team: ['Alice', 'Bob'] })
// app.data('products', [
//   { name: 'Notebook', price: 12, stock: 40 },
//   { name: 'Pen Set', price: 8, stock: 120 },
// ])

// ── Components ───────────────────────────────────────────────────────────────
app.component('nav-bar', (props, ctx) => `
  <nav class="nav">
    <a ${ctx.navigate('home')}>Home</a>
    <a ${ctx.navigate('products')}>Products</a>
    <a ${ctx.navigate('about')}>About</a>
  </nav>
  <hr>
`, `
  .nav { display: flex; gap: 12px; margin-bottom: 4px; }
  .nav a { color: #0070f3; text-decoration: none; }
`)

app.component('product-row', props => `
  <tr>
    <td>${props.name}</td>
    <td>$${props.price}</td>
    <td>${props.stock} left</td>
  </tr>
`)

app.component('team-list', (props, ctx) => {
  const company = ctx.data('company')
  return `
    <ul>
      ${ctx.map(company.team, name => `<li>${name}</li>`)}
    </ul>
  `
})

// ── Frames ───────────────────────────────────────────────────────────────────
app.frame('home', ctx => {
  const company  = ctx.data('company')
  const products = ctx.data('products')
  return `
    ${ctx.use('nav-bar')}
    <h1>${company.name}</h1>
    <p>${company.mission}</p>
    <p>We carry ${products.length} products.</p>
    <button ${ctx.navigate('products')}>View Products</button>
    <button ${ctx.navigate('about')}>About Us</button>
  `
})

app.frame('products', ctx => {
  const products = ctx.data('products')
  return `
    ${ctx.use('nav-bar')}
    <h1>Products</h1>
    <table border="1" cellpadding="6" cellspacing="0">
      <thead><tr><th>Name</th><th>Price</th><th>Stock</th></tr></thead>
      <tbody>${ctx.map(products, p => ctx.use('product-row', p))}</tbody>
    </table>
    <br>
    <button ${ctx.navigate('home')}>← Back</button>
  `
}, `table { border-collapse: collapse; width: 100%; }`)

app.frame('about', ctx => {
  const company = ctx.data('company')
  return `
    ${ctx.use('nav-bar')}
    <h1>About ${company.name}</h1>
    <p>Founded ${company.founded}. ${company.mission}</p>
    <h2>Team</h2>
    ${ctx.use('team-list')}
    <button ${ctx.navigate('home')}>← Home</button>
  `
})

app.start(3000)
```

---

## CLI

```
frame [app-file] [--mode=play|preview] [--port=3000]
```

Defaults: `app.js` in cwd, play mode, port 3000.

```json
{
  "scripts": {
    "dev":     "frame app.js --mode=play",
    "preview": "frame app.js --mode=preview"
  }
}
```

---

## Snapshot (UI AST desktop integration)

Running with `--snapshot` prints a JSON object and exits.

```
node app.js --snapshot
```

Output shape:
```json
{
  "schema": "frame-framework.projectSnapshot.v1",
  "data": { "company": { ... }, "products": [ ... ] },
  "components": [
    { "name": "nav-bar", "css": "...", "previewBody": "..." },
    { "name": "product-row", "css": "", "previewBody": "..." }
  ]
}
```

The `scripts/write-snapshot-to-desktop.js` helper runs this and writes the
output to `desktop-application/src/frameProjectSnapshot.json` so the UI AST
desktop app can read the data store and component previews.

```
node web-framework/scripts/write-snapshot-to-desktop.js
```
