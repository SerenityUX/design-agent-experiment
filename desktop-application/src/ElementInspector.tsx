import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import type { FrameDef } from './frameContent'
import { outerHtmlAtBodyPath } from './layers'
import {
  applyElementPatch,
  mergeStyleEffects,
  parseElemDetail,
  parseInlineStyle,
  serializeInlineStyle,
  splitStyleEffects,
  upsertClassRule,
  type ElementPatch,
} from './elementOps'

const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'

const sectionHead: CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: '#888',
  padding: '8px 12px 6px',
  background: '#f5f5f5',
  borderBottom: '1px solid #e8e8e8',
  fontFamily: FONT,
}

const row: CSSProperties = {
  padding: '8px 12px',
  borderBottom: '1px solid #f0f0f0',
}

const label: CSSProperties = {
  fontSize: 10,
  color: '#666',
  marginBottom: 4,
  fontFamily: FONT,
}

const input: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  fontSize: 12,
  fontFamily: FONT,
  border: '1px solid #ddd',
  borderRadius: 4,
  padding: '6px 8px',
  outline: 'none',
  background: '#fff',
}

const mono: CSSProperties = {
  ...input,
  fontFamily: 'Menlo, Monaco, monospace',
  fontSize: 11,
  lineHeight: 1.45,
}

