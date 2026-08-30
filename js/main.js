import { analyze } from './analyze.js';
import { ingestGithub, ingestDirectoryPicker, ingestDroppedItems, ingestFileInput, ingestWebsite } from './ingest.js';
import { MapRenderer } from './render.js';
import { enrichMap, findBugs, getKey, setKey, translateQuery } from './ai.js';
import { downloadJson, downloadHtml, downloadSvg, downloadPng } from './export.js';
import { parseQuery, runQuery } from './query.js';
import { validateMap, applyPatch, selfCheckLine } from './validate.js';
import { initDesigner, iterateOps } from './designer.js';

const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------ theme
// Day ops (light) is the native register; night ops persists per browser.

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('archmap.theme', theme);
}
applyTheme(localStorage.getItem('archmap.theme') || 'light');
document.querySelectorAll('[data-theme-toggle]').forEach(b => b.addEventListener('click', () => {
  applyTheme(document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light');
  if (currentData && !app.hidden) renderer.draw(); // re-read theme colors
  specimen?.redraw();
}));

const landing = $('landing'), app = $('app');
const renderer = new MapRenderer($('map'), $('sidebar'), $('chips'), {
  helpers: { parseQuery, runQuery, applyPatch, selfCheckLine },
});
let currentData = null;
let currentFiles = null; // kept for AI enrichment excerpts

// console handle for power users: archmap.data, archmap.renderer
window.archmap = { renderer, get data() { return currentData; } };

// ------------------------------------------------------------ draft autosave

const DRAFT_KEY = 'archmap.draft';
renderer.onchange = () => {
  if (!currentData) return;
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(currentData)); } catch { /* storage full */ }
};

// natural-language edits: instruction → checked ops → validated apply
renderer.oninstruct = async (text) => {
  if (!currentData) return;
  if (!getKey()) { openSettings(); return toast('Natural-language edits need an Anthropic API key (Settings). Manual editing works without one.', true); }
  showProgress('Turning your instruction into map changes…');
  try {
    const { ops, note } = await iterateOps(currentData, text);
    hideProgress();
    if (!ops.length) return toast(note || 'No change was needed for that instruction.', true);
    const r = renderer.applyOps(ops, 'instruct');
    if (r && r.errors.length && !r.applied.length) toast('The suggested change referenced things not on the map — nothing was applied.', true);
  } catch (err) {
    hideProgress();
    toast(err.message, true);
  }
};

// ------------------------------------------------------------ helpers

function showProgress(text) {
  $('progress-text').textContent = text;
  $('progress').hidden = false;
}
function updateProgress(text) { $('progress-text').textContent = text; }
function hideProgress() { $('progress').hidden = true; }

let toastTimer;
function toast(msg, isError = false) {
  const t = $('toast');
  t.textContent = msg;
  t.className = isError ? 'error' : '';
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 6000);
}

function showMap(data, files) {
  currentData = data;
  currentFiles = files || null;
  landing.hidden = true;
  app.hidden = false;
  renderer.setData(data);
  const q = new URLSearchParams(location.search);
  if (data.meta?.source === 'github' && data.meta.url) {
    q.set('repo', data.meta.url);
    history.replaceState(null, '', '?' + q.toString() + location.hash);
  }
}

async function runIngest(fn) {
  showProgress('Starting…');
  try {
    const result = await fn(updateProgress);
    let data;
    if (result.prebuilt) data = result.prebuilt;
    else {
      updateProgress(`Analyzing ${result.files.length} files…`);
      await new Promise(r => setTimeout(r, 30)); // let the UI paint
      data = analyze(result.files, result.meta);
    }
    hideProgress();
    if (result.meta?.truncated) toast('Large repo: analysis capped at the 600 most relevant files.');
    showMap(data, result.files);
  } catch (err) {
    hideProgress();
    toast(err.message || String(err), true);
  }
}

// ------------------------------------------------------------ landing wiring

const ghToken = () => localStorage.getItem('archmap.ghToken') || '';

