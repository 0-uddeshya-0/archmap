// Map validation + patch engine. Pure data functions — no DOM, no network —
// shared by the Designer (AI output is validated before it ever renders),
// natural-language edits (applied as checked ops, never as raw JSON trust),
// JSON import, and the Node test suite.

export const CLUSTER_COLORS = { client: 'client', entry: 'route', routes: 'route', services: 'service', data: 'db', external: 'external', tests: 'muted' };
export const NODE_COLORS = new Set(['client', 'route', 'service', 'db', 'external', 'muted']);
export const EDGE_KINDS = new Set(['critical', 'api', 'db', 'mount', 'normal']);

// ------------------------------------------------------------- validation

// Returns { ok, errors, warnings }. Errors make a map unrenderable or lying;
// warnings are inconsistencies the viewer tolerates.
export function validateMap(data) {
  const errors = [], warnings = [];
  const E = (m) => errors.push(m), W = (m) => warnings.push(m);
  if (!data || typeof data !== 'object') return { ok: false, errors: ['not an object'], warnings };

  if (!Array.isArray(data.clusters) || !data.clusters.length) E('clusters: missing or empty');
  if (!Array.isArray(data.nodes) || !data.nodes.length) E('nodes: missing or empty');
  if (!Array.isArray(data.edges)) E('edges: missing');
  if (errors.length) return { ok: false, errors, warnings };

  const clusterIds = new Set();
  for (const c of data.clusters) {
    if (!c.id || !c.label) E(`cluster ${JSON.stringify(c.id)}: needs id and label`);
    if (clusterIds.has(c.id)) E(`cluster "${c.id}": duplicate id`);
    clusterIds.add(c.id);
    if (c.color && !NODE_COLORS.has(c.color)) W(`cluster "${c.id}": unknown color "${c.color}"`);
  }

  const nodeIds = new Set();
  for (const n of data.nodes) {
    if (!n.id || typeof n.id !== 'string') { E(`node ${JSON.stringify(n.label || n.id)}: missing id`); continue; }
    if (nodeIds.has(n.id)) E(`node "${n.id}": duplicate id`);
    nodeIds.add(n.id);
    if (!n.label) E(`node "${n.id}": missing label`);
    if (!clusterIds.has(n.cluster)) E(`node "${n.id}": cluster "${n.cluster}" is not declared`);
    if (n.color && !NODE_COLORS.has(n.color)) W(`node "${n.id}": unknown color "${n.color}"`);
    if (n.tag && !Array.isArray(n.tag)) W(`node "${n.id}": tag should be an array`);
  }

  const edgeKeys = new Set();
  for (const e of data.edges) {
    if (!nodeIds.has(e.from)) E(`edge ${e.from} → ${e.to}: "from" is not a node`);
    if (!nodeIds.has(e.to)) E(`edge ${e.from} → ${e.to}: "to" is not a node`);
    if (e.from === e.to) W(`edge ${e.from}: points at itself`);
    if (e.kind && !EDGE_KINDS.has(e.kind)) W(`edge ${e.from} → ${e.to}: unknown kind "${e.kind}"`);
    const k = e.from + '→' + e.to;
    if (edgeKeys.has(k)) W(`edge ${k}: duplicate`);
    edgeKeys.add(k);
  }

  for (const key of ['bugs', 'fixes']) {
    for (const id of Object.keys(data[key] || {})) {
      if (!nodeIds.has(id)) W(`${key}["${id}"]: no such node`);
    }
  }
  if (data.inventory) {
    if (!Array.isArray(data.inventory.files)) W('inventory.files: should be an array');
    if (!Array.isArray(data.inventory.edges)) W('inventory.edges: should be an array');
  }
  return { ok: errors.length === 0, errors, warnings };
}

