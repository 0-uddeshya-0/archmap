// The Designer: turn a product idea into an editable architecture map.
//
// Two honest paths:
//  - Without an API key: a guided form composes a starter blueprint from
//    vetted patterns — deterministic, labeled as such, never pretending to be
//    tailored intelligence.
//  - With a key: Claude asks a short round of sharp clarifying questions
//    ("the grill"), then generates a design in the archmap schema. The output
//    is machine-validated (js/validate.js) before it ever renders; invalid
//    output goes back to the model with the exact errors, max two repairs.
//
// Iteration afterwards is edits-as-ops: natural-language instructions become
// checked patch operations, never raw JSON trust.

import { callClaude, extractJson, getKey } from './ai.js';
import { validateMap, applyPatch, CLUSTER_COLORS } from './validate.js';

// ------------------------------------------------- deterministic composer

const CLUSTER_LABELS = { client: 'Client / UI', entry: 'Entry / Gateway', routes: 'API / Routes', services: 'Services', data: 'Data & Storage', external: 'External services', tests: 'Tests' };

// answers = { name, idea, platform: 'web'|'mobile'|'both', auth, realtime,
//             admin, integrations: [payments|email|ai|storage|analytics], dataNotes }
export function composeFromAnswers(answers) {
  const a = { platform: 'web', integrations: [], ...answers };
  const has = (x) => a.integrations.includes(x);
  const nodes = [], edges = [];
  const tagsUsed = new Set(['all']);
  const N = (id, cluster, label, role, plain, tag = [], extra = {}) => {
    const t = ['all', ...tag];
    tag.forEach(x => tagsUsed.add(x));
    nodes.push({ id, cluster, label, sub: '', color: CLUSTER_COLORS[cluster], path: '', role, plain, notes: [], tag: t, ...extra });
    return id;
  };
  const E = (from, to, kind, label, tag = []) => edges.push({ from, to, kind, label, tag: ['all', ...tag] });

  // clients
  if (a.platform !== 'mobile') N('n:web-app', 'client', 'Web app', 'Browser client: renders the product UI and talks to the API over HTTPS.', 'The website your users open in a browser.', [], { critical: true });
  if (a.platform !== 'web') N('n:mobile-app', 'client', 'Mobile app', 'iOS/Android client talking to the same API as the web app.', 'The app users install on their phone.');
  if (a.admin) N('n:admin-panel', 'client', 'Admin panel', 'Internal dashboard for operators: user management, content, metrics.', 'A private control room for the team running the product.', ['admin']);

  // entry + api
  N('n:api-gateway', 'entry', 'API gateway', 'Single entry point: TLS termination, rate limiting, request routing to services.', 'The front door — every request from every client passes through here first.', [], { critical: true });
  N('n:rest-api', 'routes', 'REST API', 'HTTP endpoints for every product feature; validates input and calls services.', 'The menu of things clients can ask the system to do.', [], { critical: true });
  if (a.realtime) N('n:ws-hub', 'routes', 'WebSocket hub', 'Holds live connections; pushes updates to clients the moment something changes.', 'Keeps an open line to each user so updates appear instantly.', ['realtime']);

  // services
  N('n:core-service', 'services', 'Core service', 'The product’s business logic: the rules of what happens and when.', 'The brain — where the product’s actual behavior lives.', [], { critical: true });
  if (a.auth) N('n:auth-service', 'services', 'Auth service', 'Sign-up, login, sessions/tokens, password reset, permissions.', 'Checks who you are and what you’re allowed to do.', ['auth']);
  if (has('payments')) N('n:billing-service', 'services', 'Billing service', 'Creates charges and subscriptions via the payment provider; records invoices.', 'Handles money: charging cards and keeping receipts.', ['payments']);
  if (has('email')) N('n:notify-service', 'services', 'Notification service', 'Sends transactional email (welcome, receipts, resets) through the email provider.', 'Writes and sends the emails users receive.', ['email']);
  if (has('ai')) N('n:ai-service', 'services', 'AI service', 'Assembles prompts, calls the LLM API, and post-processes model output.', 'The part that talks to the AI model on the product’s behalf.', ['ai']);

  // data
  N('n:primary-db', 'data', 'Primary database', 'System of record for all persistent product data.', `Where everything is saved${a.dataNotes ? ` — ${a.dataNotes}` : ''}.`, [], { critical: true });
  if (a.auth || a.realtime) N('n:cache', 'data', 'Cache', 'Fast in-memory store for sessions and hot lookups.', 'Short-term memory so common things load instantly.', a.realtime ? ['realtime'] : ['auth']);
  if (has('storage')) N('n:object-storage', 'data', 'Object storage', 'Stores user uploads and generated files; served via signed URLs.', 'A big bucket for files: images, documents, exports.', ['storage']);

  // external
  if (has('payments')) N('n:payment-provider', 'external', 'Payment provider', 'Third-party processor (e.g. card networks) — the system never stores card numbers.', 'The outside company that actually moves the money.', ['payments']);
  if (has('email')) N('n:email-provider', 'external', 'Email provider', 'Third-party email delivery service.', 'The outside service that delivers the emails.', ['email']);
  if (has('ai')) N('n:llm-api', 'external', 'LLM API', 'Hosted large-language-model API.', 'The AI model, run by an outside provider.', ['ai']);
  if (has('analytics')) N('n:analytics', 'external', 'Analytics', 'Product analytics ingestion.', 'Counts what users do so the team can see what works.', ['analytics']);

  // wires
  const hasNode = (id) => nodes.some(n => n.id === id);
  if (hasNode('n:web-app')) E('n:web-app', 'n:api-gateway', 'critical', 'HTTPS');
  if (hasNode('n:mobile-app')) E('n:mobile-app', 'n:api-gateway', 'mount', 'HTTPS');
  if (hasNode('n:admin-panel')) E('n:admin-panel', 'n:api-gateway', 'mount', 'HTTPS', ['admin']);
  E('n:api-gateway', 'n:rest-api', 'critical', 'routes requests');
  E('n:rest-api', 'n:core-service', 'critical', 'feature calls');
  E('n:core-service', 'n:primary-db', 'critical', 'reads / writes');
  if (hasNode('n:auth-service')) {
    E('n:rest-api', 'n:auth-service', 'normal', 'verify session', ['auth']);
    E('n:auth-service', 'n:primary-db', 'db', 'users & sessions', ['auth']);
    if (hasNode('n:cache')) E('n:auth-service', 'n:cache', 'db', 'session tokens', ['auth']);
  }
  if (hasNode('n:ws-hub')) {
    if (hasNode('n:web-app')) E('n:web-app', 'n:ws-hub', 'mount', 'WebSocket', ['realtime']);
    if (hasNode('n:mobile-app')) E('n:mobile-app', 'n:ws-hub', 'mount', 'WebSocket', ['realtime']);
    E('n:core-service', 'n:ws-hub', 'normal', 'publish events', ['realtime']);
    if (hasNode('n:cache')) E('n:ws-hub', 'n:cache', 'db', 'presence', ['realtime']);
  }
  if (hasNode('n:billing-service')) {
    E('n:core-service', 'n:billing-service', 'normal', 'charge / subscribe', ['payments']);
    E('n:billing-service', 'n:payment-provider', 'api', 'payment API', ['payments']);
    E('n:billing-service', 'n:primary-db', 'db', 'invoices', ['payments']);
  }
  if (hasNode('n:notify-service')) {
    E('n:core-service', 'n:notify-service', 'normal', 'send email', ['email']);
    E('n:notify-service', 'n:email-provider', 'api', 'SMTP / API', ['email']);
  }
  if (hasNode('n:ai-service')) {
    E('n:core-service', 'n:ai-service', 'normal', 'AI tasks', ['ai']);
    E('n:ai-service', 'n:llm-api', 'api', 'model calls', ['ai']);
  }
  if (hasNode('n:object-storage')) E('n:core-service', 'n:object-storage', 'db', 'files', ['storage']);
  if (hasNode('n:analytics') && hasNode('n:web-app')) E('n:web-app', 'n:analytics', 'api', 'events', ['analytics']);

  const clusters = ['client', 'entry', 'routes', 'services', 'data', 'external']
    .filter(id => nodes.some(n => n.cluster === id))
    .map(id => ({ id, label: CLUSTER_LABELS[id], color: CLUSTER_COLORS[id] }));

  const findings = [
    'Starter blueprint composed deterministically from your answers using standard patterns — not AI-generated. Refine it on the canvas.',
    `Critical path: ${nodes.filter(n => n.critical).map(n => n.label).join(' → ')} — the flow most requests take.`,
    a.auth ? 'Sessions live in the auth service + cache; the API verifies every request before business logic runs.' : 'No authentication was requested — add an Auth service before handling any personal data.',
    has('payments') ? 'Card data never touches your servers: the billing service only exchanges tokens with the payment provider.' : null,
    'Assumption: one primary database is enough to start. Split stores only when a real bottleneck appears.',
  ].filter(Boolean);

  const data = {
    version: 1,
    meta: {
      name: a.name || 'new system',
      source: 'design',
      generatedAt: new Date().toISOString(),
      stats: { nodes: nodes.length, edges: edges.length },
      designedFrom: a.idea ? String(a.idea).slice(0, 500) : undefined,
    },
    clusters, nodes, edges, findings,
    tags: [...tagsUsed],
    fixes: {}, bugs: {},
    ai: { enriched: false },
  };
  const v = validateMap(data);
  if (!v.ok) throw new Error('Blueprint failed self-validation: ' + v.errors.join('; '));
  return data;
}

