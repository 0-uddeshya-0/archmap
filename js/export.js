// Export: archmap.json download, and a single self-contained HTML file that
// embeds the data + renderer + styles — openable directly in any browser,
// exactly like the original architecture-map skill's deliverable.

export function downloadJson(data) {
  const name = (data.meta?.name || 'archmap').replace(/[^\w.-]+/g, '-');
  download(`${name}.archmap.json`, JSON.stringify(data, null, 2), 'application/json');
}

export async function downloadHtml(data) {
  // Fetch our own assets and inline them. Works when served over HTTP(S),
  // which is how the site is always used (GitHub Pages / local server).
  const [css, renderJs] = await Promise.all([
    fetch('css/style.css').then(r => r.text()),
    fetch('js/render.js').then(r => r.text()),
  ]);
  const renderInline = renderJs.replace(/^export\s+/gm, '');
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escHtml(data.meta?.name || 'Architecture Map')} — ArchMap</title>
<style>${css}</style>
</head>
<body class="app-mode standalone">
<header class="topbar">
  <div class="brand">Arch<span>Map</span></div>
  <div id="chips" class="chips"></div>
  <div class="toolbar">
    <button id="zoom-out" title="Zoom out">−</button>
    <button id="zoom-fit" title="Fit">Fit</button>
    <button id="zoom-in" title="Zoom in">+</button>
  </div>
</header>
<main class="map-layout">
  <svg id="map" xmlns="http://www.w3.org/2000/svg"></svg>
  <aside id="sidebar" class="sidebar"></aside>
</main>
<script>
${renderInline}
const ARCHMAP_DATA = ${JSON.stringify(data)};
const r = new MapRenderer(document.getElementById('map'), document.getElementById('sidebar'), document.getElementById('chips'));
r.setData(ARCHMAP_DATA);
document.getElementById('zoom-in').onclick = () => r.zoom(1.25);
document.getElementById('zoom-out').onclick = () => r.zoom(0.8);
document.getElementById('zoom-fit').onclick = () => r.fit();
window.addEventListener('resize', () => r.fit());
</script>
</body>
</html>`;
  const name = (data.meta?.name || 'archmap').replace(/[^\w.-]+/g, '-');
  download(`architecture-map-${name}.html`, html, 'text/html');
}

function download(filename, content, type) {
  const blob = new Blob([content], { type });
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
