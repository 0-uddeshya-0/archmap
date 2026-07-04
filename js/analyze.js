// ArchMap static analysis engine.
// Input:  files = [{ path, content, size }]
// Output: archmap data object — computed truth only, no guesses.
//
// Two resolution strategies (pattern adapted from glato/emerge, MIT):
//  - path languages (JS/TS, Python, Ruby, PHP requires, C includes, Rust mod):
//    imports are file paths, resolved against the file tree
//  - symbol languages (C#, Java, Kotlin, Go, Rust use, PHP use):
//    pass 1 records what each file PROVIDES (namespace/package declarations),
//    pass 2 matches imports against that provider table by longest prefix

const CODE_EXT = /\.(js|jsx|ts|tsx|mjs|cjs|py|cs|go|java|kt|kts|rs|rb|php|c|h|cpp|hpp|cc|hh|cxx|hxx)$/;
const SKIP_DIRS = /(^|\/)(node_modules|\.git|dist|build|out|\.next|\.nuxt|coverage|vendor|venv|\.venv|__pycache__|\.cache|target|\.turbo|\.svelte-kit|bin|obj|Library|Temp|third_party|external)(\/|$)/;
const TEST_FILE = /(^|\/)(tests?|__tests__|spec|testFixtures|androidTest)(\/|$)|\.(test|spec)\.[jt]sx?$|(^|\/)test_.*\.py$|_test\.(py|go)$|Tests?\.cs$|Tests?\.java$/;
// vendored third-party trees (Unity packages, plugins) — analyzable but never "dead"
const VENDORED = /(^|\/)(Packages\/com\.|Plugins\/|ThirdParty\/|Vendor\/)/i;
const MAX_FILE_SIZE = 300 * 1024;
const MAX_NODES = 80;

const LANG_BY_EXT = {
  js: 'js', jsx: 'js', ts: 'js', tsx: 'js', mjs: 'js', cjs: 'js',
  py: 'py', cs: 'cs', go: 'go', java: 'jvm', kt: 'jvm', kts: 'jvm',
  rs: 'rs', rb: 'rb', php: 'php',
  c: 'c', h: 'c', cpp: 'c', hpp: 'c', cc: 'c', hh: 'c', cxx: 'c', hxx: 'c',
};

const DB_PACKAGES = new Set(['pg', 'mysql', 'mysql2', 'mongoose', 'mongodb', 'sqlite3', 'better-sqlite3', 'prisma', '@prisma/client', 'sequelize', 'typeorm', 'knex', 'drizzle-orm', 'redis', 'ioredis', 'sqlalchemy', 'psycopg2', 'pymongo', 'peewee', 'django.db', 'supabase', '@supabase/supabase-js', 'firebase-admin', 'firebase', 'database/sql', 'gorm.io', 'go-redis', 'Microsoft.EntityFrameworkCore', 'System.Data', 'Dapper', 'diesel', 'sqlx', 'sea-orm', 'java.sql', 'javax.persistence', 'jakarta.persistence', 'org.hibernate', 'ActiveRecord']);
const HTTP_PACKAGES = new Set(['axios', 'node-fetch', 'got', 'undici', 'superagent', 'requests', 'httpx', 'aiohttp', 'urllib3', 'net/http', 'System.Net.Http', 'reqwest', 'okhttp3', 'java.net.http', 'Guzzle']);
const AI_PACKAGES = new Set(['openai', 'anthropic', '@anthropic-ai/sdk', 'langchain', '@google/generative-ai', 'cohere-ai', 'replicate', 'transformers', 'tiktoken']);
const SERVER_FRAMEWORKS = new Set(['express', 'fastify', 'koa', 'hapi', '@hapi/hapi', 'flask', 'django', 'fastapi', 'starlette', 'sanic', 'bottle', 'hono', 'nest', '@nestjs/core']);
const CLIENT_FRAMEWORKS = new Set(['react', 'react-dom', 'vue', 'svelte', 'preact', 'solid-js', '@angular/core', 'next', 'nuxt']);
// well-known runtime/framework namespaces for symbol languages (external, typed)
const SYMBOL_FRAMEWORKS = { UnityEngine: 'Unity engine', UnityEditor: 'Unity editor', 'Microsoft.AspNetCore': 'ASP.NET Core', 'System.Net.Http': 'HTTP client', 'org.springframework': 'Spring', 'gin-gonic/gin': 'Gin', 'labstack/echo': 'Echo', actix_web: 'Actix Web', axum: 'Axum', tokio: 'Tokio runtime', rails: 'Rails', Laravel: 'Laravel' };

