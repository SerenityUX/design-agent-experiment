import {
  useEffect,
  useRef,
  useState,
  useCallback,
  useMemo,
  type MutableRefObject,
  type ReactNode,
} from 'react'
import { FRAMES, buildSrcDoc, type FrameDef } from './frameContent'
import {
  buildUnifiedLayerRoot,
  collectExpandableKeys,
  findLayerNodeByPick,
  layerNodeKey,
  outerHtmlAtBodyPath,
  pathsEqual,
  snapLayerPick,
  type LayerNode,
  type LayerPick,
} from './layers'
import {
  ChatPanel,
  type PageDef, type ChatAction,
  type ComponentDef, type DataAction, type ComponentAction,
} from './ChatPanel'
import { LeftBarBottomPanel } from './LeftBarBottomPanel'
import frameProjectSnapshot from './frameProjectSnapshot.json'
import type { FrameProjectSnapshot } from './frameProjectSnapshot.types'
import { evaluateTemplate } from './templateEval'
import { ElementInspector } from './ElementInspector'
import { applyElementPatch } from './elementOps'

// ─── Types ────────────────────────────────────────────────────────────────────

type RightTab = 'chat' | 'element' | 'prototype'

type Frame = { Name: string; Width: number; Height: number }
type FrameLayout = Frame & { x: number; y: number }

type NavInfo = { target: string; x: number; y: number; width: number; height: number }

const GAP = 80
const PAD = 100

const CANVAS_ZOOM_MIN = 0.05
const CANVAS_ZOOM_MAX = 4

type CanvasView = { zoom: number; panX: number; panY: number }

function normalizeWheelDeltas(deltaX: number, deltaY: number, deltaMode: number) {
  let dx = deltaX
  let dy = deltaY
  if (deltaMode === 1) {
    dx *= 16
    dy *= 16
  } else if (deltaMode === 2) {
    dx *= 40
    dy *= 40
  }
  return { dx, dy }
}

const DEFAULT_JSON = `{
  "Frames": [
    { "Name": "home",  "Width": 390, "Height": 520 },
    { "Name": "about", "Width": 390, "Height": 520 }
  ]
}`

function parseFrames(text: string): Frame[] | null {
  try {
    const { Frames } = JSON.parse(text)
    return Array.isArray(Frames) ? Frames : null
  } catch { return null }
}

function defToSource(def: FrameDef): string {
  return `<style>\n${def.css.trim()}\n</style>\n\n${def.body.trim()}`
}

function sourceToDef(src: string): FrameDef {
  const m = src.match(/<style[^>]*>([\s\S]*?)<\/style>/i)
  const css  = m ? m[1] : ''
  const body = src.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '').trim()
  return { css, body }
}

function formatHtmlWithFrameStyles(css: string, htmlFragment: string): string {
  const c = css.trim()
  const styleBlock = c ? `<style>\n${c}\n</style>` : ''
  const frag = htmlFragment.trim()
  if (styleBlock && frag) return `${styleBlock}\n\n${frag}`
  if (styleBlock) return styleBlock
  return frag
}

/** Expand disclosure keys so a deep iframe click reveals the matching hierarchy row. */
function expandKeysForPick(frame: string, path: number[] | null): string[] {
  const keys: string[] = [layerNodeKey(null, null), layerNodeKey(frame, null)]
  if (path) {
    for (let i = 0; i < path.length; i++) {
      keys.push(layerNodeKey(frame, path.slice(0, i + 1)))
    }
  }
  return keys
}

function normalizeIframePickPath(path: unknown): number[] | null {
  if (path == null) return null
  if (Array.isArray(path)) return path.map(n => Number(n))
  if (typeof path === 'object' && path !== null && typeof (path as ArrayLike<unknown>).length === 'number') {
    return Array.from(path as ArrayLike<unknown>).map(n => Number(n))
  }
  return null
}

function findFrameAtPoint(
  iframeRefs: MutableRefObject<Partial<Record<string, HTMLIFrameElement>>>,
  clientX: number,
  clientY: number,
): { name: string; iframe: HTMLIFrameElement; rect: DOMRect } | null {
  for (const name of Object.keys(iframeRefs.current)) {
    const iframe = iframeRefs.current[name]
    if (!iframe) continue
    const r = iframe.getBoundingClientRect()
    if (clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom) {
      return { name, iframe, rect: r }
    }
  }
  return null
}

// ─── Element editing helpers ─────────────────────────────────────────────────

// Parse an outerHTML string into its editable parts.
function parseElemInfo(outerHtml: string): {
  tag: string; innerHTML: string; style: string; classes: string[]
} | null {
  if (!outerHtml.trim()) return null
  const tmp = document.createElement('div')
  tmp.innerHTML = outerHtml
  const el = tmp.firstElementChild
  if (!el) return null
  return {
    tag:       el.tagName.toLowerCase(),
    innerHTML: el.innerHTML,
    style:     el.getAttribute('style') ?? '',
    classes:   Array.from(el.classList),
  }
}

// ─── Pathfinding ─────────────────────────────────────────────────────────────

type Pt = { x: number; y: number }
type Ob = { x: number; y: number; w: number; h: number }

const ROUTE_MARGIN = 28
const CORNER_R     = 12

function toSVGPath(pts: Pt[]): string {
  if (pts.length < 2) return ''
  let d = `M ${pts[0].x} ${pts[0].y}`
  for (let i = 1; i < pts.length - 1; i++) {
    const prev = pts[i - 1], curr = pts[i], next = pts[i + 1]
    const d1 = Math.hypot(curr.x - prev.x, curr.y - prev.y)
    const d2 = Math.hypot(next.x - curr.x, next.y - curr.y)
    if (d1 < 0.01 || d2 < 0.01) continue
    const cr = Math.min(CORNER_R, d1 / 2, d2 / 2)
    const ax = curr.x + (prev.x - curr.x) * (cr / d1)
    const ay = curr.y + (prev.y - curr.y) * (cr / d1)
    const bx = curr.x + (next.x - curr.x) * (cr / d2)
    const by = curr.y + (next.y - curr.y) * (cr / d2)
    d += ` L ${ax} ${ay} Q ${curr.x} ${curr.y} ${bx} ${by}`
  }
  d += ` L ${pts[pts.length - 1].x} ${pts[pts.length - 1].y}`
  return d
}

