/**
 * ChatPanel — powered by @mariozechner/pi-agent-core + @mariozechner/pi-ai
 *
 * The Agent class manages the conversation loop and native tool calling.
 * Five tools give the AI read/write access to every page in the prototype.
 */

import { useEffect, useRef, useState, useCallback, forwardRef, useImperativeHandle, type CSSProperties } from 'react'
import ReactMarkdown from 'react-markdown'
import { invoke } from '@tauri-apps/api/core'
import { Agent } from '@mariozechner/pi-agent-core'
import { streamSimple, getModels, Type } from '@mariozechner/pi-ai'
import type { AgentTool, AgentEvent } from '@mariozechner/pi-agent-core'
import type { TextContent, ImageContent } from '@mariozechner/pi-ai'

// ─── Public types ─────────────────────────────────────────────────────────────

export type PageDef = {
  name: string
  body: string
  css: string
  width: number
  height: number
}

export type ComponentDef = {
  name: string
  /** JavaScript template function source, e.g. "(props, ctx) => `<div>${props.label}</div>`" */
  templateSource: string
  css: string
  /** Pre-rendered preview HTML (rendered with sample props) */
  previewBody: string
}

export type ChatAction =
  | { type: 'set_page'; name: string; body: string; css: string; width?: number; height?: number }
  | { type: 'create_page'; name: string; body: string; css: string; width?: number; height?: number }
  | { type: 'delete_page'; name: string }

export type DataAction =
  | { type: 'set_data'; key: string; value: unknown }
  | { type: 'delete_data'; key: string }

export type ComponentAction =
  | { type: 'set_component'; name: string; templateSource: string; css: string; previewBody: string }
  | { type: 'delete_component'; name: string }

// ─── Internal types ───────────────────────────────────────────────────────────

type DiffLine = { kind: 'add' | 'remove' | 'same'; text: string }

export type ImagineConceptResult = {
  name: string
  description: string
  imageDataUrl: string | null
  /** Short appreciation of this direction — generated alongside the image */
  agentLikes?: string
  error?: string
}

type AppliedChange = {
  actionType: string
  label: string
  diff?: DiffLine[]
  screenshotDataUrl?: string
  imagineConcepts?: ImagineConceptResult[]
}

type ToolCallEntry = {
  id: string
  name: string
  label: string
  status: 'running' | 'done' | 'error'
  change?: AppliedChange
}

export type TurnEntry = {
  id: string
  role: 'user' | 'assistant'
  text: string
  toolCalls: ToolCallEntry[]
  done: boolean
}

export type ChatPanelHandle = {
  sendMessage(text: string): void
}

// ─── Diff ─────────────────────────────────────────────────────────────────────

function computeDiff(before: string, after: string): DiffLine[] {
  if (before === after) {
    return before.split('\n').map(text => ({ kind: 'same' as const, text }))
  }
  const a = before.split('\n'), b = after.split('\n')
  const m = a.length, n = b.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1])
  const lines: DiffLine[] = []
  let i = m, j = n
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      lines.push({ kind: 'same', text: a[i - 1] }); i--; j--
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      lines.push({ kind: 'add', text: b[j - 1] }); j--
    } else {
      lines.push({ kind: 'remove', text: a[i - 1] }); i--
    }
  }
  return lines.reverse()
}

function collapseContext(diff: DiffLine[], ctx = 3): DiffLine[] {
  const out: DiffLine[] = []
  let i = 0
  while (i < diff.length) {
    if (diff[i].kind !== 'same') { out.push(diff[i++]); continue }
    let end = i
    while (end < diff.length && diff[end].kind === 'same') end++
    const run = end - i
    if (run <= ctx * 2) {
      for (let k = i; k < end; k++) out.push(diff[k])
    } else {
      for (let k = i; k < i + ctx; k++) out.push(diff[k])
      out.push({ kind: 'same', text: `… ${run - ctx * 2} unchanged lines …` })
      for (let k = end - ctx; k < end; k++) out.push(diff[k])
    }
    i = end
  }
  return out
}

// ─── Model resolution ─────────────────────────────────────────────────────────

function resolveModel() {
  const pref =
    (import.meta.env.VITE_OPENROUTER_MODEL as string | undefined) ?? 'openai/gpt-4o-mini'
  const models = getModels('openrouter')
  return (
    models.find(m => m.id === pref) ??
    models.find(m => m.id === 'openai/gpt-4o-mini') ??
    models[0]
  )
}

// ─── System prompt ────────────────────────────────────────────────────────────

