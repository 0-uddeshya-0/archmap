// Validator + patch engine tests — run with: node --test tools/validate.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateMap, applyPatch, selfCheckLine, slugId } from '../js/validate.js';
import { analyze } from '../js/analyze.js';

const goodMap = () => ({
  version: 1,
  meta: { name: 'test', source: 'design', stats: {} },
  clusters: [
    { id: 'client', label: 'Client', color: 'client' },
    { id: 'services', label: 'Services', color: 'service' },
  ],
  nodes: [
    { id: 'n:web', cluster: 'client', label: 'Web app', sub: '', color: 'client', tag: ['all'] },
    { id: 'n:api', cluster: 'services', label: 'API server', sub: '', color: 'service', tag: ['all'] },
  ],
  edges: [{ from: 'n:web', to: 'n:api', kind: 'normal', label: 'HTTPS', tag: ['all'] }],
  findings: [], tags: ['all'], fixes: {}, bugs: {}, ai: {},
});

test('validateMap passes a well-formed map', () => {
  const v = validateMap(goodMap());
  assert.ok(v.ok, JSON.stringify(v.errors));
  assert.equal(v.errors.length, 0);
});

test('validateMap catches dangling edges, duplicate ids, unknown clusters', () => {
  const m = goodMap();
  m.edges.push({ from: 'n:web', to: 'n:ghost' });
  m.nodes.push({ id: 'n:web', cluster: 'client', label: 'dup' });
  m.nodes.push({ id: 'n:x', cluster: 'nope', label: 'x' });
  const v = validateMap(m);
  assert.ok(!v.ok);
  assert.ok(v.errors.some(e => e.includes('n:ghost')));
  assert.ok(v.errors.some(e => e.includes('duplicate id')));
  assert.ok(v.errors.some(e => e.includes('"nope"')));
});

test('analyze() output always validates clean', () => {
  const data = analyze([
    { path: 'index.js', content: `import { r } from './routes/api.js';\nr();`, size: 40 },
    { path: 'routes/api.js', content: `import pg from 'pg';\nexport const r = () => {};`, size: 50 },
  ]);
  const v = validateMap(data);
  assert.ok(v.ok, JSON.stringify(v.errors));
  const line = selfCheckLine(data);
  assert.ok(line.ok);
  assert.match(line.text, /0 inconsistencies/);
  assert.match(line.text, /cite file:line evidence/);
});

test('applyPatch: add / connect / update / remove round-trip stays valid', () => {
  const m = goodMap();
  const r1 = applyPatch(m, [
    { op: 'add_node', node: { label: 'Redis cache', cluster: 'data', role: 'Hot session cache' } },
    { op: 'add_edge', from: 'n:api', to: 'n:redis-cache', kind: 'db', label: 'session lookup' },
    { op: 'update_node', id: 'n:web', set: { label: 'Web client' } },
    { op: 'update_edge', from: 'n:web', to: 'n:api', set: { label: 'JSON over HTTPS' } },
  ]);
  assert.equal(r1.errors.length, 0, JSON.stringify(r1.errors));
  assert.equal(r1.applied.length, 4);
  assert.ok(m.clusters.some(c => c.id === 'data'), 'data cluster auto-declared');
  assert.ok(validateMap(m).ok);

  const r2 = applyPatch(m, [{ op: 'remove_node', id: 'n:redis-cache' }]);
  assert.equal(r2.errors.length, 0);
  assert.ok(!m.edges.some(e => e.to === 'n:redis-cache'), 'edges removed with the node');
  assert.ok(!m.clusters.some(c => c.id === 'data'), 'empty cluster dropped');
  assert.ok(validateMap(m).ok);
});

test('applyPatch rejects invalid ops without corrupting the map', () => {
  const m = goodMap();
  const r = applyPatch(m, [
    { op: 'add_edge', from: 'n:web', to: 'n:missing' },
    { op: 'update_node', id: 'n:web', set: { hacked: true } },
    { op: 'remove_edge', from: 'n:api', to: 'n:web' },
    { op: 'explode' },
  ]);
  assert.equal(r.applied.length, 0);
  assert.equal(r.errors.length, 4);
  assert.ok(validateMap(m).ok, 'map untouched by rejected ops');
  assert.equal(m.edges.length, 1);
});

test('slugId produces stable ids', () => {
  assert.equal(slugId('Auth Service!'), 'n:auth-service');
});

// ---- deterministic blueprint composer ----
const { composeFromAnswers } = await import('../js/designer.js');

test('composeFromAnswers builds a valid, complete blueprint', () => {
  const d = composeFromAnswers({
    name: 'petsit', idea: 'a marketplace for pet sitters', platform: 'both',
    auth: true, realtime: true, admin: true,
    integrations: ['payments', 'email'], dataNotes: 'profiles, bookings, reviews',
  });
  const v = validateMap(d);
  assert.ok(v.ok, JSON.stringify(v.errors));
  assert.ok(d.nodes.some(n => n.id === 'n:auth-service'));
  assert.ok(d.nodes.some(n => n.id === 'n:payment-provider'));
  assert.ok(d.nodes.some(n => n.id === 'n:ws-hub'));
  assert.ok(d.nodes.filter(n => n.critical).length >= 4, 'critical path marked');
  assert.ok(d.edges.some(e => e.kind === 'critical'), 'critical edges marked');
  assert.ok(d.tags.includes('payments') && d.tags.includes('auth'), 'feature tags present');
  assert.ok(d.findings.some(t => t.includes('deterministically')), 'labeled as a composed blueprint, not AI');
  assert.ok(d.edges.every(e => e.label), 'every wire says what flows');
});

test('composeFromAnswers minimal: web-only, nothing extra', () => {
  const d = composeFromAnswers({ idea: 'a tiny notes app', platform: 'web', auth: false, integrations: [] });
  assert.ok(validateMap(d).ok);
  assert.ok(!d.nodes.some(n => n.id === 'n:auth-service'));
  assert.ok(d.findings.some(t => t.toLowerCase().includes('no authentication')), 'missing auth called out honestly');
});
