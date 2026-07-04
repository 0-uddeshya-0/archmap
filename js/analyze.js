// ArchMap static analysis engine.
// Input:  files = [{ path, content, size }]
// Output: archmap data object (see schema in export.js) — computed truth only,
// no guesses. The AI layer (ai.js) optionally enriches it afterwards.

const CODE_EXT = /\.(js|jsx|ts|tsx|mjs|cjs|py)$/;
const SKIP_DIRS = /(^|\/)(node_modules|\.git|dist|build|out|\.next|\.nuxt|coverage|vendor|venv|\.venv|__pycache__|\.cache|target|\.turbo|\.svelte-kit)(\/|$)/;
const TEST_FILE = /(^|\/)(tests?|__tests__|spec)(\/|$)|\.(test|spec)\.[jt]sx?$|(^|\/)test_.*\.py$|_test\.py$/;
const MAX_FILE_SIZE = 300 * 1024;
const MAX_NODES = 80;

const DB_PACKAGES = new Set(['pg', 'mysql', 'mysql2', 'mongoose', 'mongodb', 'sqlite3', 'better-sqlite3', 'prisma', '@prisma/client', 'sequelize', 'typeorm', 'knex', 'drizzle-orm', 'redis', 'ioredis', 'sqlalchemy', 'psycopg2', 'pymongo', 'peewee', 'django.db', 'supabase', '@supabase/supabase-js', 'firebase-admin', 'firebase']);
const HTTP_PACKAGES = new Set(['axios', 'node-fetch', 'got', 'undici', 'superagent', 'requests', 'httpx', 'aiohttp', 'urllib3']);
const AI_PACKAGES = new Set(['openai', 'anthropic', '@anthropic-ai/sdk', 'langchain', '@google/generative-ai', 'cohere-ai', 'replicate', 'transformers', 'tiktoken']);
const SERVER_FRAMEWORKS = new Set(['express', 'fastify', 'koa', 'hapi', '@hapi/hapi', 'flask', 'django', 'fastapi', 'starlette', 'sanic', 'bottle', 'hono', 'nest', '@nestjs/core']);
const CLIENT_FRAMEWORKS = new Set(['react', 'react-dom', 'vue', 'svelte', 'preact', 'solid-js', '@angular/core', 'next', 'nuxt']);

export function isAnalyzableFile(path, size) {
  return CODE_EXT.test(path) && !SKIP_DIRS.test(path) && (!size || size <= MAX_FILE_SIZE);
}

export function isManifest(path) {
  return /(^|\/)(package\.json|pyproject\.toml|requirements\.txt|setup\.py|README\.md|readme\.md)$/.test(path) && !SKIP_DIRS.test(path);
}

// ---------------------------------------------------------------- parsing

function lang(path) {
  return path.endsWith('.py') ? 'py' : 'js';
}