function buildSystemPrompt(
  pages: PageDef[],
  dataStore: Record<string, unknown>,
  components: ComponentDef[],
  selectedElement?: string,
): string {
  const pagesBlock =
    pages.length === 0
      ? '_(no pages yet — use create_page to add one)_'
      : pages
          .map(
            p =>
              `**"${p.name}"** (${p.width}×${p.height}px)\n` +
              `\`\`\`html\n${p.body.trim() || '<!-- empty -->'}\n\`\`\`` +
              (p.css.trim() ? `\n\`\`\`css\n${p.css.trim()}\n\`\`\`` : ''),
          )
          .join('\n\n')

  const dataBlock =
    Object.keys(dataStore).length === 0
      ? '_(empty — use set_data to add keys)_'
      : '```json\n' + JSON.stringify(dataStore, null, 2) + '\n```'

  const componentsBlock =
    components.length === 0
      ? '_(none — use set_component to create one)_'
      : components
          .map(
            c =>
              `**"${c.name}"**\n` +
              `\`\`\`js\n${c.templateSource.trim()}\n\`\`\`` +
              (c.css.trim() ? `\n\`\`\`css\n${c.css.trim()}\n\`\`\`` : ''),
          )
          .join('\n\n')

  const selCtx = selectedElement?.trim()
    ? `\n**Currently selected element:** \`${selectedElement}\`\n`
    : ''

  return `You are an AI assistant embedded in **ui-ast**, a prototyping tool built on the **Frame framework**.
You can read and write pages, the data store, and the component registry.

When asked to design or create UI — especially new pages or features — use the **\`imagine\`** tool first to visually explore creative directions. Generate images of several wildly different concepts, pick the one that feels most exciting and unexpected, then build it. Favor bold, creative, out-there aesthetic choices over safe defaults.

After **\`imagine\`** returns, your reasoning should briefly note what you **like** about **each** imagined direction (specific qualities: palette, type, layout, mood, novelty) before you commit to one. The tool attaches draft “likes” per concept; expand on them in your own voice where it helps.

Use **\`search_design_inspiration\`** when you need real-world references — before building, to ground your aesthetic choices in actual sites, or when the user asks about specific design styles, trends, or wants inspiration from existing work.

---

## How pages and components work

Page bodies and component template sources are **JavaScript template literal content** — the inside of a backtick string evaluated with a \`ctx\` object available.

The desktop app evaluates every page body live using the current data store and components. **Never hardcode data values.** Always pull from the data store with \`ctx.data()\`.

### ctx helpers

| Helper | What it does |
|--------|-------------|
| \`\${ctx.data('key')}\` | Read a value from the data store |
| \`\${ctx.use('name', props)}\` | Render a registered component |
| \`\${ctx.map(arr, item => \`...\`)}\` | Render each item in an array, joined |
| \`\${ctx.navigate('page')}\` | Emit \`data-navigate="page"\` attribute for prototype links |
| \`\${ctx.if(cond, () => \`...\`, () => \`...\`)}\` | Conditional block |
| \`\${ctx.repeat(n, i => \`...\`)}\` | Repeat n times |

### Writing a page body

A page body is the **content** of the template — just the expressions, no function wrapper:

\`\`\`
<h1>\${ctx.data('company').name}</h1>
<p>\${ctx.data('company').mission}</p>
<ul>
  \${ctx.map(ctx.data('company').team, name => \`<li>\${name}</li>\`)}
</ul>
<button \${ctx.navigate('about')}>About Us</button>
\`\`\`

### Writing a component template source

A component template is **just the content** — \`props\` and \`ctx\` are both in scope:

\`\`\`
<nav class="nav">
  <a \${ctx.navigate('home')}>Home</a>
  <a \${ctx.navigate('products')}>Products</a>
</nav>
<hr>
\`\`\`

#### Props — per-instance values

Use \`props\` for anything that changes per usage. Pass them at \`ctx.use()\` call sites:

Component template (\`bottom-bar\`):
\`\`\`
<nav class="bottom-bar">
  <a class="bottom-bar__item \${props.selected === 'home'    ? 'bottom-bar__item--active' : ''}" \${ctx.navigate('home')}>Home</a>
  <a class="bottom-bar__item \${props.selected === 'search'  ? 'bottom-bar__item--active' : ''}" \${ctx.navigate('search')}>Search</a>
  <a class="bottom-bar__item \${props.selected === 'profile' ? 'bottom-bar__item--active' : ''}" \${ctx.navigate('profile')}>Profile</a>
</nav>
\`\`\`

CSS for that component:
\`\`\`
.bottom-bar { display: flex; justify-content: space-around; padding: 10px 0; border-top: 1px solid #eee; }
.bottom-bar__item { flex: 1; text-align: center; text-decoration: none; color: #999; font-size: 12px; }
.bottom-bar__item--active { color: #0070f3; font-weight: 600; }
\`\`\`

Using it in each page body (pass \`selected\` so the right tab highlights):
\`\`\`
\${ctx.use('bottom-bar', { selected: 'home' })}
\`\`\`
\`\`\`
\${ctx.use('bottom-bar', { selected: 'search' })}
\`\`\`

Props can be anything — strings, numbers, booleans, objects, arrays. Default values with \`??\`:
\`\`\`
<span class="badge badge--\${props.color ?? 'gray'}">\${props.label}</span>
\`\`\`

#### Components that read the data store

\`ctx\` is also available, so components can pull shared data directly:
\`\`\`
<ul>
  \${ctx.map(ctx.data('company').team, name => '<li>' + name + '</li>')}
</ul>
\`\`\`

**Note:** When writing callbacks inside \`ctx.map()\` or \`ctx.if()\`, use string concatenation (\`'<li>' + x + '</li>'\`) rather than nested template literals (\`\\\`<li>\${x}</li>\\\`\`) to avoid parsing issues.

### Prototype navigation

Use \`ctx.navigate('page-name')\` as an attribute on any element:
\`\`\`
<button \${ctx.navigate('checkout')}>Check out</button>
<a \${ctx.navigate('home')}>← Back</a>
<div class="card" \${ctx.navigate('detail')}>…</div>
\`\`\`

### Data store

Keys are JSON-serialisable. Every page that reads \`ctx.data('key')\` updates automatically when that key changes via \`set_data\`.

### Component CSS

Pass CSS in the \`css\` field of \`set_component\`. Use unique class name prefixes (e.g. \`.bottom-bar\`, \`.product-card\`) to avoid collisions. The CSS is automatically injected into any page that uses the component.

---

## Current Prototype State
${selCtx}
### Pages (${pages.length})
${pagesBlock}

### DataStore
${dataBlock}

### Components (${components.length})
${componentsBlock}
`
}

// ─── Tool factory ─────────────────────────────────────────────────────────────

