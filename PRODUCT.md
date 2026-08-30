# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary: non-engineers who own code they didn't fully write — founders and builders who created apps with AI assistance, or people who inherited a codebase — trying to understand what they have, find what's broken, and change it safely. They are smart but unfamiliar with import graphs, dead code, or layering; jargon loses them.

Secondary: professional developers onboarding to an unfamiliar repository or auditing its architecture (hot paths, cycles, dead code, dependency reach).

## Product Purpose

ArchMap turns a repository into an interactive architecture map, computed in the browser from the real import graph. It exists so someone can *see* a codebase — what starts it, what talks to what, where data lives, what's dead — instead of reading files one by one. Success for a first-time visitor: they map **their own repo** (paste a GitHub URL or drop a folder) and understand it. The bundled demo exists to de-risk that step, not to replace it.

## Positioning

Computed truth with evidence, zero backend. Every wire on the map is an import that exists in the code, citable to its exact `file:line`; questions are answered by graph computation, never by generated prose; code never leaves the machine (no server exists to upload to). Neighboring tools either draw diagrams an author asserts, or require installs/uploads. ArchMap's claim: a map you can interrogate and verify, in one browser tab.

## Operating Context

- Loaded from a GitHub URL (client-side API), a dragged local folder, or a portable `archmap.json`; a Claude Code skill generates the same format from inside a repo.
- Explored via guided tour, plain-language questions ("who imports X", "dead code"), reach tracing, route probing, and click-for-evidence wires.
- Edited on the canvas (drag, connect, inspect, undo) — including designs generated from a plain-language product idea (the Designer).
- Shared as a self-contained interactive HTML file, JSON, or SVG/PNG images.
- Optional bring-your-own-key Anthropic layer: plain-English enrichment, evidence-cited bug finding, question translation, design generation. Everything else works with no key and offline.

## Capabilities and Constraints

- Static site, zero backend, no build step; vanilla ES modules. `js/render.js`, `js/query.js`, `js/validate.js` are dependency-free because HTML exports embed them verbatim.
- Analyzer covers ten languages (JS/TS, Python, C#, Go, Java, Kotlin, Rust, Ruby, PHP, C/C++); regex-based, honest about being static analysis.
- Maps cap at ~80 visible nodes for readability; everything else stays in a searchable, expandable inventory — de-emphasized, never hidden.
- All structural edits flow through a validated patch engine; AI-generated designs are machine-validated with a bounded repair loop; invalid output is refused.
- Terminology: map · wires (imports) · clusters/layers · critical path · reach (upstream/downstream) · route · evidence · findings · tour · Designer.

## Brand Commitments

None binding. The user granted free rein on identity (2026-08-30): name, palette, type, and voice may all be re-proposed. Existing name "ArchMap" is in use but not locked.

## Evidence on Hand

- Live demo data: `demo/self.archmap.json` (ArchMap mapping its own source) — real, regenerable via `node tools/gen-demo.mjs`.
- 26 unit tests (`tools/*.test.mjs`) backing the truth claims (evidence lines, validation, query answers).
- Sample repos that map well in one click: expressjs/express, pallets/flask.
- No testimonials, user counts, logos, or press — do not fabricate any.

## Product Principles

1. Computed truth first: never show a fact the graph can't back; misses and assumptions are stated, not papered over.
2. Plain language is the primary register; technical depth is one click deeper, never the entry fee.
3. The map is the product — chrome recedes, the canvas leads, and every control teaches what it does.
4. Nothing leaves the browser; privacy is an architectural fact, stated plainly wherever trust is asked for.
5. Honest AI: models translate, describe, and propose — validation gates everything; the computed graph always has the last word.

## Accessibility & Inclusion

Keyboard-complete exploration (documented `?` overlay), visible focus, non-color state cues (dashed = dead, badges numbered), `prefers-reduced-motion` honored, light/dark parity. No formal WCAG target committed; treat AA contrast as the working floor.