export function isAnalyzableFile(path, size) {
  return CODE_EXT.test(path) && !SKIP_DIRS.test(path) && (!size || size <= MAX_FILE_SIZE);
}

export function isManifest(path) {
  return /(^|\/)(package\.json|pyproject\.toml|requirements\.txt|setup\.py|go\.mod|Cargo\.toml|Gemfile|composer\.json|pom\.xml|build\.gradle(\.kts)?|[\w.-]+\.csproj|README\.md|readme\.md)$/.test(path) && !SKIP_DIRS.test(path);
}

// ---------------------------------------------------------------- parsing

function lang(path) {
  return LANG_BY_EXT[path.split('.').pop().toLowerCase()] || 'js';
}

function stripComments(src, l) {
  if (l === 'py') return src.replace(/'''[\s\S]*?'''|"""[\s\S]*?"""/g, '').replace(/#[^\n]*/g, '');
  if (l === 'rb') return src.replace(/#[^\n]*/g, '');
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

// Every parser returns:
// { pathImports: [spec], symImports: [dotted/sep symbol], provides: [symbol],
//   externalHints: [pkg], exports: [name], routes: [str], hasMain: bool }
const EMPTY = () => ({ pathImports: [], symImports: [], provides: [], externalHints: [], exports: [], routes: [], hasMain: false });

function parseJS(src) {
  const p = EMPTY();
  let m;
  for (const re of [
    /import\s+(?:[\w${},*\s]+?\s+from\s+)?['"]([^'"\n]+)['"]/g,
    /require\(\s*['"]([^'"\n]+)['"]\s*\)/g,
    /import\(\s*['"]([^'"\n]+)['"]\s*\)/g,
  ]) while ((m = re.exec(src))) p.pathImports.push(m[1]);
  const exportRe = /export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|class|const|let|var)\s+([\w$]+)/g;
  while ((m = exportRe.exec(src))) p.exports.push(m[1]);
  const exportBraceRe = /export\s*\{([^}]+)\}/g;
  while ((m = exportBraceRe.exec(src))) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (name && /^[\w$]+$/.test(name)) p.exports.push(name);
    }
  }
  const cjsExportRe = /(?:module\.)?exports\.([\w$]+)\s*=/g;
  while ((m = cjsExportRe.exec(src))) p.exports.push(m[1]);
  const routeRe = /\b(?:app|router|server|api)\.(get|post|put|delete|patch|use|all)\(\s*['"`]([^'"`\n]+)['"`]/g;
  while ((m = routeRe.exec(src))) p.routes.push(`${m[1].toUpperCase()} ${m[2]}`);
  return p;
}

function parsePY(src) {
  const p = EMPTY();
  p.hasMain = src.includes('__main__');
  let m;
  const fromRe = /^\s*from\s+([\w.]+)\s+import\s+/gm;
  while ((m = fromRe.exec(src))) p.pathImports.push(m[1]);
  const impRe = /^\s*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)/gm;
  while ((m = impRe.exec(src))) for (const mod of m[1].split(',')) p.pathImports.push(mod.trim());
  const defRe = /^(?:def|class)\s+([\w]+)/gm;
  while ((m = defRe.exec(src))) p.exports.push(m[1]);
  const flaskRe = /@\s*(?:app|bp|blueprint|router)\.(?:route|get|post|put|delete|patch)\(\s*['"]([^'"\n]+)['"]/g;
  while ((m = flaskRe.exec(src))) p.routes.push(m[1]);
  return p;
}

function parseCS(src) {
  const p = EMPTY();
  let m;
  const nsRe = /^\s*namespace\s+([\w.]+)/gm;
  while ((m = nsRe.exec(src))) p.provides.push(m[1]);
  const usingRe = /^\s*(?:global\s+)?using\s+(?:static\s+)?(?!var\b)([A-Z][\w.]*)\s*;/gm;
  while ((m = usingRe.exec(src))) p.symImports.push(m[1]);
  const typeRe = /(?:public|internal|protected)?\s*(?:static\s+|abstract\s+|sealed\s+|partial\s+)*(?:class|struct|interface|enum|record)\s+([A-Z]\w*)/g;
  while ((m = typeRe.exec(src))) p.exports.push(m[1]);
  const routeAttr = /\[Http(Get|Post|Put|Delete|Patch)(?:\(\s*"([^"]*)"\s*\))?\]|\[Route\(\s*"([^"]*)"\s*\)\]/g;
  while ((m = routeAttr.exec(src))) p.routes.push(m[2] || m[3] ? `${(m[1] || 'ROUTE').toUpperCase()} ${m[2] || m[3]}` : (m[1] || 'ROUTE').toUpperCase());
  if (/static\s+(?:async\s+Task\s+|void\s+|int\s+)Main\s*\(/.test(src)) p.hasMain = true;
  return p;
}

function parseJVM(src) {
  const p = EMPTY();
  let m;
  const pkgRe = /^\s*package\s+([\w.]+)/m;
  if ((m = pkgRe.exec(src))) p.provides.push(m[1]);
  const impRe = /^\s*import\s+(?:static\s+)?([\w.]+)(?:\.\*)?/gm;
  while ((m = impRe.exec(src))) p.symImports.push(m[1]);
  const typeRe = /(?:public|internal|private)?\s*(?:abstract\s+|final\s+|open\s+|data\s+|sealed\s+)*(?:class|interface|enum|object|record)\s+([A-Z]\w*)/g;
  while ((m = typeRe.exec(src))) p.exports.push(m[1]);
  const springRe = /@(?:Get|Post|Put|Delete|Patch|Request)Mapping\(\s*(?:value\s*=\s*)?"([^"]+)"/g;
  while ((m = springRe.exec(src))) p.routes.push(m[1]);
  if (/fun\s+main\s*\(|static\s+void\s+main\s*\(/.test(src)) p.hasMain = true;
  return p;
}

function parseGO(src) {
  const p = EMPTY();
  let m;
  const pkgRe = /^\s*package\s+(\w+)/m;
  if ((m = pkgRe.exec(src))) p.provides.push(m[1]); // dir path is added by the analyzer
  const blockRe = /import\s*\(([\s\S]*?)\)/g;
  while ((m = blockRe.exec(src))) {
    let im;
    const line = /"([^"\n]+)"/g;
    while ((im = line.exec(m[1]))) p.symImports.push(im[1]);
  }
  const singleRe = /^\s*import\s+(?:\w+\s+)?"([^"\n]+)"/gm;
  while ((m = singleRe.exec(src))) p.symImports.push(m[1]);
  const fnRe = /^func\s+(?:\([^)]*\)\s+)?([A-Z]\w*)/gm;
  while ((m = fnRe.exec(src))) p.exports.push(m[1]);
  const typeRe = /^type\s+([A-Z]\w*)/gm;
  while ((m = typeRe.exec(src))) p.exports.push(m[1]);
  const routeRe = /\.\s*(GET|POST|PUT|DELETE|PATCH|Handle(?:Func)?)\(\s*"([^"\n]+)"/g;
  while ((m = routeRe.exec(src))) p.routes.push(`${m[1] === 'HandleFunc' || m[1] === 'Handle' ? 'ROUTE' : m[1]} ${m[2]}`);
  if (/^func\s+main\s*\(/m.test(src)) p.hasMain = true;
  return p;
}

function parseRS(src) {
  const p = EMPTY();
  let m;
  const useRe = /^\s*(?:pub\s+)?use\s+crate::([\w:]+)/gm;
  while ((m = useRe.exec(src))) p.symImports.push(m[1].split('::').slice(0, 3).join('::'));
  const modRe = /^\s*(?:pub\s+)?mod\s+(\w+)\s*;/gm;
  while ((m = modRe.exec(src))) p.pathImports.push(m[1]); // resolved as sibling file
  const extRe = /^\s*(?:pub\s+)?use\s+([a-z_][\w]*)::/gm;
  while ((m = extRe.exec(src))) {
    if (!['crate', 'self', 'super', 'std', 'core', 'alloc'].includes(m[1])) p.externalHints.push(m[1]);
  }
  const itemRe = /^\s*pub\s+(?:async\s+)?(?:fn|struct|enum|trait|type|const)\s+(\w+)/gm;
  while ((m = itemRe.exec(src))) p.exports.push(m[1]);
  if (/^fn\s+main\s*\(/m.test(src)) p.hasMain = true;
  return p;
}

function parseRB(src) {
  const p = EMPTY();
  let m;
  const relRe = /require_relative\s+['"]([^'"\n]+)['"]/g;
  while ((m = relRe.exec(src))) p.pathImports.push('./' + m[1]);
  const reqRe = /^\s*require\s+['"]([^'"\n]+)['"]/gm;
  while ((m = reqRe.exec(src))) p.externalHints.push(m[1].split('/')[0]);
  const defRe = /^\s*(?:class|module)\s+([A-Z]\w*)/gm;
  while ((m = defRe.exec(src))) p.exports.push(m[1]);
  const routeRe = /^\s*(get|post|put|delete|patch)\s+['"]([^'"\n]+)['"]/gm;
  while ((m = routeRe.exec(src))) p.routes.push(`${m[1].toUpperCase()} ${m[2]}`);
  return p;
}

function parsePHP(src) {
  const p = EMPTY();
  let m;
  const nsRe = /^\s*namespace\s+([\w\\]+)/m;
  if ((m = nsRe.exec(src))) p.provides.push(m[1].replace(/\\/g, '.'));
  const useRe = /^\s*use\s+([\w\\]+)/gm;
  while ((m = useRe.exec(src))) p.symImports.push(m[1].replace(/\\/g, '.'));
  const incRe = /(?:require|include)(?:_once)?\s*\(?\s*(?:__DIR__\s*\.\s*)?['"]\.?\/?([^'"\n]+\.php)['"]/g;
  while ((m = incRe.exec(src))) p.pathImports.push('./' + m[1]);
  const clsRe = /^\s*(?:abstract\s+|final\s+)?(?:class|interface|trait|enum)\s+(\w+)/gm;
  while ((m = clsRe.exec(src))) p.exports.push(m[1]);
  return p;
}

function parseC(src) {
  const p = EMPTY();
  let m;
  const localRe = /#include\s+"([^"\n]+)"/g;
  while ((m = localRe.exec(src))) p.pathImports.push('./' + m[1]);
  const sysRe = /#include\s+<([^>\n]+)>/g;
  while ((m = sysRe.exec(src))) p.externalHints.push(m[1].split('/')[0].replace(/\.h.*$/, ''));
  const fnRe = /^[A-Za-z_][\w\s*]*?\s\*?([A-Za-z_]\w*)\s*\([^;{]*\)\s*\{/gm;
  while ((m = fnRe.exec(src))) if (m[1] !== 'if' && m[1] !== 'for' && m[1] !== 'while' && m[1] !== 'switch') p.exports.push(m[1]);
  if (/\bint\s+main\s*\(/.test(src)) p.hasMain = true;
  return p;
}

const PARSERS = { js: parseJS, py: parsePY, cs: parseCS, jvm: parseJVM, go: parseGO, rs: parseRS, rb: parseRB, php: parsePHP, c: parseC };

// -------------------------------------------------------- path resolution

function normalize(path) {
  const parts = [];
  for (const p of path.split('/')) {
    if (p === '..') parts.pop();
    else if (p !== '.' && p !== '') parts.push(p);
  }
  return parts.join('/');
}

const JS_CANDIDATES = ['', '.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs', '/index.js', '/index.ts', '/index.jsx', '/index.tsx'];

function suffixMatch(cand, fileSet, exts) {
  let best = null;
  for (const ext of exts) {
    const target = cand + ext;
    for (const f of fileSet) {
      if (f === target || f.endsWith('/' + target)) {
        if (!best || f.length < best.length) best = f;
      }
    }
    if (best) return best;
  }
  return null;
}

function resolveRelative(fromPath, spec, fileSet, exts) {
  const dir = fromPath.split('/').slice(0, -1).join('/');
  const base = normalize(dir ? dir + '/' + spec : spec);
  for (const c of exts) if (fileSet.has(base + c)) return base + c;
  return null;
}

function resolvePathImport(fromPath, spec, fileSet, l) {
  if (l === 'js') {
    if (spec.startsWith('.') || spec.startsWith('/')) {
      const hit = resolveRelative(fromPath, spec, fileSet, JS_CANDIDATES);
      if (hit) return hit;
      // TS-ESM convention: source imports './x.js' but the file on disk is x.ts
      const dir = fromPath.split('/').slice(0, -1).join('/');
      const base = normalize(dir ? dir + '/' + spec : spec);
      const esm = base.match(/^(.*)\.(m|c)?js$/);
      if (esm) for (const ext of ['.ts', '.tsx', `.${esm[2] || ''}ts`]) if (fileSet.has(esm[1] + ext)) return esm[1] + ext;
      return null;
    }
    const aliasMatch = spec.match(/^(?:@\/|~\/|#)(.+)$/);
    if (aliasMatch) return suffixMatch(aliasMatch[1], fileSet, JS_CANDIDATES);
    const ws = spec.match(/^@[\w.-]+\/([\w.-]+)(?:\/(.+))?$/);
    if (ws) {
      const [, name, sub] = ws;
      for (const root of ['packages/', 'libs/', 'apps/', '']) {
        for (const c of sub ? [`${root}${name}/src/${sub}`, `${root}${name}/${sub}`] : [`${root}${name}/src/index`, `${root}${name}/index`, `${root}${name}/src/main`]) {
          const hit = suffixMatch(c, fileSet, JS_CANDIDATES);
          if (hit) return hit;
        }
      }
    }
    return null;
  }
  if (l === 'py') {
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
      const root = fromPath.split('/')[0];
      if (root && root !== rel.split('/')[0]) candidates.push(root + '/' + rel);
    }
    for (const c of candidates) {
      if (fileSet.has(c + '.py')) return c + '.py';
      if (fileSet.has(c + '/__init__.py')) return c + '/__init__.py';
    }
    if (rel.includes('/')) {
      let best = null;
      for (const f of fileSet) {
        if (f.endsWith('/' + rel + '.py') || f.endsWith('/' + rel + '/__init__.py')) {
          if (!best || f.length < best.length) best = f;
        }
      }
      return best;
    }
    return null;
  }
  if (l === 'rs') {
    // `mod x;` → sibling x.rs or x/mod.rs
    const dir = fromPath.split('/').slice(0, -1).join('/');
    for (const c of [`${dir}/${spec}.rs`, `${dir}/${spec}/mod.rs`]) if (fileSet.has(c)) return c;
    return null;
  }
  if (l === 'rb') return resolveRelative(fromPath, spec, fileSet, ['', '.rb']);
  if (l === 'php') return resolveRelative(fromPath, spec, fileSet, ['']);
  if (l === 'c') {
    const hit = resolveRelative(fromPath, spec, fileSet, ['']);
    if (hit) return hit;
    return suffixMatch(spec.replace(/^\.\//, ''), fileSet, ['']);
  }
  return null;
}

function packageName(spec) {
  if (spec.startsWith('@')) return spec.split('/').slice(0, 2).join('/');
  return spec.split('/')[0].split('.')[0];
}

// external label for an unresolved symbol import
function symbolPackage(sym, l) {
  if (l === 'go') {
    const parts = sym.split('/');
    return parts[0].includes('.') ? parts.slice(0, 3).join('/') : parts[0]; // github.com/x/y vs stdlib net/http
  }
  const parts = sym.split('.');
  if (l === 'jvm') return parts.slice(0, ['com', 'org', 'io', 'net', 'dev'].includes(parts[0]) ? 3 : 2).join('.');
  if (l === 'cs') return parts.slice(0, parts[0] === 'System' || parts[0] === 'Microsoft' ? 2 : 1).join('.');
  return parts.slice(0, 2).join('.');
}

// -------------------------------------------------------- cluster inference

function classify(path, parsed, deps, l) {
  const p = path.toLowerCase();
  const base = p.split('/').pop();
  if (TEST_FILE.test(path)) return 'tests';
  if (/(^|\/)(pages|app)\/.+\.(jsx?|tsx?)$/.test(p) && deps.hasClientFw) return 'client';
  if (/(^|\/)(components|hooks|views|screens|ui|frontend|client|public|src\/app)(\/|$)/.test(p)) return 'client';
  if (parsed.routes.length > 0) return 'routes';
  if (/(^|\/)(routes|routers|controllers?|api|endpoints|handlers|urls)(\/|$)|urls\.py$|views\.py$|controller\.(cs|java|kt|rb|php)$/.test(p)) return 'routes';
  if (/(^|\/)(models?|schemas?|db|database|migrations|entities|repositor(y|ies)|dao|stores?|data)(\/|$)|models\.py$|schema\.(js|ts|py)$|repository\.(cs|java|kt)$/.test(p)) return 'data';
  if (parsed.hasMain && path.split('/').length <= 3) return 'entry';
  if (/^(index|main|app|server|cli|manage|wsgi|asgi|__main__|program)\.\w+$/.test(base) && path.split('/').length <= 2) return 'entry';
  if (/(^|\/)cmd\/[^/]+\/main\.go$/.test(p)) return 'entry';
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
  if (!codeFiles.length) {
    const exts = [...new Set(files.map(f => f.path.split('.').pop()))].slice(0, 8).join(', ');
    throw new Error(`No recognizable source files found (saw: ${exts}). ArchMap supports JS/TS, Python, C#, Go, Java, Kotlin, Rust, Ruby, PHP, and C/C++.`);
  }
  const fileSet = new Set(codeFiles.map(f => f.path));
  const parsedMap = new Map();
  const detectedDeps = { hasClientFw: false, frameworks: new Set() };
  let goModule = null;

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
      } catch { /* malformed */ }
    }
    if (/(^|\/)go\.mod$/.test(f.path)) {
      const m = f.content.match(/^module\s+(\S+)/m);
      if (m) goModule = m[1];
    }
  }

  // pass 1: parse everything + build the provider table (symbol → files)
  const providers = new Map(); // symbol -> [path]
  const dirProviders = new Map(); // go: package dir -> [path]
  const addProvider = (map, key, path) => {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(path);
  };
  for (const f of codeFiles) {
    const l = lang(f.path);
    const src = stripComments(f.content, l);
    const parsed = (PARSERS[l] || parseJS)(src);
    parsed.lang = l;
    parsedMap.set(f.path, parsed);
    for (const ns of parsed.provides) addProvider(providers, ns, f.path);
    if (l === 'go' && !TEST_FILE.test(f.path)) {
      const dir = f.path.split('/').slice(0, -1).join('/');
      addProvider(dirProviders, dir || '.', f.path);
    }
    if (l === 'rs') {
      // module path from file location: src/a/b.rs → a::b, src/a/mod.rs → a
      const parts = f.path.replace(/\.rs$/, '').split('/');
      const srcIdx = parts.lastIndexOf('src');
      let mods = srcIdx >= 0 ? parts.slice(srcIdx + 1) : parts;
      if (mods[mods.length - 1] === 'mod') mods = mods.slice(0, -1);
      if (mods.length && mods[0] !== 'main' && mods[0] !== 'lib') addProvider(providers, mods.join('::'), f.path);
    }
  }

  // pass 2: build edges
  const internalEdges = [];
  const externalUse = new Map(); // pkg -> { files:Set, kindHint }
  const useExternal = (pkg, path, l) => {
    if (!pkg) return;
    if (!externalUse.has(pkg)) externalUse.set(pkg, { files: new Set(), lang: l });
    externalUse.get(pkg).files.add(path);
  };
  const matchSymbol = (sym, sep) => {
    // longest-prefix match against the provider table
    const parts = sym.split(sep);
    for (let n = parts.length; n >= 1; n--) {
      const key = parts.slice(0, n).join(sep);
      if (providers.has(key)) return providers.get(key);
    }
    return null;
  };

  for (const f of codeFiles) {
    const parsed = parsedMap.get(f.path);
    const l = parsed.lang;
    const seen = new Set();
    const link = (to) => {
      if (to && to !== f.path && !seen.has(to)) { internalEdges.push({ from: f.path, to }); seen.add(to); }
    };
    for (const spec of parsed.pathImports) {
      const resolved = resolvePathImport(f.path, spec, fileSet, l);
      if (resolved) link(resolved);
      else if (l === 'js' && !spec.startsWith('.') && !spec.startsWith('/')) useExternal(packageName(spec), f.path, l);
      else if (l === 'py' && !spec.startsWith('.')) useExternal(spec.split('.')[0], f.path, l);
    }
    for (const sym of parsed.symImports) {
      if (l === 'go') {
        let matched = null;
        const imp = goModule && sym.startsWith(goModule) ? sym.slice(goModule.length).replace(/^\//, '') || '.' : sym;
        for (const [dir, paths] of dirProviders) {
          if (imp === dir || sym.endsWith('/' + dir)) { matched = paths; break; }
        }
        if (matched) matched.slice(0, 3).forEach(link);
        else useExternal(symbolPackage(sym, l), f.path, l);
        continue;
      }
      const sep = l === 'rs' ? '::' : '.';
      const matched = matchSymbol(sym, sep);
      if (matched) matched.slice(0, 3).forEach(link);
      else if (l !== 'rs') useExternal(symbolPackage(sym, l), f.path, l);
    }
    for (const hint of parsed.externalHints) useExternal(hint, f.path, l);
  }

  // degree
  const inDeg = new Map(), outDeg = new Map();
  for (const e of internalEdges) {
    outDeg.set(e.from, (outDeg.get(e.from) || 0) + 1);
    inDeg.set(e.to, (inDeg.get(e.to) || 0) + 1);
  }

  const fileInfo = codeFiles.map(f => {
    const parsed = parsedMap.get(f.path);
    const cluster = classify(f.path, parsed, detectedDeps, parsed.lang);
    const loc = f.content.split('\n').length;
    const degree = (inDeg.get(f.path) || 0) + (outDeg.get(f.path) || 0);
    const extCount = parsed.externalHints.length + parsed.symImports.length ? 1 : 0;
    return { path: f.path, parsed, cluster, loc, degree, extCount };
  });

  // dead code
  const allSource = codeFiles.map(f => ({ path: f.path, content: f.content }));
  const STANDALONE_DIRS = /(^|\/)(examples?|docs?|docs_src|samples?|demos?|scripts?|benchmarks?)(\/|$)/i;
  for (const fi of fileInfo) {
    if (fi.cluster === 'entry' || fi.cluster === 'client' || fi.cluster === 'tests') continue;
    if (STANDALONE_DIRS.test(fi.path) || VENDORED.test(fi.path)) continue;
    if (fi.parsed.routes.length || fi.parsed.hasMain) continue;
    // Unity: MonoBehaviours, ScriptableObjects, Editor scripts, and [MenuItem]
    // entry points are engine-instantiated, never imported
    if (fi.parsed.lang === 'cs') {
      if (/(^|\/)Editor(\/|$)/.test(fi.path)) continue;
      if (/MonoBehaviour|ScriptableObject|EditorWindow|\[MenuItem/.test(allSource.find(s => s.path === fi.path)?.content || '')) continue;
    }
    if ((inDeg.get(fi.path) || 0) > 0) continue;
    const referenced = fi.parsed.exports.some(name =>
      name.length > 2 && allSource.some(s => s.path !== fi.path && s.content.includes(name)));
    fi.dead = !referenced && fi.parsed.exports.length > 0;
  }

  fileInfo.sort((a, b) => (b.degree + (b.dead ? 5 : 0)) - (a.degree + (a.dead ? 5 : 0)));
  const selected = fileInfo.slice(0, MAX_NODES);
  const selectedSet = new Set(selected.map(f => f.path));
  const overflow = new Map();
  for (const fi of fileInfo.slice(MAX_NODES)) overflow.set(fi.cluster, (overflow.get(fi.cluster) || 0) + 1);

  // tags
  const tagOf = (path, depth) => {
    const parts = path.split('/');
    return parts.length > depth ? parts.slice(0, depth).join('/') : null;
  };
  let tagDepth = 1;
  {
    const top = new Map();
    for (const fi of selected) {
      const t = tagOf(fi.path, 1);
      if (t) top.set(t, (top.get(t) || 0) + 1);
    }
    const max = Math.max(0, ...top.values());
    if (top.size <= 2 && max > selected.length * 0.7) tagDepth = 2;
  }
  const tagCount = new Map();
  for (const fi of selected) {
    const t = tagOf(fi.path, tagDepth);
    if (t) tagCount.set(t, (tagCount.get(t) || 0) + 1);
  }
  const tags = [...tagCount.entries()].filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([t]) => t);
  const tagsFor = (path) => {
    const t = tagOf(path, tagDepth);
    return t && tags.includes(t) ? ['all', t] : ['all'];
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

  const extSorted = [...externalUse.entries()].sort((a, b) => b[1].files.size - a[1].files.size).slice(0, 14);
  for (const [pkg, info] of extSorted) {
    const kind = SYMBOL_FRAMEWORKS[pkg] || (DB_PACKAGES.has(pkg) ? 'database' : AI_PACKAGES.has(pkg) ? 'AI/LLM' : HTTP_PACKAGES.has(pkg) ? 'HTTP client' : SERVER_FRAMEWORKS.has(pkg) ? 'server framework' : CLIENT_FRAMEWORKS.has(pkg) ? 'UI framework' : 'package');
    nodes.push({
      id: 'ext:' + pkg, cluster: 'external', label: pkg, sub: kind,
      color: 'external', path: '', role: `External ${kind} imported by ${info.files.size} file${info.files.size > 1 ? 's' : ''}.`,
      plain: '', notes: [...info.files].slice(0, 4).map(u => 'used by ' + u), tag: ['all'],
    });
  }

  const edges = [];
  const edgeKey = new Set();
  const clusterOf = new Map(fileInfo.map(f => [f.path, f.cluster]));
  for (const e of internalEdges) {
    if (!selectedSet.has(e.from) || !selectedSet.has(e.to)) continue;
    const k = e.from + '→' + e.to;
    if (edgeKey.has(k)) continue;
    edgeKey.add(k);
    const kind = clusterOf.get(e.from) === 'entry' ? 'mount' : 'normal';
    edges.push({ from: nodeId(e.from), to: nodeId(e.to), kind, label: 'import', tag: mergeTags(tagsFor(e.from), tagsFor(e.to)) });
  }
  for (const [pkg, info] of extSorted) {
    let count = 0;
    for (const u of info.files) {
      if (!selectedSet.has(u) || count >= 3) continue;
      count++;
      const kind = DB_PACKAGES.has(pkg) ? 'db' : 'api';
      edges.push({ from: nodeId(u), to: 'ext:' + pkg, kind, label: DB_PACKAGES.has(pkg) ? 'DB read/write' : pkg, tag: tagsFor(u) });
    }
  }

  markCriticalPath(nodes, edges);
  const findings = buildFindings(fileInfo, extSorted, detectedDeps, inDeg);
  const clusters = CLUSTER_ORDER
    .filter(c => nodes.some(n => n.cluster === c))
    .map(c => ({ id: c, label: CLUSTER_META[c].label, color: CLUSTER_META[c].color }));

  const langCounts = {};
  for (const f of codeFiles) langCounts[lang(f.path)] = (langCounts[lang(f.path)] || 0) + 1;

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
        languages: langCounts,
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

const LANG_LABEL = { js: 'JavaScript/TypeScript', py: 'Python', cs: 'C#', go: 'Go', jvm: 'Java/Kotlin', rs: 'Rust', rb: 'Ruby', php: 'PHP', c: 'C/C++' };

function buildRole(fi) {
  const parts = [];
  if (fi.parsed.routes.length) parts.push(`Defines ${fi.parsed.routes.length} HTTP route${fi.parsed.routes.length > 1 ? 's' : ''} (${fi.parsed.routes.slice(0, 3).join(', ')}${fi.parsed.routes.length > 3 ? ', …' : ''}).`);
  if (fi.parsed.exports.length) parts.push(`Exports ${fi.parsed.exports.slice(0, 5).join(', ')}${fi.parsed.exports.length > 5 ? ` and ${fi.parsed.exports.length - 5} more` : ''}.`);
  if (!parts.length) parts.push(`${fi.loc}-line ${LANG_LABEL[fi.parsed.lang] || ''} module.`);
  return parts.join(' ');
}

function buildNotes(fi, inDeg, outDeg) {
  const notes = [`${fi.loc} lines · ${LANG_LABEL[fi.parsed.lang] || ''}`, `${inDeg.get(fi.path) || 0} incoming / ${outDeg.get(fi.path) || 0} outgoing internal references`];
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
  const byOutDeg = nodes
    .filter(n => !n.aggregate && n.cluster !== 'external' && n.cluster !== 'tests')
    .sort((a, b) => (adj.get(b.id)?.length || 0) - (adj.get(a.id)?.length || 0));
  const candidates = [...nodes.filter(n => n.cluster === 'entry'), ...byOutDeg.slice(0, 3)];
  for (const entry of candidates) {
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
    const pathIds = [];
    for (let cur = best; cur; cur = prev.get(cur)) pathIds.push(cur);
    if (pathIds.length < 2) continue;
    const pathSet = new Set(pathIds);
    for (const n of nodes) if (pathSet.has(n.id)) n.critical = true;
    for (let i = pathIds.length - 1; i > 0; i--) {
      const e = edges.find(e => e.from === pathIds[i] && e.to === pathIds[i - 1]);
      if (e) e.kind = 'critical';
    }
    return;
  }
}

function pathLen(prev, id) {
  let n = 0;
  for (let cur = id; cur; cur = prev.get(cur)) n++;
  return n;
}

function buildFindings(fileInfo, extSorted, deps, inDeg) {
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