function makeTools(
  getPagesSnapshot: () => PageDef[],
  getDataStore: () => Record<string, unknown>,
  getComponents: () => ComponentDef[],
  applyAction: (action: ChatAction) => void,
  applyDataAction: (action: DataAction) => void,
  applyComponentAction: (action: ComponentAction) => void,
): AgentTool<any, AppliedChange | null>[] {
  const text = (s: string): TextContent => ({ type: 'text', text: s })

  const listPagesTool: AgentTool<any, null> = {
    label: 'List Pages',
    name: 'list_pages',
    description: 'List all pages currently in the prototype with their names and dimensions.',
    parameters: Type.Object({}),
    async execute() {
      const pages = getPagesSnapshot()
      const summary =
        pages.length === 0
          ? 'No pages yet.'
          : pages.map(p => `- "${p.name}" (${p.width}×${p.height}px)`).join('\n')
      return { content: [text(summary)], details: null }
    },
  }

  const readPageTool: AgentTool<any, null> = {
    label: 'Read Page',
    name: 'read_page',
    description: "Read a page's full HTML body and CSS.",
    parameters: Type.Object({
      name: Type.String({ description: 'Page name to read' }),
    }),
    async execute(_id, params) {
      const page = getPagesSnapshot().find(p => p.name === params.name)
      if (!page) return { content: [text(`Page "${params.name}" not found.`)], details: null }
      const out =
        `Page: "${page.name}" (${page.width}×${page.height}px)\n\n` +
        `CSS:\n\`\`\`css\n${page.css.trim() || '/* none */'}\n\`\`\`\n\n` +
        `Body:\n\`\`\`html\n${page.body.trim()}\n\`\`\``
      return { content: [text(out)], details: null }
    },
  }

  const setPageTool: AgentTool<any, AppliedChange> = {
    label: 'Set Page',
    name: 'set_page',
    description:
      'Update an existing page — body, CSS, and/or dimensions. Write the complete body, not a fragment.',
    parameters: Type.Object({
      name  : Type.String({ description: 'Name of the page to update' }),
      body  : Type.String({ description: 'Complete template body for the page' }),
      css   : Type.Optional(Type.String({ description: 'CSS styles for this page' })),
      width : Type.Optional(Type.Number({ description: 'Frame width in px' })),
      height: Type.Optional(Type.Number({ description: 'Frame height in px' })),
    }),
    async execute(_id, params) {
      const pages = getPagesSnapshot()
      const existing = pages.find(p => p.name === params.name)
      if (!existing) {
        return {
          content: [text(`Page "${params.name}" not found. Use create_page to add it.`)],
          details: { actionType: 'set_page', label: params.name },
        }
      }
      const beforeText = `${existing.css.trim()}\n\n${existing.body.trim()}`
      const afterText = `${(params.css ?? existing.css).trim()}\n\n${params.body.trim()}`
      applyAction({
        type: 'set_page',
        name: params.name,
        body: params.body,
        css: params.css ?? existing.css,
        width: params.width,
        height: params.height,
      })
      return {
        content: [text(`Updated page "${params.name}".`)],
        details: {
          actionType: 'set_page',
          label: params.name,
          diff: computeDiff(beforeText, afterText),
        },
      }
    },
  }

  const createPageTool: AgentTool<any, AppliedChange> = {
    label: 'Create Page',
    name: 'create_page',
    description: 'Create a new page in the prototype.',
    parameters: Type.Object({
      name: Type.String({ description: 'Unique page slug (e.g. "contact")' }),
      body: Type.String({ description: 'Complete HTML body content for the new page' }),
      css: Type.Optional(Type.String({ description: 'CSS styles for this page' })),
      width: Type.Optional(Type.Number({ description: 'Width in px (default: 390)' })),
      height: Type.Optional(Type.Number({ description: 'Height in px (default: 520)' })),
    }),
    async execute(_id, params) {
      const exists = getPagesSnapshot().some(p => p.name === params.name)
      if (exists) {
        return {
          content: [text(`Page "${params.name}" already exists. Use set_page to edit it.`)],
          details: { actionType: 'create_page', label: params.name },
        }
      }
      const css = params.css ?? ''
      const afterText = `${css.trim()}\n\n${params.body.trim()}`
      applyAction({
        type: 'create_page',
        name: params.name,
        body: params.body,
        css,
        width: params.width,
        height: params.height,
      })
      return {
        content: [text(`Created page "${params.name}".`)],
        details: {
          actionType: 'create_page',
          label: params.name,
          diff: computeDiff('', afterText),
        },
      }
    },
  }

  const deletePageTool: AgentTool<any, AppliedChange> = {
    label: 'Delete Page',
    name: 'delete_page',
    description: 'Delete a page from the prototype.',
    parameters: Type.Object({
      name: Type.String({ description: 'Name of the page to delete' }),
    }),
    async execute(_id, params) {
      const pages = getPagesSnapshot()
      const existing = pages.find(p => p.name === params.name)
      if (!existing) {
        return {
          content: [text(`Page "${params.name}" not found.`)],
          details: { actionType: 'delete_page', label: params.name },
        }
      }
      const beforeText = `${existing.css.trim()}\n\n${existing.body.trim()}`
      applyAction({ type: 'delete_page', name: params.name })
      return {
        content: [text(`Deleted page "${params.name}".`)],
        details: {
          actionType: 'delete_page',
          label: params.name,
          diff: computeDiff(beforeText, ''),
        },
      }
    },
  }

  // ── Data store tools ─────────────────────────────────────────────────────

  const readDatastoreTool: AgentTool<any, null> = {
    label: 'Read DataStore',
    name: 'read_datastore',
    description: 'Read the full shared data store as JSON. Use this to see all current data before making changes.',
    parameters: Type.Object({}),
    async execute() {
      const ds = getDataStore()
      const keys = Object.keys(ds)
      if (keys.length === 0) return { content: [text('DataStore is empty.')], details: null }
      return {
        content: [text('```json\n' + JSON.stringify(ds, null, 2) + '\n```')],
        details: null,
      }
    },
  }

  const setDataTool: AgentTool<any, AppliedChange> = {
    label: 'Set Data',
    name: 'set_data',
    description: 'Set or replace a key in the shared data store. The value must be JSON-serialisable (object, array, string, number, boolean).',
    parameters: Type.Object({
      key: Type.String({ description: 'Data store key (e.g. "products", "company", "currentUser")' }),
      value: Type.Any({ description: 'JSON-serialisable value to store at this key' }),
    }),
    async execute(_id, params) {
      const before = getDataStore()[params.key]
      const beforeText = before !== undefined ? JSON.stringify(before, null, 2) : ''
      const afterText = JSON.stringify(params.value, null, 2)
      applyDataAction({ type: 'set_data', key: params.key, value: params.value })
      return {
        content: [text(`Set data["${params.key}"].`)],
        details: { actionType: 'set_data', label: params.key, diff: computeDiff(beforeText, afterText) },
      }
    },
  }

  const deleteDataTool: AgentTool<any, AppliedChange> = {
    label: 'Delete Data',
    name: 'delete_data',
    description: 'Remove a key from the shared data store.',
    parameters: Type.Object({
      key: Type.String({ description: 'Key to remove from the data store' }),
    }),
    async execute(_id, params) {
      const ds = getDataStore()
      if (!(params.key in ds)) {
        return { content: [text(`Key "${params.key}" not found in data store.`)], details: { actionType: 'delete_data', label: params.key } }
      }
      const beforeText = JSON.stringify(ds[params.key], null, 2)
      applyDataAction({ type: 'delete_data', key: params.key })
      return {
        content: [text(`Deleted data["${params.key}"].`)],
        details: { actionType: 'delete_data', label: params.key, diff: computeDiff(beforeText, '') },
      }
    },
  }

  // ── Component tools ───────────────────────────────────────────────────────

  const listComponentsTool: AgentTool<any, null> = {
    label: 'List Components',
    name: 'list_components',
    description: 'List all registered components with their names.',
    parameters: Type.Object({}),
    async execute() {
      const comps = getComponents()
      if (comps.length === 0) return { content: [text('No components registered yet.')], details: null }
      const lines = comps.map(c => `- ${c.name}${c.css.trim() ? ' (has CSS)' : ''}`)
      return { content: [text(lines.join('\n'))], details: null }
    },
  }

  const readComponentTool: AgentTool<any, null> = {
    label: 'Read Component',
    name: 'read_component',
    description: "Read a component's template source, CSS, and preview HTML.",
    parameters: Type.Object({
      name: Type.String({ description: 'Component name to read' }),
    }),
    async execute(_id, params) {
      const comp = getComponents().find(c => c.name === params.name)
      if (!comp) return { content: [text(`Component "${params.name}" not found.`)], details: null }
      const out =
        `**${comp.name}**\n\n` +
        `Template:\n\`\`\`js\n${comp.templateSource.trim()}\n\`\`\`` +
        (comp.css.trim() ? `\n\nCSS:\n\`\`\`css\n${comp.css.trim()}\n\`\`\`` : '') +
        (comp.previewBody.trim() ? `\n\nPreview HTML:\n\`\`\`html\n${comp.previewBody.trim()}\n\`\`\`` : '')
      return { content: [text(out)], details: null }
    },
  }

  const setComponentTool: AgentTool<any, AppliedChange> = {
    label: 'Set Component',
    name: 'set_component',
    description:
      'Create or update a reusable component. The template body has `props` and `ctx` in scope. ' +
      'Props are passed at each ctx.use() call site, enabling per-page variants (e.g. selected tab, active state). ' +
      'CSS is auto-injected into every page that uses the component.',
    parameters: Type.Object({
      name: Type.String({ description: 'Component name (e.g. "bottom-bar", "nav-bar", "product-row")' }),
      templateSource: Type.String({
        description:
          'Template body with props and ctx in scope. Use props.* for per-instance values (e.g. props.selected, props.label, props.color ?? "gray"). ' +
          'Use ctx.data(key), ctx.use(name,props), ctx.navigate(name), ctx.map(arr,fn) as needed. ' +
          'In map() callbacks use string concatenation instead of nested template literals.',
      }),
      css: Type.Optional(Type.String({ description: 'CSS for this component (scoped by class names)' })),
      previewBody: Type.Optional(Type.String({
        description:
          'Pre-rendered HTML preview — what the component produces with typical sample props. ' +
          'Used by the left panel component preview.',
      })),
    }),
    async execute(_id, params) {
      const existing = getComponents().find(c => c.name === params.name)
      const beforeText = existing
        ? `${existing.templateSource.trim()}\n\n${existing.css.trim()}`
        : ''
      const afterText = `${params.templateSource.trim()}\n\n${(params.css ?? '').trim()}`
      applyComponentAction({
        type: 'set_component',
        name: params.name,
        templateSource: params.templateSource,
        css: params.css ?? '',
        previewBody: params.previewBody ?? '',
      })
      return {
        content: [text(`Set component "${params.name}".`)],
        details: { actionType: 'set_component', label: params.name, diff: computeDiff(beforeText, afterText) },
      }
    },
  }

  const deleteComponentTool: AgentTool<any, AppliedChange> = {
    label: 'Delete Component',
    name: 'delete_component',
    description: 'Remove a component from the registry.',
    parameters: Type.Object({
      name: Type.String({ description: 'Component name to delete' }),
    }),
    async execute(_id, params) {
      const existing = getComponents().find(c => c.name === params.name)
      if (!existing) return { content: [text(`Component "${params.name}" not found.`)], details: { actionType: 'delete_component', label: params.name } }
      const beforeText = `${existing.templateSource.trim()}\n\n${existing.css.trim()}`
      applyComponentAction({ type: 'delete_component', name: params.name })
      return {
        content: [text(`Deleted component "${params.name}".`)],
        details: { actionType: 'delete_component', label: params.name, diff: computeDiff(beforeText, '') },
      }
    },
  }

  const takeLookTool: AgentTool<any, AppliedChange> = {
    label: 'Take a Look',
    name: 'take_look',
    description: 'Capture a screenshot of what the user currently sees on screen. Use this to visually inspect the current state of the canvas before making changes.',
    parameters: Type.Object({}),
    async execute() {
      const base64 = await invoke<string>('take_screenshot')
      const dataUrl = `data:image/png;base64,${base64}`
      const imageContent: ImageContent = { type: 'image', data: base64, mimeType: 'image/png' }
      return {
        content: [imageContent, { type: 'text', text: 'Screenshot captured.' } as TextContent],
        details: { actionType: 'take_look', label: 'screenshot', screenshotDataUrl: dataUrl },
      }
    },
  }

  const imagineTool: AgentTool<any, AppliedChange | null> = {
    label: 'Imagine',
    name: 'imagine',
    description: `Visually imagine multiple creative UI concepts for a prompt. Brainstorms wildly different design directions, generates rendered images of each, then asks which direction feels most promising. Favor creative, unconventional, out-there aesthetics. Use this before building to explore possibilities.`,
    parameters: Type.Object({
      prompt: Type.String({ description: 'The UI or feature to imagine — e.g. "settings page for a music app", "onboarding flow", "analytics dashboard"' }),
      num_concepts: Type.Optional(Type.Number({ description: 'Number of visual concepts to generate (default 4)' })),
    }),
    async execute(_id, params) {
      const apiKey = import.meta.env.VITE_OPENROUTER_API_KEY as string
      const numConcepts = Math.min(params.num_concepts ?? 4, 5)

      async function fetchAgentLikes(concept: { name: string; imagePrompt: string }): Promise<string> {
        try {
          const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: 'openai/gpt-4o-mini',
              messages: [{
                role: 'user',
                content:
                  `You are reviewing one imagined UI mockup direction.\n` +
                  `Title: "${concept.name}"\n` +
                  `Visual brief: ${concept.imagePrompt}\n\n` +
                  `In 2–3 short sentences, name specific things to appreciate about this direction ` +
                  `(color, typography, layout energy, materials, mood, novelty). No preamble — just the appreciation.`,
              }],
              max_tokens: 200,
            }),
          })
          const data = await resp.json() as { choices?: { message?: { content?: string } }[] }
          return (data.choices?.[0]?.message?.content ?? '').trim()
        } catch {
          return ''
        }
      }

      // Step 1: Generate diverse creative concept descriptions via LLM
      let concepts: Array<{ name: string; imagePrompt: string }> = []

      try {
        const conceptResp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'openai/gpt-4o-mini',
            messages: [{
              role: 'user',
              content: `You are an experimental UI designer who loves pushing creative limits. Generate ${numConcepts} wildly different visual concept directions for this UI: "${params.prompt}"

Go for maximum diversity. Include unexpected aesthetic directions — think brutalist zine layouts, ancient manuscript textures, deep-ocean bioluminescence, neon noir terminals, living botanical organics, quantum crystalline data, surrealist melting interfaces, bold pop-art geometry. Avoid obvious choices.

For each concept:
- name: 3-5 word evocative title
- imagePrompt: A vivid, detailed image-generation prompt describing a UI mockup screenshot. Include color palette, typography style, layout, textures/materials, lighting, mood, visible UI elements.

Respond with ONLY a raw JSON array, no markdown fences, no other text:
[{"name":"...","imagePrompt":"..."}]`,
            }],
          }),
        })
        const conceptData = await conceptResp.json() as any
        const raw: string = conceptData.choices?.[0]?.message?.content ?? ''
        const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
        const parsed = JSON.parse(cleaned)
        concepts = Array.isArray(parsed) ? parsed : []
      } catch {
        concepts = [
          { name: 'Neon Noir Terminal', imagePrompt: `Dark cyberpunk UI mockup for ${params.prompt}. Pure black background, electric cyan and magenta neon glows, holographic glass panels, CRT scanline texture, monospace type, sharp chrome geometry.` },
          { name: 'Ancient Vellum', imagePrompt: `Aged manuscript UI mockup for ${params.prompt}. Cream vellum parchment texture, illuminated gold leaf accents, medieval serif calligraphy, ink-wash illustrations, candlelight amber warmth.` },
          { name: 'Brutalist Zine', imagePrompt: `Brutalist design UI mockup for ${params.prompt}. Black and white with neon yellow, massive bold type crashing the grid, cut-paste collage elements, raw HTML newspaper energy, 90s underground zine aesthetic.` },
          { name: 'Bioluminescent Abyss', imagePrompt: `Deep ocean bioluminescence UI mockup for ${params.prompt}. Black abyss background, glowing teal and violet organic blobs, jellyfish translucent panels, floating spore particles, ethereal underwater light shafts.` },
        ]
      }

      concepts = concepts.slice(0, numConcepts)

      /** OpenRouter Gemini image models need modalities; images are returned on message.images (not always message.content). */
      function extractOpenRouterImageDataUrl(imgData: any): string | null {
        const message = imgData?.choices?.[0]?.message
        if (!message) return null

        const fromImages = message.images
        if (Array.isArray(fromImages)) {
          for (const block of fromImages) {
            const url = block?.image_url?.url ?? block?.imageUrl?.url
            if (typeof url === 'string' && url.length > 0) return url
          }
        }

        const msgContent = message.content
        if (Array.isArray(msgContent)) {
          for (const block of msgContent) {
            if (block?.type === 'image_url' && block.image_url?.url) {
              return block.image_url.url
            }
            if (block?.type === 'image' && block.source?.data) {
              return `data:${block.source.media_type ?? 'image/jpeg'};base64,${block.source.data}`
            }
          }
        } else if (typeof msgContent === 'string' && msgContent.length > 0) {
          if (msgContent.startsWith('data:')) {
            return msgContent
          }
          if (msgContent.match(/^[A-Za-z0-9+/]{20}/)) {
            const mimeType = msgContent.startsWith('iVBOR') ? 'image/png' : 'image/jpeg'
            return `data:${mimeType};base64,${msgContent}`
          }
        }
        return null
      }

      // Step 2: For each concept, generate appreciation notes + image in parallel
      const results = await Promise.all(concepts.map(async (concept): Promise<ImagineConceptResult> => {
        const likesPromise = fetchAgentLikes(concept)
        const imagePromise = (async (): Promise<Omit<ImagineConceptResult, 'agentLikes'>> => {
          try {
            const imgResp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                model: 'google/gemini-3.1-flash-image-preview',
                modalities: ['image', 'text'],
                messages: [{ role: 'user', content: `UI design mockup screenshot: ${concept.imagePrompt}` }],
                image_config: {
                  aspect_ratio: '16:9',
                  image_size: '1K',
                },
              }),
            })
            const imgData = await imgResp.json() as any

            if (!imgResp.ok) {
              const errMsg = imgData?.error?.message ?? imgData?.message ?? JSON.stringify(imgData).slice(0, 300)
              return { name: concept.name, description: concept.imagePrompt, imageDataUrl: null, error: `HTTP ${imgResp.status}: ${errMsg}` }
            }

            const imageDataUrl = extractOpenRouterImageDataUrl(imgData)

            if (!imageDataUrl) {
              const preview = JSON.stringify(imgData).slice(0, 400)
              return { name: concept.name, description: concept.imagePrompt, imageDataUrl: null, error: `No image in response: ${preview}` }
            }

            return { name: concept.name, description: concept.imagePrompt, imageDataUrl }
          } catch (e) {
            return { name: concept.name, description: concept.imagePrompt, imageDataUrl: null, error: String(e) }
          }
        })()

        const [agentLikes, img] = await Promise.all([likesPromise, imagePromise])
        return { ...img, agentLikes: agentLikes || undefined }
      }))

      // Build content blocks for the model (images sent for vision)
      const blocks: (TextContent | ImageContent)[] = []
      for (const r of results) {
        blocks.push(text(`**${r.name}**`))
        if (r.agentLikes) {
          blocks.push(text(`_What stands out:_ ${r.agentLikes}`))
        }
        if (r.imageDataUrl) {
          const base64 = r.imageDataUrl.replace(/^data:[^;]+;base64,/, '')
          const mimeMatch = r.imageDataUrl.match(/^data:([^;]+)/)
          blocks.push({ type: 'image', data: base64, mimeType: mimeMatch?.[1] ?? 'image/jpeg' } as ImageContent)
        } else {
          blocks.push(text(`_(image generation failed${r.error ? ': ' + r.error : ''})_`))
        }
      }
      blocks.push(text(
        `\nYou pictured these different UIs in your brain — which feels like the best direction to continue down? Let your instincts and taste guide you. Pick the concept that excites you most and explain why, then proceed with that vision.`
      ))

      return {
        content: blocks,
        details: { actionType: 'imagine', label: params.prompt, imagineConcepts: results },
      }
    },
  }

  const searchDesignInspirationTool: AgentTool<any, null> = {
    label: 'Search Design',
    name: 'search_design_inspiration',
    description:
      'Search the web for design inspiration, UI references, visual trends, or specific design patterns using Perplexity. ' +
      'Use this when you need real-world examples — e.g. "fintech dashboard dark mode", "brutalist portfolio sites 2024", "apple-style onboarding flows", "color palettes for wellness apps". ' +
      'Returns live web results with sources.',
    parameters: Type.Object({
      query: Type.String({ description: 'Design search query — be specific for better results, e.g. "minimal dark mode crypto wallet UI" or "bold editorial typography landing pages"' }),
    }),
    async execute(_id, params) {
      const apiKey = import.meta.env.VITE_OPENROUTER_API_KEY as string
      const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'perplexity/sonar',
          messages: [{
            role: 'user',
            content: `Search for design inspiration: ${params.query}\n\nFind real examples, notable sites, visual references, and design patterns. Include specific URLs where possible. Focus on visual design quality, aesthetic direction, and what makes these examples stand out.`,
          }],
        }),
      })
      const data = await resp.json() as any
      const content = data.choices?.[0]?.message?.content ?? 'No results returned.'
      return { content: [text(content)], details: null }
    },
  }

  return [
    takeLookTool, imagineTool, searchDesignInspirationTool,
    listPagesTool, readPageTool, setPageTool, createPageTool, deletePageTool,
    readDatastoreTool, setDataTool, deleteDataTool,
    listComponentsTool, readComponentTool, setComponentTool, deleteComponentTool,
  ]
}