// ----------------------------------------------------------- AI: the grill

const DESIGN_SYSTEM = `You are a pragmatic software architect designing a system for someone who may not be an engineer. You are precise and concrete. You never invent facts the user did not give you — when you assume something, you say so explicitly in "findings". Respond ONLY with the requested JSON, no markdown fences.`;

export async function grillQuestions(idea) {
  const prompt = `A user wants to build this product:

"""${String(idea).slice(0, 2000)}"""

Ask the 3-5 clarifying questions whose answers most change the architecture. Sharp and specific to THIS idea — never generic filler. Cover the biggest unknowns among: who uses it & how they sign in, what must be stored permanently, external services (payments, email, AI, file uploads), realtime needs, platforms, expected scale. Skip anything the idea already answers.

Return JSON: {"questions": [{"id": "q1", "q": "the question", "hint": "example answer, ≤8 words"}]}`;
  const r = extractJson(await callClaude(DESIGN_SYSTEM, prompt, 3000, 'medium'));
  if (!Array.isArray(r.questions) || !r.questions.length) throw new Error('The model returned no questions — try again.');
  return r.questions.slice(0, 5).map((q, i) => ({ id: q.id || 'q' + (i + 1), q: String(q.q || ''), hint: String(q.hint || '') })).filter(q => q.q);
}

