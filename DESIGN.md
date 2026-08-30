---
name: ArchMap
description: Apollo-program documentation as a working design system — white bond paper, typewritten data, ink rules, one international-orange signal.
colors:
  paper: "#ffffff"
  paper-2: "#f4f4f1"
  paper-dot: "#d9dbd6"
  ink: "#17191c"
  ink-soft: "#3b3e44"
  muted: "#656b74"
  line: "#d8dad6"
  line-strong: "#a9ada6"
  signal: "#ff4400"
  signal-ink: "#17191c"
  signal-text: "#c53500"
  accent-2: "#c2410c"
  go: "#1e7d3f"
  nogo: "#d61f45"
  client: "#1667c9"
  route: "#1e7d3f"
  service: "#7c3aed"
  db: "#b45309"
  external: "#be2f5b"
  critical: "#d61f45"
  neutral: "#6b7280"
  node-fill: "#ffffff"
  edge-normal: "#9aa1aa"
typography:
  display:
    fontFamily: "Archivo, -apple-system, Helvetica Neue, Helvetica, Arial, sans-serif"
    fontSize: "clamp(30px, 2.85vw, 41px)"
    fontWeight: 800
    lineHeight: 1.06
    letterSpacing: "-0.02em"
  headline:
    fontFamily: "Archivo, -apple-system, Helvetica Neue, Helvetica, Arial, sans-serif"
    fontSize: "13px"
    fontWeight: 800
    letterSpacing: "0.18em"
  title:
    fontFamily: "Archivo, -apple-system, Helvetica Neue, Helvetica, Arial, sans-serif"
    fontSize: "15px"
    fontWeight: 800
    letterSpacing: "0.08em"
  body:
    fontFamily: "Archivo, -apple-system, Helvetica Neue, Helvetica, Arial, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.6
  label:
    fontFamily: "Archivo, -apple-system, Helvetica Neue, Helvetica, Arial, sans-serif"
    fontSize: "10.5px"
    fontWeight: 700
    letterSpacing: "0.12em"
  data:
    fontFamily: "Courier Prime, Courier New, ui-monospace, Menlo, monospace"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
  panel-title:
    fontFamily: "Archivo, -apple-system, Helvetica Neue, Helvetica, Arial, sans-serif"
    fontSize: "17px"
    fontWeight: 800
  lede:
    fontFamily: "Archivo, -apple-system, Helvetica Neue, Helvetica, Arial, sans-serif"
    fontSize: "16px"
    fontWeight: 400
  input:
    fontFamily: "Courier Prime, Courier New, ui-monospace, Menlo, monospace"
    fontSize: "14px"
    fontWeight: 400
  meta:
    fontFamily: "Archivo, -apple-system, Helvetica Neue, Helvetica, Arial, sans-serif"
    fontSize: "12px"
    fontWeight: 400
  annotation:
    fontFamily: "Archivo, -apple-system, Helvetica Neue, Helvetica, Arial, sans-serif"
    fontSize: "11.5px"
    fontWeight: 400
  state-tag:
    fontFamily: "Archivo, -apple-system, Helvetica Neue, Helvetica, Arial, sans-serif"
    fontSize: "9.5px"
    fontWeight: 700
    letterSpacing: "0.08em"
rounded:
  plate: "0px"
  stamp: "2px"
  chip: "3px"
  control: "4px"
  node: "8px"
  pill: "999px"
components:
  button-primary:
    backgroundColor: "{colors.signal}"
    textColor: "{colors.signal-ink}"
    rounded: "{rounded.control}"
    padding: "7px 14px"
  button-default:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "7px 14px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "7px 14px"
  button-ai:
    backgroundColor: "transparent"
    textColor: "{colors.service}"
    rounded: "{rounded.control}"
    padding: "7px 14px"
  chip:
    backgroundColor: "transparent"
    textColor: "{colors.ink-soft}"
    rounded: "{rounded.chip}"
    padding: "4px 12px"
  chip-active:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    rounded: "{rounded.chip}"
    padding: "4px 12px"
  input-text:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "9px 12px"
  mini-chip:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink-soft}"
    rounded: "{rounded.chip}"
    padding: "2px 9px"
  go-stamp:
    backgroundColor: "transparent"
    textColor: "{colors.go}"
    rounded: "{rounded.stamp}"
    padding: "0 7px"