// ─── Fonts / styles ───────────────────────────────────────────────────────────

const FONT_UI =
  'system-ui, -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif'
const FONT_MONO =
  'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Monaco, "Courier New", monospace'

const globalStyles = `
.chat-md { font-family: ${FONT_UI}; -webkit-font-smoothing: antialiased; font-size: 13px; line-height: 1.55; color: #1a1a1a; }
.chat-md p { margin: 0 0 0.65em; }
.chat-md p:last-child { margin-bottom: 0; }
.chat-md ul, .chat-md ol { margin: 0 0 0.65em; padding-left: 1.25em; }
.chat-md li { margin-bottom: 0.2em; }
.chat-md pre { margin: 0.5em 0; padding: 12px 14px; background: #f6f6f6; border: 1px solid #e0e0e0; border-radius: 7px; overflow: auto; font-size: 12px; font-family: ${FONT_MONO}; }
.chat-md code { font-family: ${FONT_MONO}; font-size: 12px; background: #f0f0f0; padding: 0.1em 0.35em; border-radius: 4px; }
.chat-md pre code { background: transparent; padding: 0; }
.chat-md h1, .chat-md h2, .chat-md h3 { margin: 0.75em 0 0.4em; font-weight: 600; font-family: ${FONT_UI}; }
.chat-md h1:first-child, .chat-md h2:first-child, .chat-md h3:first-child { margin-top: 0; }
.chat-md strong { font-weight: 600; }
.chat-md blockquote { margin: 0.5em 0; padding-left: 12px; border-left: 3px solid #ccc; color: #555; }
.chat-composer-input { font-family: ${FONT_UI} !important; -webkit-font-smoothing: antialiased; }
.chat-composer-input::placeholder { color: rgba(0,0,0,0.35); font-family: ${FONT_UI} !important; }
`

