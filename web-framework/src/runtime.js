// ─── Client Runtime ───────────────────────────────────────────────────────────
// This script is injected into every served frame page.
// __MODE__ is replaced by the server with 'play' or 'preview'.

const RUNTIME = `
(function () {
  var MODE = '__MODE__';
  var els = document.querySelectorAll('[data-navigate]');

  if (MODE === 'preview') {
    els.forEach(function (el) {
      el.classList.add('_frame-preview');
    });
    return;
  }

  // play mode — wire up navigation
  els.forEach(function (el) {
    el.classList.add('_frame-navigable');
    el.addEventListener('click', function () {
      var target = el.getAttribute('data-navigate');
      if (target) window.location.href = '/' + target;
    });
  });
})();
`.trim()

const RUNTIME_CSS = `
  ._frame-navigable { cursor: pointer; }
  ._frame-preview   { cursor: not-allowed; opacity: 0.6; position: relative; }
  ._frame-preview::after {
    content: '';
    position: absolute;
    inset: 0;
    pointer-events: none;
    border: 2px dashed rgba(0, 100, 255, 0.35);
    border-radius: inherit;
  }
`.trim()

module.exports = { RUNTIME, RUNTIME_CSS }