---

# Design System: ArchMap

<!-- Recorded from the shipped build (index.html, css/style.css, js/render.js,
     js/main.js, js/export.js) after the finish review passed. The stylesheet
     is the normative token source; this file describes what is built, not
     what was planned. Direction: "The Flight Plan", seed 514384d1. -->

## Overview

**Creative North Star: "The Flight Plan"**

ArchMap is drawn as Apollo-program documentation put to work: a mission briefing
for the codebase you own. The page is white bond paper carrying ink rules,
numbered phases down one datum rail, checklist rows, typewritten data, and
verification stamps. It deliberately refuses the dark dev-tool hero — no
terminal window, no glow. Light ("day ops") is the native register, a document
read at a desk in daylight; dark ("Night Ops") is a full-parity optional mode —
the same vocabulary in a dark room, never a different design.

Color is meaning, never mood. One international orange is the signal — the
action to take — and it commits at block scale or not at all. Green stamps GO,
red stamps NO-GO, and the six-color cluster palette on the map is the product's
own semantics (client / route / service / db / external / critical), carried
straight from CSS custom properties into the drawn SVG. Everything else is ink
on paper.

The register is documentary: claims come with evidence, empty states are drawn
and worded honestly ("0. None."), state changes are carried in the line itself
(dashed = dead, struck = disabled), and exactly one motion moment is authored —
the GO-poll stamps landing on the landing page.

**Key Characteristics:**
- White bond paper with a faint plot-grid dot pattern; structure drawn in ink rules, not boxes-on-gray.
- One orange signal, committed at block scale; orange-as-text drops to a darker AA-safe tone.
- Two type voices: Archivo speaks, Courier Prime records.
- Numbered phases on a single left datum rail; checklist rows; GO/NO-GO stamps.
- Square document plates, gently rounded controls; depth from 2px ink borders before shadow.
- Light is native, dark is parity; every token is defined in both registers.

## Colors

Ink on white paper, one orange signal, and a semantic graph palette — every hue on the map is a fact.