function routePath(src: Pt, srcFr: Ob, tgtFr: Ob, obstacles: Ob[], midXOffset = 0): Pt[] {
  const goRight = tgtFr.x + tgtFr.w / 2 > srcFr.x + srcFr.w / 2

  const srcEdge: Pt = { x: goRight ? srcFr.x + srcFr.w : srcFr.x,      y: src.y }
  const srcExit: Pt = { x: srcEdge.x + (goRight ? ROUTE_MARGIN : -ROUTE_MARGIN), y: src.y }

  const tgtAttach: Pt = {
    x: goRight ? tgtFr.x : tgtFr.x + tgtFr.w,
    y: tgtFr.y + tgtFr.h / 2,
  }
  const tgtEntry: Pt = {
    x: tgtAttach.x + (goRight ? -ROUTE_MARGIN : ROUTE_MARGIN),
    y: tgtAttach.y,
  }

  const midX   = (srcExit.x + tgtEntry.x) / 2 + midXOffset
  const minY   = Math.min(srcExit.y, tgtEntry.y)
  const maxY   = Math.max(srcExit.y, tgtEntry.y)

  const blockers = obstacles.filter(o =>
    o.x < midX && o.x + o.w > midX &&
    o.y - 4 < maxY && o.y + o.h + 4 > minY
  )

  if (blockers.length === 0) {
    return [
      src, srcEdge, srcExit,
      { x: midX, y: srcExit.y },
      { x: midX, y: tgtEntry.y },
      tgtEntry, tgtAttach,
    ]
  }

  const aboveY  = Math.min(minY, ...blockers.map(b => b.y))   - ROUTE_MARGIN
  const belowY  = Math.max(maxY, ...blockers.map(b => b.y + b.h)) + ROUTE_MARGIN
  const dAbove  = Math.abs(srcExit.y - aboveY) + Math.abs(tgtEntry.y - aboveY)
  const dBelow  = Math.abs(srcExit.y - belowY) + Math.abs(tgtEntry.y - belowY)
  const routeY  = dAbove <= dBelow ? aboveY : belowY

  return [
    src, srcEdge, srcExit,
    { x: srcExit.x,  y: routeY },
    { x: tgtEntry.x, y: routeY },
    { x: tgtEntry.x, y: tgtEntry.y },
    tgtEntry, tgtAttach,
  ]
}

// ─── Syntax highlight ────────────────────────────────────────────────────────

function highlightJSON(code: string): string {
  const esc = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return esc.replace(
    /("(?:\\.|[^"\\])*"(?:\s*:)?|true|false|null|-?\d+(?:\.\d*)?(?:[eE][+-]?\d*)?)/g,
    m => {
      if (m.startsWith('"'))
        return m.endsWith(':')
          ? `<span style="color:#0451a5">${m}</span>`
          : `<span style="color:#a31515">${m}</span>`
      if (m === 'true' || m === 'false' || m === 'null')
        return `<span style="color:#0000ff">${m}</span>`
      return `<span style="color:#098658">${m}</span>`
    }
  )
}

function highlightHTML(raw: string): string {
  const esc = raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '\x00LT\x00')
    .replace(/>/g, '\x00GT\x00')

  const tagged = esc.replace(
    /\x00LT\x00(\/?)([\w-]+)((?:\s+[^<>]*?)?)\x00GT\x00/g,
    (_, slash: string, tag: string, attrs: string) => {
      const coloredAttrs = attrs.replace(
        /([\w-]+)(=)(&quot;[^&]*?&quot;)/g,
        (_: string, name: string, eq: string, val: string) =>
          `<span style="color:#994cc3">${name}</span>${eq}<span style="color:#c96765">${val}</span>`,
      ).replace(
        /\b(data-navigate)\b/g,
        `<span style="color:#994cc3">data-navigate</span>`,
      )
      return (
        `<span style="color:#0070f3">&lt;${slash}${tag}</span>` +
        coloredAttrs +
        `<span style="color:#0070f3">&gt;</span>`
      )
    }
  )

  const styled = tagged.replace(
    /(&lt;style[^&lt;]*&gt;)([\s\S]*?)(&lt;\/style&gt;)/g,
    (_, open: string, body: string, close: string) => {
      const cssHl = body.replace(
        /([\w-]+)(\s*:\s*)([^;\n{]+)/g,
        (_: string, prop: string, colon: string, val: string) =>
          `<span style="color:#c96765">${prop}</span>${colon}<span style="color:#098658">${val}</span>`,
      )
      return open + cssHl + close
    }
  )

  return styled.replace(/\x00LT\x00/g, '&lt;').replace(/\x00GT\x00/g, '&gt;')
}

// ─── App ──────────────────────────────────────────────────────────────────────

