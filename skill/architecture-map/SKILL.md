---
name: architecture-map
description: Build an interactive architecture map of this codebase — a single self-contained HTML file plus a portable archmap.json. Clusters (entry / routes / services / data / external) with critical-path highlighting, dead-code detection, plain-English explanations, click-to-detail sidebar, feature filters, and pan + zoom. The JSON can also be opened, shared, and re-explored on the ArchMap web viewer.
---

# Architecture Map

Produce **two artifacts**:

1. `./architecture-map.html` — one self-contained HTML file, no build step, no external assets. Opens directly in a browser or via `python3 -m http.server 4747`.
2. `./archmap.json` — the same map as portable data, loadable in the ArchMap web viewer (https://0-uddeshya-0.github.io/archmap/ → "Import archmap.json") so the user can share the map without shipping HTML.

The goal is not a pretty diagram. The goal is a map a non-engineer could open and understand the system from, AND that a maintainer could spot dead code / hot paths / weak seams from at a glance.

---

## Method (in order — do not skip, do not guess)

### 1. Map the stack first
Read the README, every package manifest (package.json, pyproject.toml, Cargo.toml, go.mod, …), and the entry point. Pick clusters that match what you actually found — typical: Client · Entry · Routes · Services · Data · External. Adapt freely:
- CLI app → Entry · Commands · Core · Storage · External
- Frontend-only → Pages · Components · State · API clients · External
- Library → Public API · Core · Helpers · Tests · External

### 2. Compute the dependency graph before judging it
Before writing any prose, extract the real import graph: which file imports which, which packages are external, fan-in/fan-out per file. Use grep/AST — every edge in the map must correspond to a real import, call, HTTP request, or DB access you verified. This is what separates the map from a diagram: it is computed truth first, narrative second.

### 3. Identify the seam
Find the single most important code path. LLM app → the prompt-assembly function. Web app → the request-handler chain of the headline feature. CLI → the main loop. Mark every node on it `critical: true` and every edge `kind: "critical"`. This is the spine; everything else is decoration.

### 4. For each node, open the file and read it
Do not summarize from filename alone. Capture per node:
- `path` — real relative path, `:line` when a key callsite is at a known line (verify the line)
- `role` — one technical sentence
- `plain` — same idea for a smart non-engineer. No jargon, no unexpanded acronyms.
- `notes` — 2–4 concrete facts: line numbers, library/model versions, surprising couplings
- `tag` — feature-filter ids this node belongs to (always include `"all"`)

### 5. Find dead code
For every top-level export of every service-layer file, grep for callers. Zero live callers → node gets `dead: true` and sub-label `DEAD · zero callers`. Never silently omit dead code — surfacing it is half the value.

### 6. Label every edge with what flows
`'POST /api/foo'`, `'1 · getContext'`, `'messages.stream → opus-4-8'`, `'DB write'`, `'cron · nightly'`. Kinds: `critical` (red, the seam) · `api` (orange, external service) · `db` (amber) · `mount` (sky, entry → routes) · `normal` (grey).

### 7. Tag nodes and edges for filters
Chips come from the actual feature surface (`auth`, `chat`, `billing`, …) — never invent chips for features that don't exist. Every node/edge gets `tag: [...]` including `"all"`.

### 8. (Optional) fixes + bugs registries
If the user has a roadmap or bug list, populate `fixes` and `bugs` keyed by node id (see schema). A fix may appear under multiple nodes — that's useful, it shows everywhere it touches. **No invented bugs**: only entries citable with `file:line`.

### 9. The default sidebar earns the map its keep
`findings` must contain at least one of: dead code located, unexpectedly heavy hot paths, schema/code mismatches, libraries or models you didn't expect, fields rendered into the same prompt twice, duplicated-looking services. This is the first thing a maintainer reads.

---

## archmap.json schema (authoritative)

```json
{
  "version": 1,
  "meta": {
    "name": "owner/repo",
    "source": "skill",
    "generatedAt": "ISO-8601",
    "stats": { "filesScanned": 0, "nodes": 0, "edges": 0, "frameworks": [] }
  },
  "clusters": [ { "id": "entry", "label": "Entry points", "color": "route" } ],
  "nodes": [ {
    "id": "f:src/app.js", "cluster": "entry",
    "label": "app.js", "sub": "src", "color": "route",
    "path": "src/app.js:12",
    "role": "one technical sentence",
    "plain": "plain-English version",
    "notes": ["line 12: mounts /api", "uses express 4.19"],
    "tag": ["all", "api"],
    "critical": true, "dead": false,
    "routes": ["GET /health"], "exports": ["createApp"]
  } ],
  "edges": [ { "from": "f:src/app.js", "to": "f:src/routes/user.js", "kind": "mount", "label": "mounts /users", "tag": ["all"] } ],
  "findings": ["Dead code: src/legacy/export.js has zero callers."],
  "tags": ["all", "auth", "billing"],
  "fixes": { "f:src/app.js": [ { "n": 1, "t": "short fix description" } ] },
  "bugs":  { "f:src/app.js": [ { "sev": "high", "ref": "BUG-42", "t": "cited with file:line" } ] },
  "ai": { "enriched": true, "overview": "3-4 sentence plain-English system overview" }
}
```

Node `color` values: `client` · `route` · `service` · `db` · `external` · `muted`.

## HTML contract

- **One file**, embedded `<style>` + `<script>`, vanilla SVG. No frameworks, no external assets, no auto-layout library.
- Left-to-right column clusters; explicit `x, y, w, h` per node; clear vertical gutters so bezier edges (`M x1 y1 C cx1 y1, cx2 y2, x2 y2`, arrowheads at destination) don't cross nodes; stagger labels sharing a gutter.
- Filter chips: **Overview** (default), one per feature tag, **Show all wires**, and **Roadmap & bugs** when registries are non-empty.
- Right sidebar updates on hover, pins on click; click on canvas background clears; selecting a node dims unconnected nodes.
- Pan (drag) + zoom (wheel anchored at cursor) + Fit/+/− buttons.
- Badges: green circle = fix count, red = bug count, top-right of node.
- Palette (CSS vars): `--bg #0F0F0F --panel #161616 --panel-2 #1c1c1c --border #2a2a2a --text #e8e8e8 --muted #8a8a8a --client #4ea1ff --route #7bd389 --service #c792ea --db #ffb86b --external #ff6b9d --critical #ff3860 --accent #f5b942 --accent-2 #ff7a45`. Cluster fill = darker tint; node stroke = cluster color; critical nodes ~2.2px stroke.
- Keep the data section of the script as a single `const ARCHMAP_DATA = {…}` literal matching the JSON schema above, so the user can hand-edit it and re-import it into the web viewer.

## Rules

- Every label is a real file/function name; every path real; every cited line verified by reading it.
- No invented bugs. No jargon in `plain`. No emojis in node labels/sub-labels.
- Embed the exact same object in the HTML (`ARCHMAP_DATA`) as you write to `archmap.json` — one source of truth.

## Deliverables

1. `./architecture-map.html` and `./archmap.json` (or paths the user requested).
2. A short reply: node/edge counts, the critical path you identified, dead code found, top 3 surprises, and a reminder that `archmap.json` can be opened at the ArchMap web viewer for sharing.
3. Viewing: open the HTML directly, or `python3 -m http.server 4747` → `http://localhost:4747/architecture-map.html`.
