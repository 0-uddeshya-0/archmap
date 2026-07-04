// Repo ingestion: GitHub URL (client-side API), local folder (File System
// Access API + drag-drop + webkitdirectory), and best-effort website surface.

import { isAnalyzableFile, isManifest } from './analyze.js';

const GH_API = 'https://api.github.com';
const MAX_FILES = 600;

export function parseGithubUrl(input) {
  const m = input.trim().match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/(?:tree|blob)\/([^/]+))?(?:\/.*)?$/);
  if (m) return { owner: m[1], repo: m[2], ref: m[3] || null };
  const short = input.trim().match(/^([\w.-]+)\/([\w.-]+)$/);
  if (short) return { owner: short[1], repo: short[2], ref: null };
  return null;
}

async function gh(path, token) {
  const headers = { Accept: 'application/vnd.github+json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(GH_API + path, { headers });
  if (res.status === 403 || res.status === 429) {
    throw new Error('GitHub API rate limit hit. Add a personal access token (Settings) to raise the limit from 60 to 5,000 requests/hour.');
  }
  if (res.status === 404) throw new Error('Repository not found. Private repos need a token with repo scope (Settings).');
  if (!res.ok) throw new Error(`GitHub API error ${res.status}`);
  return res.json();
}

export async function ingestGithub(url, token, onProgress) {
  const parsed = parseGithubUrl(url);
  if (!parsed) throw new Error('Could not parse that as a GitHub URL. Try https://github.com/owner/repo');
  const { owner, repo } = parsed;
  onProgress?.('Fetching repository info…');
  const info = await gh(`/repos/${owner}/${repo}`, token);
  const ref = parsed.ref || info.default_branch;
  onProgress?.(`Listing files on ${ref}…`);
  const tree = await gh(`/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`, token);
  const LOW_PRIORITY = /(^|\/)(examples?|docs?|docs_src|samples?|demos?|benchmarks?|fixtures|e2e|__tests__|tests?|spec)(\/|$)|(^|\/)Packages\/com\./i;
  const wanted = tree.tree
    .filter(t => t.type === 'blob' && (isAnalyzableFile(t.path, t.size) || isManifest(t.path)))
    // when a repo exceeds the cap, keep core source over examples/docs/tests
    .sort((a, b) => (LOW_PRIORITY.test(a.path) ? 1 : 0) - (LOW_PRIORITY.test(b.path) ? 1 : 0))
    .slice(0, MAX_FILES);
  if (!wanted.length) throw new Error('No JS/TS/Python source files found in this repository.');
  const files = [];
  let done = 0;
  const CONCURRENCY = 12;
  const queue = [...wanted];
  async function worker() {
    while (queue.length) {
      const item = queue.shift();
      try {
        const res = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${item.path}`, token ? { headers: { Authorization: 'Bearer ' + token } } : undefined);
        if (res.ok) files.push({ path: item.path, content: await res.text(), size: item.size });
      } catch { /* skip unreadable file */ }
      done++;
      if (done % 20 === 0 || done === wanted.length) onProgress?.(`Downloading files… ${done}/${wanted.length}`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return { files, meta: { name: `${owner}/${repo}`, source: 'github', url: `https://github.com/${owner}/${repo}`, ref, truncated: tree.truncated || wanted.length === MAX_FILES } };
}

// ---------------------------------------------------------------- local

export async function ingestDirectoryPicker(onProgress) {
  const dir = await window.showDirectoryPicker();
  const files = [];
  onProgress?.('Reading folder…');
  await walkHandle(dir, '', files, onProgress);
  return { files, meta: { name: dir.name, source: 'local' } };
}

async function walkHandle(dirHandle, prefix, files, onProgress) {
  if (files.length >= MAX_FILES) return;
  for await (const [name, handle] of dirHandle.entries()) {
    if (files.length >= MAX_FILES) return;
    const path = prefix ? prefix + '/' + name : name;
    if (handle.kind === 'directory') {
      if (/^(node_modules|\.git|dist|build|venv|\.venv|__pycache__|\.next|coverage|vendor|target)$/.test(name)) continue;
      await walkHandle(handle, path, files, onProgress);
    } else if (isAnalyzableFile(path) || isManifest(path)) {
      try {
        const file = await handle.getFile();
        if (file.size > 400 * 1024) continue;
        files.push({ path, content: await file.text(), size: file.size });
        if (files.length % 25 === 0) onProgress?.(`Reading files… ${files.length}`);
      } catch { /* unreadable */ }
    }
  }
}

export async function ingestDroppedItems(items, onProgress) {
  const files = [];
  const entries = [];
  for (const item of items) {
    const entry = item.webkitGetAsEntry?.();
    if (entry) entries.push(entry);
  }
  let rootName = entries[0]?.name || 'dropped-folder';
  for (const entry of entries) await walkEntry(entry, '', files, onProgress);
  // strip a single shared root dir for cleaner paths
  if (entries.length === 1 && entries[0].isDirectory) {
    for (const f of files) f.path = f.path.replace(new RegExp('^' + rootName + '/'), '');
  }
  return { files, meta: { name: rootName, source: 'local' } };
}

function walkEntry(entry, prefix, files, onProgress) {
  return new Promise((resolve) => {
    if (files.length >= MAX_FILES) return resolve();
    const path = prefix ? prefix + '/' + entry.name : entry.name;
    if (entry.isFile) {
      if (!isAnalyzableFile(path) && !isManifest(path)) return resolve();
      entry.file(async (file) => {
        if (file.size <= 400 * 1024) {
          files.push({ path, content: await file.text(), size: file.size });
          if (files.length % 25 === 0) onProgress?.(`Reading files… ${files.length}`);
        }
        resolve();
      }, () => resolve());
    } else if (entry.isDirectory) {
      if (/^(node_modules|\.git|dist|build|venv|\.venv|__pycache__|\.next|coverage|vendor|target)$/.test(entry.name)) return resolve();
      const reader = entry.createReader();
      const readAll = (acc = []) => reader.readEntries(async (batch) => {
        if (!batch.length) {
          for (const e of acc) await walkEntry(e, path, files, onProgress);
          resolve();
        } else readAll(acc.concat([...batch]));
      }, () => resolve());
      readAll();
    } else resolve();
  });
}

export async function ingestFileInput(fileList, onProgress) {
  const files = [];
  for (const file of fileList) {
    const path = (file.webkitRelativePath || file.name).split('/').slice(1).join('/') || file.name;
    if (!isAnalyzableFile(path) && !isManifest(path)) continue;
    if (file.size > 400 * 1024) continue;
    files.push({ path, content: await file.text(), size: file.size });
    if (files.length % 25 === 0) onProgress?.(`Reading files… ${files.length}`);
    if (files.length >= MAX_FILES) break;
  }
  const root = fileList[0]?.webkitRelativePath?.split('/')[0] || 'folder';
  return { files, meta: { name: root, source: 'local' } };
}

// ------------------------------------------------- website surface (best effort)

export async function ingestWebsite(url, onProgress) {
  if (!/^https?:\/\//.test(url)) url = 'https://' + url;
  const origin = new URL(url).origin;
  onProgress?.('Fetching page… (many sites block cross-origin reads — this is best-effort)');
  let html;
  try {
    const res = await fetch(url, { mode: 'cors' });
    html = await res.text();
  } catch {
    throw new Error(
      'This site blocks cross-origin reads (CORS), which is the norm for deployed websites. ' +
      'A browser can only map a site\'s public surface, and only when the site allows it. ' +
      'For a real architecture map, use the GitHub URL or local folder option — those read actual source code.');
  }
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const title = doc.querySelector('title')?.textContent?.trim() || url;
  const scripts = [...doc.querySelectorAll('script[src]')].map(s => s.getAttribute('src'));
  const stylesheets = [...doc.querySelectorAll('link[rel="stylesheet"]')].map(l => l.getAttribute('href'));
  const links = [...new Set([...doc.querySelectorAll('a[href]')].map(a => {
    try { return new URL(a.getAttribute('href'), url); } catch { return null; }
  }).filter(u => u && u.origin === origin).map(u => u.pathname))].slice(0, 25);
  const forms = [...doc.querySelectorAll('form')].map(f => `${(f.method || 'GET').toUpperCase()} ${f.getAttribute('action') || url}`);
  const generator = doc.querySelector('meta[name="generator"]')?.getAttribute('content');

  const nodes = [];
  const edges = [];
  nodes.push({ id: 'page:root', cluster: 'entry', label: title.slice(0, 40), sub: new URL(url).hostname, color: 'route', path: url, role: 'The page that was fetched.', plain: '', notes: generator ? ['generator: ' + generator] : [], tag: ['all'], critical: true });
  links.forEach((p, i) => {
    nodes.push({ id: 'page:' + i, cluster: 'routes', label: p.length > 30 ? p.slice(0, 28) + '…' : p, sub: 'internal page', color: 'route', path: origin + p, role: 'Same-origin page linked from the root.', plain: '', notes: [], tag: ['all'] });
    edges.push({ from: 'page:root', to: 'page:' + i, kind: 'normal', label: 'link', tag: ['all'] });
  });
  scripts.slice(0, 15).forEach((s, i) => {
    const name = (s.split('/').pop() || s).split('?')[0];
    nodes.push({ id: 'js:' + i, cluster: 'services', label: name.slice(0, 32), sub: 'script', color: 'service', path: s, role: 'JavaScript bundle loaded by the page.', plain: '', notes: [], tag: ['all'] });
    edges.push({ from: 'page:root', to: 'js:' + i, kind: 'mount', label: 'loads', tag: ['all'] });
  });
  forms.slice(0, 8).forEach((f, i) => {
    nodes.push({ id: 'form:' + i, cluster: 'external', label: f.slice(0, 36), sub: 'form endpoint', color: 'external', path: '', role: 'Form submission target observed in the HTML.', plain: '', notes: [], tag: ['all'] });
    edges.push({ from: 'page:root', to: 'form:' + i, kind: 'api', label: 'submits', tag: ['all'] });
  });

  return {
    prebuilt: {
      version: 1,
      meta: { name: title, source: 'website', url, generatedAt: new Date().toISOString(), stats: { nodes: nodes.length, edges: edges.length } },
      clusters: [
        { id: 'entry', label: 'Page', color: 'route' },
        { id: 'routes', label: 'Internal pages', color: 'route' },
        { id: 'services', label: 'Scripts', color: 'service' },
        { id: 'external', label: 'Endpoints', color: 'external' },
      ].filter(c => nodes.some(n => n.cluster === c.id)),
      nodes, edges,
      findings: [
        'Website surface map: this shows only what the deployed HTML publicly exposes (pages, scripts, form endpoints) — not the real backend architecture.',
        generator ? `Built with: ${generator}.` : `${scripts.length} scripts and ${stylesheets.length} stylesheets loaded.`,
        'For a true architecture map, point ArchMap at the site\'s source repository instead.',
      ],
      tags: ['all'], fixes: {}, bugs: {}, ai: { enriched: false },
    },
  };
}