function stripComments(src, l) {
  if (l === 'py') {
    return src.replace(/'''[\s\S]*?'''|"""[\s\S]*?"""/g, '').replace(/#[^\n]*/g, '');
  }
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function parseJS(src) {
  const imports = [];
  const exports = [];
  let m;
  const importRe = /import\s+(?:[\w${},*\s]+?\s+from\s+)?['"]([^'"\n]+)['"]/g;
  while ((m = importRe.exec(src))) imports.push(m[1]);
  const requireRe = /require\(\s*['"]([^'"\n]+)['"]\s*\)/g;
  while ((m = requireRe.exec(src))) imports.push(m[1]);
  const dynRe = /import\(\s*['"]([^'"\n]+)['"]\s*\)/g;
  while ((m = dynRe.exec(src))) imports.push(m[1]);
  const exportRe = /export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|class|const|let|var)\s+([\w$]+)/g;
  while ((m = exportRe.exec(src))) exports.push(m[1]);
  const exportBraceRe = /export\s*\{([^}]+)\}/g;
  while ((m = exportBraceRe.exec(src))) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (name && /^[\w$]+$/.test(name)) exports.push(name);
    }
  }
  const cjsExportRe = /(?:module\.)?exports\.([\w$]+)\s*=/g;
  while ((m = cjsExportRe.exec(src))) exports.push(m[1]);
  // route detection: app.get('/x'), router.post('/y'), @app.route in flask handled in py
  const routes = [];
  const routeRe = /\b(?:app|router|server|api)\.(get|post|put|delete|patch|use|all)\(\s*['"`]([^'"`\n]+)['"`]/g;
  while ((m = routeRe.exec(src))) routes.push(`${m[1].toUpperCase()} ${m[2]}`);
  return { imports, exports, routes };
}

function parsePY(src) {
  const imports = [];
  const exports = [];
  let m;
  const fromRe = /^\s*from\s+([\w.]+)\s+import\s+/gm;
  while ((m = fromRe.exec(src))) imports.push(m[1]);
  const impRe = /^\s*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)/gm;
  while ((m = impRe.exec(src))) {
    for (const mod of m[1].split(',')) imports.push(mod.trim());
  }
  const defRe = /^(?:def|class)\s+([\w]+)/gm;
  while ((m = defRe.exec(src))) exports.push(m[1]);
  const routes = [];
  const flaskRe = /@\s*(?:app|bp|blueprint|router)\.(?:route|get|post|put|delete|patch)\(\s*['"]([^'"\n]+)['"]/g;
  while ((m = flaskRe.exec(src))) routes.push(m[1]);
  return { imports, exports, routes };
}

// -------------------------------------------------------- module resolution

function normalize(path) {
  const parts = [];
  for (const p of path.split('/')) {
    if (p === '..') parts.pop();
    else if (p !== '.' && p !== '') parts.push(p);
  }
  return parts.join('/');
}

const JS_CANDIDATES = ['', '.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs', '/index.js', '/index.ts', '/index.jsx', '/index.tsx'];

function resolveImport(fromPath, spec, fileSet, l) {
  if (l === 'js') {
    if (!spec.startsWith('.') && !spec.startsWith('/')) return null; // external package
    const dir = fromPath.split('/').slice(0, -1).join('/');
    const base = normalize(dir ? dir + '/' + spec : spec);
    for (const c of JS_CANDIDATES) {
      if (fileSet.has(base + c)) return base + c;
    }
    return null;
  }
  // python: dotted module path → try as file relative to repo root and to file dir
  const rel = spec.replace(/^\.+/, '').split('.').join('/');
  const fromDir = fromPath.split('/').slice(0, -1).join('/');
  const candidates = [];
  if (spec.startsWith('.')) {
    const ups = (spec.match(/^\.+/) || ['.'])[0].length - 1;
    const baseDir = fromDir.split('/').slice(0, fromDir.split('/').length - ups).join('/');
    candidates.push(normalize(baseDir + '/' + rel));
  } else {
    candidates.push(rel);
    if (fromDir) candidates.push(normalize(fromDir + '/' + rel));
    // src/ prefixed layouts
    const root = fromPath.split('/')[0];
    if (root && root !== rel.split('/')[0]) candidates.push(root + '/' + rel);
  }
  for (const c of candidates) {
    if (fileSet.has(c + '.py')) return c + '.py';
    if (fileSet.has(c + '/__init__.py')) return c + '/__init__.py';
  }
  return null;
}

function packageName(spec) {
  if (spec.startsWith('@')) return spec.split('/').slice(0, 2).join('/');
  return spec.split('/')[0].split('.')[0];
}

// -------------------------------------------------------- cluster inference

function classify(path, parsed, deps) {
  const p = path.toLowerCase();
  const base = p.split('/').pop();
  if (TEST_FILE.test(p)) return 'tests';
  if (/(^|\/)(pages|app)\/.+\.(jsx?|tsx?)$/.test(p) && deps.hasClientFw) return 'client';
  if (/(^|\/)(components|hooks|views|screens|ui|frontend|client|public|src\/app)(\/|$)/.test(p)) return 'client';
  if (parsed.routes.length > 0) return 'routes';
  if (/(^|\/)(routes|routers|controllers|api|endpoints|handlers|urls)(\/|$)|urls\.py$|views\.py$/.test(p)) return 'routes';
  if (/(^|\/)(models|schemas?|db|database|migrations|entities|repositories|dao|store|stores)(\/|$)|models\.py$|schema\.(js|ts|py)$/.test(p)) return 'data';
  if (/^(index|main|app|server|cli|manage|wsgi|asgi|__main__)\.(jsx?|tsx?|mjs|cjs|py)$/.test(base) && path.split('/').length <= 2) return 'entry';
  if (/(^|\/)(services|lib|core|utils|helpers|middleware|workers|jobs|tasks|domain|logic)(\/|$)/.test(p)) return 'services';
  return 'services';
}

const CLUSTER_META = {
  client:   { label: 'Client / UI',    color: 'client' },
  entry:    { label: 'Entry points',   color: 'route' },
  routes:   { label: 'Routes / API',   color: 'route' },
  services: { label: 'Services / Core',color: 'service' },
  data:     { label: 'Data layer',     color: 'db' },
  tests:    { label: 'Tests',          color: 'muted' },
  external: { label: 'External deps',  color: 'external' },
};
const CLUSTER_ORDER = ['client', 'entry', 'routes', 'services', 'data', 'external', 'tests'];

// ----------------------------------------------------------------- analyze

export function analyze(files, meta = {}) {
  const codeFiles = files.filter(f => isAnalyzableFile(f.path, f.size));
  const fileSet = new Set(codeFiles.map(f => f.path));
  const parsedMap = new Map();
  const detectedDeps = { hasClientFw: false, frameworks: new Set() };

  // read manifests for framework detection
  for (const f of files) {
    if (/package\.json$/.test(f.path) && !SKIP_DIRS.test(f.path)) {
      try {
        const pkg = JSON.parse(f.content);
        const all = { ...pkg.dependencies, ...pkg.devDependencies };
        for (const d of Object.keys(all || {})) {
          if (CLIENT_FRAMEWORKS.has(d)) { detectedDeps.hasClientFw = true; detectedDeps.frameworks.add(d); }
          if (SERVER_FRAMEWORKS.has(d)) detectedDeps.frameworks.add(d);
          if (AI_PACKAGES.has(d)) detectedDeps.frameworks.add(d);
        }
      } catch { /* malformed package.json — skip */ }
    }
  }

  for (const f of codeFiles) {
    const l = lang(f.path);
    const src = stripComments(f.content, l);
    parsedMap.set(f.path, l === 'py' ? parsePY(src) : parseJS(src));
  }

  // build edges
  const internalEdges = [];       // {from, to}
  const externalUse = new Map();  // pkg -> Set(paths)
  for (const f of codeFiles) {
    const parsed = parsedMap.get(f.path);
    const l = lang(f.path);
    const seen = new Set();
    for (const spec of parsed.imports) {
      const resolved = resolveImport(f.path, spec, fileSet, l);
      if (resolved && resolved !== f.path) {
        if (!seen.has(resolved)) { internalEdges.push({ from: f.path, to: resolved }); seen.add(resolved); }
      } else if (!spec.startsWith('.') && !spec.startsWith('/')) {
        const pkg = packageName(spec);
        if (!externalUse.has(pkg)) externalUse.set(pkg, new Set());
        externalUse.get(pkg).add(f.path);
      }
    }
  }

  // degree
  const inDeg = new Map(), outDeg = new Map();
  for (const e of internalEdges) {
    outDeg.set(e.from, (outDeg.get(e.from) || 0) + 1);
    inDeg.set(e.to, (inDeg.get(e.to) || 0) + 1);
  }

  // classify + select nodes by importance
  const fileInfo = codeFiles.map(f => {
    const parsed = parsedMap.get(f.path);
    const cluster = classify(f.path, parsed, detectedDeps);
    const loc = f.content.split('\n').length;
    const degree = (inDeg.get(f.path) || 0) + (outDeg.get(f.path) || 0);
    const extCount = parsed.imports.filter(s => !s.startsWith('.') && !s.startsWith('/')).length;
    return { path: f.path, parsed, cluster, loc, degree, extCount };
  });

  // dead code: file-level (no importers, not entry/client/test), then export-level grep
  const allSource = codeFiles.map(f => ({ path: f.path, content: f.content }));
  for (const fi of fileInfo) {
    if (fi.cluster === 'entry' || fi.cluster === 'client' || fi.cluster === 'tests') continue;
    if ((inDeg.get(fi.path) || 0) > 0) continue;
    // file has no internal importers — check if any export name appears elsewhere
    const referenced = fi.parsed.exports.some(name =>
      name.length > 2 && allSource.some(s => s.path !== fi.path && s.content.includes(name)));
    fi.dead = !referenced && fi.parsed.exports.length > 0;
    fi.orphan = !fi.dead; // no importers but names appear elsewhere or no exports
  }

  fileInfo.sort((a, b) => (b.degree + (b.dead ? 5 : 0)) - (a.degree + (a.dead ? 5 : 0)));
  const selected = fileInfo.slice(0, MAX_NODES);
  const selectedSet = new Set(selected.map(f => f.path));
  const overflow = new Map(); // cluster -> count
  for (const fi of fileInfo.slice(MAX_NODES)) {
    overflow.set(fi.cluster, (overflow.get(fi.cluster) || 0) + 1);
  }

  // tags from top-level dirs
  const tagCount = new Map();
  for (const fi of selected) {
    const parts = fi.path.split('/');
    const t = parts.length > 1 ? parts[0] : null;
    if (t) tagCount.set(t, (tagCount.get(t) || 0) + 1);
  }
  const tags = [...tagCount.entries()].filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([t]) => t);
  const tagsFor = (path) => {
    const t = path.split('/')[0];
    return tags.includes(t) ? ['all', t] : ['all'];
  };

  const nodeId = (p) => 'f:' + p;
  const nodes = [];
  for (const fi of selected) {
    nodes.push({
      id: nodeId(fi.path),
      cluster: fi.cluster,
      label: fi.path.split('/').pop(),
      sub: fi.dead ? 'DEAD · zero callers' : fi.path.split('/').slice(0, -1).join('/') || '(root)',
      color: CLUSTER_META[fi.cluster].color,
      path: fi.path,
      role: buildRole(fi),
      plain: '',
      notes: buildNotes(fi, inDeg, outDeg),
      tag: tagsFor(fi.path),
      dead: !!fi.dead,
      loc: fi.loc,
      exports: fi.parsed.exports.slice(0, 12),
      routes: fi.parsed.routes.slice(0, 10),
    });
  }
  for (const [cluster, count] of overflow) {
    nodes.push({
      id: 'more:' + cluster, cluster, label: `+${count} more files`, sub: 'lower-traffic files, hidden for readability',
      color: CLUSTER_META[cluster].color, path: '', role: `${count} additional ${cluster} files with low connectivity.`,
      plain: '', notes: [], tag: ['all'], aggregate: true,
    });
  }

  // external nodes: top packages by usage
  const extSorted = [...externalUse.entries()].sort((a, b) => b[1].size - a[1].size).slice(0, 14);
  for (const [pkg, users] of extSorted) {
    const kind = DB_PACKAGES.has(pkg) ? 'database' : AI_PACKAGES.has(pkg) ? 'AI/LLM' : HTTP_PACKAGES.has(pkg) ? 'HTTP client' : SERVER_FRAMEWORKS.has(pkg) ? 'server framework' : CLIENT_FRAMEWORKS.has(pkg) ? 'UI framework' : 'package';
    nodes.push({
      id: 'ext:' + pkg, cluster: 'external', label: pkg, sub: kind,
      color: 'external', path: '', role: `External ${kind} imported by ${users.size} file${users.size > 1 ? 's' : ''}.`,
      plain: '', notes: [...users].slice(0, 4).map(u => 'used by ' + u), tag: ['all'],
    });
  }

  // edges
  const edges = [];
  const edgeKey = new Set();
  for (const e of internalEdges) {
    if (!selectedSet.has(e.from) || !selectedSet.has(e.to)) continue;
    const k = e.from + '→' + e.to;
    if (edgeKey.has(k)) continue;
    edgeKey.add(k);
    const fromC = fileInfo.find(f => f.path === e.from)?.cluster;
    const kind = fromC === 'entry' ? 'mount' : 'normal';
    edges.push({ from: nodeId(e.from), to: nodeId(e.to), kind, label: 'import', tag: mergeTags(tagsFor(e.from), tagsFor(e.to)) });
  }
  for (const [pkg, users] of extSorted) {
    let count = 0;
    for (const u of users) {
      if (!selectedSet.has(u) || count >= 3) continue;
      count++;
      const kind = DB_PACKAGES.has(pkg) ? 'db' : 'api';
      edges.push({ from: nodeId(u), to: 'ext:' + pkg, kind, label: DB_PACKAGES.has(pkg) ? 'DB read/write' : pkg, tag: tagsFor(u) });
    }
  }

  markCriticalPath(nodes, edges);

  const findings = buildFindings(fileInfo, selected, extSorted, detectedDeps, internalEdges, inDeg);

  const clusters = CLUSTER_ORDER
    .filter(c => nodes.some(n => n.cluster === c))
    .map(c => ({ id: c, label: CLUSTER_META[c].label, color: CLUSTER_META[c].color }));

  return {
    version: 1,
    meta: {
      name: meta.name || 'repository',
      source: meta.source || 'unknown',
      generatedAt: new Date().toISOString(),
      stats: {
        filesScanned: codeFiles.length,
        totalFiles: files.length,
        nodes: nodes.length,
        edges: edges.length,
        frameworks: [...detectedDeps.frameworks],
      },
    },
    clusters, nodes, edges, findings,
    tags: ['all', ...tags],
    fixes: {}, bugs: {},
    ai: { enriched: false },
  };
}

function mergeTags(a, b) { return [...new Set([...a, ...b])]; }

function buildRole(fi) {
  const parts = [];
  if (fi.parsed.routes.length) parts.push(`Defines ${fi.parsed.routes.length} HTTP route${fi.parsed.routes.length > 1 ? 's' : ''} (${fi.parsed.routes.slice(0, 3).join(', ')}${fi.parsed.routes.length > 3 ? ', …' : ''}).`);
  if (fi.parsed.exports.length) parts.push(`Exports ${fi.parsed.exports.slice(0, 5).join(', ')}${fi.parsed.exports.length > 5 ? ` and ${fi.parsed.exports.length - 5} more` : ''}.`);
  if (!parts.length) parts.push(`${fi.loc}-line ${fi.path.endsWith('.py') ? 'Python' : 'JavaScript/TypeScript'} module.`);
  return parts.join(' ');
}

function buildNotes(fi, inDeg, outDeg) {
  const notes = [`${fi.loc} lines`, `${inDeg.get(fi.path) || 0} incoming / ${outDeg.get(fi.path) || 0} outgoing internal imports`];
  if (fi.extCount) notes.push(`${fi.extCount} external package import${fi.extCount > 1 ? 's' : ''}`);
  if (fi.dead) notes.push('No live callers found anywhere in the repo — candidate for deletion');
  return notes;
}

function markCriticalPath(nodes, edges) {
  const byId = new Map(nodes.map(n => [n.id, n]));
  const adj = new Map();
  for (const e of edges) {
    if (!adj.has(e.from)) adj.set(e.from, []);
    adj.get(e.from).push(e);
  }
  const entry = nodes.filter(n => n.cluster === 'entry')[0]
    || nodes.filter(n => !n.aggregate && n.cluster !== 'external').sort((a, b) => (adj.get(b.id)?.length || 0) - (adj.get(a.id)?.length || 0))[0];
  if (!entry) return;
  // BFS from entry, keep the longest shortest-path chain that ends at data/external
  const prev = new Map([[entry.id, null]]);
  const queue = [entry.id];
  let best = entry.id, bestScore = 0;
  while (queue.length) {
    const cur = queue.shift();
    for (const e of adj.get(cur) || []) {
      if (prev.has(e.to)) continue;
      prev.set(e.to, cur);
      queue.push(e.to);
      const n = byId.get(e.to);
      const depth = pathLen(prev, e.to);
      const score = depth + ((n?.cluster === 'data' || n?.cluster === 'external') ? 3 : 0);
      if (score > bestScore) { bestScore = score; best = e.to; }
    }
  }
  // walk back
  const pathIds = [];
  for (let cur = best; cur; cur = prev.get(cur)) pathIds.push(cur);
  if (pathIds.length < 2) return;
  const pathSet = new Set(pathIds);
  for (const n of nodes) if (pathSet.has(n.id)) n.critical = true;
  for (let i = pathIds.length - 1; i > 0; i--) {
    const e = edges.find(e => e.from === pathIds[i] && e.to === pathIds[i - 1]);
    if (e) e.kind = 'critical';
  }
}

function pathLen(prev, id) {
  let n = 0;
  for (let cur = id; cur; cur = prev.get(cur)) n++;
  return n;
}

function buildFindings(fileInfo, selected, extSorted, deps, internalEdges, inDeg) {
  const findings = [];
  const dead = fileInfo.filter(f => f.dead);
  if (dead.length) {
    findings.push(`Dead code: ${dead.length} file${dead.length > 1 ? 's' : ''} with zero live callers — ${dead.slice(0, 5).map(d => d.path).join(', ')}${dead.length > 5 ? ` and ${dead.length - 5} more` : ''}.`);
  }
  const hot = [...inDeg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).filter(([, c]) => c >= 3);
  if (hot.length) {
    findings.push(`Hot paths: ${hot.map(([p, c]) => `${p} (${c} importers)`).join(', ')} — changes here ripple widely.`);
  }
  const big = fileInfo.filter(f => f.loc > 500).sort((a, b) => b.loc - a.loc).slice(0, 3);
  if (big.length) {
    findings.push(`Large files: ${big.map(f => `${f.path} (${f.loc} lines)`).join(', ')} — candidates for splitting.`);
  }
  const ai = extSorted.filter(([p]) => AI_PACKAGES.has(p));
  if (ai.length) findings.push(`LLM/AI integration detected: ${ai.map(([p]) => p).join(', ')}.`);
  const dbs = extSorted.filter(([p]) => DB_PACKAGES.has(p));
  if (dbs.length > 1) findings.push(`Multiple data stores in use: ${dbs.map(([p]) => p).join(', ')} — verify this is intentional.`);
  if (deps.frameworks.size) findings.push(`Stack: ${[...deps.frameworks].join(', ')}.`);
  if (!findings.length) findings.push('No dead code, oversized files, or unusual couplings surfaced by static analysis.');
  return findings;
}
