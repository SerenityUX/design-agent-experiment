#!/usr/bin/env node
/**
 * Renders web-framework example app (or FRAME_APP_JS) with --snapshot and writes
 * desktop-application/src/frameProjectSnapshot.json for the UI AST desktop app.
 *
 * Usage (from repo root):
 *   node web-framework/scripts/write-snapshot-to-desktop.js
 *
 * Custom app entry:
 *   FRAME_APP_JS=/path/to/app.js node web-framework/scripts/write-snapshot-to-desktop.js
 */

const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const wfRoot = path.join(__dirname, '..')
const appJs = process.env.FRAME_APP_JS
  ? path.resolve(process.env.FRAME_APP_JS)
  : path.join(wfRoot, 'example', 'app.js')

const outPath = path.join(wfRoot, '..', 'desktop-application', 'src', 'frameProjectSnapshot.json')

if (!fs.existsSync(appJs)) {
  console.error('write-snapshot: app not found:', appJs)
  process.exit(1)
}

const r = spawnSync(process.execPath, [appJs, '--snapshot'], {
  encoding: 'utf-8',
  cwd: path.dirname(appJs),
})
if (r.status !== 0) {
  console.error(r.stderr || r.stdout)
  process.exit(r.status ?? 1)
}

let snap
try {
  snap = JSON.parse(r.stdout)
} catch (e) {
  console.error('write-snapshot: invalid JSON from snapshot:', e.message)
  console.error(r.stdout.slice(0, 500))
  process.exit(1)
}

snap.meta = {
  generatedFrom: path.relative(path.join(wfRoot, '..'), appJs),
  generatedAt: new Date().toISOString(),
}

fs.mkdirSync(path.dirname(outPath), { recursive: true })
fs.writeFileSync(outPath, JSON.stringify(snap, null, 2), 'utf-8')
console.log('Wrote', outPath)