const SCHEMA_RULES = `Schema (return exactly this shape):
{
 "meta": {"name": "<short product name>"},
 "clusters": [{"id": "<one of: client|entry|routes|services|data|external>", "label": "<display label>"}],
 "nodes": [{"id": "n:<kebab-slug>", "cluster": "<cluster id>", "label": "<≤3 words>",
            "role": "<one precise technical sentence>",
            "plain": "<same idea for a smart non-engineer, no jargon>",
            "notes": ["<0-3 short concrete facts or decisions>"],
            "tag": ["<feature tags like auth, payments — omit for core nodes>"],
            "critical": <true only on the primary user flow>}],
 "edges": [{"from": "n:...", "to": "n:...", "kind": "critical|api|db|mount|normal",
            "label": "<≤4 words: what flows — protocol, action, or data>",
            "tag": ["<feature tags>"]}],
 "findings": ["<4-6 design decisions, tradeoffs, risks, and EVERY assumption you made>"]
}

Hard rules:
- 8 to 16 nodes. One clear primary path from a client to the data layer: mark those nodes "critical": true and those edges "kind": "critical".
- Cluster ids ONLY from: client, entry, routes, services, data, external. Adapt the labels to the product, not the ids.
- kind: "db" for edges into stores, "api" for edges to external/third-party services, "mount" for client→entry.
- Every edge label says what actually flows. Every "plain" is readable by a non-engineer.
- Do not invent versions, vendors, or numbers the user never mentioned; generic terms ("Payment provider") are correct. List every assumption in findings.
- No emojis anywhere. No filler nodes — each node must earn its place.`;