export default function App() {
  const [jsonCode, setJsonCode]         = useState(DEFAULT_JSON)
  const [frameContents, setFrameContents] = useState<Record<string, FrameDef>>({ ...FRAMES })
  const [canvasView, setCanvasView]     = useState<CanvasView>({ zoom: 0.5, panX: 0, panY: 0 })
  const [leftWidth, setLeftWidth]       = useState(260)
  const [rightWidth, setRightWidth]     = useState(340)
  const [leftPanel, setLeftPanel]       = useState<'hierarchy' | 'json'>('hierarchy')
  const [rightTab, setRightTab]         = useState<RightTab>('element')
  const [navMap, setNavMap]             = useState<Record<string, NavInfo[]>>({})
  const canvasAreaRef                   = useRef<HTMLDivElement>(null)
  const iframeRefs                      = useRef<Partial<Record<string, HTMLIFrameElement>>>({})
  const [uiAstPick, setUiAstPick]       = useState<LayerPick | null>(null)
  const [layerExpanded, setLayerExpanded] = useState<Set<string>>(() => new Set())
  const layerRootRef = useRef<LayerNode | null>(null)
  const linkResolverRef = useRef(
    new Map<string, { sourceFrame: string; sourcePath: number[] }>(),
  )
  const protoListenersRef = useRef<{
    move: (e: PointerEvent) => void
    up: (e: PointerEvent) => void
    sourceFrame: string
  } | null>(null)

  /** Live data for `{{…}}` / `__DATASET_*__` in frame bodies; synced from Dataset editor when JSON is valid. */
  const [liveDataset, setLiveDataset] = useState<Record<string, unknown>>(() => {
    const s = frameProjectSnapshot as FrameProjectSnapshot
    return { ...s.data }
  })

  const handleDatasetChange = useCallback((data: Record<string, unknown>) => {
    setLiveDataset(data)
  }, [])

  const [chatComponents, setChatComponents] = useState<ComponentDef[]>(
    () => ((frameProjectSnapshot as FrameProjectSnapshot).components ?? []).map(c => ({
      name: c.name, css: c.css, previewBody: c.previewBody, templateSource: '',
    }))
  )

  // Live snapshot passed to LeftBarBottomPanel so agent changes are reflected immediately
  const liveSnapshot = useMemo<FrameProjectSnapshot>(() => ({
    ...(frameProjectSnapshot as FrameProjectSnapshot),
    data: liveDataset,
    components: chatComponents.map(({ name, css, previewBody }) => ({ name, css, previewBody })),
  }), [liveDataset, chatComponents])

  const handleDataAction = useCallback((action: DataAction) => {
    if (action.type === 'set_data') {
      setLiveDataset(prev => ({ ...prev, [action.key]: action.value }))
    } else if (action.type === 'delete_data') {
      setLiveDataset(prev => { const next = { ...prev }; delete next[action.key]; return next })
    }
  }, [])

  const handleComponentAction = useCallback((action: ComponentAction) => {
    if (action.type === 'set_component') {
      setChatComponents(prev => {
        const idx = prev.findIndex(c => c.name === action.name)
        const entry: ComponentDef = {
          name: action.name,
          templateSource: action.templateSource,
          css: action.css,
          previewBody: action.previewBody,
        }
        return idx >= 0 ? prev.map((c, i) => i === idx ? entry : c) : [...prev, entry]
      })
    } else if (action.type === 'delete_component') {
      setChatComponents(prev => prev.filter(c => c.name !== action.name))
    }
  }, [])

  const applyCanvasWheel = useCallback(
    (
      deltaX: number,
      deltaY: number,
      deltaMode: number,
      pinchZoom: boolean,
      clientX: number,
      clientY: number,
    ) => {
      const { dx, dy } = normalizeWheelDeltas(deltaX, deltaY, deltaMode)
      setCanvasView(prev => {
        const el = canvasAreaRef.current
        if (!el) return prev
        const rect = el.getBoundingClientRect()
        const lx = clientX - rect.left
        const ly = clientY - rect.top
        if (pinchZoom) {
          const wx = (lx - prev.panX) / prev.zoom
          const wy = (ly - prev.panY) / prev.zoom
          const factor = Math.exp(-dy * 0.008)
          const nextZoom = Math.min(CANVAS_ZOOM_MAX, Math.max(CANVAS_ZOOM_MIN, prev.zoom * factor))
          return {
            zoom: nextZoom,
            panX: lx - wx * nextZoom,
            panY: ly - wy * nextZoom,
          }
        }
        return {
          ...prev,
          panX: prev.panX - dx,
          panY: prev.panY - dy,
        }
      })
    },
    [],
  )

  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (e.data?.type === 'frame-navigables') {
        const { frame, navs } = e.data as { frame: string; navs: NavInfo[] }
        setNavMap(prev => ({ ...prev, [frame]: navs }))
        return
      }
      if (e.data?.type === 'ui-ast-wheel') {
        const d = e.data as {
          deltaX: number
          deltaY: number
          deltaMode?: number
          ctrlKey?: boolean
          metaKey?: boolean
          clientX: number
          clientY: number
        }
        const pinch = Boolean(d.ctrlKey || d.metaKey)
        applyCanvasWheel(d.deltaX, d.deltaY, d.deltaMode ?? 0, pinch, d.clientX, d.clientY)
        return
      }
      if (e.data?.type === 'ui-ast-proto-down') {
        const frame = String((e.data as { frame?: string }).frame ?? '').trim()
        if (!frame) return
        const rawPath = normalizeIframePickPath((e.data as { path?: unknown }).path)
        const sourcePath = rawPath ?? []
        const d0 = e.data as { clientX: number; clientY: number }
        const startX = d0.clientX
        const startY = d0.clientY

        const prev = protoListenersRef.current
        if (prev) {
          window.removeEventListener('pointermove', prev.move)
          window.removeEventListener('pointerup', prev.up)
          iframeRefs.current[prev.sourceFrame]?.contentWindow?.postMessage(
            { type: 'ui-ast-proto-cancel', frame: prev.sourceFrame },
            '*',
          )
          protoListenersRef.current = null
        }

        const state = {
          sourceFrame: frame,
          sourcePath,
          startX,
          startY,
          drag: false,
        }

        const move = (ev: PointerEvent) => {
          if (Math.hypot(ev.clientX - state.startX, ev.clientY - state.startY) > 8) {
            state.drag = true
          }
        }
        const up = (ev: PointerEvent) => {
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', up)
          protoListenersRef.current = null

          const sourceWin = iframeRefs.current[state.sourceFrame]?.contentWindow
          if (!state.drag) {
            sourceWin?.postMessage({ type: 'ui-ast-commit-pick', frame: state.sourceFrame }, '*')
            return
          }

          sourceWin?.postMessage({ type: 'ui-ast-proto-cancel', frame: state.sourceFrame }, '*')

          const hit = findFrameAtPoint(iframeRefs, ev.clientX, ev.clientY)
          if (!hit) return

          const lx = ev.clientX - hit.rect.left
          const ly = ev.clientY - hit.rect.top
          const requestId = `rk-${Date.now()}-${Math.random().toString(36).slice(2)}`
          linkResolverRef.current.set(requestId, {
            sourceFrame: state.sourceFrame,
            sourcePath,
          })
          hit.iframe.contentWindow?.postMessage(
            { type: 'ui-ast-resolve-pick', x: lx, y: ly, requestId },
            '*',
          )
        }

        protoListenersRef.current = { move, up, sourceFrame: frame }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
        return
      }
      if (e.data?.type === 'ui-ast-resolve-pick-result') {
        const rid = String((e.data as { requestId?: unknown }).requestId ?? '')
        const targetFrame = String((e.data as { frame?: string }).frame ?? '').trim()
        if (!rid || !targetFrame) return
        const pending = linkResolverRef.current.get(rid)
        if (!pending) return
        linkResolverRef.current.delete(rid)
        setFrameContents(prev => {
          const def = prev[pending.sourceFrame]
          if (!def) return prev
          const pathForPatch: number[] | null =
            pending.sourcePath.length > 0 ? pending.sourcePath : null
          const newBody = applyElementPatch(def.body, pathForPatch, {
            attributes: { 'data-navigate': targetFrame },
          })
          return { ...prev, [pending.sourceFrame]: { ...def, body: newBody } }
        })
        return
      }
      if (e.data?.type === 'ui-ast-click') {
        const frame = String((e.data as { frame?: string }).frame ?? '').trim()
        if (!frame) return
        const rawPath = normalizeIframePickPath((e.data as { path?: unknown }).path)
        const root = layerRootRef.current
        const pick: LayerPick = root
          ? snapLayerPick(root, frame, rawPath)
          : { frame, path: rawPath }
        setUiAstPick(pick)
        setLayerExpanded(prev => {
          const next = new Set(prev)
          for (const k of expandKeysForPick(pick.frame, pick.path)) next.add(k)
          return next
        })
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [applyCanvasWheel])

  const frames = useMemo(() => parseFrames(jsonCode), [jsonCode])

  const frameLayouts = useMemo<FrameLayout[]>(() => {
    if (!frames) return []
    let x = PAD
    return frames.map(frame => {
      const layout: FrameLayout = { ...frame, x, y: PAD }
      x += frame.Width + GAP
      return layout
    })
  }, [frames])

  // Evaluated srcDoc per frame — recomputed whenever body, dataset, or components change
  const srcDocs = useMemo<Record<string, string>>(() => {
    const out: Record<string, string> = {}
    for (const fp of frameLayouts) {
      const def = frameContents[fp.Name]
      if (def) {
        const { body: renderedBody, componentCss } = evaluateTemplate(def.body, liveDataset, chatComponents)
        out[fp.Name] = buildSrcDoc(
          fp.Name,
          renderedBody,
          (def.css ? def.css + '\n' : '') + componentCss,
        )
      }
    }
    return out
  }, [frameLayouts, frameContents, liveDataset, chatComponents])

  // Imperatively push updated srcdoc into existing iframes so browsers always reload
  const isMountedRef = useRef(false)
  useEffect(() => {
    if (!isMountedRef.current) { isMountedRef.current = true; return }
    for (const [name, src] of Object.entries(srcDocs)) {
      const iframe = iframeRefs.current[name]
      if (iframe && iframe.srcdoc !== src) iframe.srcdoc = src
    }
  }, [srcDocs])

  const worldWidth = useMemo(() => {
    if (!frameLayouts.length) return PAD * 2
    const last = frameLayouts[frameLayouts.length - 1]
    return last.x + last.Width + PAD
  }, [frameLayouts])

  const worldHeight = useMemo(() => {
    if (!frameLayouts.length) return PAD * 2
    return PAD * 2 + Math.max(...frameLayouts.map(f => f.Height))
  }, [frameLayouts])

  const connections = useMemo(() => {
    const SPREAD = 14
    type ConnInput = { src: Pt; srcFr: Ob; tgtFr: Ob; obstacles: Ob[]; gapKey: string }
    const inputs: ConnInput[] = []

    for (const fp of frameLayouts) {
      for (const nav of navMap[fp.Name] ?? []) {
        const target = frameLayouts.find(f => f.Name === nav.target)
        if (!target) continue

        inputs.push({
          src: { x: fp.x + nav.x + nav.width, y: fp.y + nav.y + nav.height / 2 },
          srcFr: { x: fp.x, y: fp.y, w: fp.Width, h: fp.Height },
          tgtFr: { x: target.x, y: target.y, w: target.Width, h: target.Height },
          obstacles: frameLayouts
            .filter(f => f.Name !== fp.Name && f.Name !== target.Name)
            .map(f => ({ x: f.x, y: f.y, w: f.Width, h: f.Height })),
          gapKey: [fp.Name, target.Name].sort().join('↔'),
        })
      }
    }

    const gapTotal: Record<string, number> = {}
    for (const inp of inputs) gapTotal[inp.gapKey] = (gapTotal[inp.gapKey] ?? 0) + 1

    const gapIdx: Record<string, number> = {}
    return inputs.map(inp => {
      const idx   = gapIdx[inp.gapKey] ?? 0
      gapIdx[inp.gapKey] = idx + 1
      const total = gapTotal[inp.gapKey]
      const offset = (idx - (total - 1) / 2) * SPREAD
      return toSVGPath(routePath(inp.src, inp.srcFr, inp.tgtFr, inp.obstacles, offset))
    })
  }, [frameLayouts, navMap])

  const prototypeSourceFrame = useMemo(() => {
    if (!frames?.length) return ''
    const f = uiAstPick?.frame
    if (f && frames.some(x => x.Name === f)) return f
    return frames[0].Name
  }, [frames, uiAstPick])

  const editorValue =
    leftPanel === 'json'
      ? jsonCode
      : prototypeSourceFrame && frameContents[prototypeSourceFrame]
        ? defToSource(frameContents[prototypeSourceFrame])
        : ''

  function onEditorChange(val: string) {
    if (leftPanel === 'json') {
      setJsonCode(val)
    } else if (prototypeSourceFrame) {
      setFrameContents(prev => ({
        ...prev,
        [prototypeSourceFrame]: sourceToDef(val),
      }))
    }
  }

  const onCanvasWheel = useCallback(
    (e: WheelEvent) => {
      e.preventDefault()
      const pinch = e.ctrlKey || e.metaKey
      applyCanvasWheel(e.deltaX, e.deltaY, e.deltaMode, pinch, e.clientX, e.clientY)
    },
    [applyCanvasWheel],
  )

  useEffect(() => {
    const el = canvasAreaRef.current
    if (!el) return
    el.addEventListener('wheel', onCanvasWheel, { passive: false })
    return () => el.removeEventListener('wheel', onCanvasWheel)
  }, [onCanvasWheel])

  const onLeftDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = leftWidth
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
    const onMove = (ev: MouseEvent) =>
      setLeftWidth(Math.max(180, Math.min(520, startW + (ev.clientX - startX))))
    const onUp = () => {
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [leftWidth])

  const onRightDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = rightWidth
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
    const onMove = (ev: MouseEvent) =>
      setRightWidth(Math.max(240, Math.min(720, startW + (startX - ev.clientX))))
    const onUp = () => {
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [rightWidth])

  const highlighted =
    leftPanel === 'json' ? highlightJSON(editorValue) : highlightHTML(editorValue)

  const layerRoot = useMemo((): LayerNode | null => {
    if (leftPanel !== 'hierarchy' || !frames?.length) return null
    const names = frames.map(f => f.Name)
    return buildUnifiedLayerRoot(names, frameContents)
  }, [leftPanel, frames, frameContents])

  useEffect(() => {
    layerRootRef.current = layerRoot
  }, [layerRoot])

  useEffect(() => {
    if (!layerRoot) return
    setLayerExpanded(new Set(collectExpandableKeys(layerRoot)))
  }, [layerRoot])

  useEffect(() => {
    if (!frames?.length || !uiAstPick) return
    if (!frames.some(f => f.Name === uiAstPick.frame)) setUiAstPick(null)
  }, [frames, uiAstPick])

  const elementNameForChat = useMemo(() => {
    if (leftPanel !== 'hierarchy' || !layerRoot || !uiAstPick) return ''
    const node = findLayerNodeByPick(layerRoot, uiAstPick)
    return node?.label ?? ''
  }, [leftPanel, layerRoot, uiAstPick])

  // ─── Chat integration ────────────────────────────────────────────────────────

  // Agent sees raw template source so it edits templates, not evaluated output
  const chatPages = useMemo<PageDef[]>(() => {
    if (!frames) return []
    return frames.map(f => ({
      name: f.Name,
      width: f.Width,
      height: f.Height,
      body: frameContents[f.Name]?.body ?? '',
      css: frameContents[f.Name]?.css ?? '',
    }))
  }, [frames, frameContents])

  const handleChatActions = useCallback((actions: ChatAction[]) => {
    for (const action of actions) {
      if (action.type === 'set_page') {
        setFrameContents(prev => ({
          ...prev,
          [action.name]: { body: action.body, css: action.css },
        }))
        if (action.width != null || action.height != null) {
          setJsonCode(prev => {
            try {
              const parsed = JSON.parse(prev) as { Frames: Frame[] }
              if (!Array.isArray(parsed.Frames)) return prev
              const next = parsed.Frames.map(f =>
                f.Name === action.name
                  ? { ...f, Width: action.width ?? f.Width, Height: action.height ?? f.Height }
                  : f
              )
              return JSON.stringify({ Frames: next }, null, 2)
            } catch { return prev }
          })
        }
      } else if (action.type === 'create_page') {
        const name = action.name
        const w = action.width ?? 390
        const h = action.height ?? 520
        setFrameContents(prev => ({
          ...prev,
          [name]: { body: action.body, css: action.css ?? '' },
        }))
        setJsonCode(prev => {
          try {
            const parsed = JSON.parse(prev) as { Frames: Frame[] }
            if (!Array.isArray(parsed.Frames)) return prev
            if (parsed.Frames.some(f => f.Name === name)) return prev
            const next = [...parsed.Frames, { Name: name, Width: w, Height: h }]
            return JSON.stringify({ Frames: next }, null, 2)
          } catch { return prev }
        })
      } else if (action.type === 'delete_page') {
        const name = action.name
        setFrameContents(prev => {
          const next = { ...prev }
          delete next[name]
          return next
        })
        setJsonCode(prev => {
          try {
            const parsed = JSON.parse(prev) as { Frames: Frame[] }
            if (!Array.isArray(parsed.Frames)) return prev
            const next = parsed.Frames.filter(f => f.Name !== name)
            return JSON.stringify({ Frames: next }, null, 2)
          } catch { return prev }
        })
      }
    }
  }, [])

  // ─── Element panel ────────────────────────────────────────────────────────────

  const elementPanelRaw = useMemo(() => {
    if (leftPanel !== 'hierarchy') return ''
    const def = uiAstPick ? frameContents[uiAstPick.frame] : undefined
    if (!def || !layerRoot || !uiAstPick) return ''
    const inner = outerHtmlAtBodyPath(def.body, uiAstPick.path)
    return formatHtmlWithFrameStyles(def.css, inner)
  }, [leftPanel, frameContents, layerRoot, uiAstPick])

  const syncUiAstOutlines = useCallback(() => {
    const active = rightTab === 'prototype'
    for (const fp of frameLayouts) {
      const w = iframeRefs.current[fp.Name]?.contentWindow
      if (!w) continue
      w.postMessage({ type: 'ui-ast-prototype-mode', active }, '*')
      if (!uiAstPick || uiAstPick.frame !== fp.Name) {
        w.postMessage({ type: 'ui-ast-select', clear: true }, '*')
        continue
      }
      w.postMessage({ type: 'ui-ast-select', path: uiAstPick.path }, '*')
    }
  }, [frameLayouts, uiAstPick, rightTab])

  useEffect(() => {
    syncUiAstOutlines()
  }, [syncUiAstOutlines])

  const rightPrototypeHint = 'Select a frame on the left to edit prototype source.'

  return (
    <div style={css.root}>

      <aside style={{ ...css.leftSidebar, width: leftWidth }}>
        <div style={css.frameTabBar}>
          <button
            type="button"
            onClick={() => setLeftPanel('hierarchy')}
            style={{
              ...css.frameTab,
              background: leftPanel === 'hierarchy' ? '#fff' : 'transparent',
              color: leftPanel === 'hierarchy' ? '#000' : '#888',
              borderBottom: leftPanel === 'hierarchy' ? '2px solid #0070f3' : '2px solid transparent',
            }}
          >
            Pages
          </button>
          <button
            type="button"
            onClick={() => setLeftPanel('json')}
            style={{
              ...css.frameTab,
              marginLeft: 'auto',
              background: leftPanel === 'json' ? '#fff' : 'transparent',
              color: leftPanel === 'json' ? '#000' : '#888',
              borderBottom: leftPanel === 'json' ? '2px solid #0070f3' : '2px solid transparent',
            }}
          >
            JSON
          </button>
        </div>

        <div style={css.leftSidebarBody}>
          <div style={css.leftSidebarMain}>
            {leftPanel === 'hierarchy' ? (
              layerRoot ? (
                <div style={css.layersPanel} role="tree" aria-label="Element hierarchy">
                  <LayerTree
                    root={layerRoot}
                    depth={0}
                    expanded={layerExpanded}
                    toggleExpanded={key => {
                      setLayerExpanded(prev => {
                        const next = new Set(prev)
                        if (next.has(key)) next.delete(key)
                        else next.add(key)
                        return next
                      })
                    }}
                    uiAstPick={uiAstPick}
                    onPick={setUiAstPick}
                  />
                </div>
              ) : (
                <div style={css.layersEmpty}>No frames yet — add some in JSON.</div>
              )
            ) : (
              <div style={css.editorWrap}>
                <pre
                  style={css.editorPre}
                  aria-hidden
                  dangerouslySetInnerHTML={{ __html: highlighted + '\n' }}
                />
                <textarea
                  style={css.editorTextarea}
                  value={editorValue}
                  onChange={e => onEditorChange(e.target.value)}
                  spellCheck={false}
                  autoCorrect="off"
                  autoCapitalize="off"
                />
              </div>
            )}
          </div>
          <LeftBarBottomPanel snapshot={liveSnapshot} onDatasetChange={handleDatasetChange} />
        </div>
      </aside>

      <div style={css.divider} onMouseDown={onLeftDividerMouseDown} />

      <div ref={canvasAreaRef} style={css.canvasArea}>
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            transformOrigin: '0 0',
            transform: `translate(${canvasView.panX}px, ${canvasView.panY}px) scale(${canvasView.zoom})`,
            width: worldWidth,
            height: worldHeight,
          }}
        >
          {frameLayouts.map(fp => {
            const def      = frameContents[fp.Name]
            const liveNavs = navMap[fp.Name] ?? []

            return (
              <div key={fp.Name}>
                <button
                  type="button"
                  style={{
                    ...css.frameLabel,
                    left: fp.x,
                    top: fp.y - 22,
                    margin: 0,
                    padding: 0,
                    border: 'none',
                    background: 'transparent',
                    cursor: 'pointer',
                    textAlign: 'left',
                  }}
                  onClick={e => {
                    e.stopPropagation()
                    const pick: LayerPick = { frame: fp.Name, path: null }
                    setUiAstPick(pick)
                    setLayerExpanded(prev => {
                      const next = new Set(prev)
                      for (const k of expandKeysForPick(fp.Name, null)) next.add(k)
                      return next
                    })
                  }}
                >
                  {fp.Name}
                </button>

                <div style={{
                  position: 'absolute', left: fp.x, top: fp.y,
                  width: fp.Width, height: fp.Height,
                  background: '#fff', boxShadow: '0 2px 12px rgba(0,0,0,0.10)',
                  overflow: 'hidden',
                }}>
                  {def ? (
                    <>
                      <iframe
                        ref={el => {
                          if (el) iframeRefs.current[fp.Name] = el
                          else delete iframeRefs.current[fp.Name]
                        }}
                        srcDoc={srcDocs[fp.Name] ?? ''}
                        onLoad={syncUiAstOutlines}
                        style={{ width: '100%', height: '100%', border: 'none', display: 'block' }}
                        scrolling="no"
                      />
                      {rightTab === 'prototype' && liveNavs.map((nav, i) => (
                        <div key={i} style={{
                          position: 'absolute',
                          left: nav.x, top: nav.y,
                          width: nav.width, height: nav.height,
                          outline: '2px solid #007AFF',
                          outlineOffset: 2,
                          borderRadius: 4,
                          pointerEvents: 'none',
                        }} />
                      ))}
                    </>
                  ) : (
                    <div style={{
                      width: '100%', height: '100%', background: '#f5f5f5',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      color: '#bbb', fontSize: 13, fontFamily: 'sans-serif',
                    }}>
                      {fp.Name}
                    </div>
                  )}
                </div>
              </div>
            )
          })}

          {rightTab === 'prototype' && connections.length > 0 && (
            <svg style={{
              position: 'absolute', top: 0, left: 0,
              width: worldWidth, height: worldHeight,
              pointerEvents: 'none', overflow: 'visible',
            }}>
              <defs>
                <marker id="arrow" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
                  <polygon points="0 0, 8 3, 0 6" fill="#007AFF" />
                </marker>
              </defs>
              {connections.map((d, i) => (
                <path key={i} d={d}
                  fill="none" stroke="#007AFF" strokeWidth={1.5}
                  strokeLinejoin="round" markerEnd="url(#arrow)"
                />
              ))}
            </svg>
          )}
        </div>
      </div>

      <div style={css.divider} onMouseDown={onRightDividerMouseDown} />

      <aside style={{ ...css.rightSidebar, width: rightWidth }}>
        <div style={css.rightTabBar}>
          {(['chat', 'element', 'prototype'] as RightTab[]).map(t => {
            const active = rightTab === t
            const label = t === 'chat' ? 'Chat' : t === 'element' ? 'Element' : 'Prototype'
            return (
              <button
                key={t}
                type="button"
                onClick={() => setRightTab(t)}
                style={{
                  ...css.rightTab,
                  color: active ? '#000' : '#888',
                  fontWeight: active ? 600 : 400,
                  borderBottom: active ? '2px solid #0070f3' : '2px solid transparent',
                }}
              >
                {label}
              </button>
            )
          })}
        </div>

        <div style={css.rightPanelBody}>
          {rightTab === 'chat' && (
            <ChatPanel
              contextHint={elementNameForChat || undefined}
              pages={chatPages}
              dataStore={liveDataset}
              components={chatComponents}
              onApplyActions={handleChatActions}
              onApplyDataAction={handleDataAction}
              onApplyComponentAction={handleComponentAction}
            />
          )}

          {rightTab === 'element' && (
            <div style={css.rightTabScroll}>
              {leftPanel !== 'hierarchy' ? (
                <pre style={css.rawPre}>Switch the left sidebar to Pages to inspect elements.</pre>
              ) : !uiAstPick ? (
                <pre style={css.rawPre}>Select an element in the hierarchy.</pre>
              ) : !frames ? (
                <pre style={css.rawPre}>(invalid frames JSON)</pre>
              ) : uiAstPick.path === null ? (
                <FrameMetaPanel
                  frameName={uiAstPick.frame}
                  frames={frames}
                  onUpdate={patch => {
                    setJsonCode(prev => {
                      try {
                        const parsed = JSON.parse(prev) as { Frames: Frame[] }
                        if (!Array.isArray(parsed.Frames)) return prev
                        const next = parsed.Frames.map(f =>
                          f.Name === uiAstPick.frame ? { ...f, ...patch } : f,
                        )
                        return JSON.stringify({ Frames: next }, null, 2)
                      } catch {
                        return prev
                      }
                    })
                  }}
                />
              ) : frameContents[uiAstPick.frame] ? (
                <ElementInspector
                  frameName={uiAstPick.frame}
                  path={uiAstPick.path}
                  frameContents={frameContents}
                  onBodyChange={body => {
                    setFrameContents(prev => ({
                      ...prev,
                      [uiAstPick.frame]: { ...prev[uiAstPick.frame]!, body },
                    }))
                  }}
                  onCssChange={cssVal => {
                    setFrameContents(prev => ({
                      ...prev,
                      [uiAstPick.frame]: { ...prev[uiAstPick.frame]!, css: cssVal },
                    }))
                  }}
                />
              ) : (
                <pre style={css.rawPre}>(no frame content)</pre>
              )}
            </div>
          )}

          {rightTab === 'prototype' && (
            leftPanel === 'hierarchy' && prototypeSourceFrame ? (
              <div style={css.prototypeStack}>
                {uiAstPick && elementPanelRaw ? (
                  <div style={css.prototypeSelectionBlock}>
                    <div style={css.prototypeSelectionLabel}>Frame styles + selection</div>
                    <pre
                      style={css.rawPreTight}
                      dangerouslySetInnerHTML={{ __html: highlightHTML(elementPanelRaw) + '\n' }}
                    />
                  </div>
                ) : null}
                <div style={{ ...css.editorWrap, flex: 1, minHeight: 0 }}>
                  <pre
                    style={css.editorPre}
                    aria-hidden
                    dangerouslySetInnerHTML={{ __html: highlightHTML(editorValue) + '\n' }}
                  />
                  <textarea
                    style={css.editorTextarea}
                    value={editorValue}
                    onChange={e => onEditorChange(e.target.value)}
                    spellCheck={false}
                    autoCorrect="off"
                    autoCapitalize="off"
                  />
                </div>
              </div>
            ) : (
              <div style={css.rightTabScroll}>
                <pre style={css.rawPre}>{rightPrototypeHint}</pre>
              </div>
            )
          )}
        </div>
      </aside>
    </div>
  )
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const editorBase: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  margin: 0,
  padding: 16,
  fontFamily: 'Menlo, Monaco, "Courier New", monospace',
  fontSize: 12,
  lineHeight: 1.7,
  whiteSpace: 'pre',
  overflowWrap: 'normal',
  tabSize: 2,
  overflow: 'auto',
  border: 'none',
  outline: 'none',
  resize: 'none',
  background: 'transparent',
}