// ─── Small icons ──────────────────────────────────────────────────────────────

function SendIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden fill="currentColor">
      <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
    </svg>
  )
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="10" height="10" viewBox="0 0 10 10" aria-hidden fill="currentColor"
      style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 0.12s', flexShrink: 0 }}
    >
      <path d="M3 2l4 3-4 3V2z" />
    </svg>
  )
}

// ─── Diff viewer ──────────────────────────────────────────────────────────────

function DiffView({ diff }: { diff: DiffLine[] }) {
  const lines = collapseContext(diff)
  return (
    <div style={{
      fontFamily: FONT_MONO, fontSize: 11, lineHeight: 1.55,
      background: '#fafafa', border: '1px solid #e8e8e8', borderRadius: 6,
      overflow: 'auto', maxHeight: 220,
    }}>
      {lines.map((line, i) => (
        <div key={i} style={{
          display: 'flex',
          background: line.kind === 'add' ? 'rgba(0,180,60,0.10)' : line.kind === 'remove' ? 'rgba(220,30,30,0.09)' : 'transparent',
          padding: '0 10px',
        }}>
          <span style={{
            color: line.kind === 'add' ? '#1a7f3c' : line.kind === 'remove' ? '#cf222e' : '#bbb',
            minWidth: 14, flexShrink: 0, userSelect: 'none',
          }}>
            {line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : ' '}
          </span>
          <span style={{ color: line.kind === 'same' ? '#999' : 'inherit', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
            {line.text}
          </span>
        </div>
      ))}
    </div>
  )
}

// ─── Tool call bubble ─────────────────────────────────────────────────────────

function ToolCallBubble({ tc }: { tc: ToolCallEntry }) {
  const [open, setOpen] = useState(false)
  const hasChange = tc.change?.diff && tc.change.diff.some(l => l.kind !== 'same')
  const statusColor =
    tc.status === 'running' ? '#999' : tc.status === 'error' ? '#c0392b' : '#1a7f3c'
  const statusLabel =
    tc.status === 'running' ? 'running…' : tc.status === 'error' ? 'error' : 'done'

  return (
    <div style={{ marginTop: 5 }}>
      <button
        type="button"
        onClick={() => hasChange && setOpen(o => !o)}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 5,
          padding: '3px 8px', border: '1px solid #e0e0e0', borderRadius: 20,
          background: '#f5f5f5', cursor: hasChange ? 'pointer' : 'default',
          fontFamily: FONT_UI, fontSize: 11, color: '#555',
        }}
      >
        {hasChange && <ChevronIcon open={open} />}
        <span style={{ fontFamily: FONT_MONO, fontSize: 11 }}>{tc.label}</span>
        <span style={{ color: statusColor, fontSize: 10 }}>({statusLabel})</span>
        {hasChange && tc.change && (
          <span style={{ color: '#888', fontSize: 10 }}>
            · {tc.change.label}
          </span>
        )}
      </button>
      {tc.change?.screenshotDataUrl && (
        <div style={{ marginTop: 6 }}>
          <img
            src={tc.change.screenshotDataUrl}
            alt="Screenshot"
            style={{
              width: '100%', maxWidth: 260, display: 'block',
              borderRadius: 6, border: '1px solid #e0e0e0',
              boxShadow: '0 1px 4px rgba(0,0,0,0.08)',
            }}
          />
        </div>
      )}
      {tc.change?.imagineConcepts && tc.change.imagineConcepts.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(2, 1fr)',
            gap: 7,
          }}>
            {tc.change.imagineConcepts.map((concept, i) => (
              <div
                key={i}
                style={{
                  borderRadius: 8, overflow: 'hidden',
                  border: '1px solid #e0e0e0',
                  boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
                  background: '#f5f5f5',
                }}
              >
                {concept.imageDataUrl ? (
                  <img
                    src={concept.imageDataUrl}
                    alt={concept.name}
                    style={{ width: '100%', display: 'block' }}
                  />
                ) : (
                  <div style={{
                    minHeight: 80, padding: '8px',
                    display: 'flex', alignItems: 'flex-start',
                    fontSize: 9, color: '#c0392b', fontFamily: FONT_MONO,
                    background: '#fff5f5', whiteSpace: 'pre-wrap', wordBreak: 'break-all',
                    lineHeight: 1.4,
                  }}>
                    {concept.error ?? 'no image'}
                  </div>
                )}
                <div style={{
                  padding: '5px 8px',
                  fontSize: 10, fontWeight: 600,
                  color: '#444', fontFamily: FONT_UI,
                  background: '#fff',
                  borderTop: '1px solid #ebebeb',
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }}>
                  {concept.name}
                </div>
                {concept.agentLikes && (
                  <div style={{
                    padding: '6px 8px 8px',
                    fontSize: 10, lineHeight: 1.45,
                    color: '#555', fontFamily: FONT_UI,
                    background: '#fafafa',
                    borderTop: '1px solid #f0f0f0',
                  }}>
                    {concept.agentLikes}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
      {open && tc.change?.diff && (
        <div style={{ marginTop: 5 }}>
          <DiffView diff={tc.change.diff} />
        </div>
      )}
    </div>
  )
}

// ─── TurnView (exported for use in minimal UI) ───────────────────────────────

export function TurnView({ turn }: { turn: TurnEntry }) {
  if (turn.role === 'user') {
    return (
      <div style={{
        alignSelf: 'flex-end', maxWidth: '88%', flexShrink: 0,
        background: '#0070f3', color: '#fff',
        borderRadius: '12px 12px 3px 12px',
        padding: '8px 12px', fontSize: 13, lineHeight: 1.45,
        fontFamily: FONT_UI, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
      }}>
        {turn.text}
      </div>
    )
  }
  return (
    <div style={{ alignSelf: 'stretch', flexShrink: 0 }}>
      {turn.text && (
        <div className="chat-md">
          <ReactMarkdown>{turn.text}</ReactMarkdown>
        </div>
      )}
      {turn.toolCalls.map(tc => (
        <ToolCallBubble key={tc.id} tc={tc} />
      ))}
      {!turn.done && !turn.text && turn.toolCalls.length === 0 && (
        <div style={{ fontSize: 12, color: '#aaa', fontFamily: FONT_UI }}>Thinking…</div>
      )}
    </div>
  )
}

// ─── ChatPanel ────────────────────────────────────────────────────────────────

export const ChatPanel = forwardRef<ChatPanelHandle, {
  contextHint?: string
  pages: PageDef[]
  dataStore: Record<string, unknown>
  components: ComponentDef[]
  onApplyActions: (actions: ChatAction[]) => void
  onApplyDataAction: (action: DataAction) => void
  onApplyComponentAction: (action: ComponentAction) => void
  onTurnsChange?: (turns: TurnEntry[]) => void
}>(function ChatPanel({
  contextHint,
  pages,
  dataStore,
  components,
  onApplyActions,
  onApplyDataAction,
  onApplyComponentAction,
  onTurnsChange,
}, ref) {
  const [turns, setTurns] = useState<TurnEntry[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [queuedCount, setQueuedCount] = useState(0)

  const pagesRef = useRef<PageDef[]>(pages)
  const dataStoreRef = useRef<Record<string, unknown>>(dataStore)
  const componentsRef = useRef<ComponentDef[]>(components)
  const contextHintRef = useRef<string | undefined>(contextHint)
  const onApplyRef = useRef(onApplyActions)
  const onApplyDataRef = useRef(onApplyDataAction)
  const onApplyComponentRef = useRef(onApplyComponentAction)
  const agentRef = useRef<Agent | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const messageQueueRef = useRef<string[]>([])
  const loadingRef = useRef(false)
  const drainQueueRef = useRef<() => void>(() => {})

  // Keep refs fresh
  useEffect(() => { pagesRef.current = pages }, [pages])
  useEffect(() => { dataStoreRef.current = dataStore }, [dataStore])
  useEffect(() => { componentsRef.current = components }, [components])
  useEffect(() => { contextHintRef.current = contextHint }, [contextHint])
  useEffect(() => { onApplyRef.current = onApplyActions }, [onApplyActions])
  useEffect(() => { onApplyDataRef.current = onApplyDataAction }, [onApplyDataAction])
  useEffect(() => { onApplyComponentRef.current = onApplyComponentAction }, [onApplyComponentAction])
  useEffect(() => { loadingRef.current = loading }, [loading])

  // Auto-scroll on new content
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [turns, loading])

  // Create Agent once on mount
  useEffect(() => {
    const apiKey = import.meta.env.VITE_OPENROUTER_API_KEY as string | undefined
    if (!apiKey) return  // error shown on first send

    const model = resolveModel()
    if (!model) return

    const tools = makeTools(
      () => pagesRef.current,
      () => dataStoreRef.current,
      () => componentsRef.current,
      action => onApplyRef.current([action]),
      action => onApplyDataRef.current(action),
      action => onApplyComponentRef.current(action),
    )

    const agent = new Agent({
      initialState: {
        systemPrompt: buildSystemPrompt(
          pagesRef.current, dataStoreRef.current, componentsRef.current, contextHintRef.current,
        ),
        model,
        tools,
      },
      streamFn: streamSimple,
      getApiKey: () => import.meta.env.VITE_OPENROUTER_API_KEY as string,
    })

    const unsub = agent.subscribe((event: AgentEvent) => {
      // -- streaming text delta
      if (event.type === 'message_update') {
        const ae = event.assistantMessageEvent
        if (ae.type === 'text_delta') {
          const delta = ae.delta
          setTurns(prev => {
            const last = prev[prev.length - 1]
            if (!last || last.role !== 'assistant' || last.done) return prev
            return [
              ...prev.slice(0, -1),
              { ...last, text: last.text + delta },
            ]
          })
        }
        return
      }

      // -- assistant turn starts
      if (event.type === 'message_start') {
        const msg = event.message as any
        if (msg.role !== 'assistant') return
        setTurns(prev => [
          ...prev,
          { id: crypto.randomUUID(), role: 'assistant', text: '', toolCalls: [], done: false },
        ])
        return
      }

      // -- assistant turn finishes
      if (event.type === 'message_end') {
        const msg = event.message as any
        if (msg.role !== 'assistant') return
        setTurns(prev => {
          const last = prev[prev.length - 1]
          if (!last || last.role !== 'assistant') return prev
          return [...prev.slice(0, -1), { ...last, done: true }]
        })
        drainQueueRef.current()
        return
      }

      // -- tool starts
      if (event.type === 'tool_execution_start') {
        const toolName = event.toolName
        const labels: Record<string, string> = {
          imagine: 'imagine',
          list_pages: 'list_pages',
          read_page: 'read_page',
          set_page: 'set_page',
          create_page: 'create_page',
          delete_page: 'delete_page',
        }
        const entry: ToolCallEntry = {
          id: event.toolCallId,
          name: toolName,
          label: labels[toolName] ?? toolName,
          status: 'running',
        }
        setTurns(prev => {
          const last = prev[prev.length - 1]
          if (!last || last.role !== 'assistant') return prev
          return [
            ...prev.slice(0, -1),
            { ...last, toolCalls: [...last.toolCalls, entry] },
          ]
        })
        return
      }

      // -- tool finishes
      if (event.type === 'tool_execution_end') {
        const change = (event.result as any)?.details as AppliedChange | null | undefined
        setTurns(prev => {
          const last = prev[prev.length - 1]
          if (!last || last.role !== 'assistant') return prev
          return [
            ...prev.slice(0, -1),
            {
              ...last,
              toolCalls: last.toolCalls.map(tc =>
                tc.id === event.toolCallId
                  ? { ...tc, status: event.isError ? 'error' : 'done', change: change ?? undefined }
                  : tc,
              ),
            },
          ]
        })
        return
      }

      // -- errors
      if (event.type === 'agent_end') {
        drainQueueRef.current()
      }
    })

    agentRef.current = agent
    return () => {
      unsub()
      agent.abort()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const dispatchMessage = useCallback((text: string) => {
    if (!agentRef.current) return
    agentRef.current.state.systemPrompt = buildSystemPrompt(
      pagesRef.current,
      dataStoreRef.current,
      componentsRef.current,
      contextHintRef.current,
    )
    setError(null)
    setLoading(true)
    agentRef.current.prompt(text).catch((e: unknown) => {
      setError(e instanceof Error ? e.message : String(e))
      drainQueueRef.current()
    })
  }, [])

  const drainQueue = useCallback(() => {
    const next = messageQueueRef.current.shift()
    if (!next) { setLoading(false); return }
    setQueuedCount(messageQueueRef.current.length)
    dispatchMessage(next)
  }, [dispatchMessage])

  // Keep drainQueueRef current so the agent event handler (closed over on mount) can call it
  useEffect(() => { drainQueueRef.current = drainQueue }, [drainQueue])

  const sendMessage = useCallback((text: string) => {
    const apiKey = import.meta.env.VITE_OPENROUTER_API_KEY as string | undefined
    if (!apiKey) {
      setError('Add VITE_OPENROUTER_API_KEY to your .env file.')
      return
    }
    if (!agentRef.current) {
      setError('Agent not initialized. Check console for errors.')
      return
    }

    setTurns(prev => [
      ...prev,
      { id: crypto.randomUUID(), role: 'user', text, toolCalls: [], done: true },
    ])

    if (loadingRef.current) {
      messageQueueRef.current.push(text)
      setQueuedCount(messageQueueRef.current.length)
    } else {
      dispatchMessage(text)
    }
  }, [dispatchMessage])

  const send = useCallback(() => {
    const text = input.trim()
    if (!text) return
    setInput('')
    sendMessage(text)
  }, [input, sendMessage])

  useImperativeHandle(ref, () => ({ sendMessage }), [sendMessage])

  useEffect(() => {
    onTurnsChange?.(turns)
  }, [turns, onTurnsChange])

  const rootStyle: CSSProperties = {
    flex: 1, display: 'flex', flexDirection: 'column',
    minHeight: 0, overflow: 'hidden',
    fontFamily: FONT_UI, WebkitFontSmoothing: 'antialiased',
  }

  return (
    <div style={rootStyle}>
      <style>{globalStyles}</style>

      {/* Message list */}
      <div style={{
        flex: 1, minHeight: 0, overflow: 'auto',
        padding: '12px 12px 4px',
        display: 'flex', flexDirection: 'column', gap: 10,
      }}>
        {/* Context line */}
        <div style={{ fontSize: 11, color: '#bbb', flexShrink: 0, fontFamily: FONT_UI }}>
          {contextHint?.trim() ? `Selected: ${contextHint}` : 'No element selected'}
          {' · '}{pages.length}p
          {' · '}{Object.keys(dataStore).length} data keys
          {' · '}{components.length} components
        </div>

        {turns.length === 0 && !loading && (
          <div style={{ fontSize: 12, color: '#aaa', fontFamily: FONT_UI }}>
            Ask me to create pages, edit elements, add styles, set up navigation — anything in your prototype.
          </div>
        )}

        {turns.map(turn =>
          turn.role === 'user' ? (
            <div
              key={turn.id}
              style={{
                alignSelf: 'flex-end', maxWidth: '88%', flexShrink: 0,
                background: '#0070f3', color: '#fff',
                borderRadius: '12px 12px 3px 12px',
                padding: '8px 12px', fontSize: 13, lineHeight: 1.45,
                fontFamily: FONT_UI, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
              }}
            >
              {turn.text}
            </div>
          ) : (
            <div key={turn.id} style={{ alignSelf: 'stretch', flexShrink: 0 }}>
              {turn.text && (
                <div className="chat-md">
                  <ReactMarkdown>{turn.text}</ReactMarkdown>
                </div>
              )}
              {turn.toolCalls.map(tc => (
                <ToolCallBubble key={tc.id} tc={tc} />
              ))}
              {!turn.done && !turn.text && turn.toolCalls.length === 0 && (
                <div style={{ fontSize: 12, color: '#aaa', fontFamily: FONT_UI }}>Thinking…</div>
              )}
            </div>
          ),
        )}

        {loading && turns.length > 0 && turns[turns.length - 1].role === 'user' && (
          <div style={{ fontSize: 12, color: '#aaa', fontFamily: FONT_UI, flexShrink: 0 }}>Thinking…</div>
        )}

        {error && (
          <div style={{
            fontSize: 12, color: '#c0392b',
            background: '#fff5f5', border: '1px solid #fcc',
            borderRadius: 6, padding: '8px 10px',
            whiteSpace: 'pre-wrap', fontFamily: FONT_UI, flexShrink: 0,
          }}>
            {error}
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Composer */}
      <form
        style={{
          flexShrink: 0, padding: '8px 10px 10px',
          borderTop: '1px solid #e8e8e8', background: '#fff',
        }}
        onSubmit={e => { e.preventDefault(); send() }}
      >
        <div style={{ position: 'relative' }}>
          <textarea
            className="chat-composer-input"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
            }}
            placeholder={loading ? 'Agent is working — your message will be queued…' : 'Ask to create pages, edit elements, add styles…'}
            rows={3}
            style={{
              display: 'block', width: '100%', boxSizing: 'border-box',
              resize: 'none', fontSize: 13, fontFamily: FONT_UI, color: '#000',
              padding: '8px 40px 8px 10px',
              border: '1px solid #d0d0d0', borderRadius: 9,
              lineHeight: 1.45, outline: 'none',
            }}
          />
          {queuedCount > 0 && (
            <div style={{
              position: 'absolute', right: 40, bottom: 12,
              fontSize: 10, fontFamily: FONT_UI, color: '#888',
              background: '#f0f0f0', borderRadius: 8,
              padding: '1px 6px', pointerEvents: 'none',
            }}>
              +{queuedCount} queued
            </div>
          )}
          <button
            type="submit"
            disabled={!input.trim()}
            title={loading ? 'Queue message (Enter)' : 'Send (Enter)'}
            aria-label="Send message"
            style={{
              position: 'absolute', right: 6, bottom: 6,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: 28, height: 28, border: 'none', borderRadius: '50%',
              background: !input.trim() ? '#d8d8d8' : loading ? '#f59e0b' : '#0070f3',
              color: '#fff', cursor: !input.trim() ? 'not-allowed' : 'pointer',
            }}
          >
            <SendIcon />
          </button>
        </div>
      </form>
    </div>
  )
})
