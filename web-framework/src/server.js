const http = require('http')
const { renderFrame } = require('./render')
const { RUNTIME, RUNTIME_CSS } = require('./runtime')

// ─── HTML shell ───────────────────────────────────────────────────────────────

function buildPage(frameName, bodyHtml, frameCSS, mode) {
  const script = RUNTIME.replace('__MODE__', mode)
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${frameName}</title>
  <style>
    body { padding: 16px; font-family: sans-serif; font-size: 14px; line-height: 1.5; }
    ${RUNTIME_CSS}
    ${frameCSS ?? ''}
  </style>
</head>
<body>
${bodyHtml}
<script>${script}</script>
</body>
</html>`
}

// ─── createServer ─────────────────────────────────────────────────────────────
// Accepts the full app internals so frames are rendered on every request,
// guaranteeing that data store changes are always reflected immediately.

function createServer({ frames, dataStore, componentRegistry }, mode) {
  return http.createServer((req, res) => {
    const url      = new URL(req.url, `http://${req.headers.host}`)
    const pathname = url.pathname

    // Root → redirect to first frame
    if (pathname === '/') {
      const first = frames[0]
      if (!first) { res.writeHead(404); res.end('No frames defined.'); return }
      res.writeHead(302, { Location: '/' + first.name })
      res.end()
      return
    }

    const name  = pathname.slice(1)
    const frame = frames.find(f => f.name === name)

    if (!frame) {
      res.writeHead(404, { 'Content-Type': 'text/html' })
      res.end(
        `<pre>Frame "${name}" not found.\n\nDefined frames:\n` +
        frames.map(f => '  ' + f.name).join('\n') + '</pre>',
      )
      return
    }

    // Render fresh each request — data store is always current
    const { body, css } = renderFrame(frame, { dataStore, componentRegistry })
    const html = buildPage(frame.name, body, css, mode)
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(html)
  })
}

module.exports = { createServer }
