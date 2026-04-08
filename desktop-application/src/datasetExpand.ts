/**
 * Expands {{dot.path}} placeholders and special markers in frame HTML using the
 * shared dataset (same shape as frame-framework app.data).
 */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function getPath(data: Record<string, unknown>, parts: string[]): unknown {
  let cur: unknown = data
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[p]
  }
  return cur
}

/** Replace `{{a.b.c}}` with escaped string values from `data`. */
export function expandDatasetPlaceholders(html: string, data: Record<string, unknown>): string {
  return html.replace(/\{\{([\w.]+)\}\}/g, (_m, path: string) => {
    const v = getPath(data, path.split('.'))
    if (v === undefined || v === null) return ''
    if (typeof v === 'object') return escapeHtml(JSON.stringify(v))
    return escapeHtml(String(v))
  })
}

type ProductRow = { name?: unknown; price?: unknown; stock?: unknown }

function expandProductRows(data: Record<string, unknown>): string {
  const prods = data.products
  if (!Array.isArray(prods)) return ''
  return prods
    .map((p: unknown) => {
      if (!p || typeof p !== 'object') return ''
      const row = p as ProductRow
      const name = row.name != null ? String(row.name) : ''
      const price = row.price != null ? String(row.price) : ''
      const stock = row.stock != null ? String(row.stock) : ''
      return `<tr><td>${escapeHtml(name)}</td><td>$${escapeHtml(price)}</td><td>${escapeHtml(stock)} left</td></tr>`
    })
    .join('')
}

function expandTeamItems(data: Record<string, unknown>): string {
  const company = data.company
  if (!company || typeof company !== 'object' || Array.isArray(company)) return ''
  const team = (company as Record<string, unknown>).team
  if (!Array.isArray(team)) return ''
  return team.map(n => `<li>${escapeHtml(String(n))}</li>`).join('')
}

/**
 * Full expansion: mustache paths, then inject table rows / team list markers.
 */
export function expandDatasetInHtml(html: string, data: Record<string, unknown>): string {
  let out = expandDatasetPlaceholders(html, data)
  out = out.replace(/__DATASET_PRODUCT_ROWS__/g, expandProductRows(data))
  out = out.replace(/__DATASET_TEAM_ITEMS__/g, expandTeamItems(data))
  return out
}
