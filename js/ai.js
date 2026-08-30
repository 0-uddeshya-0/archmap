// Optional AI enrichment layer — bring-your-own Anthropic API key.
// The key lives only in localStorage on the user's machine; calls go directly
// from the browser to api.anthropic.com (no server in between).

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-opus-5';
const KEY_STORAGE = 'archmap.anthropicKey';

export function getKey() { return localStorage.getItem(KEY_STORAGE) || ''; }
export function setKey(k) {
  if (k) localStorage.setItem(KEY_STORAGE, k.trim());
  else localStorage.removeItem(KEY_STORAGE);
}

// Opus 5 thinks by default (max_tokens covers thinking + text, so keep it
// roomy). Safety classifiers can decline a scan with stop_reason "refusal";
// the server-side fallback re-runs those on Opus 4.8 inside the same call.
export async function callClaude(system, user, maxTokens = 8000, effort = null) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': getKey(),
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'server-side-fallback-2026-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      fallbacks: [{ model: 'claude-opus-4-8' }],
      ...(effort ? { output_config: { effort } } : {}),
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });
  if (res.status === 401) throw new Error('Invalid API key. Check it in Settings.');
  if (res.status === 429) throw new Error('Rate limited by the Anthropic API — wait a moment and retry.');
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Anthropic API error ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  if (data.stop_reason === 'refusal') throw new Error('The model declined this request (safety classifier). Try again or scan a different part of the repo.');
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  return text;
}

export function extractJson(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('Model did not return JSON.');
  return JSON.parse(m[0]);
}

// Natural-language question → ONE structured query op (see js/query.js).
// Translation only: the answer is always computed from the graph afterwards,
// so a wrong translation produces a visibly wrong query — never an invented fact.
export async function translateQuery(text, data) {
  const names = data.nodes.filter(n => !n.aggregate).map(n => n.label).slice(0, 120).join(', ');
  const clusters = data.clusters.map(c => c.id).join(' | ');
  const prompt = `Translate the user's question about a codebase map into EXACTLY ONE structured query op, or null if it cannot be expressed.

Ops (pick one):
{"type":"reach","dir":"up","target":"<file name>"}        // what imports/feeds <target>, transitively
{"type":"reach","dir":"down","target":"<file name>"}      // what <target> imports/reaches, transitively
{"type":"route","from":"<file>","to":"<file>"}            // shortest import chain between two files
{"type":"list","what":"dead"|"cycles"|"routes"|"external"|"big"|"hot"|"critical"}
{"type":"cluster","cluster":"${clusters}"}
{"type":"stats"}
{"type":"find","q":"<file name>"}                          // locate/describe one file

File names on this map: ${names}

Question: ${JSON.stringify(String(text))}

Return JSON only: {"op": <op or null>, "note": "<≤10 words: why null, or empty>"}`;
  const r = extractJson(await callClaude(
    'You translate questions into structured graph queries. You never answer the question yourself. Respond ONLY with the requested JSON.',
    prompt, 2000, 'low'));
  return r.op || null;
}

const SYSTEM = `You are an expert software architect annotating a codebase map for two audiences at once: non-engineers who need plain English, and maintainers who need sharp technical judgement. Be concrete and specific to THIS codebase. Never invent facts about code you were not shown. Respond ONLY with the requested JSON, no markdown fences.`;

// Enrich node descriptions in batches, using file excerpts.
export async function enrichMap(data, files, onProgress) {
  const fileMap = new Map((files || []).map(f => [f.path, f.content]));
  const targets = data.nodes.filter(n => n.path && fileMap.has(n.path) && !n.aggregate);
  // prioritize critical + high-connectivity nodes
  const degree = new Map();
  for (const e of data.edges) {
    degree.set(e.from, (degree.get(e.from) || 0) + 1);
    degree.set(e.to, (degree.get(e.to) || 0) + 1);
  }
  targets.sort((a, b) => ((b.critical ? 100 : 0) + (degree.get(b.id) || 0)) - ((a.critical ? 100 : 0) + (degree.get(a.id) || 0)));
  const picked = targets.slice(0, 30);

  const BATCH = 6;
  for (let i = 0; i < picked.length; i += BATCH) {
    const batch = picked.slice(i, i + BATCH);
    onProgress?.(`AI: describing files ${i + 1}–${Math.min(i + BATCH, picked.length)} of ${picked.length}…`);
    const excerpts = batch.map(n => {
      const src = fileMap.get(n.path) || '';
      const head = src.split('\n').slice(0, 70).join('\n');
      return `=== ${n.path} (id: ${n.id}) ===\n${head}`;
    }).join('\n\n');
    const prompt = `Repository: ${data.meta.name}. For each file below, write:
- "role": one precise technical sentence about what this file does in THIS system
- "plain": the same idea for a smart non-engineer — no jargon, no unexpanded acronyms
- "notes": 1-3 short concrete facts you can see in the excerpt (specific functions, libraries with versions if visible, gotchas)

Return JSON: {"<node id>": {"role": "...", "plain": "...", "notes": ["..."]}, ...}

${excerpts}`;
    try {
      // routine describe-work: medium effort keeps the user's spend + latency low
      const result = extractJson(await callClaude(SYSTEM, prompt, 8000, 'medium'));
      for (const n of batch) {
        const r = result[n.id];
        if (!r) continue;
        if (r.role) n.role = r.role;
        if (r.plain) n.plain = r.plain;
        if (Array.isArray(r.notes) && r.notes.length) n.notes = [...r.notes.map(String), ...(n.notes || []).slice(0, 2)];
      }
    } catch (err) {
      if (i === 0) throw err; // first batch failing = config problem, surface it
      console.warn('enrichment batch failed:', err);
    }
  }

  // Overview + upgraded findings in one final call
  onProgress?.('AI: writing overview and findings…');
  try {
    const summary = data.nodes.filter(n => !n.aggregate).slice(0, 60)
      .map(n => `${n.path || n.label} [${n.cluster}]${n.critical ? ' CRITICAL' : ''}${n.dead ? ' DEAD' : ''}: ${n.role}`).join('\n');
    const prompt = `Repository: ${data.meta.name}. Stack: ${(data.meta.stats?.frameworks || []).join(', ') || 'unknown'}.
Static-analysis findings so far:\n${data.findings.join('\n')}

Node inventory:\n${summary}

Return JSON:
{"overview": "3-4 sentences a non-engineer could read to understand what this system is and how a request flows through it",
 "findings": ["4-6 sharp, specific observations a maintainer would care about: dead code, hot paths, surprising couplings, risky seams. Keep any static findings that are still correct."]}`;
    const r = extractJson(await callClaude(SYSTEM, prompt, 6000, 'medium'));
    if (r.overview) data.ai.overview = r.overview;
    if (Array.isArray(r.findings) && r.findings.length) data.findings = r.findings.map(String);
  } catch (err) {
    console.warn('overview generation failed:', err);
  }

  data.ai.enriched = true;
  data.ai.model = MODEL;
  return data;
}

