// SVG renderer: column-cluster layout, cubic-bezier edges, pan/zoom,
// hover/click selection, filter chips, sidebar detail.

// Colors come from CSS custom properties so the map follows the active theme.
function readTheme() {
  const s = getComputedStyle(document.documentElement);
  const v = (name, fb) => (s.getPropertyValue(name) || fb).trim() || fb;
  const colors = {
    client: v('--client', '#4ea1ff'), route: v('--route', '#7bd389'),
    service: v('--service', '#c792ea'), db: v('--db', '#ffb86b'),
    external: v('--external', '#ff6b9d'), critical: v('--critical', '#ff3860'),
    muted: v('--neutral', '#8a8a8a'),
  };
  return {
    colors,
    edges: { critical: colors.critical, api: v('--accent-2', '#ff7a45'), db: colors.db, mount: colors.client, normal: v('--edge-normal', '#555555') },
    nodeFill: v('--node-fill', '#181818'),
    text: v('--text', '#e8e8e8'),
    muted: v('--muted', '#8a8a8a'),
    badgeInk: v('--accent-ink', '#111111'),
  };
}

const NODE_W = 200, NODE_H = 54, GAP_Y = 18, COL_GAP = 130, PAD = 40;

export class MapRenderer {
  constructor(svgEl, sidebarEl, chipsEl) {
    this.svg = svgEl;
    this.sidebar = sidebarEl;
    this.chips = chipsEl;
    this.tx = 0; this.ty = 0; this.scale = 1;
    this.activeTag = 'all';
    this.showAllWires = false;
    this.selected = null;
    this.debugMode = false;
    this._bindPanZoom();
  }

