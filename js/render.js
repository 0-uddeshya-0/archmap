// SVG renderer + interaction runtime: column-cluster layout, cubic-bezier
// edges, pan/zoom, hover/click selection, filter chips, detail sidebar,
// upstream/downstream reach tracing, route probe, guided tour, minimap,
// keyboard shortcuts, deep links, and aggregate expansion.
//
// This file is also embedded verbatim in exported HTML (with `export `
// stripped), so it must stay dependency-free and self-contained.

// Colors come from CSS custom properties so the map follows the active theme.
function readTheme() {
  const s = getComputedStyle(document.documentElement);
  const v = (name, fb) => (s.getPropertyValue(name) || fb).trim() || fb;
  const colors = {
    client: v('--client', '#1667c9'), route: v('--route', '#1e7d3f'),
    service: v('--service', '#7c3aed'), db: v('--db', '#b45309'),
    external: v('--external', '#be2f5b'), critical: v('--critical', '#d61f45'),
    muted: v('--neutral', '#6b7280'), accent: v('--accent', '#ff4400'),
  };
  return {
    colors,
    edges: { critical: colors.critical, api: v('--accent-2', '#c2410c'), db: colors.db, mount: colors.client, normal: v('--edge-normal', '#9aa1aa'), route: colors.accent, up: colors.service, down: colors.route },
    nodeFill: v('--node-fill', '#ffffff'),
    canvas: v('--bg', '#ffffff'),
    text: v('--text', '#17191c'),
    muted: v('--muted', '#656b74'),
    badgeInk: v('--accent-ink', '#17191c'),
  };
}