$('gh-go').addEventListener('click', () => {
  const url = $('gh-url').value.trim();
  if (!url) return toast('Paste a GitHub repository URL first.', true);
  runIngest((p) => ingestGithub(url, ghToken(), p));
});
$('gh-url').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('gh-go').click(); });
document.querySelectorAll('.sample').forEach(a => a.addEventListener('click', (e) => {
  e.preventDefault();
  $('gh-url').value = a.dataset.url;
  $('gh-go').click();
}));

$('demo-go').addEventListener('click', async () => {
  showProgress('Loading the demo map…');
  try {
    const res = await fetch('demo/self.archmap.json');
    if (!res.ok) throw new Error('Demo map not found.');
    const data = await res.json();
    hideProgress();
    showMap(data, null);
    toast('This is ArchMap mapping its own source code. Press g for the tour.');
  } catch (err) {
    hideProgress();
    toast('Could not load the demo: ' + err.message, true);
  }
});

$('pick-dir').addEventListener('click', () => {
  if (window.showDirectoryPicker) runIngest((p) => ingestDirectoryPicker(p));
  else $('dir-input').click(); // Firefox/Safari fallback
});
$('dir-input').addEventListener('change', () => {
  if ($('dir-input').files.length) runIngest((p) => ingestFileInput($('dir-input').files, p));
});

const dropCard = $('card-local');
dropCard.addEventListener('dragover', (e) => { e.preventDefault(); dropCard.classList.add('dragging'); });
dropCard.addEventListener('dragleave', () => dropCard.classList.remove('dragging'));
dropCard.addEventListener('drop', (e) => {
  e.preventDefault();
  dropCard.classList.remove('dragging');
  if (e.dataTransfer?.items?.length) runIngest((p) => ingestDroppedItems([...e.dataTransfer.items], p));
});

$('site-go').addEventListener('click', () => {
  const url = $('site-url').value.trim();
  if (!url) return toast('Enter a website URL first.', true);
  runIngest((p) => ingestWebsite(url, p));
});
$('site-url').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('site-go').click(); });

$('import-json').addEventListener('click', () => $('json-input').click());
$('json-input').addEventListener('change', async () => {
  const file = $('json-input').files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const v = validateMap(data);
    if (!v.ok) throw new Error('Not a valid archmap.json: ' + v.errors[0]);
    if (v.warnings.length) console.warn('archmap.json warnings:', v.warnings);
    showMap(data, null);
  } catch (err) {
    toast(err.message, true);
  }
});

// ------------------------------------------------------------ designer

const designer = initDesigner({
  overlay: $('designer'),
  toast, showProgress, updateProgress, hideProgress,
  onMap: (data) => {
    showMap(data, null);
    renderer.setEditMode(true);
    $('edit-toggle').classList.add('on');
    renderer.onchange();
  },
});
$('design-open').addEventListener('click', () => designer.open());

const draftBtn = $('design-resume');
try {
  if (localStorage.getItem(DRAFT_KEY)) draftBtn.hidden = false;
} catch { /* no storage */ }
draftBtn.addEventListener('click', () => {
  try {
    const data = JSON.parse(localStorage.getItem(DRAFT_KEY));
    const v = validateMap(data);
    if (!v.ok) throw new Error('Saved draft is damaged: ' + v.errors[0]);
    showMap(data, null);
    renderer.setEditMode(true);
    $('edit-toggle').classList.add('on');
  } catch (err) { toast(err.message, true); }
});

// ------------------------------------------------------------ app wiring

$('back-home').addEventListener('click', () => {
  app.hidden = true;
  landing.hidden = false;
  history.replaceState(null, '', location.pathname);
});
$('zoom-in').addEventListener('click', () => renderer.zoom(1.25));
$('zoom-out').addEventListener('click', () => renderer.zoom(0.8));
$('zoom-fit').addEventListener('click', () => renderer.fit());
$('start-tour').addEventListener('click', () => renderer.startTour());
$('edit-toggle').addEventListener('click', () => {
  renderer.setEditMode(!renderer.editMode);
  $('edit-toggle').classList.toggle('on', renderer.editMode);
});
window.addEventListener('resize', () => { if (!app.hidden) renderer.fit(); });