  setData(data) {
    this.data = data;
    this.layout();
    this.renderChips();
    this.draw();
    this.fit();
    this.renderSidebar(null);
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
        n.w = NODE_W; n.h = NODE_H;
      });
      const boxW = cols * NODE_W + (cols - 1) * INNER_GAP + 28;
      const boxH = 44 + rows * (NODE_H + GAP_Y) - GAP_Y + 16;
      this.clusterBoxes.push({ ...c, x: x - 14, y: PAD, w: boxW, h: boxH, count: cNodes.length });
      x += boxW - 28 + NODE_W * 0 + COL_GAP;
    }
    this.worldW = x + PAD;
    this.worldH = Math.max(...this.clusterBoxes.map(b => b.y + b.h + PAD), 400) + PAD;
  }

  visible(item) {
    if (this.activeTag === 'all') return true;
    return (item.tag || ['all']).includes(this.activeTag);
  }

  edgeVisible(e) {
    if (!this.showAllWires && this.activeTag === 'all') {
      // overview: show critical + mount + db/api edges, hide plain imports for readability
      if (e.kind === 'normal') return false;
    }
    return this.visible(e);
  }

  draw() {
    const { nodes, edges } = this.data;
    const T = readTheme();
    const COLORS = T.colors, EDGE_COLORS = T.edges;
    const byId = new Map(nodes.map(n => [n.id, n]));
    const conn = this._connectivity();
    const sel = this.selected;
    const dimNode = (n) => sel && n.id !== sel && !conn.get(sel)?.has(n.id);

    let defs = `<defs>`;
    for (const [k, c] of Object.entries(EDGE_COLORS)) {
      defs += `<marker id="arr-${k}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="${c}"/></marker>`;
    }
    defs += `</defs>`;

    let g = `<g id="world" transform="translate(${this.tx},${this.ty}) scale(${this.scale})">`;
    g += `<rect x="-5000" y="-5000" width="20000" height="20000" fill="transparent" data-bg="1"/>`;

    for (const b of this.clusterBoxes) {
      const color = COLORS[b.color] || '#888';
      g += `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="12" fill="${color}12" stroke="${color}40" stroke-width="1"/>`;
      g += `<text x="${b.x + 14}" y="${b.y + 26}" fill="${color}" font-size="13" font-weight="700" letter-spacing="0.6">${esc(b.label.toUpperCase())} · ${b.count}</text>`;
    }

    // edges
    const labelSlots = new Map();
    for (const e of edges) {
      if (!this.edgeVisible(e)) continue;
      const a = byId.get(e.from), b = byId.get(e.to);
      if (!a || !b || !this.visible(a) || !this.visible(b)) continue;
      const dim = sel && !(e.from === sel || e.to === sel);
      const color = EDGE_COLORS[e.kind] || EDGE_COLORS.normal;
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
      const w = e.kind === 'critical' ? 2.4 : 1.4;
      g += `<path class="edge" data-from="${esc(e.from)}" data-to="${esc(e.to)}" d="${d}" fill="none" stroke="${color}" stroke-width="${w}" stroke-linecap="round" opacity="${dim ? 0.08 : (e.kind === 'normal' ? 0.4 : 0.85)}" marker-end="url(#arr-${e.kind || 'normal'})"/>`;
      if (e.label && e.label !== 'import' && !dim) {
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
      // in debug mode, spotlight bug/repair nodes and fade the rest
      let dim = dimNode(n);
      if (this.debugMode && !openBugs && !nodeFixes && n.id !== sel) dim = true;
      let stroke = n.critical ? COLORS.critical : color;
      let sw = n.critical ? 2.4 : (n.id === sel ? 2.2 : 1.3);
      if (this.debugMode && openBugs) { stroke = COLORS.critical; sw = 2.6; }
      else if (this.debugMode && nodeFixes) { stroke = COLORS.route; sw = 2.6; }
      g += `<g class="node" data-id="${esc(n.id)}" opacity="${dim ? 0.15 : 1}" style="cursor:pointer">`;
      if (this.debugMode && (openBugs || nodeFixes) && !dim) {
        const hc = openBugs ? COLORS.critical : COLORS.route;
        g += `<rect x="${n.x - 4}" y="${n.y - 4}" width="${n.w + 8}" height="${n.h + 8}" rx="12" fill="${hc}1f" stroke="${hc}66" stroke-width="1.5"/>`;
      }
      g += `<rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="9" fill="${T.nodeFill}" stroke="${stroke}" stroke-width="${sw}"/>`;
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
      el.addEventListener('click', (ev) => { ev.stopPropagation(); this.select(el.dataset.id); });
      el.addEventListener('dblclick', (ev) => { ev.stopPropagation(); this.focusNode(el.dataset.id); });
      el.addEventListener('mouseenter', () => { this._hoverHighlight(el.dataset.id); if (!this.selected) this.renderSidebar(el.dataset.id); });
      el.addEventListener('mouseleave', () => { this._hoverClear(); if (!this.selected) this.renderSidebar(null); });
    });
    this.svg.querySelector('[data-bg]')?.addEventListener('click', () => this.select(null));
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
    this.draw();
    this.renderSidebar(id);
  }

  // Lightweight hover: emphasize a node's branches without a full re-render.
  _hoverHighlight(id) {
    if (this.selected) return; // a pinned selection wins
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
    if (this.selected) return;
    this.svg.querySelectorAll('.node').forEach(el => { el.style.opacity = ''; });
    this.svg.querySelectorAll('.edge').forEach(el => { el.style.opacity = ''; el.style.strokeWidth = ''; });
  }

  // Center + gently zoom to a single node (double-click / search).
  focusNode(id) {
    const n = this.data.nodes.find(x => x.id === id);
    if (!n) return;
    const rect = this.svg.getBoundingClientRect();
    const ns = Math.min(1.4, Math.max(this.scale, 0.9));
    this.scale = ns;
    this.tx = rect.width / 2 - (n.x + n.w / 2) * ns;
    this.ty = rect.height / 2 - (n.y + n.h / 2) * ns;
    this._applyTransform();
    this.select(id);
  }

  // Find the best-matching node by label / path / sub and focus it.
  findAndFocus(query) {
    const q = (query || '').trim().toLowerCase();
    if (!q) return false;
    const N = this.data.nodes;
    const hit = N.find(n => (n.label || '').toLowerCase() === q)
      || N.find(n => (n.label || '').toLowerCase().includes(q))
      || N.find(n => (n.path || '').toLowerCase().includes(q))
      || N.find(n => (n.sub || '').toLowerCase().includes(q));
    if (hit) { this.focusNode(hit.id); return true; }
    return false;
  }

  // ------------------------------------------------------------ chips

  renderChips() {
    const tags = this.data.tags || ['all'];
    let html = `<button class="chip ${this.activeTag === 'all' && !this.showAllWires ? 'active' : ''}" data-tag="all">Overview</button>`;
    for (const t of tags.filter(t => t !== 'all')) {
      html += `<button class="chip ${this.activeTag === t ? 'active' : ''}" data-tag="${esc(t)}">${esc(t)}</button>`;
    }
    html += `<button class="chip ${this.showAllWires ? 'active' : ''}" data-wires="1">Show all wires</button>`;
    const hasDebug = Object.keys(this.data.fixes || {}).length || Object.keys(this.data.bugs || {}).length;
    if (hasDebug) {
      html += `<button class="chip debug-chip ${this.debugMode ? 'active' : ''}" data-debug="1">🐛 Bugs &amp; repairs</button>`;
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

  renderSidebar(id) {
    const d = this.data;
    if (!id) {
      const s = d.meta?.stats || {};
      this.sidebar.innerHTML = `
        <h2>${esc(d.meta?.name || 'Map')}</h2>
        <p class="meta">${esc(d.meta?.source || '')}${s.filesScanned ? ` · ${s.filesScanned} files scanned` : ''} · ${d.nodes.length} nodes · ${d.edges.length} edges</p>
        ${d.ai?.enriched ? '<p class="meta ai-badge">✦ AI-enriched</p>' : ''}
        <h3>Notable findings from this map</h3>
        <ul>${(d.findings || []).map(f => `<li>${esc(f)}</li>`).join('')}</ul>
        ${d.ai?.overview ? `<h3>Plain-English overview</h3><p>${esc(d.ai.overview)}</p>` : ''}
        <h3>Legend</h3>
        <ul class="legend">
          <li><span style="color:var(--critical)">━</span> critical path</li>
          <li><span style="color:var(--db)">━</span> database</li>
          <li><span style="color:var(--accent-2)">━</span> external API</li>
          <li><span style="color:var(--client)">━</span> entry → mount</li>
          <li><span style="color:var(--edge-normal)">━</span> import (toggle "Show all wires")</li>
          <li><span style="color:var(--critical)">◍</span> node with open bugs</li>
          <li><span style="color:var(--route)">◍</span> node with planned repairs</li>
        </ul>
        <p class="meta">Hover a node for details; click to pin and dim unrelated nodes.</p>`;
      return;
    }
    const n = d.nodes.find(n => n.id === id);
    if (!n) return;
    const inc = d.edges.filter(e => e.to === id).map(e => d.nodes.find(x => x.id === e.from)?.label).filter(Boolean);
    const out = d.edges.filter(e => e.from === id).map(e => d.nodes.find(x => x.id === e.to)?.label).filter(Boolean);
    const fixes = d.fixes?.[id] || [], bugs = d.bugs?.[id] || [];
    this.sidebar.innerHTML = `
      <h2>${esc(n.label)} ${n.critical ? '<span class="crit-tag">critical path</span>' : ''}${n.dead ? '<span class="dead-tag">dead code</span>' : ''}</h2>
      ${n.path ? `<p class="path">${esc(n.path)}</p>` : ''}
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
      ${(n.routes || []).length ? `<h3>Routes</h3><ul>${n.routes.map(r => `<li><code>${esc(r)}</code></li>`).join('')}</ul>` : ''}
      ${inc.length ? `<h3>What feeds it (${inc.length})</h3><p class="meta">${esc(inc.slice(0, 10).join(', '))}</p>` : ''}
      ${out.length ? `<h3>Depends on (${out.length})</h3><p class="meta">${esc(out.slice(0, 10).join(', '))}</p>` : ''}`;
  }

  // ---------------------------------------------------------- pan/zoom

  _bindPanZoom() {
    let dragging = false, lx = 0, ly = 0;
    this.svg.addEventListener('mousedown', (e) => { dragging = true; lx = e.clientX; ly = e.clientY; });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      this.tx += e.clientX - lx; this.ty += e.clientY - ly;
      lx = e.clientX; ly = e.clientY;
      this._applyTransform();
    });
    window.addEventListener('mouseup', () => { dragging = false; });
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
  }

  _applyTransform() {
    const world = this.svg.querySelector('#world');
    if (world) world.setAttribute('transform', `translate(${this.tx},${this.ty}) scale(${this.scale})`);
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
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function trunc(s, n) { return s.length > n ? s.slice(0, n - 1) + '…' : s; }
function badge(cx, cy, color, count, ink = '#111') {
  return `<circle cx="${cx}" cy="${cy}" r="9" fill="${color}"/><text x="${cx}" y="${cy + 3.5}" fill="${ink}" font-size="10" font-weight="700" text-anchor="middle">${count}</text>`;
}