const css = {
  root: {
    display: 'flex',
    height: '100vh',
    width: '100vw',
    overflow: 'hidden',
  } satisfies React.CSSProperties,

  canvasArea: {
    flex: 1,
    minWidth: 0,
    position: 'relative',
    background: '#F5F5F5',
    overflow: 'hidden',
    touchAction: 'none',
  } satisfies React.CSSProperties,

  divider: {
    width: 4,
    cursor: 'col-resize',
    flexShrink: 0,
    background: 'transparent',
    borderLeft: '1px solid #E0E0E0',
  } satisfies React.CSSProperties,

  leftSidebar: {
    display: 'flex',
    flexDirection: 'column',
    background: '#fff',
    overflow: 'hidden',
    flexShrink: 0,
  } satisfies React.CSSProperties,

  leftSidebarBody: {
    flex: 1,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  } satisfies React.CSSProperties,

  /** Upper ~3/4 — pages / JSON editor */
  leftSidebarMain: {
    flex: 3,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  } satisfies React.CSSProperties,

  rightSidebar: {
    display: 'flex',
    flexDirection: 'column',
    background: '#fff',
    overflow: 'hidden',
    flexShrink: 0,
  } satisfies React.CSSProperties,

  rightTabBar: {
    display: 'flex',
    alignItems: 'center',
    padding: '0 8px',
    gap: 2,
    height: 34,
    borderBottom: '1px solid #E0E0E0',
    flexShrink: 0,
  } satisfies React.CSSProperties,

  rightTab: {
    fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
    fontSize: 12,
    border: 'none',
    background: 'transparent',
    borderBottom: '2px solid transparent',
    borderRadius: '4px 4px 0 0',
    cursor: 'pointer',
    padding: '0 10px',
    height: 30,
    whiteSpace: 'nowrap',
  } satisfies React.CSSProperties,

  rightPanelBody: {
    flex: 1,
    overflow: 'hidden',
    position: 'relative',
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
  } satisfies React.CSSProperties,

  rightTabScroll: {
    flex: 1,
    minHeight: 0,
    overflow: 'auto',
  } satisfies React.CSSProperties,

  chatLine: {
    margin: 16,
    fontSize: 13,
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    lineHeight: 1.5,
    color: '#333',
  } satisfies React.CSSProperties,

  elemHint: {
    margin: 16,
    fontSize: 12,
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    lineHeight: 1.5,
    color: '#888',
  } satisfies React.CSSProperties,

  rawPre: {
    margin: 0,
    padding: 16,
    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    fontSize: 11,
    lineHeight: 1.6,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    color: '#1a1a1a',
  } satisfies React.CSSProperties,

  rawPreTight: {
    margin: 0,
    padding: '0 12px 12px',
    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    fontSize: 11,
    lineHeight: 1.6,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    color: '#1a1a1a',
  } satisfies React.CSSProperties,

  prototypeStack: {
    display: 'flex',
    flexDirection: 'column',
    flex: 1,
    minHeight: 0,
    overflow: 'hidden',
  } satisfies React.CSSProperties,

  prototypeSelectionBlock: {
    flexShrink: 0,
    maxHeight: '42%',
    overflow: 'auto',
    borderBottom: '1px solid #E8E8E8',
    background: '#fff',
  } satisfies React.CSSProperties,

  prototypeSelectionLabel: {
    padding: '8px 12px 4px',
    fontSize: 10,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
    color: '#888',
  } satisfies React.CSSProperties,

  leftSidebarHeader: {
    display: 'flex',
    alignItems: 'center',
    padding: '0 14px',
    height: 34,
    borderBottom: '1px solid #E0E0E0',
    flexShrink: 0,
  } satisfies React.CSSProperties,

  leftSidebarTitle: {
    fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
    fontSize: 12,
    fontWeight: 500,
    color: '#555',
    userSelect: 'none',
  } satisfies React.CSSProperties,

  frameTabBar: {
    display: 'flex',
    alignItems: 'center',
    padding: '0 8px',
    height: 34,
    borderBottom: '1px solid #E0E0E0',
    flexShrink: 0,
    gap: 2,
    overflowX: 'auto',
  } satisfies React.CSSProperties,

  frameTab: {
    fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
    fontSize: 12,
    border: 'none',
    borderBottom: '2px solid transparent',
    borderRadius: '4px 4px 0 0',
    cursor: 'pointer',
    padding: '0 10px',
    height: 30,
    whiteSpace: 'nowrap',
    transition: 'color 0.1s',
  } satisfies React.CSSProperties,

  frameLabel: {
    position: 'absolute',
    fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
    fontSize: 12,
    fontWeight: 500,
    color: '#888',
    whiteSpace: 'nowrap',
    userSelect: 'none',
    WebkitFontSmoothing: 'antialiased',
  } satisfies React.CSSProperties,

  editorWrap: {
    position: 'relative',
    flex: 1,
    overflow: 'hidden',
  } satisfies React.CSSProperties,

  layersPanel: {
    flex: 1,
    overflow: 'auto',
    padding: '10px 0 16px',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    fontSize: 12,
    userSelect: 'none',
    borderTop: '1px solid transparent',
  } satisfies React.CSSProperties,

  layersEmpty: {
    flex: 1,
    padding: 16,
    fontSize: 12,
    color: '#888',
    fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
  } satisfies React.CSSProperties,

  layerDisclosure: {
    width: 22,
    height: 28,
    flexShrink: 0,
    border: 'none',
    background: 'transparent',
    cursor: 'pointer',
    padding: 0,
    fontSize: 11,
    lineHeight: '28px',
    color: '#666',
    borderRadius: 4,
  } satisfies React.CSSProperties,

  layerDisclosureSpacer: {
    width: 22,
    flexShrink: 0,
    display: 'block',
  } satisfies React.CSSProperties,

  layerRowLine: {
    flex: 1,
    minWidth: 0,
    minHeight: 28,
    lineHeight: '28px',
    border: 'none',
    cursor: 'pointer',
    font: 'inherit',
    margin: 0,
    padding: '0 12px 0 4px',
    borderRadius: 4,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    textAlign: 'left',
  } satisfies React.CSSProperties,

  editorPre: {
    ...editorBase,
    color: '#383a42',
  } satisfies React.CSSProperties,

  editorTextarea: {
    ...editorBase,
    color: 'transparent',
    caretColor: '#000',
  } satisfies React.CSSProperties,
} as const