// export menu
const exportMenu = $('export-menu');
$('export-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  exportMenu.hidden = !exportMenu.hidden;
});
document.addEventListener('click', (e) => {
  if (!exportMenu.hidden && !e.target.closest('.menu-wrap')) exportMenu.hidden = true;
});
async function doExport(fn, label) {
  if (!currentData) return;
  exportMenu.hidden = true;
  try { await fn(currentData, renderer); }
  catch (err) { toast(`${label} export failed: ` + err.message, true); }
}
$('export-json').addEventListener('click', () => doExport((d) => downloadJson(d), 'JSON'));
$('export-html').addEventListener('click', () => doExport((d) => downloadHtml(d), 'HTML'));
$('export-svg').addEventListener('click', () => doExport((d) => downloadSvg(d), 'SVG'));
$('export-png').addEventListener('click', () => doExport((d) => downloadPng(d), 'PNG'));

$('ai-enrich').addEventListener('click', async () => {
  if (!currentData) return;
  if (!getKey()) { openSettings(); return toast('Add your Anthropic API key first — it stays in this browser.', true); }
  if (!currentFiles) return toast('AI enrichment needs source files — re-open the repo via GitHub or local folder.', true);
  showProgress('AI: preparing…');
  try {
    await enrichMap(currentData, currentFiles, updateProgress);
    hideProgress();
    renderer.setData(currentData);
    toast('Map enriched by Claude.');
  } catch (err) {
    hideProgress();
    toast(err.message, true);
  }
});

// ---------------------------------------------------- ask the map / search

// One box, two behaviors: questions run through the deterministic query
// engine (answers computed from the graph); anything else is a file search.
// With an API key, unparsed questions are translated by Claude into a
// structured query — translation only, the answer is still computed.
let searchTimer;
$('node-search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    const q = $('node-search').value.trim();
    if (q.length >= 2 && !parseQuery(q)) renderer.findAndFocus(q);
  }, 350);
});
$('node-search').addEventListener('keydown', async (e) => {
  if (e.key !== 'Enter') return;
  const q = $('node-search').value.trim();
  if (!q || !currentData) return;
  if (renderer.ask(q)) return;
  if (renderer.findAndFocus(q)) return;
  if (q.split(/\s+/).length >= 2 && getKey()) {
    try {
      const op = await translateQuery(q, currentData);
      if (op && renderer.runOp(op)) return;
      toast(`Couldn't turn that into a map query. Try "who imports X", "path from A to B", "dead code"…`, true);
    } catch (err) { toast(err.message, true); }
    return;
  }
  toast(`No match for "${q}". Ask things like "who imports X", "path from A to B", "dead code", "biggest files".`, true);
});

// ------------------------------------------------------------ debug overlay

function applyDebug(obj) {
  if (!currentData) return;
  if (obj.bugs && typeof obj.bugs === 'object') currentData.bugs = { ...(currentData.bugs || {}), ...obj.bugs };
  if (obj.fixes && typeof obj.fixes === 'object') currentData.fixes = { ...(currentData.fixes || {}), ...obj.fixes };
  renderer.debugMode = true;
  renderer.renderChips();
  renderer.draw();
}

$('open-debug').addEventListener('click', () => {
  if (!currentData) return toast('Open a codebase first.', true);
  $('debug').hidden = false;
});
$('debug-close').addEventListener('click', () => { $('debug').hidden = true; });

$('debug-apply').addEventListener('click', () => {
  const raw = $('debug-json').value.trim();
  if (!raw) { $('debug').hidden = true; return; }
  try {
    const obj = JSON.parse(raw);
    if (!obj.bugs && !obj.fixes) throw new Error('Expected a { "bugs": {…}, "fixes": {…} } object.');
    applyDebug(obj);
    $('debug').hidden = true;
    toast('Debug overlay applied — toggle 🐛 Bugs & repairs on the map.');
  } catch (err) { toast('Invalid JSON: ' + err.message, true); }
});

