import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import type { FrameProjectSnapshot } from './frameProjectSnapshot.types'
import frameProjectSnapshot from './frameProjectSnapshot.json'

type BottomTab = 'dataset' | 'components'

function parseDatasetJson(text: string):
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: string } {
  try {
    const v = JSON.parse(text) as unknown
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      return { ok: true, data: v as Record<string, unknown> }
    }
    return { ok: false, error: 'Root value must be a JSON object { … }, not an array or primitive.' }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

function buildPreviewSrc(bodyHtml: string, css: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/><style>html,body{margin:0;padding:0;height:100%;display:flex;align-items:center;justify-content:center;background:#f5f5f5;} ${css}</style></head><body>${bodyHtml}</body></html>`
}

const tabBar: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  padding: '0 6px',
  gap: 2,
  height: 28,
  borderBottom: '1px solid #E8E8E8',
  flexShrink: 0,
  background: '#fff',
}

const tabBtn = (active: boolean): CSSProperties => ({
  fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
  fontSize: 11,
  border: 'none',
  background: 'transparent',
  borderBottom: active ? '2px solid #0070f3' : '2px solid transparent',
  color: active ? '#000' : '#888',
  fontWeight: active ? 600 : 400,
  cursor: 'pointer',
  padding: '0 8px',
  height: 24,
})

const mono: CSSProperties = {
  margin: 0,
  padding: 8,
  fontFamily: 'Menlo, Monaco, "Courier New", monospace',
  fontSize: 10,
  lineHeight: 1.45,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  color: '#1a1a1a',
  overflow: 'auto',
  flex: 1,
  minHeight: 0,
}

type Props = {
  /** Override (e.g. hot-reloaded). Defaults to imported `frameProjectSnapshot.json`. */
  snapshot?: FrameProjectSnapshot | null
  /** Called when the dataset field contains valid object JSON (e.g. to sync app state later). */
  onDatasetChange?: (data: Record<string, unknown>) => void
}

export function LeftBarBottomPanel({ snapshot: snapshotProp, onDatasetChange }: Props) {
  const snapshot = snapshotProp ?? (frameProjectSnapshot as FrameProjectSnapshot)
  const [tab, setTab] = useState<BottomTab>('dataset')
  const [datasetText, setDatasetText] = useState(() =>
    JSON.stringify(snapshot.data, null, 2),
  )

  const snapshotDataJson = useMemo(() => JSON.stringify(snapshot.data), [snapshot])
  useEffect(() => {
    try {
      setDatasetText(JSON.stringify(JSON.parse(snapshotDataJson) as Record<string, unknown>, null, 2))
    } catch {
      setDatasetText(snapshotDataJson)
    }
  }, [snapshotDataJson])

  const datasetParse = useMemo(() => parseDatasetJson(datasetText), [datasetText])

  useEffect(() => {
    if (datasetParse.ok) onDatasetChange?.(datasetParse.data)
  }, [datasetParse, onDatasetChange])

  const componentsJson = useMemo(() => JSON.stringify(snapshot.components, null, 2), [snapshot.components])

  const meta = snapshot.meta

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        borderTop: '1px solid #E0E0E0',
        background: '#fff',
        overflow: 'hidden',
      }}
    >
      <div style={tabBar} role="tablist" aria-label="Dataset and components">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'dataset'}
          style={tabBtn(tab === 'dataset')}
          onClick={() => setTab('dataset')}
        >
          Dataset
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'components'}
          style={tabBtn(tab === 'components')}
          onClick={() => setTab('components')}
        >
          Components
        </button>
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontSize: 9,
          color: '#aaa',
          padding: '2px 8px 4px',
          fontFamily: 'Menlo, Monaco, monospace',
          flexShrink: 0,
          borderBottom: '1px solid #f0f0f0',
        }}
      >
        <span
          style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}
          title={meta?.generatedAt}
        >
          {meta?.generatedFrom ?? 'Dataset (editable JSON)'}
        </span>
        <button
          type="button"
          onClick={() => setDatasetText(JSON.stringify(snapshot.data, null, 2))}
          style={{
            flexShrink: 0,
            fontSize: 10,
            fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
            border: '1px solid #ddd',
            borderRadius: 4,
            padding: '2px 8px',
            background: '#fff',
            cursor: 'pointer',
            color: '#555',
          }}
        >
          Reset
        </button>
      </div>

      {tab === 'dataset' ? (
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <textarea
            value={datasetText}
            onChange={e => setDatasetText(e.target.value)}
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            aria-invalid={!datasetParse.ok}
            style={{
              ...mono,
              flex: 1,
              minHeight: 80,
              width: '100%',
              boxSizing: 'border-box',
              resize: 'none',
              border: 'none',
              outline: 'none',
              background: datasetParse.ok ? '#fff' : '#fff8f8',
              tabSize: 2,
            }}
          />
          {!datasetParse.ok ? (
            <div
              style={{
                flexShrink: 0,
                fontSize: 10,
                fontFamily: 'Menlo, Monaco, monospace',
                color: '#b00020',
                padding: '4px 8px',
                borderTop: '1px solid #f0d0d0',
                background: '#fff5f5',
              }}
            >
              {datasetParse.error}
            </div>
          ) : null}
        </div>
      ) : (
        <div
          style={{
            flex: 1,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          }}
        >
          <pre
            style={{
              ...mono,
              flex: '0 0 38%',
              maxHeight: '38%',
              borderBottom: '1px solid #eee',
            }}
          >
            {componentsJson}
          </pre>
          <div
            style={{
              flex: 1,
              minHeight: 0,
              overflow: 'auto',
              padding: '6px 8px 10px',
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
            }}
          >
            {snapshot.components.map(c => (
              <div
                key={c.name}
                style={{
                  border: '1px solid #E8E8E8',
                  borderRadius: 6,
                  overflow: 'hidden',
                  background: '#fafafa',
                  flexShrink: 0,
                }}
              >
                <div
                  style={{
                    padding: '4px 8px',
                    fontSize: 10,
                    fontWeight: 600,
                    fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
                    color: '#333',
                    borderBottom: '1px solid #eee',
                    background: '#fff',
                  }}
                >
                  {c.name}
                  {c.renderError ? (
                    <span style={{ fontWeight: 400, color: '#c00', marginLeft: 6 }}>({c.renderError})</span>
                  ) : null}
                </div>
                <div style={{ display: 'flex', minHeight: 64 }}>
                  <pre
                    style={{
                      margin: 0,
                      flex: 1,
                      minWidth: 0,
                      padding: 6,
                      fontFamily: 'Menlo, Monaco, monospace',
                      fontSize: 9,
                      lineHeight: 1.35,
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                      color: '#444',
                      overflow: 'auto',
                      borderRight: '1px solid #eee',
                      background: '#fff',
                    }}
                  >
                    {JSON.stringify(c, null, 2)}
                  </pre>
                  <iframe
                    title={`Preview: ${c.name}`}
                    sandbox="allow-same-origin"
                    style={{
                      width: 112,
                      flexShrink: 0,
                      height: 72,
                      border: 'none',
                      display: 'block',
                      background: '#f5f5f5',
                    }}
                    srcDoc={buildPreviewSrc(c.previewBody, c.css)}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
