const { createApp } = require('../src/index')

const app = createApp()

// ─── DataStore ────────────────────────────────────────────────────────────────
//
// The data store is a shared JSON object accessible from every frame and
// component via ctx.data(key).
//
// app.loadData('./data.json') binds the store to a file so every
// app.data(key, value) call automatically persists the change to disk.
//
// If data.json does not exist yet, calling app.data() first then loadData()
// will create the file.  The reverse also works: loadData() first populates
// from the file, then any app.data() calls override specific keys.
//
// Data values must be JSON-serialisable (objects, arrays, strings, numbers,
// booleans).  Functions are not allowed.

app.data('company', {
  name:    'Supply Co.',
  founded: 2024,
  mission: 'Straightforward products at honest prices.',
  team:    ['Alice', 'Bob', 'Carol'],
})

app.data('products', [
  { name: 'Notebook', price: 12,  stock: 40  },
  { name: 'Pen Set',  price: 8,   stock: 120 },
  { name: 'Backpack', price: 45,  stock: 7   },
  { name: 'Ruler',    price: 3,   stock: 200 },
])

// ─── ComponentRegistry ────────────────────────────────────────────────────────
//
// app.component(name, templateFn, css?) registers a reusable HTML snippet.
//
// templateFn signature: (props, ctx) => string
//   props — plain object passed at ctx.use(name, props) call site
//   ctx   — full context: ctx.data(), ctx.use(), ctx.map(), ctx.navigate() …
//
// A component's CSS is automatically injected once per page that renders it,
// regardless of how many times the component appears on that page.

// Navigation bar shared by all pages
app.component('page-header', (props, ctx) => `
  <p>
    <a ${ctx.navigate('home')}>Home</a> /
    <a ${ctx.navigate('products')}>Products</a> /
    <a ${ctx.navigate('about')}>About</a>
  </p>
  <hr>
  <h1>${props.title}</h1>
`)

// Short description paragraph — comes with scoped CSS
app.component('intro-blurb', props => `
  <p class="intro-blurb">${props.text}</p>
`, `.intro-blurb { color: #444; margin: 0 0 12px; max-width: 36em; }`)

// Inline badge showing how many products exist
app.component('product-count', props => `
  <p class="product-count">We carry <strong>${props.count}</strong> products.</p>
`, `.product-count strong { color: #0070f3; }`)

// A single <tr> row for the products table
app.component('product-row', props => `
  <tr>
    <td>${props.name}</td>
    <td>$${props.price}</td>
    <td>${props.stock} left</td>
  </tr>
`)

// A single <li> for team members
app.component('team-member', props => `
  <li>${props.name}</li>
`)

// ─── Frames (pages) ───────────────────────────────────────────────────────────
//
// app.frame(name, templateFn, css?) defines a page.
//
// templateFn: (ctx) => string
// Frames are re-rendered on every request, so data store changes are always live.

app.frame('home', ctx => {
  const company  = ctx.data('company')
  const products = ctx.data('products')
  return `
    ${ctx.use('page-header', { title: company.name })}
    ${ctx.use('intro-blurb', { text: company.mission })}
    ${ctx.use('product-count', { count: products.length })}
    <br>
    <button ${ctx.navigate('products')}>View Products</button>
    <button ${ctx.navigate('about')}>About Us</button>
  `
})

app.frame('products', ctx => {
  const products = ctx.data('products')
  return `
    ${ctx.use('page-header', { title: 'Products' })}
    <table border="1" cellpadding="6" cellspacing="0">
      <thead>
        <tr><th>Name</th><th>Price</th><th>Stock</th></tr>
      </thead>
      <tbody>
        ${ctx.map(products, p => ctx.use('product-row', p))}
      </tbody>
    </table>
    <br>
    <button ${ctx.navigate('home')}>← Back</button>
  `
}, `table { border-collapse: collapse; width: 100%; }`)

app.frame('about', ctx => {
  const company = ctx.data('company')
  return `
    ${ctx.use('page-header', { title: 'About ' + company.name })}
    <p>Founded ${company.founded}. ${company.mission}</p>
    <h2>Team</h2>
    <ul>
      ${ctx.map(company.team, name => ctx.use('team-member', { name }))}
    </ul>
    <br>
    <button ${ctx.navigate('home')}>← Home</button>
  `
})

// ─── Entry ────────────────────────────────────────────────────────────────────

if (process.argv.includes('--snapshot')) {
  console.log(JSON.stringify(app.snapshot(), null, 2))
  process.exit(0)
}

app.start(3000)
