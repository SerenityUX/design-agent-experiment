// ─── Navigation reporting script ──────────────────────────────────────────────
// Injected into every iframe. Finds all [data-navigate] elements, measures
// their positions, and posts them to the parent window so the desktop app
// can draw prototype connection lines without any hardcoded coordinates.

function navScript(name: string): string {
  return `<script>
(function () {
  var FRAME = ${JSON.stringify(name)};
  function report() {
    var els = document.querySelectorAll('[data-navigate]');
    var navs = [];
    els.forEach(function (el) {
      var r = el.getBoundingClientRect();
      navs.push({
        target : el.getAttribute('data-navigate'),
        x      : r.left,
        y      : r.top,
        width  : r.width,
        height : r.height,
      });
    });
    window.parent.postMessage(
      { type: 'frame-navigables', frame: FRAME, navs: navs },
      '*'
    );
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', report);
  } else {
    report();
  }
  window.addEventListener('resize', report);
  new MutationObserver(report).observe(document.body, {
    childList: true, subtree: true, attributes: false,
  });
})();
</script>`
}

// ─── UI AST selection highlight (parent postMessage → outline node) ───────────

function selectionScript(): string {
  return `<script>
(function () {
  var CLS = 'ui-ast-selected';
  function clearSel() {
    var nodes = document.querySelectorAll('.' + CLS);
    for (var i = 0; i < nodes.length; i++) nodes[i].classList.remove(CLS);
  }
  function applyPath(path) {
    clearSel();
    if (path === null) {
      document.body.classList.add(CLS);
      return;
    }
    var n = document.body;
    for (var i = 0; i < path.length; i++) {
      n = n.children[path[i]];
      if (!n) return;
    }
    n.classList.add(CLS);
  }
  window.addEventListener('message', function (e) {
    if (!e.data || e.data.type !== 'ui-ast-select') return;
    if (e.data.clear) {
      clearSel();
      return;
    }
    applyPath(e.data.path);
  });
})();
</script>`
}

// ─── Hierarchy click → parent (no navigation / button default) ───────────────

function hierarchyClickScript(name: string): string {
  return `<script>
(function () {
  var FRAME = ${JSON.stringify(name)};
  var prototypeMode = false;
  var pendingProto = null;

  function pathFromBody(el) {
    if (!el || el === document.body) return null;
    var path = [];
    var n = el;
    while (n !== document.body) {
      var p = n.parentElement;
      if (!p) return null;
      var ix = Array.prototype.indexOf.call(p.children, n);
      if (ix < 0) return null;
      path.unshift(ix);
      n = p;
    }
    return path;
  }
  function sendPick(el) {
    if (!el || el === document.documentElement) return;
    var path = el === document.body ? null : pathFromBody(el);
    window.parent.postMessage(
      { type: 'ui-ast-click', frame: FRAME, path: path },
      '*'
    );
  }
  document.addEventListener('pointerdown', function (e) {
    if (e.button !== 0) return;
    var t = e.target;
    if (t.nodeType !== Node.ELEMENT_NODE) t = t.parentElement;
    if (!t) return;

    if (prototypeMode) {
      e.preventDefault();
      if (t === document.body) return;
      pendingProto = { path: pathFromBody(t) };
      window.parent.postMessage(
        {
          type: 'ui-ast-proto-down',
          frame: FRAME,
          path: pendingProto.path,
          clientX: e.clientX,
          clientY: e.clientY,
        },
        '*'
      );
      return;
    }

    e.preventDefault();
    sendPick(t);
  }, true);
  document.addEventListener('click', function (e) {
    e.preventDefault();
    if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
    e.stopPropagation();
  }, true);

  window.addEventListener('message', function (e) {
    if (!e.data) return;
    if (e.data.type === 'ui-ast-prototype-mode') {
      prototypeMode = !!e.data.active;
      return;
    }
    if (e.data.type === 'ui-ast-commit-pick') {
      if (e.data.frame !== FRAME || !pendingProto) return;
      var path = pendingProto.path;
      pendingProto = null;
      var n = document.body;
      if (path && path.length) {
        for (var i = 0; i < path.length; i++) {
          n = n.children[path[i]];
          if (!n) return;
        }
        sendPick(n);
      } else {
        sendPick(document.body);
      }
      return;
    }
    if (e.data.type === 'ui-ast-proto-cancel') {
      if (e.data.frame !== FRAME) return;
      pendingProto = null;
      return;
    }
    if (e.data.type === 'ui-ast-resolve-pick') {
      var x = e.data.x;
      var y = e.data.y;
      var rid = e.data.requestId;
      var el = document.elementFromPoint(x, y);
      if (!el || el === document.documentElement) {
        window.parent.postMessage(
          { type: 'ui-ast-resolve-pick-result', frame: FRAME, path: null, requestId: rid },
          '*'
        );
        return;
      }
      var path = el === document.body ? null : pathFromBody(el);
      window.parent.postMessage(
        { type: 'ui-ast-resolve-pick-result', frame: FRAME, path: path, requestId: rid },
        '*'
      );
    }
  });
})();
</script>`
}