$('debug-import').addEventListener('click', () => $('debug-json-input').click());
$('debug-json-input').addEventListener('change', async () => {
  const file = $('debug-json-input').files[0];
  if (!file) return;
  try {
    applyDebug(JSON.parse(await file.text()));
    $('debug').hidden = true;
    toast('Debug overlay imported.');
  } catch (err) { toast('Invalid debug JSON: ' + err.message, true); }
});

$('debug-clear').addEventListener('click', () => {
  if (!currentData) return;
  currentData.bugs = {}; currentData.fixes = {};
  renderer.debugMode = false;
  renderer.renderChips();
  renderer.draw();
  $('debug').hidden = true;
  toast('Debug overlay cleared.');
});

$('debug-ai').addEventListener('click', async () => {
  if (!currentData) return;
  if (!getKey()) { $('debug').hidden = true; openSettings(); return toast('Add your Anthropic API key first — it stays in this browser.', true); }
  if (!currentFiles) return toast('AI bug-finding needs source files — re-open the repo via GitHub or local folder.', true);
  $('debug').hidden = true;
  showProgress('AI: scanning for bugs…');
  try {
    await findBugs(currentData, currentFiles, updateProgress);
    hideProgress();
    renderer.debugMode = true;
    renderer.renderChips();
    renderer.draw();
    const nb = Object.values(currentData.bugs || {}).reduce((s, a) => s + a.length, 0);
    toast(nb ? `Found ${nb} potential bug${nb === 1 ? '' : 's'} — see the red nodes.` : 'No obvious bugs found in the scanned files.');
  } catch (err) { hideProgress(); toast(err.message, true); }
});

// ------------------------------------------------------------ settings

function openSettings() {
  $('set-gh-token').value = ghToken();
  $('set-ai-key').value = getKey();
  $('settings').hidden = false;
}
$('open-settings').addEventListener('click', openSettings);
$('open-settings-2').addEventListener('click', openSettings);
$('settings-close').addEventListener('click', () => { $('settings').hidden = true; });
$('settings-save').addEventListener('click', () => {
  const gh = $('set-gh-token').value.trim();
  if (gh) localStorage.setItem('archmap.ghToken', gh);
  else localStorage.removeItem('archmap.ghToken');
  setKey($('set-ai-key').value.trim());
  $('settings').hidden = true;
  toast('Settings saved (this browser only).');
});
document.querySelectorAll('.overlay').forEach(o => o.addEventListener('click', (e) => {
  if (e.target === o && (o.id === 'settings' || o.id === 'debug')) o.hidden = true;
}));

// ---------------------------------------------------- specimen (landing hero)
// A real render of this site's own map, with plain-name callouts and a
// GO/NO-GO poll computed live from the same data. The one authored motion
// moment on the landing: the stamps land once, in sequence.

let specimen = null;

