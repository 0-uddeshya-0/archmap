import { analyze } from './analyze.js';
import { ingestGithub, ingestDirectoryPicker, ingestDroppedItems, ingestFileInput, ingestWebsite } from './ingest.js';
import { MapRenderer } from './render.js';
import { enrichMap, getKey, setKey } from './ai.js';
import { downloadJson, downloadHtml } from './export.js';

const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------ theme

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('archmap.theme', theme);
  document.querySelectorAll('[data-theme-toggle]').forEach(b => { b.textContent = theme === 'light' ? '◑' : '◐'; });
}
applyTheme(localStorage.getItem('archmap.theme') || 'dark');
document.querySelectorAll('[data-theme-toggle]').forEach(b => b.addEventListener('click', () => {
  applyTheme(document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light');
  if (currentData && !app.hidden) renderer.draw(); // re-read theme colors
}));

const landing = $('landing'), app = $('app');
const renderer = new MapRenderer($('map'), $('sidebar'), $('chips'));
let currentData = null;
let currentFiles = null; // kept for AI enrichment excerpts

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
    history.replaceState(null, '', '?' + q.toString());
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
    if (!data.nodes || !data.clusters) throw new Error('Not a valid archmap.json file.');
    showMap(data, null);
  } catch (err) {
    toast(err.message, true);
  }
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
window.addEventListener('resize', () => { if (!app.hidden) renderer.fit(); });

$('export-json').addEventListener('click', () => currentData && downloadJson(currentData));
$('export-html').addEventListener('click', async () => {
  if (!currentData) return;
  try { await downloadHtml(currentData); }
  catch (err) { toast('Export failed: ' + err.message, true); }
});

$('ai-enrich').addEventListener('click', async () => {
  if (!currentData) return;
  if (!getKey()) { openSettings(); return toast('Add your Anthropic API key first — it stays in this browser.', true); }
  if (!currentFiles) return toast('AI enrichment needs source files — re-open the repo via GitHub or local folder.', true);
  showProgress('AI: preparing…');
  try {
    await enrichMap(currentData, currentFiles, updateProgress);
    hideProgress();
    renderer.setData(currentData);
    toast('Map enriched by Claude ✦');
  } catch (err) {
    hideProgress();
    toast(err.message, true);
  }
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
  if (e.target === o && o.id === 'settings') o.hidden = true;
}));

// ------------------------------------------------------------ deep link

const repoParam = new URLSearchParams(location.search).get('repo');
if (repoParam) {
  $('gh-url').value = repoParam;
  runIngest((p) => ingestGithub(repoParam, ghToken(), p));
}