function normalizeDesign(d, idea) {
  const data = {
    version: 1,
    meta: {
      name: String(d.meta?.name || 'new system').slice(0, 60),
      source: 'design',
      generatedAt: new Date().toISOString(),
      stats: { nodes: (d.nodes || []).length, edges: (d.edges || []).length },
      designedFrom: String(idea).slice(0, 500),
    },
    clusters: (d.clusters || []).map(c => ({ id: c.id, label: String(c.label || c.id).slice(0, 40), color: CLUSTER_COLORS[c.id] })),
    nodes: (d.nodes || []).map(n => ({
      id: String(n.id || ''), cluster: n.cluster, label: String(n.label || '').slice(0, 40),
      sub: '', color: CLUSTER_COLORS[n.cluster] || 'service', path: '',
      role: String(n.role || ''), plain: String(n.plain || ''),
      notes: Array.isArray(n.notes) ? n.notes.slice(0, 4).map(String) : [],
      tag: [...new Set(['all', ...(Array.isArray(n.tag) ? n.tag.map(String) : [])])],
      ...(n.critical ? { critical: true } : {}),
    })),
    edges: (d.edges || []).map(e => ({
      from: e.from, to: e.to, kind: e.kind || 'normal', label: String(e.label || '').slice(0, 40),
      tag: [...new Set(['all', ...(Array.isArray(e.tag) ? e.tag.map(String) : [])])],
    })),
    findings: Array.isArray(d.findings) ? d.findings.slice(0, 8).map(String) : [],
    tags: ['all'],
    fixes: {}, bugs: {},
    ai: { enriched: false },
  };
  data.tags = [...new Set(['all', ...data.nodes.flatMap(n => n.tag), ...data.edges.flatMap(e => e.tag)])].filter(t => t);
  return data;
}

// Generate, validate, and (if needed) repair — the model never ships an
// invalid map because js/validate.js gates every candidate.
export async function generateDesign(idea, qa, onProgress) {
  const qaText = (qa || []).filter(x => x.a?.trim()).map(x => `Q: ${x.q}\nA: ${x.a.trim()}`).join('\n');
  const skipped = (qa || []).filter(x => !x.a?.trim()).map(x => x.q);
  let prompt = `Design the architecture for this product:

"""${String(idea).slice(0, 2000)}"""

${qaText ? `Clarifications from the user:\n${qaText}\n` : ''}${skipped.length ? `Unanswered questions (make a sensible assumption for each and STATE IT in findings): ${skipped.join(' · ')}\n` : ''}
${SCHEMA_RULES}`;

  for (let attempt = 1; attempt <= 3; attempt++) {
    onProgress?.(attempt === 1 ? 'Designing the architecture…' : `Repairing the design (round ${attempt - 1})…`);
    const raw = extractJson(await callClaude(DESIGN_SYSTEM, prompt, 12000));
    const data = normalizeDesign(raw, idea);
    const v = validateMap(data);
    if (v.ok) return { data, warnings: v.warnings };
    if (attempt === 3) throw new Error('The generated design failed validation: ' + v.errors.slice(0, 3).join('; '));
    prompt = `Your previous design had validation errors. Fix ONLY these problems and return the complete corrected JSON:

${v.errors.map(e => '- ' + e).join('\n')}

Previous design:
${JSON.stringify(raw)}

${SCHEMA_RULES}`;
  }
}

// Natural-language change → checked patch ops (see js/validate.js applyPatch).
export async function iterateOps(data, instruction) {
  const slim = {
    meta: { name: data.meta?.name },
    clusters: data.clusters,
    nodes: data.nodes.filter(n => !n.aggregate).map(n => ({ id: n.id, cluster: n.cluster, label: n.label, role: n.role, tag: n.tag, critical: n.critical })),
    edges: data.edges.map(e => ({ from: e.from, to: e.to, kind: e.kind, label: e.label })),
    findings: data.findings,
  };
  const prompt = `Current architecture map:
${JSON.stringify(slim)}

The user asks: ${JSON.stringify(String(instruction))}

Express the change as a list of ops. Available ops:
{"op":"add_node","node":{"label":"...","cluster":"client|entry|routes|services|data|external","role":"one sentence","plain":"non-engineer version","tag":["feature"],"critical":false}}
{"op":"update_node","id":"n:...","set":{"label"?,"cluster"?,"role"?,"plain"?,"notes"?,"tag"?,"critical"?}}
{"op":"remove_node","id":"n:..."}    // also removes its wires
{"op":"add_edge","from":"n:...","to":"n:...","kind":"critical|api|db|mount|normal","label":"what flows"}
{"op":"update_edge","from":"n:...","to":"n:...","set":{"kind"?,"label"?}}
{"op":"remove_edge","from":"n:...","to":"n:..."}
{"op":"set_meta","set":{"name"?,"overview"?}}
{"op":"set_findings","findings":["..."]}

Rules: reference ONLY node ids that exist above (or that your own earlier add_node creates — its id will be "n:" + the label slugified, lowercase, spaces→dashes). Smallest change that satisfies the request. If the request is unclear or impossible on this map, return zero ops and explain in "note".

Return JSON only: {"ops":[...], "note":"≤15 words on what you did or why nothing"}`;
  const r = extractJson(await callClaude(DESIGN_SYSTEM, prompt, 8000, 'medium'));
  return { ops: Array.isArray(r.ops) ? r.ops : [], note: String(r.note || '') };
}

