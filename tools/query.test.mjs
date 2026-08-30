// Query engine tests — run with: node --test tools/query.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseQuery, runQuery, resolveNode } from '../js/query.js';
import { analyze } from '../js/analyze.js';

const f = (path, content) => ({ path, content, size: content.length });
const data = analyze([
  f('index.js', `import { route } from './routes/api.js';\nroute();`),
  f('routes/api.js', `import { save } from '../models/store.js';\nconst express = require('express');\nconst app = express();\napp.get('/users', (q, s) => s.json(save()));\nexport const route = () => save();`),
  f('models/store.js', `import pg from 'pg';\nexport const save = () => {};`),
  f('services/orphan.js', `export function orphanHelperFn() { return 42; }`),
  f('services/a.js', `import { b } from './b.js';\nexport const a = () => b();`),
  f('services/b.js', `import { a } from './a.js';\nexport const b = () => a();`),
]);

test('parseQuery understands common phrasings', () => {
  assert.deepEqual(parseQuery('who imports store.js'), { type: 'reach', dir: 'up', target: 'store.js' });
  assert.deepEqual(parseQuery('What does api.js import?'), { type: 'reach', dir: 'down', target: 'api.js' });
  assert.deepEqual(parseQuery('path from index.js to store.js'), { type: 'route', from: 'index.js', to: 'store.js' });
  assert.deepEqual(parseQuery('how does index.js reach pg'), { type: 'route', from: 'index.js', to: 'pg' });
  assert.deepEqual(parseQuery('dead code'), { type: 'list', what: 'dead' });
  assert.deepEqual(parseQuery('circular imports'), { type: 'list', what: 'cycles' });
  assert.deepEqual(parseQuery('list endpoints'), { type: 'list', what: 'routes' });
  assert.deepEqual(parseQuery('biggest files'), { type: 'list', what: 'big' });
  assert.deepEqual(parseQuery('most imported files'), { type: 'list', what: 'hot' });
  assert.deepEqual(parseQuery('critical path'), { type: 'list', what: 'critical' });
  assert.deepEqual(parseQuery('show the data layer'), { type: 'cluster', cluster: 'data' });
  assert.deepEqual(parseQuery('stats'), { type: 'stats' });
  assert.deepEqual(parseQuery('explain store.js'), { type: 'find', q: 'store.js' });
  assert.equal(parseQuery('completely unparseable gibberish here today'), null);
});

test('resolveNode is fuzzy but honest', () => {
  assert.equal(resolveNode(data, 'store.js').id, 'f:models/store.js');
  assert.equal(resolveNode(data, 'store').id, 'f:models/store.js');
  assert.equal(resolveNode(data, 'models/store').id, 'f:models/store.js');
  assert.equal(resolveNode(data, 'no-such-file-xyz'), null);
});

test('runQuery: dead code answer lists the orphan', () => {
  const r = runQuery({ type: 'list', what: 'dead' }, data);
  assert.match(r.summary, /zero live callers/);
  assert.ok(r.items.some(i => i.label === 'orphan.js'));
  assert.ok(r.apply.ids.includes('f:services/orphan.js'));
});

test('runQuery: cycles answer includes both cycle members and their wires', () => {
  const r = runQuery({ type: 'list', what: 'cycles' }, data);
  assert.ok(r.items.some(i => i.label === 'a.js'));
  assert.ok(r.items.some(i => i.label === 'b.js'));
  assert.equal(r.apply.edgeIdxs.length, 2);
});

test('runQuery: routes answer lists real endpoints', () => {
  const r = runQuery({ type: 'list', what: 'routes' }, data);
  assert.ok(r.items.some(i => i.note === 'GET /users'));
});

test('runQuery: reach and route resolve fuzzy names into apply actions', () => {
  const up = runQuery({ type: 'reach', dir: 'up', target: 'store' }, data);
  assert.deepEqual(up.apply, { type: 'reach', id: 'f:models/store.js', dir: 'up' });
  const rt = runQuery({ type: 'route', from: 'index', to: 'pg' }, data);
  assert.equal(rt.apply.type, 'route');
  assert.equal(rt.apply.from, 'f:index.js');
  assert.equal(rt.apply.to, 'ext:pg');
});

test('runQuery: misses are honest, never invented', () => {
  const r = runQuery({ type: 'reach', dir: 'up', target: 'ghost-file' }, data);
  assert.ok(r.miss);
  assert.match(r.summary, /No file on this map matches/);
});

test('runQuery: stats summarizes computed numbers only', () => {
  const r = runQuery({ type: 'stats' }, data);
  assert.match(r.summary, /6 files analyzed/);
  assert.match(r.summary, /1 dead file/);
  assert.match(r.summary, /2 cycle wires/);
});