const LAYER_TAB_PX = 20

type LayerTreeProps = {
  root: LayerNode
  depth: number
  expanded: Set<string>
  toggleExpanded: (key: string) => void
  uiAstPick: LayerPick | null
  onPick: (pick: LayerPick | null) => void
}

function LayerTree(props: LayerTreeProps): ReactNode {
  const { root, depth, expanded, toggleExpanded, uiAstPick, onPick } = props

  function renderNode(node: LayerNode, d: number): ReactNode {
    const key = layerNodeKey(node.frameName, node.path)
    const hasChildren = node.children.length > 0
    const isOpen = !hasChildren || expanded.has(key)
    const selected =
      uiAstPick !== null &&
      node.frameName !== null &&
      uiAstPick.frame === node.frameName &&
      pathsEqual(uiAstPick.path, node.path)

    return (
      <div key={key} role="presentation">
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            minHeight: 28,
            paddingLeft: 4 + d * LAYER_TAB_PX,
          }}
        >
          {hasChildren ? (
            <button
              type="button"
              aria-expanded={isOpen}
              aria-label={isOpen ? 'Collapse layer' : 'Expand layer'}
              onClick={e => {
                e.preventDefault()
                e.stopPropagation()
                toggleExpanded(key)
              }}
              style={css.layerDisclosure}
            >
              {isOpen ? '▾' : '▸'}
            </button>
          ) : (
            <span style={css.layerDisclosureSpacer} aria-hidden />
          )}
          <button
            type="button"
            role="treeitem"
            aria-selected={selected}
            onClick={() => {
              if (node.frameName === null) {
                onPick(null)
              } else {
                onPick({ frame: node.frameName, path: node.path })
              }
            }}
            style={{
              ...css.layerRowLine,
              background: selected ? 'rgba(0, 122, 255, 0.12)' : 'transparent',
              fontWeight: node.kind === 'frame' || node.label === 'Pages' ? 600 : 400,
              color: node.label === 'Pages' ? '#111' : '#333',
            }}
          >
            {node.label}
          </button>
        </div>
        {hasChildren && isOpen && (
          <div role="group">
            {node.children.map(child => renderNode(child, d + 1))}
          </div>
        )}
      </div>
    )
  }

  return renderNode(root, depth)
}

