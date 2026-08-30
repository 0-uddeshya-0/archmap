// Analyzer unit tests — run with: node --test tools/
import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../js/analyze.js';

const f = (path, content) => ({ path, content, size: content.length });

test('JS import resolution builds real edges with file:line evidence', () => {
  const data = analyze([
    f('src/app.js', `import { helper } from './lib/helper.js';\nexport const main = () => helper();`),
    f('src/lib/helper.js', `export function helper() { return 1; }`),
  ]);
  const e = data.edges.find(e => e.from === 'f:src/app.js' && e.to === 'f:src/lib/helper.js');
  assert.ok(e, 'edge exists');
  assert.equal(e.ev, 'src/app.js:1', 'evidence cites the import line');
  assert.equal(e.spec, './lib/helper.js', 'evidence keeps the import specifier');
});

test('evidence line numbers survive comment stripping', () => {
  const data = analyze([
    f('a.js', `/* a\n block\n comment */\n// line comment\nimport { x } from './b.js';\nexport const a = () => x();`),
    f('b.js', `export const x = () => 1;`),
  ]);
  const e = data.edges.find(e => e.from === 'f:a.js' && e.to === 'f:b.js');
  assert.equal(e.ev, 'a.js:5', 'line number accounts for comment lines');
});

test('Python from-import resolves and routes are extracted', () => {
  const data = analyze([
    f('app.py', `from utils import x\nfrom flask import Flask\napp = Flask(__name__)\n@app.route('/health')\ndef health():\n    return 'ok'\n`),
    f('utils.py', `def x():\n    return 1\n`),
  ]);
  assert.ok(data.edges.some(e => e.from === 'f:app.py' && e.to === 'f:utils.py'));
  const appNode = data.nodes.find(n => n.id === 'f:app.py');
  assert.ok(appNode.routes.includes('/health'));
});

test('Express routes are extracted', () => {
  const data = analyze([
    f('server.js', `const express = require('express');\nconst app = express();\napp.get('/api/users', (req, res) => res.json([]));\napp.listen(3000);`),
  ]);
  const n = data.nodes.find(n => n.id === 'f:server.js');
  assert.ok(n.routes.includes('GET /api/users'));
});

test('circular imports are detected and flagged', () => {
  const data = analyze([
    f('src/a.js', `import { b } from './b.js';\nexport const a = () => b();`),
    f('src/b.js', `import { a } from './a.js';\nexport const b = () => a();`),
  ]);
  assert.ok(data.findings.some(x => x.startsWith('Circular imports')), 'finding present');
  const cyc = data.edges.filter(e => e.cycle);
  assert.equal(cyc.length, 2, 'both edges of the 2-cycle flagged');
});

test('dead code: exported but never referenced', () => {
  const data = analyze([
    f('src/index.js', `import { used } from './services/used.js';\nused();`),
    f('src/services/used.js', `export function used() {}`),
    f('src/services/orphan.js', `export function orphanHelperFn() { return 42; }`),
  ]);
  const orphan = data.nodes.find(n => n.id === 'f:src/services/orphan.js');
  assert.ok(orphan.dead, 'orphan flagged dead');
  const used = data.nodes.find(n => n.id === 'f:src/services/used.js');
  assert.ok(!used.dead, 'used file not flagged');
});

test('external packages become external nodes with evidence', () => {
  const data = analyze([
    f('src/db.js', `import pg from 'pg';\nexport const pool = new pg.Pool();`),
  ]);
  const ext = data.nodes.find(n => n.id === 'ext:pg');
  assert.ok(ext, 'pg external node exists');
  assert.equal(ext.sub, 'database');
  const e = data.edges.find(e => e.to === 'ext:pg');
  assert.equal(e.ev, 'src/db.js:1', 'external edge carries evidence');
});

test('big repos overflow into aggregates with a full inventory', () => {
  const files = [f('src/index.js', Array.from({ length: 120 }, (_, i) => `import { s${i} } from './services/s${i}.js';`).join('\n'))];
  for (let i = 0; i < 120; i++) {
    files.push(f(`src/services/s${i}.js`, `import { core } from '../core.js';\nexport function s${i}() { return core(); }`));
  }
  files.push(f('src/core.js', `export function core() { return 1; }`));
  const data = analyze(files);
  const agg = data.nodes.find(n => n.aggregate);
  assert.ok(agg, 'aggregate node exists');
  assert.ok(data.inventory.files.length > 0, 'inventory lists hidden files');
  assert.ok(data.inventory.edges.length > 0, 'inventory keeps their edges');
  const total = data.nodes.filter(n => n.id.startsWith('f:')).length + data.inventory.files.length;
  assert.equal(total, files.length, 'every analyzed file is on the map or in the inventory');
});

test('critical path is marked from an entry point', () => {
  const data = analyze([
    f('index.js', `import { route } from './routes/api.js';\nroute();`),
    f('routes/api.js', `import { save } from '../models/store.js';\nexport const route = () => save();`),
    f('models/store.js', `import pg from 'pg';\nexport const save = () => {};`),
  ]);
  assert.ok(data.nodes.some(n => n.critical), 'some node is critical');
  assert.ok(data.edges.some(e => e.kind === 'critical'), 'some edge is critical');
});

test('meta stats include loc and languages', () => {
  const data = analyze([f('a.py', 'x = 1\ny = 2\n'), f('b.js', 'const z = 3;\n')]);
  assert.equal(data.meta.stats.languages.py, 1);
  assert.equal(data.meta.stats.languages.js, 1);
  assert.ok(data.meta.stats.totalLoc >= 4);
});
