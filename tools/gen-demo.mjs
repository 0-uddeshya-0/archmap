#!/usr/bin/env node
// Generates demo/self.archmap.json — ArchMap mapping its own source — by
// running the same analyzer the site runs in the browser.
//   node tools/gen-demo.mjs [outfile]

import { readdir, readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze, isAnalyzableFile, isManifest } from '../js/analyze.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['.git', 'node_modules', 'demo', '.claude', '.superset', '.github']);

async function collect(dir, files) {
  for (const name of await readdir(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    const st = await stat(full);
    if (st.isDirectory()) await collect(full, files);
    else {
      const rel = relative(root, full).split(sep).join('/');
      if (!isAnalyzableFile(rel, st.size) && !isManifest(rel)) continue;
      files.push({ path: rel, content: await readFile(full, 'utf8'), size: st.size });
    }
  }
}

const files = [];
await collect(root, files);
const data = analyze(files, {
  name: 'archmap (this site)',
  source: 'demo',
  url: 'https://github.com/0-uddeshya-0/archmap',
  ref: 'main',
});
const out = process.argv[2] || join(root, 'demo', 'self.archmap.json');
await mkdir(dirname(out), { recursive: true });
await writeFile(out, JSON.stringify(data, null, 1));
console.log(`wrote ${out}: ${data.nodes.length} nodes, ${data.edges.length} edges, ${data.findings.length} findings`);