function Section({
  title,
  defaultOpen = true,
  children,
}: {
  title: string
  defaultOpen?: boolean
  children: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div style={{ borderBottom: '1px solid #e8e8e8' }}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        style={{
          ...sectionHead,
          width: '100%',
          textAlign: 'left',
          cursor: 'pointer',
          border: 'none',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <span>{title}</span>
        <span style={{ fontSize: 9, opacity: 0.7 }}>{open ? '▼' : '▶'}</span>
      </button>
      {open ? <div>{children}</div> : null}
    </div>
  )
}

type Props = {
  frameName: string
  path: number[]
  frameContents: Record<string, FrameDef>
  onBodyChange: (newBody: string) => void
  onCssChange: (newCss: string) => void
}

export function ElementInspector({ frameName, path, frameContents, onBodyChange, onCssChange }: Props) {
  const def = frameContents[frameName]
  const outer = useMemo(
    () => (def ? outerHtmlAtBodyPath(def.body, path) : ''),
    [def, path],
  )
  const detail = useMemo(() => parseElemDetail(outer), [outer])

  const commit = useCallback(
    (patch: ElementPatch) => {
      if (!def) return
      onBodyChange(applyElementPatch(def.body, path, patch))
    },
    [def, path, onBodyChange],
  )

  const { base, effects } = useMemo(() => splitStyleEffects(detail?.style ?? ''), [detail?.style])
  const baseProps = useMemo(() => parseInlineStyle(base), [base])

  const [opacity, setOpacity] = useState(() => baseProps.opacity ?? '')
  const [radius, setRadius] = useState(() => baseProps['border-radius'] ?? '')
  const [shadow, setShadow] = useState(() => baseProps['box-shadow'] ?? '')

  useEffect(() => {
    const p = parseInlineStyle(base)
    setOpacity(p.opacity ?? '')
    setRadius(p['border-radius'] ?? '')
    setShadow(p['box-shadow'] ?? '')
  }, [base])

  const applyBaseLayout = useCallback(() => {
    const p = { ...parseInlineStyle(base) }
    if (opacity.trim()) p.opacity = opacity.trim()
    else delete p.opacity
    if (radius.trim()) p['border-radius'] = radius.trim()
    else delete p['border-radius']
    if (shadow.trim()) p['box-shadow'] = shadow.trim()
    else delete p['box-shadow']
    const newBase = serializeInlineStyle(p)
    commit({ style: mergeStyleEffects(newBase, effects) })
  }, [base, effects, opacity, radius, shadow, commit])

  const [effectDrafts, setEffectDrafts] = useState<string[]>(() => effects)

  useEffect(() => {
    setEffectDrafts(effects)
  }, [effects])

  const saveEffects = useCallback(
    (next: string[]) => {
      setEffectDrafts(next)
      const p = parseInlineStyle(base)
      const newBase = serializeInlineStyle(p)
      commit({ style: mergeStyleEffects(newBase, next) })
    },
    [base, commit],
  )

  if (!def || !detail) {
    return <p style={{ padding: 16, fontSize: 12, color: '#888', fontFamily: FONT }}>(could not read element)</p>
  }

  const primaryClass = detail.className.split(/\s+/).filter(Boolean)[0] ?? ''

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, background: '#fff' }}>
      <div
        style={{
          padding: '10px 12px',
          borderBottom: '1px solid #e8e8e8',
          fontFamily: FONT,
        }}
      >
        <div style={{ fontSize: 11, color: '#aaa', marginBottom: 4 }}>Element</div>
        <div style={{ fontSize: 14, fontWeight: 600, color: '#111' }}>
          &lt;{detail.tag}&gt;
          {primaryClass ? (
            <span style={{ fontWeight: 400, color: '#666' }}> .{primaryClass}</span>
          ) : null}
        </div>
        <div style={{ fontSize: 10, color: '#999', marginTop: 4, fontFamily: 'Menlo, monospace' }}>
          {frameName} · path [{path.join(', ')}]
        </div>
      </div>

      <div style={{ flex: 1, overflow: 'auto' }}>
        <Section title="Content">
          <div style={row}>
            <div style={label}>Inner HTML</div>
            <textarea
              style={{ ...mono, minHeight: 72, resize: 'vertical' }}
              value={detail.innerHTML}
              onChange={e => commit({ innerHTML: e.target.value })}
              spellCheck={false}
            />
          </div>
        </Section>

        <Section title="Layout / appearance">
          <div style={{ ...row, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <div>
              <div style={label}>Opacity</div>
              <input
                style={input}
                value={opacity}
                onChange={e => setOpacity(e.target.value)}
                onBlur={applyBaseLayout}
                placeholder="1"
              />
            </div>
            <div>
              <div style={label}>Radius</div>
              <input
                style={input}
                value={radius}
                onChange={e => setRadius(e.target.value)}
                onBlur={applyBaseLayout}
                placeholder="0"
              />
            </div>
          </div>
          <div style={row}>
            <div style={label}>Box shadow</div>
            <input
              style={input}
              value={shadow}
              onChange={e => setShadow(e.target.value)}
              onBlur={applyBaseLayout}
              placeholder="0 2px 8px rgba(0,0,0,0.1)"
            />
          </div>
          <div style={row}>
            <div style={label}>Inline style (full)</div>
            <textarea
              style={{ ...mono, minHeight: 56 }}
              value={detail.style}
              onChange={e => commit({ style: e.target.value })}
              spellCheck={false}
            />
          </div>
        </Section>

        <Section title="Attributes">
          <div style={row}>
            <div style={label}>id</div>
            <input
              style={input}
              value={detail.id}
              onChange={e => commit({ attributes: { id: e.target.value || null } })}
            />
          </div>
          <div style={row}>
            <div style={label}>class</div>
            <input
              style={input}
              value={detail.className}
              onChange={e => commit({ attributes: { class: e.target.value || null } })}
            />
          </div>
          <div style={row}>
            <div style={label}>data-navigate (prototype)</div>
            <input
              style={input}
              value={detail.dataNavigate}
              onChange={e => commit({ attributes: { 'data-navigate': e.target.value || null } })}
              placeholder="target frame name"
            />
          </div>
        </Section>

        <Section title="Effects (CSS layers)">
          <div style={{ padding: '8px 12px 4px', fontSize: 10, color: '#888', fontFamily: FONT }}>
            Each effect is merged into the inline style (like stacked video effects). Use any CSS declarations.
          </div>
          {effectDrafts.map((fx, i) => (
            <div key={i} style={{ ...row, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <textarea
                style={{ ...mono, minHeight: 44 }}
                value={fx}
                onChange={e => {
                  const next = [...effectDrafts]
                  next[i] = e.target.value
                  setEffectDrafts(next)
                }}
                onBlur={() => saveEffects(effectDrafts)}
                placeholder="filter: blur(2px); transform: rotate(0.5deg);"
                spellCheck={false}
              />
              <button
                type="button"
                onClick={() => {
                  const next = effectDrafts.filter((_, j) => j !== i)
                  saveEffects(next)
                }}
                style={{
                  alignSelf: 'flex-end',
                  fontSize: 10,
                  border: 'none',
                  background: 'transparent',
                  color: '#c00',
                  cursor: 'pointer',
                  fontFamily: FONT,
                }}
              >
                Remove
              </button>
            </div>
          ))}
          <div style={{ padding: '0 12px 12px' }}>
            <button
              type="button"
              onClick={() => saveEffects([...effectDrafts, ''])}
              style={{
                width: '100%',
                padding: '8px',
                fontSize: 12,
                fontFamily: FONT,
                border: '1px dashed #ccc',
                borderRadius: 6,
                background: '#fafafa',
                cursor: 'pointer',
                color: '#333',
              }}
            >
              + Add effect
            </button>
          </div>
        </Section>

        {primaryClass ? (
          <Section title="Shared class (frame CSS)" defaultOpen={false}>
            <div style={{ padding: '8px 12px 12px' }}>
              <p style={{ fontSize: 10, color: '#888', fontFamily: FONT, margin: '0 0 8px' }}>
                Push the current inline layout (opacity, radius, shadow) as a rule for{' '}
                <code>.{primaryClass}</code> so all elements with this class update.
              </p>
              <button
                type="button"
                onClick={() => {
                  const decl = [opacity && `opacity: ${opacity}`, radius && `border-radius: ${radius}`, shadow && `box-shadow: ${shadow}`]
                    .filter(Boolean)
                    .join('; ')
                  if (!decl) return
                  onCssChange(upsertClassRule(def.css, primaryClass, decl))
                }}
                style={{
                  width: '100%',
                  padding: '8px',
                  fontSize: 12,
                  fontFamily: FONT,
                  border: '1px solid #0070f3',
                  borderRadius: 6,
                  background: '#fff',
                  color: '#0070f3',
                  cursor: 'pointer',
                }}
              >
                Apply layout to .{primaryClass} in frame CSS
              </button>
            </div>
          </Section>
        ) : null}
      </div>
    </div>
  )
}