// ─── FrameMetaPanel ───────────────────────────────────────────────────────────
// Shows when a frame node is selected — lets user edit Width/Height from the
// Element tab without touching raw JSON.

export function FrameMetaPanel({
  frameName, frames, onUpdate,
}: {
  frameName: string
  frames: Frame[]
  onUpdate: (patch: Partial<Frame>) => void
}) {
  const frame = frames.find(f => f.Name === frameName)
  if (!frame) return <p style={css.elemHint}>Frame not found in JSON.</p>

  const field: React.CSSProperties = {
    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    fontSize: 12,
    border: '1px solid #ddd',
    borderRadius: 4,
    padding: '4px 8px',
    width: '100%',
    background: '#fff',
    outline: 'none',
  }
  const label: React.CSSProperties = {
    fontSize: 11,
    color: '#666',
    fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
    display: 'block',
    marginBottom: 4,
  }
  const row: React.CSSProperties = {
    marginBottom: 14,
  }

  return (
    <div style={{ padding: 14 }}>
      <div style={{ ...row }}>
        <span style={label}>Name</span>
        <input style={{ ...field, color: '#aaa' }} value={frame.Name} readOnly />
      </div>
      <div style={row}>
        <span style={label}>Width</span>
        <input
          style={field}
          type="number"
          value={frame.Width}
          onChange={e => onUpdate({ Width: Number(e.target.value) })}
        />
      </div>
      <div style={row}>
        <span style={label}>Height</span>
        <input
          style={field}
          type="number"
          value={frame.Height}
          onChange={e => onUpdate({ Height: Number(e.target.value) })}
        />
      </div>
    </div>
  )
}