// One-line self-check summary for the sidebar — computed, never asserted.
export function selfCheckLine(data) {
  const v = validateMap(data);
  const withEv = (data.edges || []).filter(e => e.ev).length;
  const parts = [`${data.nodes.length} nodes · ${data.edges.length} wires checked`];
  if (withEv) parts.push(`${withEv} wire${withEv === 1 ? '' : 's'} cite file:line evidence`);
  parts.push(v.ok ? '0 inconsistencies' : `${v.errors.length} inconsistencies`);
  return { ok: v.ok, text: parts.join(' · '), errors: v.errors };
}

// ------------------------------------------------------------- patch engine

export function slugId(label) {
  return 'n:' + String(label || 'node').toLowerCase().replace(/[^\w]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

const NODE_FIELDS = new Set(['label', 'cluster', 'sub', 'role', 'plain', 'notes', 'tag', 'critical', 'routes', 'exports']);
const EDGE_FIELDS = new Set(['kind', 'label']);

function ensureCluster(data, clusterId) {
  if (data.clusters.some(c => c.id === clusterId)) return true;
  if (!(clusterId in CLUSTER_COLORS)) return false;
  const LABELS = { client: 'Client / UI', entry: 'Entry / Gateway', routes: 'API / Routes', services: 'Services', data: 'Data & Storage', external: 'External services', tests: 'Tests' };
  data.clusters.push({ id: clusterId, label: LABELS[clusterId], color: CLUSTER_COLORS[clusterId] });
  return true;
}

// Applies a list of ops to the map, mutating `data`. Each op is validated
// before it is applied; invalid ops are skipped and reported. Returns
// { applied: [description...], errors: [description...] }.
export function applyPatch(data, ops) {
  const applied = [], errors = [];
  if (!Array.isArray(ops)) return { applied, errors: ['patch: expected an array of ops'] };
  const byId = () => new Map(data.nodes.map(n => [n.id, n]));

  for (const op of ops) {
    if (!op || typeof op !== 'object' || !op.op) { errors.push('op missing "op" field'); continue; }
    const nodes = byId();
    try {
      if (op.op === 'add_node') {
        const spec = op.node || {};
        if (!spec.label) { errors.push('add_node: needs node.label'); continue; }
        const cluster = spec.cluster || 'services';
        if (!ensureCluster(data, cluster)) { errors.push(`add_node "${spec.label}": unknown cluster "${cluster}"`); continue; }
        let id = spec.id || slugId(spec.label);
        while (nodes.has(id)) id += '-2';
        const c = data.clusters.find(c => c.id === cluster);
        data.nodes.push({
          id, cluster, label: String(spec.label), sub: String(spec.sub || ''),
          color: c.color, path: '', role: String(spec.role || ''), plain: String(spec.plain || ''),
          notes: Array.isArray(spec.notes) ? spec.notes.map(String) : [],
          tag: Array.isArray(spec.tag) && spec.tag.length ? [...new Set(['all', ...spec.tag.map(String)])] : ['all'],
          ...(spec.critical ? { critical: true } : {}),
        });
        applied.push(`added node "${spec.label}" (${id}) in ${cluster}`);
      } else if (op.op === 'update_node') {
        const n = nodes.get(op.id);
        if (!n) { errors.push(`update_node: no node "${op.id}"`); continue; }
        const set = op.set || {};
        const bad = Object.keys(set).filter(k => !NODE_FIELDS.has(k));
        if (bad.length) { errors.push(`update_node "${op.id}": unknown fields ${bad.join(', ')}`); continue; }
        if (set.cluster !== undefined) {
          if (!ensureCluster(data, set.cluster)) { errors.push(`update_node "${op.id}": unknown cluster "${set.cluster}"`); continue; }
          n.cluster = set.cluster;
          n.color = data.clusters.find(c => c.id === set.cluster).color;
          delete n.px; delete n.py; // let it re-seat in its new column
        }
        for (const k of ['label', 'sub', 'role', 'plain']) if (set[k] !== undefined) n[k] = String(set[k]);
        if (set.notes !== undefined) n.notes = Array.isArray(set.notes) ? set.notes.map(String) : n.notes;
        if (set.tag !== undefined) n.tag = Array.isArray(set.tag) ? [...new Set(['all', ...set.tag.map(String)])] : n.tag;
        if (set.critical !== undefined) n.critical = !!set.critical;
        if (set.routes !== undefined) n.routes = Array.isArray(set.routes) ? set.routes.map(String) : n.routes;
        applied.push(`updated node "${n.label}"`);
      } else if (op.op === 'remove_node') {
        if (!nodes.has(op.id)) { errors.push(`remove_node: no node "${op.id}"`); continue; }
        const label = nodes.get(op.id).label;
        data.nodes = data.nodes.filter(n => n.id !== op.id);
        const before = data.edges.length;
        data.edges = data.edges.filter(e => e.from !== op.id && e.to !== op.id);
        if (data.bugs) delete data.bugs[op.id];
        if (data.fixes) delete data.fixes[op.id];
        applied.push(`removed node "${label}" and ${before - data.edges.length} wire(s)`);
      } else if (op.op === 'add_edge') {
        if (!nodes.has(op.from)) { errors.push(`add_edge: no node "${op.from}"`); continue; }
        if (!nodes.has(op.to)) { errors.push(`add_edge: no node "${op.to}"`); continue; }
        if (op.from === op.to) { errors.push('add_edge: from and to are the same node'); continue; }
        if (data.edges.some(e => e.from === op.from && e.to === op.to)) { errors.push(`add_edge: ${op.from} → ${op.to} already exists`); continue; }
        const kind = EDGE_KINDS.has(op.kind) ? op.kind : 'normal';
        data.edges.push({ from: op.from, to: op.to, kind, label: String(op.label || ''), tag: ['all'] });
        applied.push(`connected ${nodes.get(op.from).label} → ${nodes.get(op.to).label}`);
      } else if (op.op === 'update_edge') {
        const e = data.edges.find(e => e.from === op.from && e.to === op.to);
        if (!e) { errors.push(`update_edge: no edge ${op.from} → ${op.to}`); continue; }
        const set = op.set || {};
        const bad = Object.keys(set).filter(k => !EDGE_FIELDS.has(k));
        if (bad.length) { errors.push(`update_edge: unknown fields ${bad.join(', ')}`); continue; }
        if (set.kind !== undefined) {
          if (!EDGE_KINDS.has(set.kind)) { errors.push(`update_edge: unknown kind "${set.kind}"`); continue; }
          e.kind = set.kind;
        }
        if (set.label !== undefined) e.label = String(set.label);
        applied.push(`updated wire ${op.from} → ${op.to}`);
      } else if (op.op === 'remove_edge') {
        const before = data.edges.length;
        data.edges = data.edges.filter(e => !(e.from === op.from && e.to === op.to));
        if (data.edges.length === before) { errors.push(`remove_edge: no edge ${op.from} → ${op.to}`); continue; }
        applied.push(`removed wire ${op.from} → ${op.to}`);
      } else if (op.op === 'set_meta') {
        const set = op.set || {};
        if (set.name !== undefined) { data.meta.name = String(set.name); applied.push(`renamed map to "${set.name}"`); }
        if (set.overview !== undefined) { data.ai = data.ai || {}; data.ai.overview = String(set.overview); applied.push('updated overview'); }
      } else if (op.op === 'set_findings') {
        if (!Array.isArray(op.findings)) { errors.push('set_findings: needs an array'); continue; }
        data.findings = op.findings.map(String);
        applied.push('updated findings');
      } else {
        errors.push(`unknown op "${op.op}"`);
      }
    } catch (err) {
      errors.push(`${op.op}: ${err.message}`);
    }
  }
  // drop clusters that no longer hold nodes (except when map is empty)
  if (data.nodes.length) data.clusters = data.clusters.filter(c => data.nodes.some(n => n.cluster === c.id));
  return { applied, errors };
}