### Primary
- **International Orange** (`signal`, #ff4400): the one action color. Used at block scale only: the primary button fill, an active toolbar toggle, the caret, the focus outline, selection tint. Never a wash, never a decoration.
- **Ink on Orange** (`signal-ink`, #17191c): text set on an orange block (primary buttons keep dark ink, not white).
- **Orange as Text** (`signal-text`, #c53500): whenever orange is *written* on paper — the brand's "Map" half, links on hover, inline warnings — it drops to this darker tone for AA contrast at text sizes.
- **API Rust** (`accent-2`, #c2410c): the external-API wire color on the canvas; the signal family's quieter relative.

### Secondary
- **GO Green** (`go`, #1e7d3f): verification passed — GO stamps, the ✓ fact line, self-check passes, planned-repair outlines.
- **NO-GO Red** (`nogo`, #d61f45): verification failed — NO-GO stamps, error toasts, danger buttons, failed self-checks.

### Tertiary — the graph palette (product semantics, not decoration)
- **Client Blue** (`client`, #1667c9): entry/client cluster and entry→mount wires.
- **Route Green** (`route`, #1e7d3f): routes cluster and downstream-reach traces.
- **Service Violet** (`service`, #7c3aed): services cluster, upstream-reach traces, and every AI-powered control (Enrich, Debug-AI, instruction input) — AI belongs to the service layer.
- **Data Amber** (`db`, #b45309): data cluster, database wires, file paths in the sidebar.
- **External Rose** (`external`, #be2f5b): the outside world.
- **Critical Red** (`critical`, #d61f45): the critical path, dead-code marks, open-bug outlines and badges.
- **Overflow Grey** (`neutral`, #6b7280): de-emphasized inventory nodes.
- **Node Plate** (`node-fill`, #ffffff) and **Quiet Wire** (`edge-normal`, #9aa1aa): the canvas's resting surfaces.

### Neutral
- **Bond Paper** (`paper`, #ffffff): the page and every plate.
- **Second Sheet** (`paper-2`, #f4f4f1): inset surfaces — code spans, receipts, notes, menu hover.
- **Plot Grid Dot** (`paper-dot`, #d9dbd6): the radial-gradient dot grid on landing (28px), map (26px), and specimen (22px).
- **Document Ink** (`ink`, #17191c): text, 2px structural rules, the inverted plates (phase numbers, active chips, toast).
- **Soft Ink** (`ink-soft`, #3b3e44): running prose and secondary copy.
- **Pencil Note** (`muted`, #656b74): hints, metadata, placeholders.
- **Hairline Rule** (`line`, #d8dad6) and **Heavy Rule** (`line-strong`, #a9ada6): row separators and control borders respectively.

### Named Rules
**The One Signal Rule.** Orange is the single voice of action and it commits at block scale — a filled button, an active toggle — or drops to `signal-text` when written on paper. If orange is decorating rather than signaling the next action, it is wrong.

**The Six-Digit Rule.** The graph palette tokens stay 6-digit hex. `render.js` reads them from CSS custom properties at draw time and composes alpha variants by appending hex pairs (`${color}10`, `${color}1f`); any other color format breaks the canvas.

**The Borrowed-Meaning Rule.** Chrome may wear a graph color only when it points at that graph meaning: upstream buttons wear Service Violet like the traces they draw, downstream buttons wear Route Green, AI controls wear Service Violet. Never recruit a cluster color as decoration.

**Dark parity.** Every color token above is redefined under `[data-theme="dark"]` (Night Ops): paper #121417, ink #e8eaed, signal #ff5a1f, signal-text #ff8a5c, go #58c07d, nogo #ff4d6e, and a lightened graph palette (see `.impeccable/design.json` for the full dark set). A new color that exists in only one theme is unfinished.

## Typography

**Display/Body Font:** Archivo (with -apple-system, Helvetica Neue, Helvetica, Arial fallbacks)
**Data Font:** Courier Prime (with Courier New, ui-monospace, Menlo fallbacks)

**Character:** A standards-manual grotesk speaks; a typewriter records. Both are Google-hosted with real system fallback stacks because standalone HTML exports must degrade gracefully offline.

### Hierarchy
- **Display** (800, clamp(30px → 41px), 1.06, -0.02em, uppercase): the hero statement only. The ramp jumps straight from text sizes to display — there are no intermediate hero sizes.
- **Headline** (800, 13px, 0.18em tracking, uppercase): section headings (`.phase-title`). Hierarchy comes from weight and tracking, not size; a heading may carry a plain-language annotation *after* it (muted, mono, lowercase), never a kicker above it.
- **Title** (800, 15px, 0.08em, uppercase): panel and overlay headings (Settings, help, Designer). The sidebar's selected-file name is its one larger cousin (800, 17px, -0.01em, mixed case).
- **Body** (400, 15px, 1.6): running prose. Ledes cap at 56–62ch (`max-width: 56ch` / `62ch`).
- **Utility steps** — panel-title 17px/800, lede 16px, input 14px (mono), meta 12px, annotation 11.5px, state-tag 9.5px/700 tracked: the documentary micro-ramp between the named registers; every step has one job.
- **Label** (700, 10.5px, 0.12em, uppercase): form labels and sidebar section heads (the latter tracked wider at 0.18em and underlined with a 1px ink rule).
- **Data** (Courier Prime, 400, ~11–14px): everything computed or measured — inputs, facts, transcripts, receipts, HUD readouts, phase numbers, and all text drawn on the map canvas (`#map text`). Numeric readouts set `font-variant-numeric: tabular-nums`.

### Named Rules
**The Two Registers Rule.** Archivo speaks (headings, prose, buttons); Courier Prime records (data, evidence, ids, readouts). If a value was computed from the graph, it is set in mono.

**The No-Kicker Rule.** Nothing sits above a heading — no eyebrow, no kicker. Context attaches after the heading as a muted inline annotation, or on the datum rail as a phase number.

**The Rasterized-Export Exception.** Standalone SVG/PNG image exports set a system mono stack (`ui-monospace, SFMono-Regular, Menlo, Consolas`) instead of Courier Prime, because webfonts cannot load inside a serialized raster. This is the intended offline degradation, not drift.

## Layout

The landing page is one continuous document on a **datum rail**: a `max-width: 1120px` column (24px gutters) where every section is a `.phase` grid (`72px 1fr`, the rail width is the `--rail-w` token) registered against a single continuous 2px ink rule on the left. Phase numbers (001–004, A, B) sit on the rail as ink plates — mono 12px bold, paper-on-ink. Content inside phases is built from checklist rows: 2px ink top rule, 1px hairline row separators, grid columns of `44px [label] 1fr`.

The topbar is a sticky document strip (min-height 52px, 2px ink bottom rule) whose metadata cells are mono 11px uppercase separated by hairline rules. The app view is a full-viewport flex column: the map canvas leads, a 348px sidebar sits behind a 2px ink left rule. HUD elements float over the canvas centered on the map area (offset for the sidebar: `left: calc((100% - 348px) / 2)`).

Spacing is optical, not tokenized: control padding runs 4–14px, plate padding 8–32px, section rhythm 36–56px. There is no spacing scale; match the neighboring density rather than inventing steps.

Breakpoints as built: **1100px** (toolbar chips wrap to their own row, search narrows), **900px** (hero stacks, specimen unsticks, rail narrows to 40px, checklist rows collapse to 2 columns), **760px** (sidebar becomes a slide-in drawer with a toggle button, minimap hides, HUD spans the full width), **700px** (landing nav links hide), **480px** (annex tables stack term-over-description).

### Named Rules
**The Datum Rail Rule.** Every landing section registers against the one left ink rule. New sections join the rail as numbered phases; they do not float free.

**The Canvas Leads Rule.** In the app, chrome recedes: the map owns the viewport, the sidebar and HUD annotate it from the edges, and nothing overlays the canvas center except transient HUD plates.

## Elevation & Depth

Depth is drawn before it is cast: structure comes from 2px ink borders and inverted ink plates, and shadows are quiet paper-lift underneath. There are exactly two shadow tokens; modal scrims are translucent ink (`color-mix(in srgb, var(--ink) 18–22%, transparent)`), never black glass.

### Shadow Vocabulary
- **Rest** (`--shadow`: `0 2px 6px rgba(23,25,28,0.06), 0 10px 28px rgba(23,25,28,0.09)`): plates sitting on the page — specimen, transcript, HUD status, minimap.
- **Lift** (`--shadow-lift`: `0 16px 48px rgba(23,25,28,0.16)`): things floating above the document — overlay panels, menus, the tour plate, toast, the mobile sidebar drawer.

Both deepen under Night Ops (rgba(0,0,0,0.35–0.55)).

### Named Rules
**The Ink-Before-Shadow Rule.** If an element needs presence, give it an ink border first (2px for plates, 1px for rows and controls). Shadow is reserved for elements that genuinely sit above the paper; nothing gets a shadow instead of a border.

## Shapes

Two form languages coexist deliberately. **Documents are square:** every plate — specimen, transcript, HUD tour and status, panels, menus, receipts — has `border-radius: 0` and a 1–2px ink border. **Controls are gently rounded:** buttons, inputs, kbd at 4px; chips at 3px; stamps and severity tags at 2px. The pill (999px) exists in exactly two places: the floating hint pill over the map and the tiny "surface only" beta tag. On the canvas, node plates round at 8px (rx="8"), cluster blocks at 10px, debug halos at 12px.

State lives in the line, not just the color: **dashed = dead** (nodes `stroke-dasharray="5 3"`, cycle edges `"7 4"`, legend swatch `"4 3"`), **struck = disabled** (disabled buttons and dead file paths get `line-through` at 1px thickness, never opacity fades). Stamps are 1.5px-bordered, uppercase, letter-spaced plates (GO/NO-GO, CRITICAL, severity tags).

### Named Rules
**The Plates-Square, Controls-Rounded Rule.** A surface that presents information is square with an ink rule; a surface you press is rounded 2–4px. Do not round a document plate, and do not square a button.

**The Line-Form State Rule.** Dead is dashed, disabled is struck, circular is dashed-long. State must survive greyscale: the line form carries it, color only reinforces it.

## Components

### Buttons
- **Shape:** gently rounded (4px), 1px Heavy Rule border, sans 13px/600, `white-space: nowrap`.
- **Primary:** International Orange fill, dark ink text (`signal-ink`), weight 700, 0.02em tracking, padding 7px 14px. Hover brightens the block (`filter: brightness(1.06)`); it never changes hue.
- **Default:** paper fill, ink text; hover darkens the border to ink; active presses down 1px (`translateY(1px)`).
- **Ghost:** transparent and borderless until hover restores the Heavy Rule border. Used for chrome (theme, settings).
- **AI (`.ai-btn`):** transparent with Service Violet text and a 55%-violet border; hover adds an 8% violet wash. Marks every Claude-powered control.
- **Disabled:** struck, not faded — `line-through`, Pencil Note text, hairline border, active press removed.
- **Focus (all controls):** 2px International Orange outline, 2px offset (`:focus-visible`).

### Chips
- **Filter chips:** transparent, 1px Heavy Rule border, 3px radius, 12px/600; **active = inverted ink plate** (ink fill, paper text) — active-ness is ink, not orange. The debug chip is the exception: active = NO-GO red, because it means "showing problems".
- **Mini-chips** (file references): mono 11.5px on paper, hover turns border and text to the signal family.

### Cards / Containers
- **Document plates** (specimen, transcript, panels): 2px ink border, radius 0, paper fill, Rest or Lift shadow per altitude, headed by an internal rule (`border-bottom: 1px solid var(--ink)`).
- **Receipts** (computed summaries): Second Sheet fill, 1px ink border, radius 0, mono 12px, tabular numerals.
- **Inverted plates** (phase numbers, tour step, toast, active chips): ink fill, paper text — the strongest emphasis in the system, used sparingly. Inversion is a color treatment, not a shape class: phase numbers and tour steps stay square, active chips keep 3px, the transient toast keeps 4px.

### Inputs / Fields
- **Style:** paper fill, 1px Heavy Rule border, 4px radius, **mono face** (data is typed here), padding 9px 12px, orange caret.
- **Focus:** border turns International Orange plus a 3px ring at 18% signal (`box-shadow: 0 0 0 3px color-mix(in srgb, var(--signal) 18%, transparent)`); the map search and instruction input use the same pattern at 15% (violet for the AI instruction field).
- **Placeholders:** Pencil Note.

### Navigation
- **Topbar links:** sans 13px/600, no underline, 4px radius; hover = Second Sheet wash. The brand is uppercase 800 with the "Map" half in Orange-as-Text; in-app it gains a muted "‹ new map" back cue.

### Icons
Drawn, never emoji or icon fonts: a single inline SVG sprite of 16-viewBox stroke symbols (play, edit, bug, spark, export, gear, sun, moon) rendered at 15px, `stroke-width: 1.6`, round caps and joins, `currentColor`. Icons accompany words; icon-only buttons exist solely for theme and settings toggles and carry `aria-label`s. Renderer-generated buttons (HUD, sidebar) use words alone. Typographic marks are text, not icons — the world natively uses the ✓ tick (GO Green), − / + zoom, the ‹ back cue, and · separators, all set in the type color system.

### The Map (signature)
Node plates are 200×54px (rx 8), Node Plate fill, stroked in their cluster color (1.3px; 2.4px critical; ~2.2–2.8px selected/traced), labeled in mono 12.5px/600 with a 10.5px muted sub-line. Cluster blocks are 10%-alpha washes with 22%-alpha borders and 12px bold tracked headers; edges are cubic béziers in semantic colors; bug/repair counts are drawn 9px-radius badges. The legend is **drawn, not written**: real SVG swatches (`lgLine`, `lgNode`, `lgDot`) reproduce the actual line forms. All colors reach the SVG via `readTheme()` reading the CSS custom properties, so the canvas re-draws correctly on theme flip.

### The GO Stamp (signature)
Mono 700, 0.14em tracking, GO Green text in a 1.5px GO Green border, 2px radius, padding 0 7px (NO-GO swaps to red; unavailable swaps to muted "—"). On the landing specimen the stamps land as the one authored motion moment: from `opacity: 0, scale(1.3) rotate(-4deg)` to rest in 0.18s, staggered 500ms + 380ms per row — each row a real computed check, stamped like a verification poll. Under `prefers-reduced-motion` they appear instantly.

### Motion (system-wide)
One easing token: `--ease: cubic-bezier(0.22, 1, 0.36, 1)`. Micro-transitions run 0.15s (borders, colors, node/edge opacity), the sidebar drawer 0.2s, the stamp 0.18s. The spinner (3px hairline ring, orange top arc) slows to 2s rather than stopping under reduced motion; a global reduced-motion rule collapses all other transitions to 0.01ms.

## Do's and Don'ts

### Do:
- **Do** commit orange at block scale — a filled primary button, an active toggle — and switch to `signal-text` (#c53500) the moment orange becomes text on paper.
- **Do** draw structure with ink rules: 2px ink for plate and document boundaries, 1px hairline for rows inside them, an inverted ink plate for the strongest emphasis.
- **Do** set every computed or measured value in Courier Prime, with `tabular-nums` where digits align (receipts, HUD, GO rows).
- **Do** define any new color token in both `:root` and `[data-theme="dark"]`, and keep graph palette entries 6-digit hex (the renderer appends alpha hex pairs).
- **Do** carry state in line form — dashed for dead, struck for disabled, 1.5px-bordered uppercase stamps for verdicts.
- **Do** add new icons to the inline sprite as 16-viewBox, 1.6px-stroke, round-capped drawings on `currentColor`.
- **Do** keep zero-states drawn and worded honestly ("0. None." / the specimen ghost) — an empty answer is still an answer.

### Don't:
- **Don't** put an eyebrow or kicker above a heading; annotations attach after the heading, muted and inline.
- **Don't** use emoji or glyph-font icons anywhere, including renderer-generated buttons — those use words.
- **Don't** round a document plate (radius stays 0) or give shadows to things an ink border already grounds; the pill shape stays confined to the hint pill and the beta tag.
- **Don't** fade disabled controls — strike them through.
- **Don't** recruit cluster colors for decoration; chrome wears a graph color only when it triggers that graph meaning.
- **Don't** author new motion moments; the GO-poll stamp sequence is the only one, and everything else stays at 0.15s micro-transitions honoring `prefers-reduced-motion`.
- **Don't** add UI libraries, icon packages, or extra font dependencies: the world is hand-drawn vanilla CSS/SVG, fonts stay Google-hosted Archivo + Courier Prime over real system fallbacks, and `render.js` / `query.js` / `validate.js` stay dependency-free because exports embed them verbatim.
