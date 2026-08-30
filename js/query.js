// Deterministic query engine over the map graph. Pure data — no DOM, no AI.
// Questions are parsed into structured ops and answered by graph computation,
// so every answer is verifiable against the map. When the local parser can't
// understand a phrasing, the caller may ask Claude to translate the question
// into ONE of these ops (translation only — the answer still comes from here).

// Op shapes:
//   { type: 'reach',   dir: 'up'|'down', target: '<name>' }
//   { type: 'route',   from: '<name>', to: '<name>' }
//   { type: 'list',    what: 'dead'|'cycles'|'routes'|'external'|'big'|'hot'|'critical' }
//   { type: 'cluster', cluster: 'client'|'entry'|'routes'|'services'|'data'|'external'|'tests' }
//   { type: 'stats' }
//   { type: 'find',    q: '<name>' }
export const QUERY_OPS = ['reach', 'route', 'list', 'cluster', 'stats', 'find'];

const CLUSTER_WORDS = { client: 'client', ui: 'client', frontend: 'client', entry: 'entry', routes: 'routes', api: 'routes', controllers: 'routes', services: 'services', core: 'services', data: 'data', models: 'data', database: 'data', external: 'external', packages: 'external', tests: 'tests' };

const PATTERNS = [
  [/^(?:who|what|which files?)\s+(?:imports?|uses?|feeds?|depends?\s+on|calls?)\s+(.+?)\??$/i, (m) => ({ type: 'reach', dir: 'up', target: m[1] })],
  [/^(?:upstream|callers)(?:\s+of)?\s+(.+?)\??$/i, (m) => ({ type: 'reach', dir: 'up', target: m[1] })],
  [/^what\s+does\s+(.+?)\s+(?:import|use|depend\s+on|reach|need|call)\??$/i, (m) => ({ type: 'reach', dir: 'down', target: m[1] })],
  [/^(?:downstream|dependencies|deps)(?:\s+of)?\s+(.+?)\??$/i, (m) => ({ type: 'reach', dir: 'down', target: m[1] })],
  [/^(?:path|route)\s+(?:from\s+)?(.+?)\s+(?:to|->|→)\s+(.+?)\??$/i, (m) => ({ type: 'route', from: m[1], to: m[2] })],
  [/^how\s+(?:does|do)\s+(.+?)\s+(?:reach|get\s+to|talk\s+to|connect\s+to|hit)\s+(.+?)\??$/i, (m) => ({ type: 'route', from: m[1], to: m[2] })],
  [/^(?:show\s+|list\s+|find\s+)?(?:the\s+)?dead(?:\s*code)?(?:\s+files?)?\??$/i, () => ({ type: 'list', what: 'dead' })],
  [/^(?:show\s+|list\s+|find\s+)?(?:unused|orphan(?:ed)?)\s+(?:files?|code)\??$/i, () => ({ type: 'list', what: 'dead' })],
  [/(?:^|\s)(?:cycles?|circular)/i, () => ({ type: 'list', what: 'cycles' })],
  [/^(?:show\s+|list\s+)?(?:http\s+|api\s+)?(?:routes|endpoints)\??$/i, () => ({ type: 'list', what: 'routes' })],
  [/^(?:show\s+|list\s+)?(?:external(?:\s+(?:deps|dependencies|packages|services))?|packages)\??$/i, () => ({ type: 'list', what: 'external' })],
  [/^(?:show\s+|list\s+)?(?:the\s+)?(?:biggest|largest|longest)(?:\s+files?)?\??$/i, () => ({ type: 'list', what: 'big' })],
  [/^(?:show\s+|list\s+)?(?:the\s+)?(?:hot(?:test)?|busiest|most\s+(?:imported|used|depended[- ]on))(?:\s+(?:files?|paths?))?\??$/i, () => ({ type: 'list', what: 'hot' })],
  [/^(?:show\s+|what(?:'s|\s+is)\s+)?(?:the\s+)?critical(?:\s*path)?\??$/i, () => ({ type: 'list', what: 'critical' })],
  [/^(?:show\s+)?(?:the\s+)?(\w+)\s+(?:files|layer|cluster|nodes)\??$/i, (m) => CLUSTER_WORDS[m[1].toLowerCase()] ? { type: 'cluster', cluster: CLUSTER_WORDS[m[1].toLowerCase()] } : null],
  [/^(?:stats|summary|overview|how\s+(?:big|many)\b.*)\??$/i, () => ({ type: 'stats' })],
  [/^(?:explain|what\s+is|what's|tell\s+me\s+about|describe)\s+(.+?)\??$/i, (m) => ({ type: 'find', q: m[1] })],
];

export function parseQuery(text) {
  const q = String(text || '').trim().replace(/\s+/g, ' ');
  if (!q) return null;
  for (const [re, build] of PATTERNS) {
    const m = q.match(re);
    if (m) {
      const op = build(m);
      if (op) return op;
    }
  }
  return null;
}

// Fuzzy node resolution: exact label > label contains > path contains.
export function resolveNode(data, name) {
  const q = String(name || '').trim().toLowerCase().replace(/^["']|["']$/g, '');
  if (!q) return null;
  const N = data.nodes.filter(n => !n.aggregate);
  return N.find(n => (n.label || '').toLowerCase() === q)
    || N.find(n => (n.label || '').toLowerCase() === q + '.js' || (n.label || '').toLowerCase() === q + '.py')
    || N.find(n => (n.label || '').toLowerCase().includes(q))
    || N.find(n => (n.path || '').toLowerCase().includes(q))
    || null;
}

// Executes an op against the map. Returns a displayable result:
// { title, summary, items: [{ id?, label, note? }], apply?, miss? }
// `apply` tells the viewer what to do on canvas:
//   { type: 'reach', id, dir } | { type: 'route', from, to }
//   { type: 'highlight', ids, edgeIdxs? } | { type: 'focus', id }
export function runQuery(op, data) {
  const nodes = data.nodes.filter(n => !n.aggregate);
  const inDeg = new Map();
  for (const e of data.edges) inDeg.set(e.to, (inDeg.get(e.to) || 0) + 1);
  const item = (n, note) => ({ id: n.id, label: n.label, note });
  const missTarget = (name) => ({
    title: 'Not found', miss: true,
    summary: `No file on this map matches "${name}". Try the exact file name, or search with /.`,
    items: [],
  });

  if (op.type === 'reach') {
    const n = resolveNode(data, op.target);
    if (!n) return missTarget(op.target);
    return {
      title: op.dir === 'up' ? `What feeds ${n.label}` : `What ${n.label} reaches`,
      summary: 'Tracing over real import wires…',
      items: [],
      apply: { type: 'reach', id: n.id, dir: op.dir },
    };
  }

  if (op.type === 'route') {
    const a = resolveNode(data, op.from), b = resolveNode(data, op.to);
    if (!a) return missTarget(op.from);
    if (!b) return missTarget(op.to);
    return {
      title: `Route ${a.label} → ${b.label}`,
      summary: 'Probing the shortest import chain…',
      items: [],
      apply: { type: 'route', from: a.id, to: b.id },
    };
  }

  if (op.type === 'list') {
    if (op.what === 'dead') {
      const dead = nodes.filter(n => n.dead);
      return {
        title: 'Dead code',
        summary: dead.length
          ? `${dead.length} file${dead.length > 1 ? 's' : ''} export code with zero live callers found anywhere in the repo.`
          : 'No dead code found — every exported file has at least one live caller.',
        items: dead.map(n => item(n, n.path)),
        apply: dead.length ? { type: 'highlight', ids: dead.map(n => n.id) } : undefined,
      };
    }
    if (op.what === 'cycles') {
      const idxs = data.edges.map((e, i) => ({ e, i })).filter(x => x.e.cycle);
      const ids = [...new Set(idxs.flatMap(x => [x.e.from, x.e.to]))];
      return {
        title: 'Circular imports',
        summary: ids.length
          ? `${ids.length} files import each other in ${idxs.length} cycle wire${idxs.length > 1 ? 's' : ''} — they can only be changed together.`
          : 'No circular imports on this map.',
        items: ids.map(id => { const n = nodes.find(n => n.id === id); return n ? item(n) : null; }).filter(Boolean),
        apply: ids.length ? { type: 'highlight', ids, edgeIdxs: idxs.map(x => x.i) } : undefined,
      };
    }
    if (op.what === 'routes') {
      const withRoutes = nodes.filter(n => (n.routes || []).length);
      const total = withRoutes.reduce((s, n) => s + n.routes.length, 0);
      return {
        title: 'HTTP routes',
        summary: total ? `${total} route${total > 1 ? 's' : ''} defined across ${withRoutes.length} file${withRoutes.length > 1 ? 's' : ''}.` : 'No HTTP route definitions were found.',
        items: withRoutes.flatMap(n => n.routes.slice(0, 6).map(r => item(n, r))),
        apply: withRoutes.length ? { type: 'highlight', ids: withRoutes.map(n => n.id) } : undefined,
      };
    }
    if (op.what === 'external') {
      const ext = nodes.filter(n => n.cluster === 'external');
      return {
        title: 'External dependencies',
        summary: ext.length ? `${ext.length} external package${ext.length > 1 ? 's' : ''}/service${ext.length > 1 ? 's' : ''} imported by this code.` : 'No external dependencies detected.',
        items: ext.map(n => item(n, n.sub)),
        apply: ext.length ? { type: 'highlight', ids: ext.map(n => n.id) } : undefined,
      };
    }
    if (op.what === 'big') {
      const big = nodes.filter(n => n.loc).sort((a, b) => b.loc - a.loc).slice(0, 6);
      return {
        title: 'Biggest files',
        summary: big.length ? 'By lines of code:' : 'No line counts on this map.',
        items: big.map(n => item(n, `${n.loc} lines`)),
        apply: big.length ? { type: 'highlight', ids: big.map(n => n.id) } : undefined,
      };
    }
    if (op.what === 'hot') {
      const hot = nodes.map(n => ({ n, d: inDeg.get(n.id) || 0 })).filter(x => x.d >= 2)
        .sort((a, b) => b.d - a.d).slice(0, 6);
      return {
        title: 'Most depended-on files',
        summary: hot.length ? 'Changes to these ripple the furthest:' : 'No file has more than one importer on this map.',
        items: hot.map(x => item(x.n, `${x.d} importer${x.d > 1 ? 's' : ''}`)),
        apply: hot.length ? { type: 'highlight', ids: hot.map(x => x.n.id) } : undefined,
      };
    }
    if (op.what === 'critical') {
      const crit = nodes.filter(n => n.critical);
      const edgeIdxs = data.edges.map((e, i) => ({ e, i })).filter(x => x.e.kind === 'critical').map(x => x.i);
      return {
        title: 'The critical path',
        summary: crit.length ? `${crit.length} files form the spine of this system:` : 'No critical path is marked on this map.',
        items: crit.map(n => item(n)),
        apply: crit.length ? { type: 'highlight', ids: crit.map(n => n.id), edgeIdxs } : undefined,
      };
    }
  }

  if (op.type === 'cluster') {
    const members = nodes.filter(n => n.cluster === op.cluster);
    const label = data.clusters.find(c => c.id === op.cluster)?.label || op.cluster;
    return {
      title: label,
      summary: members.length ? `${members.length} file${members.length > 1 ? 's' : ''} in this layer.` : `Nothing in the ${op.cluster} layer on this map.`,
      items: members.slice(0, 20).map(n => item(n)),
      apply: members.length ? { type: 'highlight', ids: members.map(n => n.id) } : undefined,
    };
  }

  if (op.type === 'stats') {
    const s = data.meta?.stats || {};
    const langs = s.languages ? Object.entries(s.languages).sort((a, b) => b[1] - a[1]).map(([l, c]) => `${l} (${c})`).join(', ') : '';
    const dead = nodes.filter(n => n.dead).length;
    const cyc = data.edges.filter(e => e.cycle).length;
    return {
      title: `${data.meta?.name || 'This map'}`,
      summary: [
        `${s.filesScanned || nodes.length} files analyzed${s.totalLoc ? `, ${s.totalLoc.toLocaleString()} lines` : ''}`,
        `${data.nodes.length} nodes, ${data.edges.length} wires on the map`,
        langs ? `languages: ${langs}` : '',
        dead ? `${dead} dead file${dead > 1 ? 's' : ''}` : 'no dead code found',
        cyc ? `${cyc} cycle wires` : 'no circular imports',
      ].filter(Boolean).join(' · '),
      items: [],
    };
  }

  if (op.type === 'find') {
    const n = resolveNode(data, op.q);
    if (!n) return missTarget(op.q);
    return {
      title: n.label,
      summary: n.role || n.sub || '',
      items: [item(n, n.path)],
      apply: { type: 'focus', id: n.id },
    };
  }

  return { title: 'Unknown query', miss: true, summary: 'That query type is not supported.', items: [] };
}