// ─── ElementEditPanel ─────────────────────────────────────────────────────────
// Shows when an element is selected — editable Content, Style, and CSS fields.

export function ElementEditPanel({
  frameName, path, frameContents, onBodyChange, onCssChange,
}: {
  frameName: string
  path: number[]
  frameContents: Record<string, FrameDef>
  onBodyChange: (frameName: string, newBody: string) => void
  onCssChange:  (frameName: string, newCss: string) => void
}) {
  const def = frameContents[frameName]
  if (!def) return <p style={css.elemHint}>(no frame content)</p>

  const outer = outerHtmlAtBodyPath(def.body, path)
  const info  = parseElemInfo(outer)
  if (!info) return <p style={css.elemHint}>(could not read element)</p>

  const ta: React.CSSProperties = {
    width: '100%',
    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    fontSize: 12,
    lineHeight: 1.6,
    border: '1px solid #ddd',
    borderRadius: 4,
    padding: '6px 8px',
    resize: 'vertical',
    outline: 'none',
    background: '#fff',
  }
  const lbl: React.CSSProperties = {
    fontSize: 11,
    color: '#666',
    fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
    display: 'block',
    marginBottom: 4,
  }
  const section: React.CSSProperties = { marginBottom: 16 }

  return (
    <div style={{ padding: 14 }}>
      <div style={{ fontSize: 11, color: '#999', fontFamily: 'monospace', marginBottom: 14 }}>
        &lt;{info.tag}&gt;{info.classes.length ? ' .' + info.classes.join(' .') : ''}
      </div>

      <div style={section}>
        <span style={lbl}>Content</span>
        <textarea
          style={{ ...ta, minHeight: 64 }}
          value={info.innerHTML}
          onChange={e => {
            const newBody = applyElementPatch(def.body, path, { innerHTML: e.target.value })
            onBodyChange(frameName, newBody)
          }}
          spellCheck={false}
        />
      </div>

      <div style={section}>
        <span style={lbl}>Style</span>
        <textarea
          style={{ ...ta, minHeight: 48 }}
          value={info.style}
          placeholder="color: red; font-weight: bold;"
          onChange={e => {
            const newBody = applyElementPatch(def.body, path, { style: e.target.value })
            onBodyChange(frameName, newBody)
          }}
          spellCheck={false}
        />
      </div>

      {info.classes.length > 0 && (
        <div style={section}>
          <span style={lbl}>
            CSS{' '}
            <span style={{ color: '#aaa', fontStyle: 'italic' }}>
              (class changes affect all matching elements)
            </span>
          </span>
          <textarea
            style={{ ...ta, minHeight: 120 }}
            value={def.css}
            onChange={e => onCssChange(frameName, e.target.value)}
            spellCheck={false}
          />
        </div>
      )}
    </div>
  )
}
