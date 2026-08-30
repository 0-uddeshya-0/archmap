---
name: architecture-map
description: Build an interactive architecture map of this codebase — a portable archmap.json plus a single self-contained HTML file with the full ArchMap viewer (guided tour, upstream/downstream reach tracing, route probe, minimap, keyboard controls, deep links). Clusters (entry / routes / services / data / external) with critical-path highlighting, dead-code and circular-import detection, and plain-English explanations. The JSON opens on the ArchMap web viewer for sharing and re-exploration.
---

# Architecture Map

Produce **two artifacts**:

1. `./archmap.json` — the map as portable data (schema below), loadable at the ArchMap web viewer (https://0-uddeshya-0.github.io/archmap/ → "Import archmap.json").
2. `./architecture-map.html` — one self-contained HTML file with the full interactive viewer. Build it from the official runtime (below); hand-write a minimal viewer only if offline.

The goal is not a pretty diagram. The goal is a map a non-engineer could open and understand the system from (the guided tour derives from your data), AND that a maintainer could spot dead code / cycles / hot paths / weak seams from at a glance.

---

## Method (in order — do not skip, do not guess)

### 1. Map the stack first
Read the README, every package manifest (package.json, pyproject.toml, Cargo.toml, go.mod, …), and the entry point. Pick clusters that match what you actually found — typical: Client · Entry · Routes · Services · Data · External. Adapt freely:
- CLI app → Entry · Commands · Core · Storage · External
- Frontend-only → Pages · Components · State · API clients · External
- Library → Public API · Core · Helpers · Tests · External

### 2. Compute the dependency graph before judging it
Before writing any prose, extract the real import graph: which file imports which, which packages are external, fan-in/fan-out per file. Use grep/AST — every edge in the map must correspond to a real import, call, HTTP request, or DB access you verified. This is what separates the map from a diagram: computed truth first, narrative second.

### 3. Identify the seam
Find the single most important code path. LLM app → the prompt-assembly function. Web app → the request-handler chain of the headline feature. CLI → the main loop. Mark every node on it `critical: true` and every edge `kind: "critical"`. This is the spine; everything else is decoration.

### 4. For each node, open the file and read it
Do not summarize from filename alone. Capture per node:
- `path` — real relative path, `:line` when a key callsite is at a known line (verify the line)
- `role` — one technical sentence
- `plain` — same idea for a smart non-engineer. No jargon, no unexpanded acronyms.
- `notes` — 2–4 concrete facts: line numbers, library/model versions, surprising couplings
- `tag` — feature-filter ids this node belongs to (always include `"all"`)

### 5. Find dead code and cycles
For every top-level export of every service-layer file, grep for callers. Zero live callers → `dead: true` and sub-label `DEAD · zero callers`. Mutually-importing files → set `cycle: true` on every edge inside the cycle and name the cycle in `findings`. Never silently omit either — surfacing them is half the value.

### 6. Label every edge with what flows
`'POST /api/foo'`, `'1 · getContext'`, `'messages.stream → opus'`, `'DB write'`, `'cron · nightly'`. Kinds: `critical` (red, the seam) · `api` (orange, external service) · `db` (amber) · `mount` (sky, entry → routes) · `normal` (grey).

### 7. Tag nodes and edges for filters
Chips come from the actual feature surface (`auth`, `chat`, `billing`, …) — never invent chips for features that don't exist. Every node/edge gets `tag: [...]` including `"all"`.

### 8. Keep the map readable; put the rest in `inventory`
Cap the map at ~80 nodes. Extra low-traffic files go into `inventory.files` (and their edges into `inventory.edges`) plus one `{ "id": "more:<cluster>", "aggregate": true }` node per overflowing cluster — the viewer lets readers list and expand them, so nothing is hidden, only de-emphasized.

### 9. (Optional) fixes + bugs registries
If the user has a roadmap or bug list, populate `fixes` and `bugs` keyed by node id (see schema). **No invented bugs**: only entries citable with `file:line`.

### 10. The default sidebar earns the map its keep
`findings` must contain at least one of: dead code located, circular imports, unexpectedly heavy hot paths, schema/code mismatches, libraries or models you didn't expect, layering violations (data importing UI), duplicated-looking services. This is the first thing a maintainer reads.

---

## archmap.json schema (authoritative)

```json
{
  "version": 1,
  "meta": {
    "name": "owner/repo",
    "source": "skill",
    "url": "https://github.com/owner/repo",
    "ref": "main",
    "generatedAt": "ISO-8601",
    "stats": { "filesScanned": 0, "totalLoc": 0, "nodes": 0, "edges": 0, "languages": {"js": 3}, "frameworks": [] }
  },
  "clusters": [ { "id": "entry", "label": "Entry points", "color": "route" } ],
  "nodes": [ {
    "id": "f:src/app.js", "cluster": "entry",
    "label": "app.js", "sub": "src", "color": "route",
    "path": "src/app.js",
    "role": "one technical sentence",
    "plain": "plain-English version",
    "notes": ["line 12: mounts /api", "uses express 4.19"],
    "tag": ["all", "api"],
    "critical": true, "dead": false, "loc": 214,
    "routes": ["GET /health"], "exports": ["createApp"]
  } ],
  "edges": [ { "from": "f:src/app.js", "to": "f:src/routes/user.js", "kind": "mount", "label": "mounts /users", "tag": ["all"], "cycle": false, "ev": "src/app.js:12", "spec": "./routes/user.js" } ],
  "findings": ["Dead code: src/legacy/export.js has zero callers."],
  "tags": ["all", "auth", "billing"],
  "inventory": {
    "files": [ { "path": "src/util/tiny.js", "cluster": "services", "loc": 12, "degree": 1 } ],
    "edges": [ ["src/util/tiny.js", "src/app.js"] ]
  },
  "fixes": { "f:src/app.js": [ { "t": "short fix description" } ] },
  "bugs":  { "f:src/app.js": [ { "sev": "HIGH", "ref": "BUG-42", "t": "plain sentence", "ev": ["src/app.js:42"] } ] },
  "ai": { "enriched": true, "overview": "3-4 sentence plain-English system overview" }
}
```

- Node `color`: `client` · `route` · `service` · `db` · `external` · `muted`.
- `meta.url` + `meta.ref` + node `path` enable "view source ↗" links in the viewer — include them when the repo is on GitHub.
- **Edge evidence**: set `ev` to the `file:line` of the import/call that creates the edge (verify the line by reading it) and `spec` to the import specifier. The viewer shows this when the reader clicks the wire, and links it to GitHub. An edge you cannot cite should not be on the map.
- `inventory` is optional but recommended for repos > 80 files: it powers search-anything and "expand all" in the viewer. Its `edges` entries are `[fromPath, toPath, line]`.

## Building architecture-map.html (preferred: official runtime)

The ArchMap viewer runtime ships as four files in the ArchMap repo. Fetch them (network) or copy them (if the user has the repo):

```
https://raw.githubusercontent.com/0-uddeshya-0/archmap/main/js/render.js
https://raw.githubusercontent.com/0-uddeshya-0/archmap/main/js/query.js
https://raw.githubusercontent.com/0-uddeshya-0/archmap/main/js/validate.js
https://raw.githubusercontent.com/0-uddeshya-0/archmap/main/css/style.css
```

Then emit this exact template (this is what the web app's own "Export HTML" produces — readers get the tour, reach tracing, route probe, ask-the-map queries, evidence-on-click, the manual editor, minimap, keyboard controls, and deep links for free):

```html
<!DOCTYPE html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{NAME} — ArchMap</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;600;700;800&family=Courier+Prime:wght@400;700&display=swap">
<style>{CONTENTS OF style.css}</style>
</head>
<body class="app-mode standalone">
<header class="topbar">
  <div class="brand">Arch<span>Map</span></div>
  <div id="chips" class="chips"></div>
  <div class="toolbar">
    <input id="map-search" data-map-search class="node-search" type="text" placeholder="Ask or search…  ( / )" spellcheck="false" aria-label="Ask the map or search files">
    <button id="start-tour" title="Guided tour (g)">Tour</button>
    <button id="edit-toggle" title="Edit the map (session-only)">Edit</button>
    <button id="zoom-out">−</button><button id="zoom-fit">Fit</button><button id="zoom-in">+</button>
    <button id="theme-toggle" data-theme-toggle class="ghost" title="Switch light / dark (t)">Theme</button>
  </div>
</header>
<main class="map-layout">
  <svg id="map" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Architecture map"></svg>
  <aside id="sidebar" class="sidebar"></aside>
</main>
<script>
{CONTENTS OF query.js, then validate.js, then render.js — each with every line-leading "export " removed}
const ARCHMAP_DATA = {THE JSON, with every "<" character escaped as backslash-u003c};
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
let st; search.addEventListener('input', () => { clearTimeout(st); st = setTimeout(() => { const q = search.value.trim(); if (q.length >= 2 && !parseQuery(q)) r.findAndFocus(q); }, 350); });
search.addEventListener('keydown', (e) => { if (e.key !== 'Enter') return; const q = search.value.trim(); if (q && !r.ask(q)) r.findAndFocus(q); });
window.addEventListener('resize', () => r.fit());
</script>
</body>
</html>
```

**Offline fallback** (no network, no local copy): hand-write a minimal single-file viewer — left-to-right column clusters with explicit `x,y,w,h`, bezier edges with arrowheads, pan/drag + wheel zoom, chips, hover/click sidebar — light-first, using the palette `--bg #ffffff --panel-2 #f4f4f1 --text #17191c --muted #656b74 --client #1667c9 --route #1e7d3f --service #7c3aed --db #b45309 --external #be2f5b --critical #d61f45 --accent #ff4400`. Say clearly in your reply that the fallback viewer was used and the JSON can be opened on the web viewer for the full experience.

## Rules

- Every label is a real file/function name; every path real; every cited line verified by reading it.
- No invented bugs. No jargon in `plain`. No emojis in node labels/sub-labels.
- Embed the exact same object in the HTML (`ARCHMAP_DATA`) as you write to `archmap.json` — one source of truth.
- Never describe graph reachability as "impact" or "blast radius" — the map shows authored imports, not runtime causality.

## Deliverables

1. `./archmap.json` and `./architecture-map.html` (or paths the user requested).
2. A short reply: node/edge counts, the critical path you identified, dead code and cycles found, top 3 surprises, and a reminder that `archmap.json` can be opened at the ArchMap web viewer for sharing.
3. Viewing: open the HTML directly, or `python3 -m http.server 4747` → `http://localhost:4747/architecture-map.html`.
