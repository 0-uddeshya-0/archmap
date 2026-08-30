// Export: archmap.json, a single self-contained interactive HTML file (embeds
// the data + the full viewer runtime), and canonical SVG / PNG images of the
// complete map in the current theme with no viewer state.

import { MapRenderer } from './render.js';

export function downloadJson(data) {
  download(`${safeName(data)}.archmap.json`, JSON.stringify(data, null, 2), 'application/json');
}

export async function downloadHtml(data) {
  // Fetch our own assets and inline them. Works when served over HTTP(S),
  // which is how the site is always used (GitHub Pages / local server).
  // query.js + validate.js are pure and import-free, so the exported file
  // keeps the ask-the-map engine and the full manual editor.
  const [css, renderJs, queryJs, validateJs] = await Promise.all([
    fetch('css/style.css').then(r => r.text()),
    fetch('js/render.js').then(r => r.text()),
    fetch('js/query.js').then(r => r.text()),
    fetch('js/validate.js').then(r => r.text()),
  ]);
  const strip = (s) => s.replace(/^export\s+/gm, '').replace(/^import[^\n]*\n/gm, '');
  const renderInline = strip(renderJs);
  const helpersInline = strip(queryJs) + '\n' + strip(validateJs);
  const theme = document.documentElement.getAttribute('data-theme') || 'light';
  const html = `<!DOCTYPE html>
<html lang="en" data-theme="${theme}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escHtml(data.meta?.name || 'Architecture Map')} — ArchMap</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;600;700;800&family=Courier+Prime:wght@400;700&display=swap">
<style>${css}</style>
</head>
<body class="app-mode standalone">
<svg hidden aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
  <symbol id="i-play" viewBox="0 0 16 16"><path d="M5 3.5v9l7-4.5z"/></symbol>
  <symbol id="i-edit" viewBox="0 0 16 16"><path d="M11.5 2.5l2 2L5 13l-2.6.6L3 11z"/></symbol>
  <symbol id="i-sun" viewBox="0 0 16 16"><circle cx="8" cy="8" r="3"/><path d="M8 1.5V3M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M12.6 3.4l-1 1M4.4 11.6l-1 1"/></symbol>
  <symbol id="i-moon" viewBox="0 0 16 16"><path d="M13 9.5A5.5 5.5 0 0 1 6.5 3 5.5 5.5 0 1 0 13 9.5z"/></symbol>
</svg>
<header class="topbar">
  <div class="brand">Arch<span>Map</span></div>
  <div id="chips" class="chips"></div>
  <div class="toolbar">
    <input id="map-search" data-map-search class="node-search" type="text" placeholder="Ask or search…  ( / )" spellcheck="false" aria-label="Ask the map or search files">
    <button id="start-tour" title="Guided tour (g)"><svg class="icon"><use href="#i-play"/></svg>Tour</button>
    <button id="edit-toggle" title="Edit the map (session-only — export again to keep changes)"><svg class="icon"><use href="#i-edit"/></svg>Edit</button>
    <button id="zoom-out" title="Zoom out (−)">−</button>
    <button id="zoom-fit" title="Fit (f)">Fit</button>
    <button id="zoom-in" title="Zoom in (+)">+</button>
    <button id="theme-toggle" data-theme-toggle class="ghost theme-toggle icon-only" title="Switch light / dark (t)" aria-label="Switch light or dark theme"><svg class="icon sun"><use href="#i-sun"/></svg><svg class="icon moon"><use href="#i-moon"/></svg></button>
  </div>
</header>
<main class="map-layout">
  <svg id="map" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Architecture map"></svg>
  <aside id="sidebar" class="sidebar"></aside>
</main>
<script>
${helpersInline}
${renderInline}
const ARCHMAP_DATA = ${JSON.stringify(data).replace(/</g, '\\u003c')};
const r = new MapRenderer(document.getElementById('map'), document.getElementById('sidebar'), document.getElementById('chips'),
  { helpers: { parseQuery, runQuery, applyPatch, selfCheckLine } });
r.setData(ARCHMAP_DATA);
document.getElementById('zoom-in').onclick = () => r.zoom(1.25);
document.getElementById('zoom-out').onclick = () => r.zoom(0.8);
document.getElementById('zoom-fit').onclick = () => r.fit();
document.getElementById('start-tour').onclick = () => r.startTour();
document.getElementById('edit-toggle').onclick = function () {
  r.setEditMode(!r.editMode);
  this.classList.toggle('on', r.editMode);
};
document.getElementById('theme-toggle').onclick = () => {
  const el = document.documentElement;
  el.setAttribute('data-theme', el.getAttribute('data-theme') === 'light' ? 'dark' : 'light');
  r.draw();
};
const search = document.getElementById('map-search');
let searchTimer;
search.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    const q = search.value.trim();
    if (q.length >= 2 && !parseQuery(q)) r.findAndFocus(q);
  }, 350);
});
search.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const q = search.value.trim();
  if (!q) return;
  if (!r.ask(q)) r.findAndFocus(q);
});
window.addEventListener('resize', () => r.fit());
</script>
</body>
</html>`;
  download(`architecture-map-${safeName(data)}.html`, html, 'text/html');
}

// ------------------------------------------------- canonical image exports

// Render the complete map into a fresh offscreen renderer (no selection, no
// reach/route/tour state) and serialize it as one standalone SVG document.
function buildStandaloneSvg(data) {
  const holder = document.createElement('div');
  holder.style.cssText = 'position:fixed;left:-12000px;top:0;width:1400px;height:900px;';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  holder.appendChild(svg);
  document.body.appendChild(holder);
  try {
    const r = new MapRenderer(svg, null, null, { headless: true });
    r.setData(data);
    r.tx = 0; r.ty = 0; r.scale = 1;
    r._applyTransform();
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#0b0d10';
    const W = Math.ceil(r.worldW), H = Math.ceil(r.worldH);
    const font = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    const svgText = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="${font}">
<rect x="0" y="0" width="${W}" height="${H}" fill="${bg}"/>
${svg.innerHTML}
</svg>`;
    return { svgText, W, H };
  } finally {
    holder.remove();
  }
}

export function downloadSvg(data) {
  const { svgText } = buildStandaloneSvg(data);
  download(`architecture-map-${safeName(data)}.svg`, svgText, 'image/svg+xml');
}

export function downloadPng(data) {
  const { svgText, W, H } = buildStandaloneSvg(data);
  const scale = Math.min(2, 8000 / Math.max(W, H)); // 2x, capped for huge maps
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(new Blob([svgText], { type: 'image/svg+xml' }));
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(W * scale);
        canvas.height = Math.round(H * scale);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((blob) => {
          URL.revokeObjectURL(url);
          if (!blob) return reject(new Error('PNG encoding failed.'));
          downloadBlob(`architecture-map-${safeName(data)}.png`, blob);
          resolve();
        }, 'image/png');
      } catch (err) { URL.revokeObjectURL(url); reject(err); }
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not rasterize the map.')); };
    img.src = url;
  });
}

// ------------------------------------------------------------- plumbing

function safeName(data) {
  return (data.meta?.name || 'archmap').replace(/[^\w.-]+/g, '-');
}

function download(filename, content, type) {
  downloadBlob(filename, new Blob([content], { type }));
}

function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
}