const NODE_W = 200, NODE_H = 54, GAP_Y = 18, COL_GAP = 130, PAD = 40;
const REDUCED = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export class MapRenderer {
  // opts.headless: render-only (exports) — no HUD, keyboard, or URL-hash wiring
  // opts.helpers: injected pure functions from query.js / validate.js
  //   { parseQuery, runQuery, applyPatch, selfCheckLine } — injection keeps this
  //   file dependency-free so it can be embedded verbatim in HTML exports.
  constructor(svgEl, sidebarEl, chipsEl, opts = {}) {
    this.svg = svgEl;
    this.sidebar = sidebarEl;
    this.chips = chipsEl;
    this.tx = 0; this.ty = 0; this.scale = 1;
    this.activeTag = 'all';
    this.showAllWires = false;
    this.selected = null;
    this.edgeSel = null;    // index into data.edges
    this.debugMode = false;
    this.editMode = false;
    this.reach = null;      // { origin, dir:'up'|'down', nodes:Set, edges:Set, hops, links }
    this.route = null;      // { ids:[...], edges:Set }
    this.routePick = null;  // { from: id|null } while picking endpoints
    this.connectFrom = null; // node id while drawing a new wire (edit mode)
    this.queryHl = null;    // { ids:Set, edgeIdxs:Set } from an answered query
    this.tour = null;       // { chapters:[...], idx }
    this._anim = null;
    this._history = [];
    this.onchange = null;   // called after any structural edit (autosave hook)
    this.oninstruct = null; // async (text) => — natural-language edit handler
    this.helpers = opts.helpers || {};
    this._headless = !!opts.headless;
    this._hud = {};
    if (!this._headless) {
      this._buildHud();
      this._bindPanZoom();
      this._bindKeys();
      this._bindSidebar();
    }
  }

  setData(data) {
    this.data = data;
    this.reach = null; this.route = null; this.routePick = null;
    this.edgeSel = null; this.queryHl = null; this.connectFrom = null;
    this.editMode = false;
    this._history = [];
    if (this._hud.edit) this._hud.edit.hidden = true;
    this._stopTour(true);
    this.layout();
    this.renderChips();
    this.draw();
    this.fit();
    this.renderSidebar(this.selected && data.nodes.some(n => n.id === this.selected) ? this.selected : null);
    if (!this._headless) {
      this._applyHash();
      this._maybeHint();
    }
  }

  layout() {
    const { clusters, nodes } = this.data;
    let x = PAD;
    this.clusterBoxes = [];
    const INNER_GAP = 16;
    for (const c of clusters) {
      const cNodes = nodes.filter(n => n.cluster === c.id);
      if (!cNodes.length) continue;
      // tall clusters wrap into multiple sub-columns so the map stays readable
      const cols = Math.max(1, Math.ceil(cNodes.length / 20));
      const rows = Math.ceil(cNodes.length / cols);
      cNodes.forEach((n, i) => {
        const col = Math.floor(i / rows), row = i % rows;
        n.x = x + col * (NODE_W + INNER_GAP);
        n.y = PAD + 44 + row * (NODE_H + GAP_Y);
        // user-dragged positions (px/py) override the computed grid
        if (n.px != null && n.py != null) { n.x = n.px; n.y = n.py; }
        n.w = NODE_W; n.h = NODE_H;
      });
      // the box wraps the nodes' ACTUAL positions, so it stays truthful
      // even after nodes are dragged around in edit mode
      const minX = Math.min(...cNodes.map(n => n.x)), maxX = Math.max(...cNodes.map(n => n.x + n.w));
      const minY = Math.min(...cNodes.map(n => n.y)), maxY = Math.max(...cNodes.map(n => n.y + n.h));
      this.clusterBoxes.push({ ...c, x: minX - 14, y: minY - 44, w: maxX - minX + 28, h: maxY - minY + 60, count: cNodes.length });
      const gridW = cols * NODE_W + (cols - 1) * INNER_GAP + 28;
      x += gridW - 28 + COL_GAP;
    }
    this.worldW = Math.max(x, ...this.clusterBoxes.map(b => b.x + b.w)) + PAD;
    this.worldH = Math.max(...this.clusterBoxes.map(b => b.y + b.h + PAD), 400) + PAD;
  }

  visible(item) {
    if (this.activeTag === 'all') return true;
    return (item.tag || ['all']).includes(this.activeTag);
  }

  edgeVisible(e, i) {
    if (this.route?.edges.has(i) || this.reach?.edges.has(i)) return true;
    if (!this.showAllWires && this.activeTag === 'all') {
      // overview: show critical + mount + db/api + cycle edges, hide plain imports
      if (e.kind === 'normal' && !e.cycle) return false;
    }
    return this.visible(e);
  }

  // Resolve per-node / per-edge emphasis for the active exploration mode.
  _emphasis() {
    const sel = this.selected;
    if (this.edgeSel != null) {
      const e = this.data.edges[this.edgeSel];
      const ends = new Set(e ? [e.from, e.to] : []);
      return {
        node: (n) => ends.has(n.id) ? 1 : 0.25,
        edge: (ed, i) => i === this.edgeSel ? { o: 1, w: 3 } : { o: 0.1 },
      };
    }
    if (this.queryHl) {
      const q = this.queryHl;
      return {
        node: (n) => q.ids.has(n.id) ? 1 : 0.14,
        edge: (e, i) => q.edgeIdxs.has(i) ? { o: 0.95, w: 2.4 } : (q.ids.has(e.from) && q.ids.has(e.to) ? null : { o: 0.06 }),
      };
    }
    if (this.route) {
      const on = new Set(this.route.ids);
      return {
        node: (n) => on.has(n.id) ? 1 : 0.12,
        edge: (e, i) => this.route.edges.has(i) ? { o: 1, w: 2.8, c: 'route' } : { o: 0.05 },
      };
    }
    if (this.reach) {
      const r = this.reach;
      const key = r.dir === 'up' ? 'up' : 'down';
      return {
        node: (n) => (n.id === r.origin || r.nodes.has(n.id)) ? 1 : 0.1,
        edge: (e, i) => r.edges.has(i) ? { o: 0.95, w: 2.2, c: key } : { o: 0.04 },
      };
    }
    if (this.tour) {
      const ch = this.tour.chapters[this.tour.idx];
      const on = new Set(ch.ids);
      const all = ch.all;
      return {
        node: (n) => (all || on.has(n.id)) ? 1 : 0.14,
        edge: (e) => (all || (on.has(e.from) && on.has(e.to))) ? null : { o: 0.05 },
      };
    }
    const bugsMap = this.data.bugs || {}, fixesMap = this.data.fixes || {};
    if (this.debugMode) {
      return {
        node: (n) => ((bugsMap[n.id] || []).length || (fixesMap[n.id] || []).length || n.id === sel) ? 1 : 0.15,
        edge: (e) => (e.from === sel || e.to === sel) ? null : { o: 0.15 },
      };
    }
    if (sel) {
      const conn = this._connectivity();
      const near = conn.get(sel) || new Set();
      return {
        node: (n) => (n.id === sel || near.has(n.id)) ? 1 : 0.15,
        edge: (e) => (e.from === sel || e.to === sel) ? { o: 0.95, w: 2.2 } : { o: 0.08 },
      };
    }
    return { node: () => 1, edge: () => null };
  }

  draw() {
    const { nodes, edges } = this.data;
    const T = readTheme();
    const COLORS = T.colors, EDGE_COLORS = T.edges;
    const byId = new Map(nodes.map(n => [n.id, n]));
    const emph = this._emphasis();

    let defs = `<defs>`;
    for (const [k, c] of Object.entries(EDGE_COLORS)) {
      defs += `<marker id="arr-${k}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="${c}"/></marker>`;
    }
    defs += `</defs>`;

    let g = `<g id="world" transform="translate(${this.tx},${this.ty}) scale(${this.scale})">`;
    g += `<rect x="-20000" y="-20000" width="60000" height="60000" fill="transparent" data-bg="1"/>`;

    for (const b of this.clusterBoxes) {
      const color = COLORS[b.color] || '#888';
      g += `<g class="cluster-hd" data-cluster="${esc(b.id)}" style="cursor:pointer">`;
      g += `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="10" fill="${color}10" stroke="${color}38" stroke-width="1"/>`;
      g += `<text x="${b.x + 14}" y="${b.y + 26}" fill="${color}" font-size="12" font-weight="700" letter-spacing="1.2">${esc(b.label.toUpperCase())} · ${b.count}</text>`;
      g += `</g>`;
    }

    // edges
    const labelSlots = new Map();
    for (let i = 0; i < edges.length; i++) {
      const e = edges[i];
      if (!this.edgeVisible(e, i)) continue;
      const a = byId.get(e.from), b = byId.get(e.to);
      if (!a || !b || !this.visible(a) || !this.visible(b)) continue;
      const st = emph.edge(e, i) || {};
      const kindKey = st.c || e.kind || 'normal';
      const color = EDGE_COLORS[kindKey] || EDGE_COLORS.normal;
      const x1 = a.x + a.w, y1 = a.y + a.h / 2;
      const x2 = b.x, y2 = b.y + b.h / 2;
      const backward = x2 < x1;
      let d;
      if (backward) {
        const midY = Math.min(y1, y2) - 40;
        d = `M ${a.x + a.w / 2} ${a.y} C ${a.x + a.w / 2} ${midY}, ${b.x + b.w / 2} ${midY}, ${b.x + b.w / 2} ${b.y}`;
      } else {
        const cx = (x1 + x2) / 2;
        d = `M ${x1} ${y1} C ${cx} ${y1}, ${cx} ${y2}, ${x2} ${y2}`;
      }
      const w = st.w || (e.kind === 'critical' ? 2.4 : 1.4);
      const baseO = e.kind === 'normal' && !e.cycle ? 0.4 : 0.85;
      const o = st.o != null ? st.o : baseO;
      const dash = e.cycle ? ' stroke-dasharray="7 4"' : '';
      g += `<path class="edge" data-i="${i}" data-from="${esc(e.from)}" data-to="${esc(e.to)}" d="${d}" fill="none" stroke="${color}" stroke-width="${w}" stroke-linecap="round"${dash} opacity="${o}" marker-end="url(#arr-${kindKey})"/>`;
      // invisible fat twin makes the wire clickable (evidence / edit)
      g += `<path class="edge-hit" data-i="${i}" d="${d}" fill="none" stroke="transparent" stroke-width="13" style="cursor:pointer" pointer-events="stroke"><title>${esc(this._edgeTip(e))}</title></path>`;
      if (e.label && e.label !== 'import' && o > 0.5) {
        const gutter = Math.round((x1 + x2) / 2 / 40);
        const slot = labelSlots.get(gutter) || 0;
        labelSlots.set(gutter, slot + 1);
        const lx = (x1 + x2) / 2, ly = (y1 + y2) / 2 - 6 - slot * 13;
        g += `<text x="${lx}" y="${ly}" fill="${color}" font-size="10" text-anchor="middle" opacity="0.9">${esc(e.label.slice(0, 26))}</text>`;
      }
    }

    // nodes
    const bugsMap = this.data.bugs || {}, fixesMap = this.data.fixes || {};
    for (const n of nodes) {
      if (!this.visible(n)) continue;
      const color = COLORS[n.color] || '#888';
      const openBugs = (bugsMap[n.id] || []).length;
      const nodeFixes = (fixesMap[n.id] || []).length;
      const alpha = emph.node(n);
      let stroke = n.critical ? COLORS.critical : color;
      let sw = n.critical ? 2.4 : (n.id === this.selected ? 2.2 : 1.3);
      if (this.debugMode && openBugs) { stroke = COLORS.critical; sw = 2.6; }
      else if (this.debugMode && nodeFixes) { stroke = COLORS.route; sw = 2.6; }
      if (this.reach && n.id === this.reach.origin) { stroke = EDGE_COLORS[this.reach.dir === 'up' ? 'up' : 'down']; sw = 2.8; }
      if (this.route && (n.id === this.route.ids[0] || n.id === this.route.ids[this.route.ids.length - 1])) { stroke = COLORS.accent; sw = 2.8; }
      const dash = n.dead ? ' stroke-dasharray="5 3"' : '';
      g += `<g class="node" data-id="${esc(n.id)}" opacity="${alpha}" style="cursor:pointer">`;
      if (this.debugMode && (openBugs || nodeFixes) && alpha === 1) {
        const hc = openBugs ? COLORS.critical : COLORS.route;
        g += `<rect x="${n.x - 4}" y="${n.y - 4}" width="${n.w + 8}" height="${n.h + 8}" rx="12" fill="${hc}1f" stroke="${hc}66" stroke-width="1.5"/>`;
      }
      g += `<rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="8" fill="${T.nodeFill}" stroke="${stroke}" stroke-width="${sw}"${dash}/>`;
      g += `<text x="${n.x + 12}" y="${n.y + 22}" fill="${T.text}" font-size="12.5" font-weight="600">${esc(trunc(n.label, 26))}</text>`;
      const subColor = n.dead ? COLORS.critical : T.muted;
      g += `<text x="${n.x + 12}" y="${n.y + 40}" fill="${subColor}" font-size="10.5">${esc(trunc(n.sub || '', 30))}</text>`;
      if (nodeFixes) g += badge(n.x + n.w - (openBugs ? 34 : 12), n.y - 2, COLORS.route, nodeFixes, T.badgeInk);
      if (openBugs) g += badge(n.x + n.w - 12, n.y - 2, COLORS.critical, openBugs, '#ffffff');
      g += `</g>`;
    }
    g += `</g>`;
    this.svg.innerHTML = defs + g;

    this.svg.querySelectorAll('.node').forEach(el => {
      el.addEventListener('click', (ev) => { ev.stopPropagation(); this._nodeClicked(el.dataset.id); });
      el.addEventListener('dblclick', (ev) => { ev.stopPropagation(); this.focusNode(el.dataset.id); });
      el.addEventListener('mouseenter', () => { this._hoverHighlight(el.dataset.id); if (this._quiet()) this.renderSidebar(el.dataset.id); });
      el.addEventListener('mouseleave', () => { this._hoverClear(); if (this._quiet()) this.renderSidebar(null); });
    });
    this.svg.querySelectorAll('.cluster-hd').forEach(el => {
      el.addEventListener('dblclick', (ev) => { ev.stopPropagation(); this.focusCluster(el.dataset.cluster); });
    });
    this.svg.querySelectorAll('.edge-hit').forEach(el => {
      el.addEventListener('click', (ev) => { ev.stopPropagation(); this.selectEdge(parseInt(el.dataset.i, 10)); });
    });
    this.svg.querySelector('[data-bg]')?.addEventListener('click', () => {
      if (this.routePick) return this._cancelRoutePick();
      if (this.connectFrom) return this._cancelConnect();
      if (this.edgeSel != null) { this.edgeSel = null; this.draw(); this.renderSidebar(null); return; }
      if (this.queryHl) { this.clearQuery(); return; }
      this.select(null);
    });
    this._drawMinimap();
  }

  _edgeTip(e) {
    const KIND_TIP = { critical: 'critical path', api: 'external service call', db: 'data store access', mount: 'entry mounts this', normal: 'import' };
    return `${this._label(e.from)} → ${this._label(e.to)} · ${KIND_TIP[e.kind] || 'import'}${e.ev ? ` · ${e.ev}` : ''} — click for details`;
  }

  selectEdge(i) {
    if (!this.data.edges[i]) return;
    this.selected = null;
    this.edgeSel = i;
    this.draw();
    this._sbEdge(i);
    if (this.sidebar && window.matchMedia('(max-width: 760px)').matches) this.sidebar.classList.add('open');
  }

  _quiet() { return !this.selected && this.edgeSel == null && !this.route && !this.reach && !this.tour && !this.routePick && !this.connectFrom && !this.queryHl; }

  _nodeClicked(id) {
    if (this.connectFrom === 'PENDING') {
      this.connectFrom = id;
      this._status(`Connect: <b>${esc(this._label(id))}</b> → … click the target node — <button data-hud-clear>cancel</button>`, true);
      this.draw();
      return;
    }
    if (this.connectFrom) {
      const from = this.connectFrom;
      this.connectFrom = null;
      this._status('');
      if (from === id) { this.draw(); return; }
      const r = this.applyOps([{ op: 'add_edge', from, to: id, kind: 'normal', label: '' }], 'connect');
      if (r && !r.errors.length) {
        const idx = this.data.edges.findIndex(e => e.from === from && e.to === id);
        if (idx >= 0) this.selectEdge(idx); // open the wire editor to label it
      }
      return;
    }
    if (this.routePick) {
      if (!this.routePick.from) {
        this.routePick.from = id;
        this._status(`Route: <b>${esc(this._label(id))}</b> → … now click the destination file`, true);
        this.draw();
        return;
      }
      const from = this.routePick.from;
      this.routePick = null;
      this.traceRoute(from, id);
      return;
    }
    this.select(id);
  }

  _connectivity() {
    const conn = new Map();
    for (const e of this.data.edges) {
      if (!conn.has(e.from)) conn.set(e.from, new Set());
      if (!conn.has(e.to)) conn.set(e.to, new Set());
      conn.get(e.from).add(e.to);
      conn.get(e.to).add(e.from);
    }
    return conn;
  }

  select(id) {
    this.selected = id;
    this.edgeSel = null;
    if (this.sidebar && window.matchMedia('(max-width: 760px)').matches) {
      this.sidebar.classList.toggle('open', !!id);
    }
    this.draw();
    this.renderSidebar(id);
    this._syncHash();
  }

  // Lightweight hover: emphasize a node's branches without a full re-render.
  _hoverHighlight(id) {
    if (!this._quiet()) return; // an active mode owns the emphasis
    const conn = this._connectivity();
    const near = conn.get(id) || new Set();
    near.add(id);
    this.svg.querySelectorAll('.node').forEach(el => {
      el.style.opacity = near.has(el.dataset.id) ? '1' : '0.16';
    });
    this.svg.querySelectorAll('.edge').forEach(el => {
      const on = el.dataset.from === id || el.dataset.to === id;
      el.style.opacity = on ? '0.95' : '0.05';
      el.style.strokeWidth = on ? '2.6' : '';
    });
  }
  _hoverClear() {
    if (!this._quiet()) return;
    this.svg.querySelectorAll('.node').forEach(el => { el.style.opacity = ''; });
    this.svg.querySelectorAll('.edge').forEach(el => { el.style.opacity = ''; el.style.strokeWidth = ''; });
  }

  // ------------------------------------------------------------ camera

  _applyTransform() {
    const world = this.svg.querySelector('#world');
    if (world) world.setAttribute('transform', `translate(${this.tx},${this.ty}) scale(${this.scale})`);
    this._drawMinimap();
  }

  zoom(factor) {
    const rect = this.svg.getBoundingClientRect();
    const mx = rect.width / 2, my = rect.height / 2;
    const ns = Math.min(3, Math.max(0.12, this.scale * factor));
    this.tx = mx - (mx - this.tx) * (ns / this.scale);
    this.ty = my - (my - this.ty) * (ns / this.scale);
    this.scale = ns;
    this._applyTransform();
  }

  fit() {
    const rect = this.svg.getBoundingClientRect();
    if (!rect.width || !this.worldW) return;
    this.scale = Math.min(rect.width / this.worldW, rect.height / this.worldH, 1.1);
    this.tx = (rect.width - this.worldW * this.scale) / 2;
    this.ty = (rect.height - this.worldH * this.scale) / 2;
    this._applyTransform();
  }

  // Animate the camera to frame a world-space bbox (or jump if reduced motion).
  _flyTo(bbox, maxScale = 1.25) {
    const rect = this.svg.getBoundingClientRect();
    const pad = 70;
    const s = Math.min((rect.width - pad * 2) / bbox.w, (rect.height - pad * 2) / bbox.h, maxScale);
    const tx = rect.width / 2 - (bbox.x + bbox.w / 2) * s;
    const ty = rect.height / 2 - (bbox.y + bbox.h / 2) * s;
    if (REDUCED()) { this.tx = tx; this.ty = ty; this.scale = s; this._applyTransform(); return; }
    const from = { tx: this.tx, ty: this.ty, s: this.scale };
    const t0 = performance.now(), DUR = 420;
    cancelAnimationFrame(this._anim);
    const step = (t) => {
      const k = Math.min(1, (t - t0) / DUR);
      const e = 1 - Math.pow(1 - k, 3); // ease-out cubic
      this.tx = from.tx + (tx - from.tx) * e;
      this.ty = from.ty + (ty - from.ty) * e;
      this.scale = from.s + (s - from.s) * e;
      this._applyTransform();
      if (k < 1) this._anim = requestAnimationFrame(step);
    };
    this._anim = requestAnimationFrame(step);
  }

  _bboxOf(ids) {
    const nodes = this.data.nodes.filter(n => ids.includes(n.id) && n.x != null);
    if (!nodes.length) return { x: 0, y: 0, w: this.worldW, h: this.worldH };
    const x1 = Math.min(...nodes.map(n => n.x)), y1 = Math.min(...nodes.map(n => n.y));
    const x2 = Math.max(...nodes.map(n => n.x + n.w)), y2 = Math.max(...nodes.map(n => n.y + n.h));
    return { x: x1 - 20, y: y1 - 20, w: x2 - x1 + 40, h: y2 - y1 + 40 };
  }

  focusNode(id) {
    const n = this.data.nodes.find(x => x.id === id);
    if (!n) return;
    this._flyTo({ x: n.x - 40, y: n.y - 40, w: n.w + 80, h: n.h + 80 }, Math.min(1.4, Math.max(this.scale, 0.9)));
    this.select(id);
  }

  focusCluster(clusterId) {
    const ids = this.data.nodes.filter(n => n.cluster === clusterId).map(n => n.id);
    if (ids.length) this._flyTo(this._bboxOf(ids));
  }

  // Find the best-matching node by label / path / sub; falls back to the
  // hidden-file inventory and promotes a match onto the map.
  findAndFocus(query) {
    const q = (query || '').trim().toLowerCase();
    if (!q) return false;
    const N = this.data.nodes;
    const hit = N.find(n => (n.label || '').toLowerCase() === q)
      || N.find(n => (n.label || '').toLowerCase().includes(q))
      || N.find(n => (n.path || '').toLowerCase().includes(q))
      || N.find(n => (n.sub || '').toLowerCase().includes(q));
    if (hit) { this.focusNode(hit.id); return true; }
    const inv = this.data.inventory?.files || [];
    const invHit = inv.find(f => f.path.toLowerCase().includes(q));
    if (invHit) {
      const id = this.promoteFile(invHit.path);
      if (id) { this.focusNode(id); this._flash(`Added ${esc(invHit.path.split('/').pop())} to the map (was in the overflow)`); return true; }
    }
    return false;
  }

  // ------------------------------------------------- reach (upstream/downstream)

  _adjacency() {
    const fwd = new Map(), rev = new Map();
    this.data.edges.forEach((e, i) => {
      if (!fwd.has(e.from)) fwd.set(e.from, []);
      if (!rev.has(e.to)) rev.set(e.to, []);
      fwd.get(e.from).push({ to: e.to, i });
      rev.get(e.to).push({ to: e.from, i });
    });
    return { fwd, rev };
  }

  reachCounts(id) {
    const { fwd, rev } = this._adjacency();
    const count = (adj) => {
      const seen = new Set([id]);
      const q = [id];
      while (q.length) {
        for (const { to } of adj.get(q.shift()) || []) if (!seen.has(to)) { seen.add(to); q.push(to); }
      }
      return seen.size - 1;
    };
    return { up: count(rev), down: count(fwd) };
  }

  traceReach(id, dir) {
    const { fwd, rev } = this._adjacency();
    const adj = dir === 'up' ? rev : fwd;
    const seen = new Map([[id, 0]]);
    const edgesOn = new Set();
    const q = [id];
    let maxHops = 0;
    while (q.length) {
      const cur = q.shift();
      for (const { to, i } of adj.get(cur) || []) {
        edgesOn.add(i);
        if (!seen.has(to)) {
          seen.set(to, seen.get(cur) + 1);
          maxHops = Math.max(maxHops, seen.get(to));
          q.push(to);
        }
      }
    }
    seen.delete(id);
    const N = this._nouns();
    if (!seen.size) {
      this._flash(dir === 'up'
        ? `Nothing on the map points at ${esc(this._label(id))}`
        : `${esc(this._label(id))} points at nothing on the map`);
      return;
    }
    this.route = null; this.routePick = null;
    this.reach = { origin: id, dir, nodes: new Set(seen.keys()), hopOf: seen, edges: edgesOn, hops: maxHops, links: edgesOn.size };
    this.selected = id;
    const word = dir === 'up'
      ? (seen.size > 1 ? 'feed' : 'feeds')
      : (seen.size > 1 ? 'are reached from' : 'is reached from');
    this._status(`<b>${seen.size}</b> ${seen.size > 1 ? N.things : N.thing} ${word} <b>${esc(this._label(id))}</b> · ${edgesOn.size} ${edgesOn.size > 1 ? N.wires : N.wire} · ${maxHops} hop${maxHops > 1 ? 's' : ''} — <button data-hud-clear>clear</button>`);
    this.draw();
    this.renderSidebar(id);
    this._flyTo(this._bboxOf([id, ...seen.keys()]));
    this._syncHash();
  }

  // ------------------------------------------------------------ route probe

  startRoutePick(fromId = null) {
    this._clearModes();
    this.routePick = { from: fromId };
    this._status(fromId
      ? `Route: <b>${esc(this._label(fromId))}</b> → … click the destination file — <button data-hud-clear>cancel</button>`
      : `Route: click the <b>origin</b> file, then the destination — <button data-hud-clear>cancel</button>`, true);
    this.draw();
  }

  _cancelRoutePick() {
    this.routePick = null;
    this._status('');
    this.draw();
  }

  traceRoute(fromId, toId) {
    if (fromId === toId) { this._cancelRoutePick(); this.select(fromId); return; }
    const { fwd } = this._adjacency();
    const bfs = (a, b) => {
      const prev = new Map([[a, null]]);
      const prevEdge = new Map();
      const q = [a];
      while (q.length) {
        const cur = q.shift();
        if (cur === b) break;
        for (const { to, i } of fwd.get(cur) || []) {
          if (prev.has(to)) continue;
          prev.set(to, cur); prevEdge.set(to, i);
          q.push(to);
        }
      }
      if (!prev.has(b)) return null;
      const ids = [], edges = new Set();
      for (let cur = b; cur != null; cur = prev.get(cur)) {
        ids.unshift(cur);
        if (prevEdge.has(cur)) edges.add(prevEdge.get(cur));
      }
      return { ids, edges };
    };
    let hit = bfs(fromId, toId), swapped = false;
    if (!hit) { hit = bfs(toId, fromId); swapped = !!hit; }
    if (!hit) {
      this.routePick = null;
      this._status(`No import path between <b>${esc(this._label(fromId))}</b> and <b>${esc(this._label(toId))}</b> in either direction — <button data-hud-clear>ok</button>`);
      this.draw();
      return;
    }
    this.reach = null; this.routePick = null;
    this.route = hit;
    this.selected = null;
    const n = hit.ids.length;
    this._status(`Route ${swapped ? '(reversed — imports flow the other way) ' : ''}<b>${esc(this._label(hit.ids[0]))}</b> → <b>${esc(this._label(hit.ids[n - 1]))}</b> · ${n - 1} hop${n > 2 ? 's' : ''} — <button data-hud-clear>clear</button>`);
    this.draw();
    this.renderSidebar(null);
    this._flyTo(this._bboxOf(hit.ids));
    this._syncHash();
  }

  // ------------------------------------------------------------ guided tour

  buildTour() {
    const d = this.data;
    const nodes = d.nodes.filter(n => !n.aggregate);
    const inDeg = new Map();
    for (const e of d.edges) inDeg.set(e.to, (inDeg.get(e.to) || 0) + 1);
    const chapters = [];
    const s = d.meta?.stats || {};
    const clusterLabels = d.clusters.map(c => c.label);
    chapters.push({
      title: 'The whole map', all: true, ids: nodes.map(n => n.id), fitAll: true,
      body: `${d.meta?.name || 'This codebase'}: ${s.filesScanned || nodes.length} files${s.totalLoc ? `, ${fmtK(s.totalLoc)} lines` : ''}. Read left to right — ${clusterLabels.join(' → ')}. Wires are real imports found in the code, not guesses.`,
    });
    const entries = nodes.filter(n => n.cluster === 'entry');
    if (entries.length) chapters.push({
      title: 'Where execution starts', ids: entries.map(n => n.id),
      body: `${entries.map(n => n.label).join(', ')} ${entries.length > 1 ? 'are the doors into this system' : 'is the door into this system'} — when the app runs, it starts here and everything else is loaded from these files.`,
    });
    const critical = nodes.filter(n => n.critical);
    if (critical.length > 1) chapters.push({
      title: 'The critical path', ids: critical.map(n => n.id),
      body: `The spine of the system (red): ${critical.map(n => n.label).join(' → ')}. Most requests or runs travel this chain — understand it and you understand the app.`,
    });
    const hot = nodes.filter(n => (inDeg.get(n.id) || 0) >= 3)
      .sort((a, b) => (inDeg.get(b.id) || 0) - (inDeg.get(a.id) || 0)).slice(0, 4);
    if (hot.length) chapters.push({
      title: 'The busiest files', ids: hot.map(n => n.id),
      body: `${hot.map(n => `${n.label} (${inDeg.get(n.id)} importers)`).join(', ')} — many files depend on these, so a change here ripples everywhere. Touch with care.`,
    });
    const dataExt = nodes.filter(n => n.cluster === 'data' || n.cluster === 'external');
    if (dataExt.length) chapters.push({
      title: 'State & the outside world', ids: dataExt.map(n => n.id),
      body: `Where information is stored and which outside services are used: ${dataExt.slice(0, 6).map(n => n.label).join(', ')}${dataExt.length > 6 ? '…' : ''}. Amber wires are database traffic, orange are external calls.`,
    });
    const dead = nodes.filter(n => n.dead);
    if (dead.length) chapters.push({
      title: 'Dead code', ids: dead.map(n => n.id),
      body: `${dead.length} file${dead.length > 1 ? 's' : ''} (dashed) export${dead.length > 1 ? '' : 's'} code with zero live callers: ${dead.slice(0, 4).map(n => n.label).join(', ')}${dead.length > 4 ? '…' : ''}. Verify, then delete — less code is less to maintain.`,
    });
    return chapters;
  }

  startTour(idx = 0) {
    this._clearModes();
    const chapters = this.buildTour();
    if (!chapters.length) return;
    this.tour = { chapters, idx: Math.min(idx, chapters.length - 1) };
    this._dismissHint();
    this._showChapter();
  }

  _showChapter() {
    const t = this.tour;
    if (!t) return;
    const ch = t.chapters[t.idx];
    this.selected = null;
    if (this._hud.minimap) this._hud.minimap.style.visibility = 'hidden'; // presentation focus
    this.draw();
    if (ch.fitAll) this.fit();
    else this._flyTo(this._bboxOf(ch.ids));
    const bar = this._hud.tour;
    bar.hidden = false;
    bar.innerHTML = `
      <button data-tour-prev ${t.idx === 0 ? 'disabled' : ''} aria-label="Previous chapter">Back</button>
      <div class="tour-body">
        <div class="tour-head"><span class="tour-step">${t.idx + 1}/${t.chapters.length}</span> <b>${esc(ch.title)}</b></div>
        <p>${esc(ch.body)}</p>
      </div>
      ${t.idx === t.chapters.length - 1
        ? '<button data-tour-close class="tour-done" aria-label="Finish tour">Done</button>'
        : '<button data-tour-next aria-label="Next chapter">Next</button>'}
      <button data-tour-close class="tour-x" aria-label="Exit tour">✕</button>`;
    bar.querySelector('[data-tour-prev]')?.addEventListener('click', () => this.tourStep(-1));
    bar.querySelector('[data-tour-next]')?.addEventListener('click', () => this.tourStep(1));
    bar.querySelectorAll('[data-tour-close]').forEach(b => b.addEventListener('click', () => this._stopTour()));
    this._syncHash();
  }

  tourStep(delta) {
    if (!this.tour) return;
    const next = this.tour.idx + delta;
    if (next < 0 || next >= this.tour.chapters.length) return;
    this.tour.idx = next;
    this._showChapter();
  }

  _stopTour(silent = false) {
    if (!this.tour) return;
    this.tour = null;
    if (this._hud.tour) this._hud.tour.hidden = true;
    if (this._hud.minimap) this._hud.minimap.style.visibility = '';
    if (!silent) { this.draw(); this.fit(); this._syncHash(); }
  }

  // ------------------------------------------------ critical-path trace motion

  playTrace() {
    const edges = this.data.edges;
    const chain = [];
    const critEdges = edges.map((e, i) => ({ e, i })).filter(x => x.e.kind === 'critical');
    if (!critEdges.length) { this._flash('No critical path on this map'); return; }
    // order the chain: start from the edge whose source is no other critical edge's target
    const targets = new Set(critEdges.map(x => x.e.to));
    let cur = critEdges.find(x => !targets.has(x.e.from)) || critEdges[0];
    const remaining = new Set(critEdges);
    while (cur) {
      chain.push(cur); remaining.delete(cur);
      cur = [...remaining].find(x => x.e.from === chain[chain.length - 1].e.to);
    }
    if (REDUCED()) { this._flash('Critical path highlighted (motion off)'); return; }
    const per = Math.min(340, 2800 / chain.length);
    chain.forEach((x, idx) => {
      const el = this.svg.querySelector(`.edge[data-i="${x.i}"]`);
      if (!el) return;
      const len = el.getTotalLength();
      el.style.transition = 'none';
      el.style.strokeDasharray = `${len}`;
      el.style.strokeDashoffset = `${len}`;
      setTimeout(() => {
        el.style.transition = `stroke-dashoffset ${per}ms linear`;
        el.style.strokeDashoffset = '0';
      }, idx * per + 30);
    });
    setTimeout(() => {
      chain.forEach(x => {
        const el = this.svg.querySelector(`.edge[data-i="${x.i}"]`);
        if (el) { el.style.transition = ''; el.style.strokeDasharray = ''; el.style.strokeDashoffset = ''; }
      });
    }, chain.length * per + 700);
  }

  // -------------------------------------------------- aggregate expansion

  // Add one hidden inventory file onto the map as a real node. Returns its id.
  promoteFile(path, batch = false) {
    const inv = this.data.inventory;
    if (!inv) return null;
    const idx = inv.files.findIndex(f => f.path === path);
    if (idx === -1) return null;
    const f = inv.files.splice(idx, 1)[0];
    const id = 'f:' + f.path;
    if (this.data.nodes.some(n => n.id === id)) return id;
    const cluster = this.data.clusters.find(c => c.id === f.cluster) || this.data.clusters[0];
    const node = {
      id, cluster: f.cluster, label: f.path.split('/').pop(),
      sub: f.dead ? 'DEAD · zero callers' : f.path.split('/').slice(0, -1).join('/') || '(root)',
      color: cluster.color, path: f.path,
      role: `${f.loc}-line file, expanded from the “more files” group.`,
      plain: '', notes: [`${f.loc} lines`, `${f.degree} internal reference${f.degree === 1 ? '' : 's'}`],
      tag: ['all'], dead: !!f.dead, loc: f.loc,
    };
    const aggIdx = this.data.nodes.findIndex(n => n.id === 'more:' + f.cluster);
    if (aggIdx >= 0) this.data.nodes.splice(aggIdx, 0, node);
    else this.data.nodes.push(node);
    // wire it up from the full-edge inventory ([from, to, line?])
    const have = new Set(this.data.edges.map(e => e.from + '→' + e.to));
    const visible = new Set(this.data.nodes.map(n => n.id));
    for (const [a, b, line] of inv.edges) {
      if (a !== f.path && b !== f.path) continue;
      const from = 'f:' + a, to = 'f:' + b;
      if (!visible.has(from) || !visible.has(to) || from === to) continue;
      const k = from + '→' + to;
      if (have.has(k)) continue;
      have.add(k);
      const edge = { from, to, kind: 'normal', label: 'import', tag: ['all'] };
      if (line) edge.ev = `${a}:${line}`;
      this.data.edges.push(edge);
    }
    // shrink or remove the aggregate node
    const agg = this.data.nodes.find(n => n.id === 'more:' + f.cluster);
    if (agg) {
      const left = inv.files.filter(x => x.cluster === f.cluster).length;
      if (left <= 0) this.data.nodes = this.data.nodes.filter(n => n.id !== agg.id);
      else { agg.label = `+${left} more files`; agg.role = `${left} additional ${f.cluster} files with low connectivity.`; }
    }
    if (!batch) { this.layout(); this.draw(); }
    return id;
  }

  expandCluster(clusterId) {
    const inv = this.data.inventory;
    if (!inv) return;
    const paths = inv.files.filter(f => f.cluster === clusterId).map(f => f.path);
    for (const p of paths) this.promoteFile(p, true);
    this.layout();
    this.draw();
    this.focusCluster(clusterId);
    this._flash(`Expanded ${paths.length} file${paths.length === 1 ? '' : 's'} — the map now shows every analyzed ${clusterId} file`);
  }

  // ------------------------------------------------------------ edit mode

  setEditMode(on) {
    this.editMode = !!on;
    this.connectFrom = null;
    if (this._hud.edit) {
      this._hud.edit.hidden = !this.editMode;
      const inst = this._hud.edit.querySelector('[data-instruct-wrap]');
      if (inst) inst.hidden = !this.oninstruct;
    }
    if (this.editMode) this._flash('Edit mode — drag nodes · click a node or wire to edit it');
    else this._status('');
    this.draw();
    this.renderSidebar(this.selected);
  }

  _pushHistory() {
    const strip = { ...this.data };
    this._history.push(JSON.stringify(strip));
    if (this._history.length > 30) this._history.shift();
  }

  undo() {
    if (!this._history.length) { this._flash('Nothing to undo'); return; }
    const snap = JSON.parse(this._history.pop());
    const sel = this.selected;
    // restore IN PLACE so external references to the data object stay valid
    for (const k of Object.keys(this.data)) delete this.data[k];
    Object.assign(this.data, snap);
    this.edgeSel = null;
    this.layout();
    this.renderChips();
    this.draw();
    this.renderSidebar(this.data.nodes.some(n => n.id === sel) ? sel : null);
    this._flash('Undone');
    this.onchange?.();
  }

  // Every structural change flows through the validated patch engine —
  // manual edits and natural-language edits use the exact same checked path.
  applyOps(ops, label = 'edit') {
    if (!this.helpers.applyPatch) { this._flash('Editing is not available in this view'); return null; }
    this._pushHistory();
    const r = this.helpers.applyPatch(this.data, ops);
    if (!r.applied.length) {
      this._history.pop(); // nothing changed — drop the snapshot
      if (r.errors.length) this._flash(`Not applied: ${esc(r.errors[0])}`);
      return r;
    }
    this.data.meta = this.data.meta || {};
    if (this.data.meta.source !== 'design') this.data.meta.edited = true;
    this.layout();
    this.renderChips();
    this.draw();
    const msg = r.applied.length === 1 ? r.applied[0] : `${r.applied.length} changes applied`;
    this._flash(`${esc(msg)}${r.errors.length ? ` · ${r.errors.length} op(s) rejected` : ''}`);
    this.onchange?.();
    return r;
  }

  addNodeInteractive() {
    const r = this.applyOps([{ op: 'add_node', node: { label: 'New component', cluster: 'services', role: '', plain: '' } }], 'add');
    if (!r || !r.applied.length) return;
    const n = this.data.nodes[this.data.nodes.length - 1];
    this.focusNode(n.id); // opens the inspector for immediate renaming
  }

  startConnect(fromId = null) {
    const from = fromId || this.selected;
    if (!from) {
      this._status('Connect: click the <b>source</b> node first, then the target — <button data-hud-clear>cancel</button>', true);
      this.routePick = null;
      this.connectFrom = 'PENDING';
      return;
    }
    this.connectFrom = from;
    this._status(`Connect: <b>${esc(this._label(from))}</b> → … click the target node — <button data-hud-clear>cancel</button>`, true);
    this.draw();
  }

  _cancelConnect() {
    this.connectFrom = null;
    this._status('');
    this.draw();
  }

  // ------------------------------------------------------------ query answers

  // Runs a structured query op (from js/query.js) and shows the computed
  // answer. Every fact in the answer card exists in the graph.
  runOp(op) {
    if (!this.helpers.runQuery) return false;
    const res = this.helpers.runQuery(op, this.data);
    const ap = res.apply;
    if (ap?.type === 'reach') { this.traceReach(ap.id, ap.dir); return true; }
    if (ap?.type === 'route') { this.traceRoute(ap.from, ap.to); return true; }
    if (ap?.type === 'focus') { this.focusNode(ap.id); return true; }
    this._clearModes();
    if (ap?.type === 'highlight') {
      this.queryHl = { ids: new Set(ap.ids), edgeIdxs: new Set(ap.edgeIdxs || []) };
      this.selected = null;
      this.draw();
      this._flyTo(this._bboxOf(ap.ids));
    }
    this._sbAnswer(res);
    return true;
  }

  // Parse-and-run a plain-language question. Returns false when the local
  // parser can't understand it (caller may fall back to search or AI).
  ask(text) {
    if (!this.helpers.parseQuery) return false;
    const op = this.helpers.parseQuery(text);
    if (!op) return false;
    return this.runOp(op);
  }

  clearQuery() {
    this.queryHl = null;
    this.draw();
    this.renderSidebar(this.selected);
  }

  _sbAnswer(res) {
    if (!this.sidebar) return;
    const items = (res.items || []).slice(0, 24).map(i =>
      `<li>${i.id ? `<button class="mini-chip" data-goto="${esc(i.id)}">${esc(i.label)}</button>` : esc(i.label)}${i.note ? ` <span class="meta">${esc(i.note)}</span>` : ''}</li>`).join('');
    this.sidebar.innerHTML = `
      <h2>${esc(res.title)}</h2>
      ${res.summary ? `<p>${esc(res.summary)}</p>` : ''}
      ${items ? `<ul class="answer-list">${items}</ul>` : ''}
      ${(res.items || []).length > 24 ? `<p class="meta">+${res.items.length - 24} more</p>` : ''}
      <div class="sb-actions"><button data-act="clear-query" class="sb-btn">Clear answer</button></div>
      <p class="meta">${res.miss ? 'Nothing was invented to fill the gap.' : 'Computed from the map graph — every item is verifiable on the canvas.'}</p>`;
    if (this.sidebar && window.matchMedia('(max-width: 760px)').matches) this.sidebar.classList.add('open');
  }

  // ------------------------------------------------------------ chips

  renderChips() {
    if (!this.chips) return;
    const tags = this.data.tags || ['all'];
    let html = `<button class="chip ${this.activeTag === 'all' && !this.showAllWires ? 'active' : ''}" data-tag="all">Overview</button>`;
    for (const t of tags.filter(t => t !== 'all')) {
      html += `<button class="chip ${this.activeTag === t ? 'active' : ''}" data-tag="${esc(t)}">${esc(t)}</button>`;
    }
    html += `<button class="chip ${this.showAllWires ? 'active' : ''}" data-wires="1" title="Show every import, not just the important wires">All wires</button>`;
    const hasDebug = Object.keys(this.data.fixes || {}).length || Object.keys(this.data.bugs || {}).length;
    if (hasDebug) {
      html += `<button class="chip debug-chip ${this.debugMode ? 'active' : ''}" data-debug="1">Bugs &amp; repairs</button>`;
    } else {
      this.debugMode = false;
    }
    this.chips.innerHTML = html;
    this.chips.querySelectorAll('.chip').forEach(el => el.addEventListener('click', () => {
      if (el.dataset.wires) { this.showAllWires = !this.showAllWires; }
      else if (el.dataset.debug) { this.debugMode = !this.debugMode; }
      else { this.activeTag = el.dataset.tag; }
      this.renderChips(); this.draw();
    }));
  }

  // ---------------------------------------------------------- sidebar

  _label(id) {
    return this.data.nodes.find(n => n.id === id)?.label || id.replace(/^f:/, '').split('/').pop();
  }

  // designed maps talk about components & wires; analyzed maps about files & imports
  _nouns() {
    return this.data?.meta?.source === 'design'
      ? { thing: 'component', things: 'components', wire: 'wire', wires: 'wires' }
      : { thing: 'file', things: 'files', wire: 'import', wires: 'imports' };
  }

  _bindSidebar() {
    if (!this.sidebar) return;
    this.sidebar.addEventListener('click', (e) => {
      const t = e.target.closest('[data-goto],[data-act]');
      if (!t) return;
      if (t.dataset.goto) { this.edgeSel = null; this.focusNode(t.dataset.goto); return; }
      const act = t.dataset.act;
      if (act === 'tour') this.startTour();
      else if (act === 'help') this.toggleHelp();
      else if (act === 'route') this.startRoutePick(t.dataset.from || null);
      else if (act === 'reach-up') this.traceReach(t.dataset.id, 'up');
      else if (act === 'reach-down') this.traceReach(t.dataset.id, 'down');
      else if (act === 'copy-link') this._copyLink();
      else if (act === 'promote') { const id = this.promoteFile(t.dataset.path); if (id) this.focusNode(id); }
      else if (act === 'expand-cluster') this.expandCluster(t.dataset.cluster);
      else if (act === 'clear') { this._clearModes(); this.draw(); this.renderSidebar(this.selected); }
      else if (act === 'clear-query') this.clearQuery();
      else if (act === 'trace') this.playTrace();
      else if (act === 'connect') this.startConnect(t.dataset.from);
      else if (act === 'node-apply') this._inspectorApply(t.dataset.id);
      else if (act === 'node-delete') {
        const id = t.dataset.id;
        this.applyOps([{ op: 'remove_node', id }], 'delete');
        this.select(null);
      }
      else if (act === 'edge-apply') {
        const edge = this.data.edges[parseInt(t.dataset.i, 10)];
        if (!edge) return;
        this.applyOps([{ op: 'update_edge', from: edge.from, to: edge.to, set: {
          label: this.sidebar.querySelector('#ins-e-label')?.value || '',
          kind: this.sidebar.querySelector('#ins-e-kind')?.value || 'normal',
        } }], 'edge');
        this._sbEdge(this.edgeSel);
      }
      else if (act === 'edge-reverse') {
        const edge = this.data.edges[parseInt(t.dataset.i, 10)];
        if (!edge) return;
        const { from, to, kind, label } = edge;
        const r = this.applyOps([
          { op: 'remove_edge', from, to },
          { op: 'add_edge', from: to, to: from, kind, label },
        ], 'reverse');
        if (r && r.applied.length) {
          this.edgeSel = this.data.edges.findIndex(e2 => e2.from === to && e2.to === from);
          this.draw();
          this._sbEdge(this.edgeSel);
        }
      }
      else if (act === 'edge-delete') {
        const edge = this.data.edges[parseInt(t.dataset.i, 10)];
        if (!edge) return;
        this.edgeSel = null;
        this.applyOps([{ op: 'remove_edge', from: edge.from, to: edge.to }], 'delete');
        this.renderSidebar(null);
      }
    });
  }

  _inspectorApply(id) {
    const q = (sel) => this.sidebar.querySelector(sel);
    const notes = (q('#ins-notes')?.value || '').split('\n').map(s => s.trim()).filter(Boolean);
    const tag = (q('#ins-tags')?.value || '').split(',').map(s => s.trim()).filter(Boolean);
    this.applyOps([{ op: 'update_node', id, set: {
      label: q('#ins-label')?.value || '',
      cluster: q('#ins-cluster')?.value,
      role: q('#ins-role')?.value || '',
      plain: q('#ins-plain')?.value || '',
      notes, tag,
      critical: !!q('#ins-critical')?.checked,
    } }], 'update');
    this.renderSidebar(id);
  }

  renderSidebar(id) {
    if (!this.sidebar) return;
    const d = this.data;
    if (this.edgeSel != null && !id) return this._sbEdge(this.edgeSel);
    if (this.route) return this._sbRoute();
    if (!id && this.reach) id = this.reach.origin;
    if (!id) return this._sbOverview();
    const n = d.nodes.find(n => n.id === id);
    if (!n) return this._sbOverview();
    if (n.aggregate) return this._sbAggregate(n);
    if (this.editMode) return this._sbNodeEdit(n);
    this._sbNode(n);
  }

  // ------------------------------------------------------- edge detail panel

  _sbEdge(i) {
    const d = this.data;
    const e = d.edges[i];
    if (!e) return this._sbOverview();
    const KIND_MEANING = {
      critical: 'Critical path — part of the spine most requests travel.',
      api: 'Call to an external service outside this codebase.',
      db: 'Read/write access to a data store.',
      mount: 'An entry point loading/mounting this module.',
      normal: 'A plain import: the source file uses code from the target.',
    };
    let evHtml = '';
    if (e.ev) {
      const [file, line] = splitEv(e.ev);
      const gh = d.meta?.source === 'github' && d.meta.url
        ? `${d.meta.url}/blob/${d.meta.ref || 'HEAD'}/${file}#L${line}` : null;
      evHtml = `<h3>Evidence</h3>
        <p class="meta">This wire exists because of the import at:</p>
        <p class="path">${esc(e.ev)}${gh ? ` <a href="${esc(gh)}" target="_blank" rel="noopener">open line ↗</a>` : ''}</p>
        ${e.spec ? `<p class="meta mono">imports <code>${esc(e.spec)}</code></p>` : ''}`;
    } else if (d.meta?.source === 'design') {
      evHtml = `<p class="meta">A designed relationship — part of the proposed architecture, not analyzed code.</p>`;
    }
    const editForm = this.editMode && this.helpers.applyPatch ? `
      <h3>Edit wire</h3>
      <label class="ins-label">What flows <input id="ins-e-label" type="text" value="${esc(e.label || '')}" placeholder="e.g. HTTPS · DB write · charge card"></label>
      <label class="ins-label">Kind <select id="ins-e-kind">${['normal', 'critical', 'api', 'db', 'mount'].map(k => `<option value="${k}" ${e.kind === k ? 'selected' : ''}>${k}</option>`).join('')}</select></label>
      <div class="sb-actions">
        <button data-act="edge-apply" data-i="${i}" class="sb-btn primary">Apply</button>
        <button data-act="edge-reverse" data-i="${i}" class="sb-btn">Reverse</button>
        <button data-act="edge-delete" data-i="${i}" class="sb-btn danger">Delete wire</button>
      </div>` : '';
    this.sidebar.innerHTML = `
      <h2>Wire</h2>
      <div class="chip-list">
        <button class="mini-chip" data-goto="${esc(e.from)}">${esc(this._label(e.from))}</button>
        <span class="meta">→</span>
        <button class="mini-chip" data-goto="${esc(e.to)}">${esc(this._label(e.to))}</button>
      </div>
      ${e.label && e.label !== 'import' ? `<p><b>${esc(e.label)}</b></p>` : ''}
      <p class="meta">${esc(KIND_MEANING[e.kind] || KIND_MEANING.normal)}</p>
      ${e.cycle ? `<p class="meta" style="color:var(--critical)">Part of a circular import — these files depend on each other.</p>` : ''}
      ${evHtml}
      ${editForm}`;
  }

  // ------------------------------------------------------ node inspector (edit)

  _sbNodeEdit(n) {
    const CLUSTERS = ['client', 'entry', 'routes', 'services', 'data', 'external', 'tests'];
    const tags = (n.tag || []).filter(t => t !== 'all').join(', ');
    this.sidebar.innerHTML = `
      <h2>Edit — ${esc(n.label)}</h2>
      <p class="meta">${esc(n.id)}</p>
      <label class="ins-label">Name <input id="ins-label" type="text" value="${esc(n.label)}"></label>
      <label class="ins-label">Layer <select id="ins-cluster">${CLUSTERS.map(c => `<option value="${c}" ${n.cluster === c ? 'selected' : ''}>${esc(CLUSTER_LABELS[c] || c)}</option>`).join('')}</select></label>
      <label class="ins-label">What it does (technical) <textarea id="ins-role" rows="2">${esc(n.role || '')}</textarea></label>
      <label class="ins-label">In plain English <textarea id="ins-plain" rows="2">${esc(n.plain || '')}</textarea></label>
      <label class="ins-label">Notes (one per line) <textarea id="ins-notes" rows="2">${esc((n.notes || []).join('\n'))}</textarea></label>
      <label class="ins-label">Feature tags (comma-separated) <input id="ins-tags" type="text" value="${esc(tags)}" placeholder="auth, payments"></label>
      <label class="ins-check"><input id="ins-critical" type="checkbox" ${n.critical ? 'checked' : ''}> On the critical path</label>
      <div class="sb-actions">
        <button data-act="node-apply" data-id="${esc(n.id)}" class="sb-btn primary">Apply</button>
        <button data-act="connect" data-from="${esc(n.id)}" class="sb-btn">Connect from here</button>
        <button data-act="node-delete" data-id="${esc(n.id)}" class="sb-btn danger">Delete</button>
      </div>
      <p class="meta">Drag the node on the canvas to move it. Wires update live; click a wire to edit or delete it.</p>`;
  }

  _sbOverview() {
    const d = this.data;
    const s = d.meta?.stats || {};
    const isDesign = d.meta?.source === 'design';
    const langs = s.languages ? Object.entries(s.languages).sort((a, b) => b[1] - a[1]).map(([l, c]) => `${LANG_NAMES[l] || l} (${c})`).join(', ') : '';
    const check = this.helpers.selfCheckLine ? this.helpers.selfCheckLine(d) : null;
    this.sidebar.innerHTML = `
      <h2>${esc(d.meta?.name || 'Map')}</h2>
      <p class="meta">${esc(d.meta?.source || '')}${s.filesScanned ? ` · ${s.filesScanned} files` : ''}${s.totalLoc ? ` · ${fmtK(s.totalLoc)} lines` : ''} · ${d.nodes.length} nodes · ${d.edges.length} wires</p>
      ${langs ? `<p class="meta">${esc(langs)}</p>` : ''}
      ${isDesign ? '<p class="meta design-badge">Proposed design — a starting blueprint to edit, not analyzed code</p>' : ''}
      ${d.meta?.edited ? '<p class="meta design-badge">Manually edited — some nodes/wires were changed by hand</p>' : ''}
      ${d.ai?.enriched ? '<p class="meta ai-badge">AI-enriched</p>' : ''}
      ${check ? `<p class="meta selfcheck ${check.ok ? 'ok' : 'bad'}">${check.ok ? '✓' : '✗'} self-check: ${esc(check.text)}</p>` : ''}
      <div class="sb-actions">
        <button data-act="tour" class="sb-btn primary">Guided tour</button>
        <button data-act="route" class="sb-btn">Trace a route</button>
        <button data-act="help" class="sb-btn">Shortcuts</button>
      </div>
      <h3>${isDesign ? 'Design decisions & assumptions' : 'Findings'}</h3>
      <ul>${(d.findings || []).map(f => `<li>${esc(f)}</li>`).join('')}</ul>
      ${d.ai?.overview ? `<h3>Plain-English overview</h3><p>${esc(d.ai.overview)}</p>` : ''}
      <h3>Ask the map</h3>
      <p class="meta">Type a question in the top bar: <i>who imports app.js</i> · <i>path from index to db</i> · <i>dead code</i> · <i>circular imports</i> · <i>biggest files</i>. Answers are computed from the graph, never generated.</p>
      <h3>Legend</h3>
      <ul class="legend">
        <li>${lgLine('var(--critical)')} critical path</li>
        <li>${lgLine('var(--db)')} database</li>
        <li>${lgLine('var(--accent-2)')} external API</li>
        <li>${lgLine('var(--client)')} entry → mount</li>
        <li>${lgLine('var(--edge-normal)')} import (chip: “All wires”)</li>
        <li>${lgLine('var(--edge-normal)', true)} circular import</li>
        <li>${lgNode()} dashed node = dead code</li>
        <li>${lgDot('var(--critical)')} open bugs · ${lgDot('var(--route)')} planned repairs</li>
      </ul>
      <p class="meta">Hover a file to spotlight its wires · click to pin · click any wire for its evidence · double-click to zoom · <kbd>?</kbd> for all shortcuts.</p>`;
  }

  _sbNode(n) {
    const d = this.data;
    const id = n.id;
    const inc = d.edges.filter(e => e.to === id).map(e => d.nodes.find(x => x.id === e.from)).filter(Boolean);
    const out = d.edges.filter(e => e.from === id).map(e => d.nodes.find(x => x.id === e.to)).filter(Boolean);
    const fixes = d.fixes?.[id] || [], bugs = d.bugs?.[id] || [];
    const rc = this.reachCounts(id);
    const srcLink = d.meta?.source === 'github' && d.meta.url && n.path && !id.startsWith('ext:')
      ? `${d.meta.url}/blob/${d.meta.ref || 'HEAD'}/${n.path.replace(/:\d+$/, '')}` : null;
    const reach = this.reach && this.reach.origin === id ? this.reach : null;
    const chipList = (arr) => arr.slice(0, 12).map(x => `<button class="mini-chip" data-goto="${esc(x.id)}">${esc(x.label)}</button>`).join('') + (arr.length > 12 ? `<span class="meta"> +${arr.length - 12} more</span>` : '');
    this.sidebar.innerHTML = `
      <h2>${esc(n.label)} ${n.critical ? '<span class="crit-tag">critical path</span>' : ''}${n.dead ? '<span class="dead-tag">dead code</span>' : ''}</h2>
      ${n.path ? `<p class="path">${esc(n.path)}${srcLink ? ` <a href="${esc(srcLink)}" target="_blank" rel="noopener" title="Open source on GitHub">view source ↗</a>` : ''}</p>` : ''}
      <p class="meta">${esc(CLUSTER_LABELS[n.cluster] || n.cluster)}${n.loc ? ` · ${n.loc} lines` : ''} · ${inc.length} in / ${out.length} out</p>
      <div class="sb-actions">
        <button data-act="reach-up" data-id="${esc(id)}" class="sb-btn up" ${rc.up ? '' : 'disabled'} title="Everything that imports this file, directly or indirectly">Upstream · ${rc.up}</button>
        <button data-act="reach-down" data-id="${esc(id)}" class="sb-btn down" ${rc.down ? '' : 'disabled'} title="Everything this file reaches, directly or indirectly">Downstream · ${rc.down}</button>
        <button data-act="route" data-from="${esc(id)}" class="sb-btn" title="Shortest import path from this file to any other">Route from here</button>
        <button data-act="copy-link" class="sb-btn" title="Copy a link that reopens the map focused here">Copy link</button>
      </div>
      ${reach ? `<div class="receipt">${reach.dir === 'up' ? 'Upstream' : 'Downstream'}: <b>${reach.nodes.size}</b> ${this._nouns().things} · ${reach.links} ${this._nouns().wires} · ${reach.hops} hop${reach.hops > 1 ? 's' : ''} <button data-act="clear" class="mini-chip">clear</button></div>${this._reachList(reach)}` : ''}
      ${bugs.length ? `<h3>Known bugs</h3><ul class="buglist">${bugs.map(b => `
        <li class="bug">
          <div class="bugline"><span class="sev sev-${esc(String(b.sev || 'bug').toLowerCase())}">${esc(b.sev || 'BUG')}</span>${b.ref ? `<span class="ref">${esc(b.ref)}</span>` : ''}<span class="bugtext">${esc(b.t)}</span></div>
          ${(b.ev && b.ev.length) ? `<div class="ev">${b.ev.map(e => `<code>${esc(e)}</code>`).join(' ')}</div>` : ''}
          ${b.warn ? `<div class="warn">⚠️ ${esc(b.warn)}</div>` : ''}
        </li>`).join('')}</ul>` : ''}
      ${fixes.length ? `<h3>Planned fixes</h3><ol class="fixlist">${fixes.map(f => `<li>${esc(f.t)}</li>`).join('')}</ol>` : ''}
      ${n.role ? `<h3>What it does</h3><p>${esc(n.role)}</p>` : ''}
      ${n.plain ? `<h3>In plain English</h3><p>${esc(n.plain)}</p>` : ''}
      ${(n.notes || []).length ? `<h3>Notes</h3><ul>${n.notes.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
      ${(n.routes || []).length ? `<h3>HTTP routes</h3><ul>${n.routes.map(r => `<li><code>${esc(r)}</code></li>`).join('')}</ul>` : ''}
      ${(n.exports || []).length ? `<h3>Exports</h3><p class="meta mono">${n.exports.slice(0, 10).map(esc).join(', ')}${n.exports.length > 10 ? '…' : ''}</p>` : ''}
      ${inc.length ? `<h3>What feeds it (${inc.length})</h3><div class="chip-list">${chipList(inc)}</div>` : ''}
      ${out.length ? `<h3>Depends on (${out.length})</h3><div class="chip-list">${chipList(out)}</div>` : ''}`;
  }

  _reachList(reach) {
    const byHop = new Map();
    for (const [id, hop] of reach.hopOf) {
      if (!byHop.has(hop)) byHop.set(hop, []);
      byHop.get(hop).push(id);
    }
    let html = '';
    for (const hop of [...byHop.keys()].sort((a, b) => a - b)) {
      const ids = byHop.get(hop);
      html += `<h3>${hop} hop${hop > 1 ? 's' : ''} ${reach.dir === 'up' ? 'up' : 'away'}</h3><div class="chip-list">${ids.slice(0, 14).map(x => `<button class="mini-chip" data-goto="${esc(x)}">${esc(this._label(x))}</button>`).join('')}${ids.length > 14 ? `<span class="meta"> +${ids.length - 14} more</span>` : ''}</div>`;
    }
    return html;
  }

  _sbRoute() {
    const r = this.route;
    const steps = r.ids.map((id, i) => {
      const n = this.data.nodes.find(x => x.id === id);
      return `<li><button class="mini-chip" data-goto="${esc(id)}">${esc(n?.label || id)}</button>${n?.path ? ` <span class="meta">${esc(n.path)}</span>` : ''}</li>`;
    }).join('');
    const N = this._nouns();
    this.sidebar.innerHTML = `
      <h2>Route</h2>
      <p class="meta">The shortest chain of ${N.wires} from <b>${esc(this._label(r.ids[0]))}</b> to <b>${esc(this._label(r.ids[r.ids.length - 1]))}</b>.</p>
      <div class="receipt">${r.ids.length} ${N.things} · ${r.ids.length - 1} hop${r.ids.length > 2 ? 's' : ''} <button data-act="clear" class="mini-chip">clear</button></div>
      <h3>The journey</h3>
      <ol class="fixlist route-steps">${steps}</ol>
      <p class="meta">${this.data.meta?.source === 'design' ? 'Every step is an authored wire on this design. Other paths may exist — this is the shortest.' : 'Every step is an import statement that exists in the code. Other paths may exist — this is the shortest.'}</p>`;
  }

  _sbAggregate(n) {
    const inv = this.data.inventory;
    const files = inv ? inv.files.filter(f => f.cluster === n.cluster).sort((a, b) => b.degree - a.degree) : [];
    const rows = files.slice(0, 120).map(f => `
      <li class="inv-row">
        <button class="mini-chip" data-act="promote" data-path="${esc(f.path)}" title="Add this file to the map">Add</button>
        <span class="inv-path${f.dead ? ' dead' : ''}">${esc(f.path)}</span>
        <span class="meta">${f.loc}L · ${f.degree}°</span>
      </li>`).join('');
    this.sidebar.innerHTML = `
      <h2>${esc(n.label)}</h2>
      <p class="meta">${esc(CLUSTER_LABELS[n.cluster] || n.cluster)} — lower-traffic files kept off the map for readability. Nothing is hidden from the analysis: they are all listed here.</p>
      ${files.length ? `<div class="sb-actions"><button data-act="expand-cluster" data-cluster="${esc(n.cluster)}" class="sb-btn primary">Expand all ${files.length} onto the map</button></div>
      <h3>Files (${files.length})</h3>
      <ul class="inv-list">${rows}</ul>${files.length > 120 ? `<p class="meta">+${files.length - 120} more — use search to find any of them.</p>` : ''}`
      : '<p class="meta">This map was generated without a file inventory — regenerate it on the ArchMap site to expand aggregates.</p>'}`;
  }

  // ------------------------------------------------------------ HUD

  _buildHud() {
    const host = this.svg.parentElement;
    if (!host) { this._hud = {}; return; }
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    const mk = (id, cls, html = '') => {
      let el = host.querySelector('#' + id);
      if (!el) {
        el = document.createElement('div');
        el.id = id; el.className = cls; el.hidden = true;
        el.innerHTML = html;
        host.appendChild(el);
      }
      return el;
    };
    this._hud = {
      status: mk('hud-status', 'hud-status'),
      tour: mk('hud-tour', 'hud-tour'),
      hint: mk('hud-hint', 'hud-hint'),
      help: mk('hud-help', 'hud-help'),
      minimap: mk('hud-minimap', 'hud-minimap', '<canvas width="200" height="132"></canvas>'),
      edit: mk('hud-edit', 'hud-edit', `
        <button data-ed="add" title="Add a component">Add node</button>
        <button data-ed="connect" title="Draw a wire between two components">Connect</button>
        <button data-ed="undo" title="Undo (Ctrl/Cmd+Z)">Undo</button>
        <span data-instruct-wrap class="instruct-wrap" hidden>
          <input data-instruct type="text" placeholder="Tell the map what to change… e.g. add a Redis cache" aria-label="Describe a change">
        </span>`),
    };
    this._hud.status.addEventListener('click', (e) => {
      if (e.target.closest('[data-hud-clear]')) { this._clearModes(); this.draw(); this.renderSidebar(this.selected); }
    });
    this._hud.edit.addEventListener('click', (e) => {
      const b = e.target.closest('[data-ed]');
      if (!b) return;
      if (b.dataset.ed === 'add') this.addNodeInteractive();
      else if (b.dataset.ed === 'connect') this.startConnect(this.selected);
      else if (b.dataset.ed === 'undo') this.undo();
    });
    this._hud.edit.querySelector('[data-instruct]').addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const text = e.target.value.trim();
      if (text && this.oninstruct) { this.oninstruct(text); e.target.value = ''; }
    });
    if (this.sidebar && !host.querySelector('.sidebar-toggle')) {
      const tog = document.createElement('button');
      tog.className = 'sidebar-toggle';
      tog.textContent = 'Details';
      tog.addEventListener('click', () => this.sidebar.classList.toggle('open'));
      host.appendChild(tog);
    }
    this._buildHelp();
    this._bindMinimap();
    try { if (localStorage.getItem('archmap.minimap') === '0') this._hud.minimap.hidden = true; else this._hud.minimap.hidden = false; }
    catch { this._hud.minimap.hidden = false; }
  }

  _status(html, sticky = false) {
    const el = this._hud.status;
    if (!el) return;
    if (!html) { el.hidden = true; return; }
    el.innerHTML = html;
    el.hidden = false;
    clearTimeout(this._statusTimer);
    if (!sticky && !html.includes('data-hud-clear')) {
      this._statusTimer = setTimeout(() => { el.hidden = true; }, 5000);
    }
  }

  _flash(html) {
    this._status(html);
    clearTimeout(this._statusTimer);
    this._statusTimer = setTimeout(() => { this._hud.status.hidden = true; }, 3500);
  }

  _clearModes() {
    this.route = null; this.reach = null; this.routePick = null;
    this.queryHl = null; this.connectFrom = null; this.edgeSel = null;
    this._stopTour(true);
    this._status('');
    this._syncHash();
  }

  _maybeHint() {
    let seen = false;
    try { seen = localStorage.getItem('archmap.hintDone') === '1'; } catch { /* no storage */ }
    if (seen || !this._hud.hint) return;
    this._hud.hint.innerHTML = `Drag to pan · scroll to zoom · click a file to inspect · <button data-hint-tour>take the one-minute tour</button> · <kbd>?</kbd> shortcuts <button data-hint-x aria-label="Dismiss">✕</button>`;
    this._hud.hint.hidden = false;
    this._hud.hint.querySelector('[data-hint-tour]').addEventListener('click', () => this.startTour());
    this._hud.hint.querySelector('[data-hint-x]').addEventListener('click', () => this._dismissHint());
  }

  _dismissHint() {
    if (this._hud.hint) this._hud.hint.hidden = true;
    try { localStorage.setItem('archmap.hintDone', '1'); } catch { /* no storage */ }
  }

  _buildHelp() {
    const rows = [
      ['?', 'show / hide this guide'],
      ['/', 'ask the map, or search files — “who imports app.js”, “dead code”, “path from a to b”'],
      ['g', 'guided tour · ‹ › or [ ] to change chapter'],
      ['u / d', 'trace upstream / downstream from the selected file'],
      ['r', 'route probe: shortest import path between two files'],
      ['p', 'play the critical-path trace'],
      ['f or 0', 'fit the whole map'],
      ['+ / −', 'zoom in / out'],
      ['m', 'toggle the minimap'],
      ['t', 'switch light / dark theme'],
      ['b', 'toggle the bugs & repairs overlay'],
      ['⌘/Ctrl z', 'undo (in edit mode)'],
      ['Esc', 'clear route / reach / query / tour / selection'],
    ];
    this._hud.help.innerHTML = `
      <div class="help-panel" role="dialog" aria-label="Keyboard shortcuts">
        <h2>Exploring this map</h2>
        <p class="meta">Hover a file to spotlight its wires. Click a node to pin it — click a <b>wire</b> to see the exact import (file:line) that created it. Double-click to zoom. Drag the canvas to pan, scroll to zoom. Every wire is real, with evidence.</p>
        <table>${rows.map(([k, t]) => `<tr><td><kbd>${k}</kbd></td><td>${t}</td></tr>`).join('')}</table>
        <button data-help-x class="sb-btn">Close</button>
      </div>`;
    this._hud.help.addEventListener('click', (e) => {
      if (e.target === this._hud.help || e.target.closest('[data-help-x]')) this.toggleHelp(false);
    });
  }

  toggleHelp(force) {
    const el = this._hud.help;
    if (!el) return;
    el.hidden = force !== undefined ? !force : !el.hidden;
  }

  _copyLink() {
    this._syncHash();
    const url = location.href;
    const done = () => this._flash('Link copied — it reopens the map right here');
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(url).then(done, () => this._flash(esc(url)));
    else this._flash(esc(url));
  }

  // ------------------------------------------------------------ minimap

  _bindMinimap() {
    const mm = this._hud.minimap;
    if (!mm) return;
    const canvas = mm.querySelector('canvas');
    const jump = (e) => {
      const r = canvas.getBoundingClientRect();
      const k = this._mmScale || 1;
      const wx = (e.clientX - r.left) / k, wy = (e.clientY - r.top) / k;
      const rect = this.svg.getBoundingClientRect();
      this.tx = rect.width / 2 - wx * this.scale;
      this.ty = rect.height / 2 - wy * this.scale;
      this._applyTransform();
    };
    let down = false;
    canvas.addEventListener('mousedown', (e) => { down = true; jump(e); });
    window.addEventListener('mousemove', (e) => { if (down) jump(e); });
    window.addEventListener('mouseup', () => { down = false; });
  }

  toggleMinimap() {
    const mm = this._hud.minimap;
    if (!mm) return;
    mm.hidden = !mm.hidden;
    try { localStorage.setItem('archmap.minimap', mm.hidden ? '0' : '1'); } catch { /* no storage */ }
    if (!mm.hidden) this._drawMinimap();
  }

  _drawMinimap() {
    const mm = this._hud.minimap;
    if (!mm || mm.hidden || !this.data) return;
    const canvas = mm.querySelector('canvas');
    const ctx = canvas.getContext('2d');
    const T = readTheme();
    const k = Math.min(canvas.width / this.worldW, canvas.height / this.worldH);
    this._mmScale = k;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const b of this.clusterBoxes) {
      ctx.fillStyle = (T.colors[b.color] || '#888') + '22';
      ctx.fillRect(b.x * k, b.y * k, b.w * k, b.h * k);
    }
    for (const n of this.data.nodes) {
      if (n.x == null || !this.visible(n)) continue;
      ctx.fillStyle = (T.colors[n.color] || '#888');
      ctx.fillRect(n.x * k, n.y * k, Math.max(2, n.w * k), Math.max(1.5, n.h * k));
    }
    // viewport rectangle
    const rect = this.svg.getBoundingClientRect();
    if (rect.width) {
      const vx = (-this.tx / this.scale) * k, vy = (-this.ty / this.scale) * k;
      const vw = (rect.width / this.scale) * k, vh = (rect.height / this.scale) * k;
      ctx.strokeStyle = T.colors.accent;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(vx, vy, vw, vh);
    }
  }

  // ------------------------------------------------------------ keyboard

  _bindKeys() {
    window.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'z' && this.editMode && this.data) {
        const t0 = e.target;
        if (!(t0 && (t0.tagName === 'INPUT' || t0.tagName === 'TEXTAREA'))) {
          e.preventDefault();
          this.undo();
          return;
        }
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) {
        if (e.key === 'Escape') t.blur();
        return;
      }
      if (!this.data) return;
      const k = e.key;
      if (k === '?') { this.toggleHelp(); }
      else if (k === '/') {
        const s = document.querySelector('[data-map-search]');
        if (s) { e.preventDefault(); s.focus(); s.select?.(); }
      }
      else if (k === 'f' || k === '0') this.fit();
      else if (k === '+' || k === '=') this.zoom(1.25);
      else if (k === '-') this.zoom(0.8);
      else if (k === 'g') { this.tour ? this._stopTour() : this.startTour(); }
      else if (k === '[' || (this.tour && k === 'ArrowLeft')) this.tourStep(-1);
      else if (k === ']' || (this.tour && k === 'ArrowRight')) this.tourStep(1);
      else if (k === 'r') this.routePick ? this._cancelRoutePick() : this.startRoutePick(this.selected);
      else if (k === 'u' && this.selected) this.traceReach(this.selected, 'up');
      else if (k === 'd' && this.selected) this.traceReach(this.selected, 'down');
      else if (k === 'p') this.playTrace();
      else if (k === 'm') this.toggleMinimap();
      else if (k === 't') document.querySelector('[data-theme-toggle]')?.click();
      else if (k === 'b') { this.debugMode = !this.debugMode; this.renderChips(); this.draw(); }
      else if (k === 'Escape') {
        if (!this._hud.help?.hidden) return this.toggleHelp(false);
        if (this.tour) return this._stopTour();
        if (this.connectFrom) return this._cancelConnect();
        if (this.edgeSel != null) { this.edgeSel = null; this.draw(); this.renderSidebar(null); return; }
        if (this.route || this.reach || this.routePick || this.queryHl) { this._clearModes(); this.draw(); this.renderSidebar(this.selected); return; }
        if (this.selected) this.select(null);
      }
      else return;
      if (['/', '+', '=', '-'].includes(k)) e.preventDefault();
    });
  }

  // ------------------------------------------------------------ deep links

  _syncHash() {
    if (this._applyingHash || this._headless) return;
    try {
      const p = new URLSearchParams();
      if (this.tour) p.set('view', String(this.tour.idx));
      else if (this.route) p.set('route', `${this.route.ids[0]}~${this.route.ids[this.route.ids.length - 1]}`);
      else if (this.reach) { p.set('focus', this.reach.origin); p.set('reach', this.reach.dir); }
      else if (this.selected) p.set('focus', this.selected);
      const h = p.toString();
      history.replaceState(null, '', h ? '#' + h : location.pathname + location.search);
    } catch { /* file:// or sandbox without history access */ }
  }

  _applyHash() {
    let h = '';
    try { h = location.hash.slice(1); } catch { return; }
    if (!h) return;
    const p = new URLSearchParams(h);
    this._applyingHash = true;
    try {
      const has = (id) => this.data.nodes.some(n => n.id === id);
      if (p.has('view')) this.startTour(parseInt(p.get('view'), 10) || 0);
      else if (p.has('route')) {
        const [a, b] = p.get('route').split('~');
        if (has(a) && has(b)) this.traceRoute(a, b);
      } else if (p.has('focus')) {
        const id = p.get('focus');
        if (has(id)) {
          if (p.get('reach') === 'up' || p.get('reach') === 'down') this.traceReach(id, p.get('reach'));
          else this.focusNode(id);
        }
      }
    } finally { this._applyingHash = false; }
  }

  // ---------------------------------------------------------- pan/zoom

  _bindPanZoom() {
    let dragging = false, lx = 0, ly = 0;
    let nodeDrag = null; // { node, moved } while dragging a node in edit mode
    let drawQueued = false;
    const queueDraw = () => {
      if (drawQueued) return;
      drawQueued = true;
      requestAnimationFrame(() => { drawQueued = false; this.draw(); });
    };
    this.svg.addEventListener('mousedown', (e) => {
      lx = e.clientX; ly = e.clientY;
      const nodeEl = this.editMode && e.target.closest('.node');
      if (nodeEl) {
        const node = this.data.nodes.find(n => n.id === nodeEl.dataset.id);
        if (node && !node.aggregate) {
          nodeDrag = { node, moved: false };
          this._pushHistory();
          return;
        }
      }
      dragging = true;
    });
    window.addEventListener('mousemove', (e) => {
      if (nodeDrag) {
        const dx = (e.clientX - lx) / this.scale, dy = (e.clientY - ly) / this.scale;
        if (Math.abs(e.clientX - lx) + Math.abs(e.clientY - ly) > 2) nodeDrag.moved = true;
        const n = nodeDrag.node;
        n.x += dx; n.y += dy;
        n.px = n.x; n.py = n.y;
        lx = e.clientX; ly = e.clientY;
        queueDraw();
        return;
      }
      if (!dragging) return;
      this.tx += e.clientX - lx; this.ty += e.clientY - ly;
      lx = e.clientX; ly = e.clientY;
      this._applyTransform();
    });
    window.addEventListener('mouseup', () => {
      if (nodeDrag) {
        if (nodeDrag.moved) {
          this.layout(); // cluster boxes follow the node
          this.draw();
          this.onchange?.();
        } else {
          this._history.pop(); // click, not a drag — no snapshot needed
        }
        nodeDrag = null;
      }
      dragging = false;
    });
    this.svg.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = this.svg.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      const ns = Math.min(3, Math.max(0.12, this.scale * factor));
      this.tx = mx - (mx - this.tx) * (ns / this.scale);
      this.ty = my - (my - this.ty) * (ns / this.scale);
      this.scale = ns;
      this._applyTransform();
    }, { passive: false });
    // touch: one-finger pan, two-finger pinch zoom
    let touches = null;
    this.svg.addEventListener('touchstart', (e) => { touches = [...e.touches].map(t => ({ x: t.clientX, y: t.clientY })); }, { passive: true });
    this.svg.addEventListener('touchmove', (e) => {
      if (!touches) return;
      const now = [...e.touches].map(t => ({ x: t.clientX, y: t.clientY }));
      if (now.length === 1 && touches.length === 1) {
        this.tx += now[0].x - touches[0].x;
        this.ty += now[0].y - touches[0].y;
      } else if (now.length === 2 && touches.length === 2) {
        const d0 = Math.hypot(touches[0].x - touches[1].x, touches[0].y - touches[1].y);
        const d1 = Math.hypot(now[0].x - now[1].x, now[0].y - now[1].y);
        if (d0 > 0) {
          const rect = this.svg.getBoundingClientRect();
          const cx = (now[0].x + now[1].x) / 2 - rect.left, cy = (now[0].y + now[1].y) / 2 - rect.top;
          const ns = Math.min(3, Math.max(0.12, this.scale * (d1 / d0)));
          this.tx = cx - (cx - this.tx) * (ns / this.scale);
          this.ty = cy - (cy - this.ty) * (ns / this.scale);
          this.scale = ns;
        }
      }
      touches = now;
      this._applyTransform();
      e.preventDefault();
    }, { passive: false });
    this.svg.addEventListener('touchend', () => { touches = null; }, { passive: true });
  }
}

const CLUSTER_LABELS = {
  client: 'Client / UI', entry: 'Entry point', routes: 'Routes / API',
  services: 'Services / Core', data: 'Data layer', tests: 'Tests', external: 'External dependency',
};
const LANG_NAMES = { js: 'JS/TS', py: 'Python', cs: 'C#', go: 'Go', jvm: 'Java/Kotlin', rs: 'Rust', rb: 'Ruby', php: 'PHP', c: 'C/C++' };

// tiny drawn legend swatches (inline SVG, 1.6px stroke voice — no glyph icons)
function lgLine(color, dashed = false) {
  return `<svg class="lg-sw" width="20" height="8" aria-hidden="true"><line x1="1" y1="4" x2="19" y2="4" stroke="${color}" stroke-width="2"${dashed ? ' stroke-dasharray="4 3"' : ''}/></svg>`;
}
function lgNode() {
  return `<svg class="lg-sw" width="16" height="11" aria-hidden="true"><rect x="1.5" y="1.5" width="13" height="8" rx="2" fill="none" stroke="var(--critical)" stroke-width="1.6" stroke-dasharray="3 2"/></svg>`;
}
function lgDot(color) {
  return `<svg class="lg-sw" width="10" height="10" aria-hidden="true"><circle cx="5" cy="5" r="4" fill="${color}"/></svg>`;
}

function splitEv(ev) {
  const m = String(ev).match(/^(.*):(\d+)$/);
  return m ? [m[1], m[2]] : [String(ev), ''];
}
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function trunc(s, n) { return s.length > n ? s.slice(0, n - 1) + '…' : s; }
function fmtK(n) { return n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(n); }
function badge(cx, cy, color, count, ink = '#111') {
  return `<circle cx="${cx}" cy="${cy}" r="9" fill="${color}"/><text x="${cx}" y="${cy + 3.5}" fill="${ink}" font-size="10" font-weight="700" text-anchor="middle">${count}</text>`;
}