// Bug-finding pass — populates data.bugs / data.fixes for the debug overlay.
// Strictly grounded: reports only problems visible in the shown code, with
// "path:line" evidence, so a non-expert can trust and act on each finding.
export async function findBugs(data, files, onProgress) {
  const fileMap = new Map((files || []).map(f => [f.path, f.content]));
  const targets = data.nodes.filter(n => n.path && fileMap.has(n.path) && !n.aggregate);
  const degree = new Map();
  for (const e of data.edges) {
    degree.set(e.from, (degree.get(e.from) || 0) + 1);
    degree.set(e.to, (degree.get(e.to) || 0) + 1);
  }
  targets.sort((a, b) => ((b.critical ? 100 : 0) + (degree.get(b.id) || 0)) - ((a.critical ? 100 : 0) + (degree.get(a.id) || 0)));
  const picked = targets.slice(0, 24);
  data.bugs = data.bugs || {};
  data.fixes = data.fixes || {};

  const BATCH = 4;
  for (let i = 0; i < picked.length; i += BATCH) {
    const batch = picked.slice(i, i + BATCH);
    onProgress?.(`AI: scanning files ${i + 1}–${Math.min(i + BATCH, picked.length)} of ${picked.length} for bugs…`);
    const excerpts = batch.map(n => {
      const src = fileMap.get(n.path) || '';
      const head = src.split('\n').slice(0, 120).map((l, idx) => `${idx + 1}: ${l}`).join('\n');
      return `=== ${n.path} (id: ${n.id}) ===\n${head}`;
    }).join('\n\n');
    const prompt = `You are debugging a "vibe-coded" app for a non-expert who built it without knowing how to code. For each file below, report ONLY real, concrete problems you can actually see in the shown code — bugs, risky seams, missing error handling, security issues, obvious logic errors. NEVER invent a bug. If a file looks fine, return an empty "bugs" array for it.
For each bug: "sev" (HIGH | MED | LOW), "t" (one plain-English sentence a non-coder understands), "ev" (array of "path:line" using the line numbers shown), and optional "warn" (a caution like "verify against production data").
Also propose "fixes": short, concrete next steps as {"t": "..."}.

Return JSON only: {"<node id>": {"bugs":[{"sev":"HIGH","t":"...","ev":["path:line"],"warn":"..."}], "fixes":[{"t":"..."}]}, ...}

${excerpts}`;
    try {
      // bug hunting is correctness-sensitive: keep default (high) effort
      const result = extractJson(await callClaude(SYSTEM, prompt, 10000));
      for (const n of batch) {
        const r = result[n.id];
        if (!r) continue;
        if (Array.isArray(r.bugs) && r.bugs.length) {
          const bugs = r.bugs.map(b => ({
            sev: String(b.sev || 'MED').toUpperCase(),
            t: String(b.t || ''),
            ev: Array.isArray(b.ev) ? b.ev.map(String).slice(0, 6) : [],
            ...(b.warn ? { warn: String(b.warn) } : {}),
          })).filter(b => b.t);
          if (bugs.length) data.bugs[n.id] = bugs;
        }
        if (Array.isArray(r.fixes) && r.fixes.length) {
          const fixes = r.fixes.map(f => ({ t: String(f.t || '') })).filter(f => f.t);
          if (fixes.length) data.fixes[n.id] = fixes;
        }
      }
    } catch (err) {
      if (i === 0) throw err;
      console.warn('bug scan batch failed:', err);
    }
  }

  data.ai = data.ai || {};
  data.ai.debugScanned = true;
  data.ai.model = MODEL;
  return data;
}