async function buildSpecimen() {
  const svg = $('spec-map');
  if (!svg) return;
  try {
    const res = await fetch('demo/self.archmap.json');
    if (!res.ok) throw new Error('demo missing');
    const data = await res.json();
    // webfont metrics change callout sizes — measure only after fonts settle
    try { await Promise.race([document.fonts.ready, new Promise(r => setTimeout(r, 1500))]); } catch { /* no Font API */ }
    const r = new MapRenderer(svg, null, null, { headless: true });
    r.setData(data);
    specimen = { redraw: () => r.draw() };

    // plain-name callouts (the labels speak the visitor's language)
    const canvas = $('spec-canvas');
    const inDeg = new Map();
    for (const e of data.edges) inDeg.set(e.to, (inDeg.get(e.to) || 0) + 1);
    const entry = data.nodes.find(n => n.cluster === 'entry');
    const hot = [...data.nodes].filter(n => !n.aggregate && n.id.startsWith('f:'))
      .sort((a, b) => (inDeg.get(b.id) || 0) - (inDeg.get(a.id) || 0))[0];
    const ext = data.nodes.find(n => n.cluster === 'external');
    // callouts sit in fixed slots; drawn leader lines point at the real nodes
    const spots = [
      entry && { n: entry, title: 'THE FRONT DOOR', text: 'execution starts here', side: 'left', yPct: 0.1 },
      hot && { n: hot, title: 'THE BUSY ONE', text: `${inDeg.get(hot.id) || 0} files lean on it`, side: 'right', yPct: 0.42 },
      ext && { n: ext, title: 'THE OUTSIDE WORLD', text: 'packages it calls', side: 'left', yPct: 0.74 },
    ].filter(Boolean);
    const rect = svg.getBoundingClientRect();
    const lines = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    lines.id = 'spec-lines';
    canvas.appendChild(lines);
    for (const s of spots) {
      const nx = s.n.x * r.scale + r.tx + (s.n.w * r.scale) / 2;
      const ny = s.n.y * r.scale + r.ty + (s.n.h * r.scale) / 2;
      const el = document.createElement('div');
      el.className = 'spec-callout';
      el.innerHTML = `<b>${s.title}</b>${s.text}`;
      canvas.appendChild(el);
      const w = el.offsetWidth, h = el.offsetHeight;
      const x = s.side === 'left' ? 8 : rect.width - w - 8;
      const y = Math.max(4, Math.min(rect.height - h - 4, rect.height * s.yPct));
      el.style.left = x + 'px';
      el.style.top = y + 'px';
      const x1 = s.side === 'left' ? x + w : x;
      const y1 = y + h / 2;
      lines.innerHTML += `<line x1="${x1}" y1="${y1}" x2="${nx}" y2="${ny}"/><circle cx="${nx}" cy="${ny}" r="2"/>`;
    }
    svg.addEventListener('click', () => $('demo-go').click());

    // the poll — every row computed from the data just rendered
    const evd = data.edges.filter(e => e.ev).length;
    const check = selfCheckLine(data);
    const onMap = data.nodes.filter(n => n.id.startsWith('f:')).length;
    const covered = onMap + (data.inventory?.files?.length || 0);
    const scanned = data.meta?.stats?.filesScanned || covered;
    const rows = [
      { k: 'WIRES EVIDENCED', v: `${evd}/${data.edges.length}`, go: evd === data.edges.length },
      { k: 'SELF-CHECK', v: check.ok ? '0 INCONSISTENCIES' : `${check.errors.length} ISSUES`, go: check.ok },
      { k: 'COVERAGE', v: `${covered}/${scanned} FILES`, go: covered >= scanned },
    ];
    const poll = $('go-poll');
    poll.innerHTML = rows.map(row => `
      <div class="go-row"><span>${row.k}</span><span class="go-val">${row.v}</span><span class="go-stamp"${row.go ? '' : ' style="color:var(--nogo);border-color:var(--nogo)"'}>${row.go ? 'GO' : 'NO-GO'}</span></div>`).join('');
    const stamps = poll.querySelectorAll('.go-stamp');
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    stamps.forEach((st, i) => {
      if (reduced) st.classList.add('stamped');
      else setTimeout(() => st.classList.add('stamped'), 500 + i * 380);
    });
  } catch {
    $('spec-ghost').hidden = false;
    $('go-poll').innerHTML = '<div class="go-row"><span>SPECIMEN</span><span class="go-val">UNAVAILABLE OFFLINE</span><span class="go-stamp stamped" style="color:var(--muted);border-color:var(--muted)">—</span></div>';
  }
}
buildSpecimen();

// ------------------------------------------------------------ deep link

const params = new URLSearchParams(location.search);
const repoParam = params.get('repo');
if (repoParam) {
  $('gh-url').value = repoParam;
  runIngest((p) => ingestGithub(repoParam, ghToken(), p));
} else if (params.has('demo')) {
  $('demo-go').click();
}
