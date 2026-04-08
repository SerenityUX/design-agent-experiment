#!/usr/bin/env node

// ─── frame CLI ────────────────────────────────────────────────────────────────
// Usage: frame [app-file] [--mode=play|preview] [--port=3000]
//
// Defaults:
//   app-file  → app.js in current directory
//   --mode    → play
//   --port    → 3000

const path = require('path')
const fs   = require('fs')

// Parse args (strip node + script from argv)
const args = process.argv.slice(2)

// Port
const portArg = args.find(a => a.startsWith('--port='))
const port    = portArg ? parseInt(portArg.split('=')[1], 10) : 3000

// App file — first arg that doesn't start with '--'
const fileArg = args.find(a => !a.startsWith('--'))
const appFile = fileArg
  ? path.resolve(process.cwd(), fileArg)
  : path.resolve(process.cwd(), 'app.js')

if (!fs.existsSync(appFile)) {
  console.error(`frame: cannot find "${appFile}"`)
  console.error('Usage: frame [app-file] [--mode=play|preview] [--port=3000]')
  process.exit(1)
}

// Require the app — it calls app.start() internally, which reads mode from argv.
try {
  require(appFile)
} catch (err) {
  console.error(`frame: error loading "${appFile}"`)
  console.error(err.message)
  process.exit(1)
}