// ------------------------------------------------------------- DOM wiring

export function initDesigner({ overlay, onMap, toast, showProgress, updateProgress, hideProgress }) {
  const $ = (sel) => overlay.querySelector(sel);
  let stage = 'idea';
  let idea = '', name = '', questions = [];

  const show = (s) => {
    stage = s;
    overlay.querySelectorAll('[data-stage]').forEach(el => { el.hidden = el.dataset.stage !== s; });
  };

  const openDesigner = () => {
    overlay.hidden = false;
    $('#dz-keyless').hidden = !!getKey();
    show('idea');
    $('#dz-idea').focus();
  };
  const close = () => { overlay.hidden = true; };
  $('#dz-close').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  // stage 1 → grill (AI) or form (keyless)
  $('#dz-continue').addEventListener('click', async () => {
    idea = $('#dz-idea').value.trim();
    name = $('#dz-name').value.trim();
    if (!idea) return toast('Describe the product first — a few sentences is enough.', true);
    if (!getKey()) { show('form'); return; }
    show('grill-wait');
    try {
      questions = await grillQuestions(idea);
      const box = $('#dz-questions');
      box.innerHTML = questions.map((q, i) => `
        <label class="dz-q">${escapeHtml(q.q)}
          <input type="text" data-qid="${escapeHtml(q.id)}" placeholder="${escapeHtml(q.hint || 'leave blank to let the design assume')}">
        </label>`).join('');
      show('grill');
      box.querySelector('input')?.focus();
    } catch (err) {
      show('idea');
      toast('Could not prepare questions: ' + err.message, true);
    }
  });

  const runGenerate = async (qa) => {
    close();
    showProgress('Designing the architecture…');
    try {
      const { data } = await generateDesign(idea, qa, updateProgress);
      if (name) data.meta.name = name;
      hideProgress();
      onMap(data);
      toast('Design generated and validated ✓ — drag nodes, click things, or tell it what to change.');
    } catch (err) {
      hideProgress();
      toast(err.message, true);
    }
  };

  $('#dz-generate').addEventListener('click', () => {
    const qa = questions.map(q => ({
      q: q.q,
      a: $(`[data-qid="${CSS.escape(q.id)}"]`)?.value || '',
    }));
    runGenerate(qa);
  });
  $('#dz-skip-grill').addEventListener('click', () => runGenerate([]));

  // keyless form → deterministic blueprint
  $('#dz-compose').addEventListener('click', () => {
    try {
      const integrations = [...overlay.querySelectorAll('[data-int]:checked')].map(el => el.dataset.int);
      const data = composeFromAnswers({
        name: name || $('#dz-name').value.trim(),
        idea,
        platform: $('#dz-platform').value,
        auth: $('#dz-auth').checked,
        realtime: $('#dz-realtime').checked,
        admin: $('#dz-admin').checked,
        integrations,
        dataNotes: $('#dz-data').value.trim(),
      });
      close();
      onMap(data);
      toast('Starter blueprint ready — drag nodes, click to edit, add wires. It’s yours now.');
    } catch (err) { toast(err.message, true); }
  });
  overlay.querySelectorAll('[data-dz-back]').forEach(b => b.addEventListener('click', () => show('idea')));

  return { open: openDesigner };
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