/** Forward wheel to parent so canvas pan / pinch-zoom works over frames (Figma-like). */
function canvasWheelScript(name: string): string {
  return `<script>
(function () {
  var FRAME = ${JSON.stringify(name)};
  document.addEventListener('wheel', function (e) {
    e.preventDefault();
    window.parent.postMessage({
      type: 'ui-ast-wheel',
      frame: FRAME,
      deltaX: e.deltaX,
      deltaY: e.deltaY,
      deltaMode: e.deltaMode,
      ctrlKey: e.ctrlKey,
      metaKey: e.metaKey,
      clientX: e.clientX,
      clientY: e.clientY,
    }, '*');
  }, { passive: false, capture: true });
})();
</script>`
}

// ─── Build a full srcdoc for an iframe ────────────────────────────────────────

export function buildSrcDoc(name: string, body: string, css: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<style>
body { padding: 16px; font-family: sans-serif; font-size: 14px; line-height: 1.5; }
.ui-ast-selected { outline: 2px solid #007AFF !important; outline-offset: 2px !important; }
${css}
</style>
</head>
<body>
${body}
${navScript(name)}
${selectionScript()}
${hierarchyClickScript(name)}
${canvasWheelScript(name)}
</body>
</html>`
}

// ─── Frame definitions ────────────────────────────────────────────────────────

export interface FrameDef {
  body: string
  css : string
}

export const FRAMES: Record<string, FrameDef> = {

  home: {
    css: ``,
    // Template body — evaluated by templateEval.ts using live ctx helpers
    body: `
      <p><a \${ctx.navigate('home')}>Home</a> / <a \${ctx.navigate('products')}>Products</a> / <a \${ctx.navigate('about')}>About</a></p>
      <hr>
      <h1>\${ctx.data('company').name}</h1>
      <p>\${ctx.data('company').mission}</p>
      <p>We carry \${ctx.data('products').length} products.</p>
      <br>
      <button \${ctx.navigate('products')}>View Products</button>
      <button \${ctx.navigate('about')}>About Us</button>
    `,
  },

  products: {
    css: `
      table { border-collapse: collapse; width: 100%; }
      th, td { border: 1px solid #000; padding: 6px 10px; text-align: left; }
      th { background: #f0f0f0; }
    `,
    body: `
      <p><a \${ctx.navigate('home')}>Home</a> / <a \${ctx.navigate('products')}>Products</a> / <a \${ctx.navigate('about')}>About</a></p>
      <hr>
      <h1>Products</h1>
      <table>
        <thead>
          <tr><th>Name</th><th>Price</th><th>Stock</th></tr>
        </thead>
        <tbody>
          \${ctx.map(ctx.data('products'), p => \`<tr><td>\${p.name}</td><td>$\${p.price}</td><td>\${p.stock} left</td></tr>\`)}
        </tbody>
      </table>
      <br>
      <button \${ctx.navigate('home')}>← Back</button>
    `,
  },

  about: {
    css: ``,
    body: `
      <p><a \${ctx.navigate('home')}>Home</a> / <a \${ctx.navigate('products')}>Products</a> / <a \${ctx.navigate('about')}>About</a></p>
      <hr>
      <h1>About \${ctx.data('company').name}</h1>
      <p>Founded \${ctx.data('company').founded}. \${ctx.data('company').mission}</p>
      <h2>Team</h2>
      <ul>
        \${ctx.map(ctx.data('company').team, name => \`<li>\${name}</li>\`)}
      </ul>
      <br>
      <button \${ctx.navigate('home')}>← Home</button>
    `,
  },

}
