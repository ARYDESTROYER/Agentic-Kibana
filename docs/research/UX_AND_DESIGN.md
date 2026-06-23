# UX & Visual Design Research — SOC / Security Products

> **Purpose.** A product-design research brief for the TLSOC Agentic Triage Suite
> web UI (`webui/`, Vite + React + `@elastic/eui@95.12`). It studies how the
> leading SOC consoles handle *layout density, navigation & iconography, AI-assistant
> chat, tables & filtering,* and *design standardization,* then turns that into a
> concrete, dependency-light set of recommendations we can implement on top of EUI.
>
> Audience: anyone building or polishing a screen in `webui/`. Read §6 for the
> actionable list; §1–§5 are the evidence behind it.
>
> Scope of products surveyed: **Elastic Security / Kibana (EUI)**, **OpenSearch
> Dashboards (OUI)**, **Splunk (Splunk UI / Enterprise Security)**, **Microsoft
> Sentinel + Defender XDR (Fluent 2)** and **Microsoft Security Copilot**,
> **CrowdStrike Falcon + Charlotte AI**, **Datadog (Cloud SIEM)**, and **Google
> SecOps / Chronicle + Gemini**.
>
> All external claims are cited inline; the full source list is in §8.
> Last updated 2026-06-23.

---

## 0. TL;DR — what "professional SOC UI" actually means

Across every product surveyed, the same handful of design moves recur. They are
the bar we should hit:

1. **Density is a feature, not a bug.** SOC tools are list/table-first and proudly
   dense. Whitespace is spent on *grouping and hierarchy*, not on padding. Every
   one of them ships a **compact/comfortable density toggle** for tables and a
   bounded content width so wide monitors don't stretch a table to 3000px.
2. **One spacing grid, everywhere.** EUI (base-16 / 4-step), Fluent 2 (4px base),
   Splunk, Datadog all derive *every* margin/padding from a single token scale.
   Ad-hoc pixel literals are the #1 cause of an "amateur" feel.
3. **Full-height app shells.** A fixed top bar + sticky left nav + a scrolling
   content region that fills the viewport. Toolbars (search/filter) stick to the
   top of the scroll region; the data region virtualizes.
4. **Iconography is a *set*, not a grab-bag.** Single stroke weight, 2 sizes (16 /
   24), consistent optical alignment, semantic color used sparingly (red = bad,
   not decoration). Apps get a single brand mark; nav items get a *muted* glyph
   that turns the accent color only when selected.
5. **The AI assistant is a first-class surface,** not a bubble. It renders
   structured output (tables, generated queries with a copy button, citations to
   sources, "what I did / which tools I used"), offers **prompt starters /
   promptbooks**, a **scope/context chip**, and a **model selector**, and it lives
   either as a docked right rail or a full page — never a tiny floating window.
6. **Faceted filtering + saved views.** A persistent facet panel/bar with counts,
   "filter by data source," multi-select facets, free-text search, and the ability
   to save a filter set as a named view.

The good news: the TLSOC webui already does a lot of this (a shared `ui.tsx`
primitive set, a `COLORS`/`TYPE` token layer, a reusable `ChatPanel`, client-side
faceted filtering on Cases). §6 is mostly *tightening and standardizing* what
exists, plus a few targeted additions (a real spacing-token module, a density
toggle, full-height chat, sort-everywhere).

---

## 1. Layout density & space usage

### 1.1 The shared pattern: bounded width + full height + sticky toolbars

Dense SOC UIs are almost always built as a **flex app shell**: a fixed header, a
sticky/collapsible left nav, and a content column that grows to fill the viewport
height. The data region inside scrolls independently while a **toolbar (search +
filters + density/refresh) sticks to the top** of that scroll region.

- **Elastic / EUI** codifies this in `EuiPageTemplate`: a wrapping component that
  controls `paddingSize`, `bottomBorder`, `restrictWidth`, and `panelled`, with
  namespaced children `.Sidebar`, `.Header`, `.BottomBar`, and `.Section`.
  `EuiPage` is a flex wrapper that *automatically grows to fill the height of a
  flex container.* Crucially, **`restrictWidth` centers the page content and caps
  it — at `1200px` when set to `true`,** or at any explicit value. This is the
  mechanism that keeps a data table from stretching edge-to-edge on a 34" monitor.
  ([EUI Page template][eui-page], [EUI Page components][eui-pagecomp])
- **Microsoft Fluent 2** frames the same idea through its layout system: a
  multi-platform spacing ramp "used in every component and layout to create a
  familiar and cohesive product experience, regardless of device." Content lives
  on a grid with defined gutters rather than free-floating. ([Fluent 2 Layout][fluent-layout])
- **Datadog** Log/SIEM Explorer is the archetype dense layout: a **left facet
  panel**, a top query bar, and a virtualized result list that fills the rest, with
  a **side panel** that slides in for a single record rather than navigating away —
  so the dense list never loses its place. ([Datadog Log Explorer][dd-explorer],
  [Datadog Log Side Panel][dd-sidepanel])

### 1.2 How they make dense screens feel *clean* (not cramped)

- **A single spacing scale.** Everything is a multiple of a base unit, so vertical
  rhythm is consistent and the eye groups rows/sections without conscious effort.
  EUI's base is **16px** with the scale `xxs 2 · xs 4 · s 8 · m 12 · base 16 ·
  l 24 · xl 32 · xxl 40 · xxxl 48 · xxxxl 64` (px). The base returns a *number* so
  you can do math (`euiTheme.base * 2`); the `size.*` tokens return CSS strings.
  ([EUI sizing tokens][eui-size-src]) Fluent 2 uses a **4px base** grid with the
  note that the off-grid values 2, 6, 10 exist only to optically align icons.
  ([Fluent 2 Layout][fluent-layout])
- **Bounded content width.** Capping the readable/working column (EUI's
  `restrictWidth`, Fluent's grid max) prevents the "data stretched across a
  void" look on ultrawide displays. ([EUI Page template][eui-page])
- **Density toggles instead of one-size padding.** `EuiDataGrid` ships a built-in
  density control plus row-height options (`rowHeightsOptions`, including
  `defaultHeight: 'auto'` to fit content) and **cell virtualization** that kicks in
  when the grid's height/width is constrained — only visible cells render, so a
  100k-row table stays smooth. ([EUI Data grid in-memory][eui-grid-mem],
  [EUI Container constraints][eui-grid-constraints]) EUI even ships dedicated
  density icons (`tableDensityCompact/Normal/Expanded`) — the TLSOC `icons.ts`
  already registers all three.
- **Toolbars and headers stick.** The filter/search bar pins to the top of the
  scroll region so it is always reachable in a long list; the dense data scrolls
  under it.
- **Slide-in side panels over full navigations.** Datadog's log side panel and
  Sentinel's incident pane both open detail *beside* the list, preserving the
  analyst's scroll position and context. Datadog's panel has a reusable structure:
  an **upper "context" section** (auto-attached tags — host, container, source) and a
  **lower "content" section** (the message + structured fields), with
  **cross-correlation tabs** (Metrics in a ±30-min window, the related Trace) and
  *interactive JSON* (click a field to add a column, filter, or build a facet).
  ([Datadog Log Side Panel][dd-sidepanel]) TLSOC's `CaseDetailFlyout` is the analog —
  context-up / evidence-down with tabs is a proven layout.

### 1.3 Dark-first, dense consoles (CrowdStrike, Chronicle)

CrowdStrike Falcon and Google Chronicle/SecOps lean into **dark, high-density**
consoles where the dark canvas lets a few semantic colors (red detections, amber
warnings) pop without visual noise. The discipline that makes them read as
"professional" rather than "busy": consistent row height, a single accent, heavy
use of monospace for IOCs/queries, and badges (not prose) for status.

- **Dark is the default** for table-heavy triage. CrowdStrike ships a public
  *Falcon Styles* stylesheet with light **and** dark themes, dark applied by adding
  `theme-dark` to the document root. ([CrowdStrike falcon-styles][cs-falconstyles])
  Google **SecOps was dark-by-default** until a *Light Theme was newly added in May
  2025* "for users who prefer higher contrast, or work in brightly lit
  environments." ([SecOps UX updates 2025][gcp-uxblog]) The lesson: ship a polished
  dark theme as a first-class mode (TLSOC already has a runtime light/dark toggle).
- **Density commitments are explicit.** SecOps UDM Search is engineered to navigate
  **up to 1,000,000 results in-browser** without exporting — a hard commitment to a
  dense, in-UI table. ([Google UDM Search][gcp-udm])
- **The shared skeleton:** a *persistent left rail* (nav and/or facets) + a
  *list/table-first center* + a *right/side detail panel* for the selected item.
  Datadog (left facet panel + right log/signal side panel), SecOps (sliding left
  nav + right Gemini/Case side panel), Falcon (domain-grouped left menu + detection
  detail panel) all follow it.
- **Honest caution.** Even category leaders get dense wrong: Gartner Peer Insights
  reviewers note CrowdStrike's Next-Gen SIEM UI "can feel disorganized and
  unintuitive, making navigation and investigation less efficient." ([Gartner Peer
  Insights][cs-gartner]) Density without a clear hierarchy/grid reads as clutter —
  which is exactly why §5's token discipline matters.

**Takeaways for TLSOC.** We already have a flex shell (`EuiPage` + fixed
`EuiHeader` + `EuiPageSidebar sticky`) and a `restrictWidth={1280}` content
section in `Shell.tsx`. Gaps: no spacing-token module (many inline pixel
literals), no table density control, and the content sections don't always
exploit full height (chat especially). See §6.

---

## 2. Navigation & iconography

### 2.1 Sidebar navigation patterns

- **Kibana / Elastic Security** uses a **collapsible solution side nav**: grouped,
  with section labels, a clear active state, and the ability to collapse to icons
  to reclaim horizontal space on dense screens. EUI provides `EuiSideNav` (grouped
  items, selected state) and `EuiCollapsibleNav` for this. The TLSOC `Shell.tsx`
  already builds an `EuiSideNav` from three labeled groups (Triage / Automation /
  Platform).
- **Splunk** groups navigation by app and surfaces a consistent top bar across
  apps; the Splunk UI design language is published as a system so every app reads
  the same. ([Splunk UI Design System][splunk-ds])
- **Datadog** keeps a persistent, icon-led left rail with product sections that
  expand on hover/click — dense but legible because every item is one glyph + one
  word at a fixed row height. ([Datadog Log Explorer][dd-explorer])

### 2.2 What makes icons look professional vs. amateur

The single biggest "polish" lever, and the cheapest. The rules every mature system
follows:

1. **One icon set, one stroke weight.** EUI ships a curated glyph set at a single
   stroke; Fluent ships the Fluent icon family at a single weight. Mixing icon
   *families* (or stroke weights) is the fastest way to look unfinished.
2. **A tiny set of sizes on a grid.** EUI `EuiIcon` sizes are `s / m / l / xl /
   xxl / original`, with **`m` (16×16) the default**, and the system's own guidance
   is that custom SVGs should be **16×16 or 32×32** to stay on-grid.
   ([EUI Icons][eui-icons]) Fluent aligns icons to its 4px grid (the 2/6/10
   padding values exist *specifically* to keep icons aligned).
   ([Fluent 2 Layout][fluent-layout])
3. **Optical alignment & consistent box.** Icons sit in a fixed-size box so labels
   line up regardless of glyph width — TLSOC's `IconChip` (a 36/48px rounded
   tinted square) is exactly this idiom.
4. **Semantic color, used sparingly.** Color carries meaning (danger/success/
   warning), not decoration. Nav glyphs are *muted/subdued* by default and only
   take the accent color when selected — which TLSOC's `Shell.tsx` already does
   (`color={selected ? COLORS.primary : 'subdued'}`).
5. **One brand mark; everything else is a glyph.** A single app logo (gradient
   rounded square + glyph in TLSOC's `socLogo`) anchors the brand; nav and content
   use the neutral glyph set.

### 2.3 The lazy-icon footgun (and how Elastic solves it)

EUI ships every glyph as a lazily `import()`-ed chunk. In a statically served
SPA those chunks can fail to resolve, rendering blank gray squares. The fix is
**`appendIconComponentCache`** to pre-register the icons you use so EUI resolves
them synchronously. TLSOC already does this in `webui/src/lib/icons.ts` (registering
~140 glyphs incl. table/sort/density chrome) — this is the correct, documented
pattern and must stay in sync as new icon `type`s are introduced. ([EUI Icons][eui-icons])

### 2.4 Health & status indicators

Mature consoles surface system health in the chrome: a colored health pill,
a version badge, connection state. TLSOC's header already has an `EuiHealth`
pill (polling `/api/health` every 15s) + a version `EuiBadge` — keep this; it's
a recognized "this product is alive and observable" signal.

---

## 3. AI assistant / chat UX in security tools

This is the area with the most differentiation and the most opportunity. The
modern security AI assistant is a **structured, auditable, scoped** surface, not a
generic chatbot. Five reference implementations:

### 3.1 Microsoft Security Copilot

- **Sessions + prompt bar.** Work happens in **sessions**; you open *All history →
  New session* to start a chat. The **prompt bar** takes natural-language requests.
  ([MS — Prompting in Security Copilot][ms-prompting])
- **Process log / "what I did."** As a response forms, Copilot shows a **process
  log** giving "visibility into the actions taken, **sources used**, and processing
  time," plus a **debugger** to see *which plugins were selected and executed* and
  how they enriched the prompt. This is the gold standard for *explainable* AI
  output — a SOC analyst must be able to see the agent's tool calls and sources.
  ([MS — Prompting][ms-prompting])
- **Promptbooks.** Reusable, *named* sequences of prompts grouped to accomplish a
  task, shown in a library "listed by name, owner, description, number of prompts,
  required plugins, and visibility." In the standalone experience the output of one
  prompt feeds the next. ([MS — Promptbooks][ms-promptbooks])
- **Plugin/scope selection.** Capabilities are gated by enabled plugins; the UI
  exposes which plugins a promptbook needs. ([MS — Promptbooks][ms-promptbooks])
- **Embedded vs. standalone.** Copilot exists both as a standalone portal and
  *embedded* as a side panel inside Defender/Sentinel/Purview, sharing the same
  prompt model. ([MS — Copilot in Purview][ms-purview])

### 3.2 Elastic AI Assistant for Security

- **Lives in an expandable flyout** reachable via a header button **and** a **Chat**
  action from alert/event detail flyouts — i.e. *contextual* chat scoped to the
  record in view. The expandable flyout "accommodates various content and responses";
  conversations persist across navigation. ([Elastic AI Assistant][elastic-aia])
- **Conversation history in a left sidebar.** Each user's **last 99 conversations**
  auto-save; history shows in a left sidebar of the chat window and on a
  *Conversations* settings tab, and a conversation can be **shared** with teammates.
  ([Elastic AI Assistant][elastic-aia])
- **System prompts + quick prompts.** You can edit/create **System Prompts** and
  modify/create **Quick Prompts** (preset starters); an inline *prompt preview* lets
  you add/remove context and set field-level anonymization *before* sending.
  ([Elastic AI Assistant][elastic-aia])
- **Field-level anonymization.** When attaching events as context, anonymization
  settings mark each field to send as plaintext, obfuscate, or not send at all — a
  privacy control built into the composer. ([Elastic AI Assistant][elastic-aia])
- **Citations toggle.** Chat options let you "show or hide anonymized values" and
  **include citations**; when on, the assistant "refers you to information sources
  including data you've shared, knowledge-base content, and Elastic Security Labs /
  product docs." ([Elastic AI Assistant][elastic-aia])
- **Generated queries are a first-class, actionable artifact.** The assistant writes
  **ES|QL** in code blocks (it has *index names + field metadata* as context); the
  output carries action buttons — **Add to timeline** (push the query/filter into the
  active Timeline) and **Add note to timeline** — plus copy. ([Elastic AI
  Assistant][elastic-aia], [Elastic ES|QL assistant][elastic-esql])
- **Connector/model selector + editable Knowledge Base.** LLM connectors (Bedrock/
  OpenAI/Gemini) are chosen in settings; the Knowledge Base (pre-populated with
  Security Labs articles) grounds answers and can "remember specified information."
  ([Elastic AIA Knowledge Base][elastic-kb])

### 3.3 CrowdStrike Charlotte AI

- **Conversational, plain-language directive UX** embedded *in the Falcon console*
  (not a standalone bubble). Analysts "query, investigate, and remediate in natural
  language." Positioned as an always-on agentic analyst that reasons through
  detections like an experienced human. ([CrowdStrike Charlotte AI][cs-charlotte],
  [Project Kestrel][cs-kestrel])
- **Per-answer "show response details" provenance toggle.** Every Charlotte answer
  has a *show response details* control to "inspect the underlying data source that
  Charlotte AI used to assemble the answer." This is the single cleanest, most
  copyable explainability pattern in the survey — provenance is *one click under
  every answer*, not buried. ([CrowdStrike — transforms Falcon UX][cs-charlotteux])
- **Multi-agent pipeline insulated by a "final formatter."** Entity-extraction →
  router → API/query-generation → validation → "a final agent structures the
  response in a human-readable format," explicitly inserting "buffers that insulate
  end-users from the direct output of LLMs." Maps to TLSOC's formatter stage.
  ([Charlotte AI multi-approach][cs-multi])
- **NL → generated dashboards/reports.** "Describe what you want to see, and the
  appropriate layout and filters are automatically generated." ([Project
  Kestrel][cs-kestrel])

### 3.4 Google SecOps / Chronicle + Gemini

This is the closest analog to TLSOC's own verdict/case model:

- **AI verdicts with reasoning.** The Triage & Investigation Agent determines if
  alerts are true/false positives and "provides a summarized explanation for its
  assessment." ([Google — Triage & Investigation Agent][gcp-tin])
- **Structured case summary widget.** The **Gemini Case Summary** widget renders an
  AI assessment in **three labeled sections — "What Actually Happened?", "Case
  Activity", and "Next and Pending Actions"** (recommended remediation). A
  structured, sectioned summary beats a wall of prose. ([Google — Case summary
  widget][gcp-casesummary])
- **NL → query, iteratively.** Gemini helps "build, edit, and run searches" from
  natural language, then **iterate: adjust scope, expand the time range, add
  filters,** presenting "full mapped syntax" (the generated UDM query). ([Google —
  Gemini in SecOps][gcp-gemini])
- **An investigative chat assistant** inside cases for context + recommendations.
  ([Google — Gemini in SecOps][gcp-gemini])
- **Results render *exclusively in a side panel*.** Running an NL→UDM search renders
  "the query and results exclusively in the side panel… you can keep a Case view in
  focus while the Gemini assistant fetches a summary," and the generated UDM query is
  shown alongside. The assistant **retains context** across turns ("expand the time
  range by a week"). ([Google — Gemini in SecOps][gcp-gemini])
- **Three-pane case/graph view.** A Security-Graph case view: left pane = associated
  alerts + timestamps; middle = a graph of interconnected entities + a graphical
  alert timeline with playback. ([Google — explore entities/alerts][gcp-graph])

### 3.4b Datadog Bits AI (Security Analyst)

The strongest "AI investigation as a structured panel" reference:

- **Investigation renders as a structured side panel, not free chat** — sections
  *Overall conclusion*, *Key evidence*, and *Investigative steps* (each step carries
  **embedded query results and a link to the full query**) + per-step analysis.
  ([Datadog Bits Security Analyst][dd-bits])
- **Actionable from the panel:** create a case pre-populated with the AI
  investigation, run a SOAR workflow, declare an incident, add a suppression,
  archive, or jump to the standard Cloud SIEM view — plus a feedback control.
  ([Datadog Bits Security Analyst][dd-bits])
- **Status surfacing:** AI-investigated signals show "Investigating" in the Severity
  column until resolved to Benign/Suspicious; a dedicated Bits tab filters to them.
  ([Datadog Bits Security Analyst][dd-bits])

### 3.5 Cross-cutting AI-chat design rules (the synthesis)

| Concern | What the leaders do |
|---|---|
| **Surface** | Docked right rail (embedded) **or** a full page — never a tiny floating window. Contextual entry from a record ("Chat about this alert/case"). |
| **Output structure** | Render tables, **generated queries with a copy button**, citations/sources, and a sectioned summary — not just prose. |
| **Explainability** | Show "what I did": tools/plugins used, sources, cost/time. (Copilot process log; SecOps reasoning; Elastic citations.) |
| **Scope** | A visible scope chip ("scoped to case X", "knowledge base on"), plus plugin/data-source toggles. |
| **Model/skill selection** | A model/connector selector and reusable **promptbooks / starters**. |
| **Empty state** | Suggested prompts/promptbooks; never a blank box. |
| **Density** | Tight message rhythm, role-aligned bubbles or rows, subdued metadata footnotes. |

**Where TLSOC stands.** The `ChatPanel` already nails a lot of this: reusable
(page + case flyout), markdown rendering with XSS-safe escaping, **a result table
renderer**, a **"Query used" chip with copy**, per-message **cost + model**
footnote, **memory action/suggestion** surfaces, **prompt starters**, a typing
indicator, and a **model selector**. The main gaps are *full-height layout* (the
lane should fill the viewport on the Chat page) and *richer source/citation +
"tools used" rendering* to match Copilot's process log / SecOps reasoning. See §6.

---

## 4. Tables & filtering

### 4.1 Sorting affordances

- **EUI tables** make sorting explicit: `EuiBasicTable`/`EuiInMemoryTable` mark
  `sortable: true` columns with a sort caret in the header and a sort direction
  indicator; `EuiInMemoryTable` does client-side sort/pagination for you.
  `EuiDataGrid` schemas allow *custom sort comparators* per column (not just A–Z).
  ([EUI Data grid in-memory][eui-grid-mem], [EUI In-memory tables][eui-inmemory])
- The "professional" expectation in a SOC table is **every meaningful column is
  sortable** and the active sort is visibly indicated. SecOps/Sentinel/Datadog all
  sort by severity, time, and entity as table stakes.

### 4.2 Faceted filters & "filter by data source"

- **Datadog** is the reference. The mechanics worth copying exactly:
  - **Qualitative facets = a counted top-list with checkboxes.** Each facet shows
    "a top list of unique values, and **a count of logs matching each**"; clicking a
    value toggles the search, checkboxes add/remove values. The count-beside-value is
    the signature density move — you see distribution *before* you click.
  - **Quantitative facets = a min/max slider** with numeric inputs.
  - **A facet search box** scopes the (long) facet list, matching display + field
    name.
  - **Per-facet cog → hide / edit / group**; analysts hide rarely-used facets "to
    keep only the most relevant," and facets are **grouped into meaningful themes**
    for navigability — a *user-curated* density control.
  - **Saved Views** store the query **plus the displayed-facet subset**, so a teammate
    can switch troubleshooting contexts in one click.
  ([Datadog Facets][dd-facets], [Datadog Saved Views][dd-savedviews])
- **"Filter by data source"** is a near-universal facet (Datadog `source`,
  Sentinel product/connector, SecOps log source). For a vendor-agnostic tool like
  TLSOC this is especially important — analysts must be able to slice cases/logs by
  *which connector/source* produced them.
- **Sentinel/Defender** present the incident queue as a grid with faceted filters
  (severity, status, owner, product/source) and severity color-coding, on the
  Fluent 2 system. ([Fluent 2 Design tokens][fluent-tokens])

### 4.3 Saved views & density toggles

- **Saved Views** (Datadog) and **density toggles** are the two features that
  separate a "table" from a "workbench." Density is a *named control* across products:
  EUI Data grid's built-in Compact/Normal/Expanded; **Datadog's "Options" button →
  Content Height + Content Display per row**; **SecOps' Column Manager** for choosing
  table columns. Saved views persist a named filter+sort+column set. ([EUI Data grid
  in-memory][eui-grid-mem], [Datadog visualize/density][dd-visualize], [Google UDM
  Search][gcp-udm], [Datadog Saved Views][dd-savedviews])
- **Inline triage + bulk actions in the list.** Datadog's Signals Explorer has a
  per-row triage-status dropdown (Open / Under Review / Archived) and row checkboxes
  for **bulk actions** — analysts act without leaving the table. A model for adding
  bulk close/assign to the TLSOC Cases table. ([Datadog Signals][dd-signals])

**Where TLSOC stands.** `CasesPage` already has an excellent client-side filter
model: free-text search, multi-select facets (verdict/status/rule/persona/playbook/
assignee/tags), a risk-band dual-range, a time window, a "More filters" popover, a
**self-healing** filter state, and a "showing N of M" count — plus sortable columns
and a row→flyout pattern. Gaps vs. the leaders: **no "filter by source/connector"
facet**, **no saved views**, **no density toggle**, and filtering is duplicated
between `CasesPage` and `ScansPage`. See §6.

---

## 5. Standardization — tokens, scales, component consistency

### 5.1 The principle

Every mature system is built on **design tokens**: named values for color,
typography, spacing, elevation, borders, and motion, so no component hardcodes a
pixel or hex.

- **Fluent 2** uses a **two-layer token model**: *global* tokens (raw values — hex,
  type, radius, stroke) and *alias* tokens (semantic meaning on top), published via
  `@fluentui/react-theme` and a `FluentProvider` context. ([Fluent 2 Design
  tokens][fluent-tokens], [Fluent theming][fluent-theming])
- **Splunk Design System** publishes *Components, Design Tokens (colors,
  typography, elevation, spacing, borders, measures), Blueprints, Icons,* and a
  dashboard framework — a full system so "every app looks like Splunk." ([Splunk
  Design System][splunk-ds], [Splunk — A new way to look like Splunk][splunk-look])
- **EUI** exposes the same via `euiTheme` (the `size`, `font`, `colors`, `border`
  tokens) with documented scales. ([EUI sizing tokens][eui-size-src])

### 5.2 The concrete scales (for our token layer)

- **EUI spacing** (base `euiTheme.base = 16`): `xxs 2 · xs 4 · s 8 · m 12 ·
  base 16 · l 24 · xl 32 · xxl 40 · xxxl 48 · xxxxl 64` (px). Tokens return CSS
  *strings*; `euiTheme.base` returns a *number* for math (or use `mathWithUnits`).
  ([EUI sizing tokens][eui-size-src])
- **EUI type ramp** (base 16px = 1rem, ~Major-Third 1.2 ratio, line-height ×1.5):
  `xxxs 0.5625→9px · xxs 0.6875→11px · xs 0.75→12px · s 0.875→14px · m 1→16px ·
  l 1.25→20px · xl 1.5→24px · xxl 1.875→30px`. Default family **Inter**; mono
  **Roboto Mono**. ([EUI font scale hook][eui-fontscale])
- **EUI font weights:** light 300 · regular 400 · **medium 450** · semiBold 500 ·
  bold 600. (EUI's "medium" is 450, an Inter-specific value — not 500.) ([EUI
  typography src][eui-type-src])
- **EUI semantic colors** (current *Borealis* theme, light): `primary #0B64DD ·
  success #008A5E · warning #966B03 · danger #C61E25 · accent(teal) #00B0AA`, each
  with dedicated text/background/border variants. Use the *named token* (and the
  text variant for text), never a re-picked hex. ([EUI Colors][eui-colors])
- **EUI icon sizes (px):** `s 12 · m 16 (default) · l 24 · xl 32 · xxl 40 ·
  original (no constraint)`; author custom SVGs at 16 or 32. ([EUI Icons][eui-icons])
- **EUI `restrictWidth`:** `true` → 1200px, or any explicit number. ([EUI Page
  template][eui-page])
- **EuiDataGrid density** = `gridStyle.fontSize` (s/m/l) × `gridStyle.cellPadding`
  (s/m/l); the built-in toolbar density toggle
  (`toolbarVisibility.showDisplaySelector.allowDensity`) lets the *user* override
  to Compact/Normal/Expanded, and `allowRowHeight` + `rowHeightsOptions` (single /
  N-line / `'auto'`) control row height. `gridStyle.onChange`/
  `rowHeightsOptions.onChange` let the app persist the user's choice. ([EUI Data
  grid in-memory][eui-grid-mem])
- **Fluent 2 spacing base:** 4px grid (with 2/6/10 for icon alignment). ([Fluent 2
  Layout][fluent-layout])

### 5.3 How they make a *multi-page console* feel uniform

- A **single page-header pattern** (eyebrow + title + right-aligned actions) on
  every page. (TLSOC has `PageHeader`/`SectionHeader` — use them everywhere.)
- A **single set of primitives** for stat tiles, badges, empty states, cards,
  skeletons. (TLSOC's `ui.tsx` is exactly this; the rule is *compose, don't
  re-roll*.)
- **Semantic colors defined once** and applied by meaning, never re-picked per page.
  (TLSOC's `COLORS` + `verdictColor/riskHex/statusHex` do this — keep it the single
  source of truth.)
- **A shared layout container** so every page has the same max width, padding, and
  full-height behavior (TLSOC's `Shell` `EuiPageSection restrictWidth={1280}`).

### 5.4 OpenSearch / OUI note

OpenSearch Dashboards ships **OUI (OpenSearch UI)** — an **Apache-2.0 fork of EUI**
made because newer EUI was relicensed away from Apache 2.0. OUI stayed **Sass-based**
(EUI later moved to Emotion) but **inherited EUI's scale and component APIs
wholesale**: `$ouiSize = 16px` with `$ouiSizeXXS 2 · XS 4 · S 8 · M 12 · (base) 16 ·
L 24 · XL 32 · XXL 40` — *byte-identical* to EUI's pixel scale (the `oui-next` theme
even keeps `$euiSize*` aliases for back-compat). It ships `theme_light/dark` +
`theme_next_light/dark`. So our design *grammar* (spacing, type ratio, data-grid
density, component set) is effectively identical to EUI: **a UI that adheres to EUI
tokens reads as native in OpenSearch Dashboards too**, and an OpenSearch-targeted
deployment needs no design change. ([OpenSearch OUI][oui-repo], [OUI FAQ][oui-faq])

---

## 6. Recommendations for the TLSOC webui

Constraints honored: **EUI 95 + a tiny design-token layer, no new npm deps**, plain
CSS / inline-style only (must build for the static nginx bundle), and the existing
shared primitives in `webui/src/components/common/ui.tsx`,
`webui/src/lib/theme.ts`, `webui/src/lib/format.ts`, `webui/src/index.css`.

Each item is tagged **[S] small / [M] medium / [L] larger** by effort.

### 6.1 Add a real spacing-token module (kill pixel literals) — [S]

Today spacing is a mix of `EuiSpacer size=` (good) and many inline `style={{
marginTop: 24, padding: 12, gap: 16 }}` literals (e.g. `Shell.tsx`, `ui.tsx`,
`ChatPanel`). Introduce a `SPACE` map in `lib/theme.ts` mirroring EUI's scale so
every literal resolves to a token:

```ts
// lib/theme.ts — mirrors EUI's euiTheme.size scale (base 16)
export const SPACE = {
  xxs: 2, xs: 4, s: 8, m: 12, base: 16, l: 24, xl: 32, xxl: 40, xxxl: 48,
} as const;
```

Then replace inline literals: `marginTop: 24` → `marginTop: SPACE.l`, `gap: 16` →
`gap: SPACE.base`, `padding: 12` → `padding: SPACE.m`. Prefer `<EuiSpacer
size="…">` for vertical gaps where possible (it already maps to these tokens).
**Payoff:** consistent rhythm, trivially auditable, no behavior change. Pair with a
lint rule of habit: "no raw spacing pixels in `style=` — use `SPACE` or `EuiSpacer`."

### 6.2 Standardize content width + full-height per page — [S]

`Shell.tsx` already sets `restrictWidth={1280}` — good. Two refinements:

- **Make the width a token** (`export const CONTENT_MAX = 1280` in `theme.ts`) and
  reference it, so dense table pages can opt into a wider cap (e.g. 1600) while
  reading pages (Standup, a single case) stay narrower — matching EUI's
  per-template `restrictWidth`.
- **Let designated pages go full-height.** The shell uses `minHeight: calc(100vh -
  51px)`. For Chat (and any future split-pane investigate view), pass a flag so the
  page section becomes a `display:flex; height:` column whose child (the chat lane)
  fills it (see 6.4).

### 6.3 Add a table density toggle + sort-everywhere + "filter by source" — [M]

On `CasesPage` (and mirror in `ScansPage`):

- **Density toggle.** Add a 3-way control using the already-registered icons
  `tableDensityCompact / tableDensityNormal / tableDensityExpanded`
  (`EuiButtonGroup`, compressed). Map to `EuiBasicTable`'s `compressed` prop and a
  CSS row-padding class. Persist the choice in `localStorage`. This is the single
  most "pro SOC" affordance we're missing.
- **Sort every meaningful column.** Cases already sorts title/verdict/risk/status/
  updated/assignee. Add `tags`(count) and `entity` where it makes sense; ensure the
  active sort caret is visible (EUI does this when `sortable: true`).
- **"Filter by source / connector" facet.** Add a `sources`/`connector` multi-select
  to the filter bar (and the `buildFacets`/`applyFilters`/`healFilters` model),
  derived from each case's originating source. This is the highest-value missing
  facet for a *vendor-agnostic* tool — analysts will want "show me only Wazuh
  cases." Backend `Case` should already carry source provenance; surface it.
- **Inline triage + bulk actions (later).** Datadog's Signals Explorer shows a
  per-row status dropdown + checkbox **bulk actions** (close/assign/archive) so
  analysts act without opening each row. `EuiBasicTable` supports a `selection` prop
  + an actions bar — a natural follow-on once the deterministic close/escalate path
  (#3) is respected (bulk action must still route through the same backend
  endpoints, never client-side verdict mutation). ([Datadog Signals][dd-signals])

### 6.4 Make the Chat page full-height (stop wasting vertical space) — [M]

The `ChatPanel` is already a flex column (`height:100%`), but on the Chat *page*
it sits inside the normal `restrictWidth` section, so the transcript lane only
grows with content instead of filling the viewport — wasted space and a composer
that floats mid-page. Fix:

- Render the Chat page in a **full-height flex container** (`height: calc(100vh -
  HEADER)`), so `ChatPanel`'s `flex:1` lane fills the viewport and the composer
  sticks to the bottom (this is what Copilot/Gemini chat do).
- Cap the *transcript* readable width (~760px, already there for bubbles) but let
  the *lane* span full width so result tables/queries have room.

### 6.5 Enrich the AI assistant output to match the leaders — [M]

`ChatPanel` already renders a result table, a "Query used" chip with copy, and
cost/model. Close the gap to Copilot's process log / SecOps reasoning:

- **"What the agent did" disclosure.** When the backend returns tool/step info
  (tools used, sources/RAG snippets consulted, time), render a collapsible
  `EuiAccordion` "Show how I got this" under the answer — mirroring Copilot's
  process log, Charlotte's per-answer **"show response details"** source toggle, and
  SecOps' reasoning. (The case `/rationale` endpoint already assembles exactly this
  shape; reuse it for chat where available.) Charlotte's pattern is the bar:
  *provenance is one click under every answer, not buried in a separate view.*
- **Consider a structured "investigation panel" for case-scoped AI.** Datadog Bits
  renders an investigation as **Conclusion → Key evidence → Investigative steps
  (each with the query it ran + a link/copy)** rather than prose. For a case's
  agent trace / "Why" tab, a sectioned panel like this (we already have the
  ingredients: verdict, evidence, tools/queries, rationale) reads far more
  professionally than a paragraph.
- **Citations / sources block.** When the answer cites knowledge/RAG docs, render a
  compact "Sources" list (doc title + chip), like Elastic's citations toggle.
- **Sectioned case summaries.** For case-scoped chat and the case "Why" tab, prefer
  a **sectioned** summary ("What happened / Activity / Recommended next steps") à la
  the SecOps Gemini Case Summary widget, instead of one prose block.
- **Promptbook-style starters per context.** We have `starters`; extend to a small
  named set ("Investigate this IP", "Summarize today", "Why this verdict?") and show
  them in the empty state *and* as a quick-action row above the composer.
- All new text stays **plain-text / `EuiCodeBlock`** for any model/log-derived value
  (uphold non-negotiable #9).

### 6.6 Icon & visual-consistency hygiene — [S]

- **Audit `EuiIcon size=`.** Standardize on `s`(12) for inline metadata, `m`(16) for
  nav/buttons, `l`(24) for `IconChip`/headers — no arbitrary sizes. (Mostly already
  true; sweep for one-offs.)
- **Keep `icons.ts` the single registry.** Any new `iconType` string used anywhere
  must be added to `appendIconComponentCache` or it renders blank in the nginx
  build. Consider a tiny dev-time check that greps `iconType="…"` / `icon: '…'`
  usages against the registry.
- **Subdued-by-default, accent-on-active** for all nav/secondary glyphs (already the
  rule in `Shell`); don't color icons decoratively.

### 6.7 Saved views (filter presets) — [L, optional but high-value]

Persist named filter+sort sets (start in `localStorage`; later a backend pref).
UI: an `EuiComboBox`/`EuiPopover` "Views" control next to the filter bar with
*Save current view* / built-ins ("My open cases", "Needs human", "True positives
last 7d", "By source: Wazuh"). This is the Datadog Saved-Views pattern and is what
turns the Cases table into a workbench. ([Datadog Saved Views][dd-savedviews])

### 6.8 De-duplicate the filter bar — [M]

`CasesPage` and `ScansPage` carry near-identical filter models/bars (intentionally
inlined today). Once stable, extract a shared `useFacetFilters` hook + `<FilterBar>`
into `components/common/` so adding a facet (e.g. source) happens once. Keeps the
multi-page console uniform (§5.3). (Do this only after 6.3 lands, to avoid churn.)

### 6.9 Typography scale alignment — [S]

`TYPE` in `theme.ts` is a good start (`hero/h1/h2/kpi/label`). Align its values to
EUI's font ramp where they overlap and *always* go through `TYPE` (no inline
`fontSize:` literals) so headings are uniform across pages. Consider mapping `label`
(11px uppercase eyebrow) and `kpi` (24px) to documented EUI scale steps for
consistency with EUI-native text. ([EUI font scale hook][eui-fontscale])

### 6.10 Quick wins checklist

- [ ] `SPACE` token map; replace inline spacing literals (§6.1).
- [ ] `CONTENT_MAX` token; per-page width opt-in (§6.2).
- [ ] Table density toggle (reuse `tableDensity*` icons) + persist (§6.3).
- [ ] "Filter by source/connector" facet on Cases + Scans (§6.3).
- [ ] Full-height Chat page (§6.4).
- [ ] "How I got this" accordion + sources block in `ChatPanel` (§6.5).
- [ ] Sectioned case summary in the "Why" tab (§6.5).
- [ ] Icon-size sweep + registry check (§6.6).
- [ ] (Optional) Saved views (§6.7); shared FilterBar (§6.8).

None of these add a dependency, change the backend contract, or touch the 12
non-negotiables; they're presentation + a token layer on top of EUI 95.

---

## 7. Appendix — current TLSOC design assets (for reference)

- **Shell / layout:** `webui/src/components/Shell/Shell.tsx` — fixed `EuiHeader`,
  brand-gradient accent bar, grouped `EuiSideNav` (Triage/Automation/Platform),
  sticky `EuiPageSidebar`, `EuiPageSection restrictWidth={1280}`.
- **Token layer:** `webui/src/lib/theme.ts` — `COLORS` (semantic, runtime-themeable
  via `setAccent`), `tint()`, `TYPE`, `verdictColor/verdictHex/statusHex/riskHex/
  riskBand`, `CHART_COLORS`, `CATEGORY_META`.
- **Primitives:** `webui/src/components/common/ui.tsx` — `PageHeader`,
  `SectionHeader`, `IconChip`, `StatTile`, `TrendStat`, `Card`, `RiskBadge`,
  `VerdictBadge`, `StatusBadge`, `ConfidenceBadge`, `EmptyState`, `Skeleton`,
  `Loading`, `ErrorCallout`.
- **CSS utilities:** `webui/src/index.css` — `.socGrid`, `.socBoard/.socLane`,
  `.socCard`, `.socStat`, `.socSideNav` selected state, chat bubbles, skeleton
  shimmer, reduced-motion handling, refined scrollbars.
- **Chat:** `webui/src/components/Chat/ChatPanel.tsx` — reusable engine (page +
  flyout), XSS-safe markdown, `ResultTable`, `AnswerMeta` (query+copy, cost, model),
  memory action/suggestion, starters, typing indicator, model selector.
- **Tables/filtering:** `webui/src/components/Cases/CasesPage.tsx` — client-side
  faceted filter model (search + 7 facets + risk range + time), self-healing
  filters, sortable columns, row→flyout, "showing N of M".
- **Icon registry:** `webui/src/lib/icons.ts` — `appendIconComponentCache` of ~140
  glyphs incl. `tableDensityCompact/Normal/Expanded`, sort carets, pagination.

---

## 8. Sources

### Elastic / EUI / OpenSearch
- EUI — Page template (`restrictWidth`, full-height `EuiPage`, namespaced sections): https://eui.elastic.co/docs/components/templates/page-template/ [eui-page]
- EUI — Page components: https://eui.elastic.co/docs/layout/page-components/ [eui-pagecomp]
- EUI — Sizing tokens (base 16; xxs 2 … xxxxl 64) src: https://github.com/elastic/eui (packages/eui-theme-common, `variables/size.ts`) [eui-size-src]
- EUI — Typography tokens (font weights 300/400/450/500/600) src: https://github.com/elastic/eui (packages/eui-theme-common, `variables/typography.ts`) [eui-type-src]
- EUI — Font scale hook (font-size + line-height per scale): https://eui.elastic.co/docs/getting-started/theming/tokens/typography/font-scale-hook/ [eui-fontscale]
- EUI — Icons (`s/m/l/xl/xxl/original`, m=16 default, `appendIconComponentCache`): https://eui.elastic.co/docs/components/display/icons/ [eui-icons]
- EUI — Colors tokens (Borealis semantic palette + text/bg/border variants): https://eui.elastic.co/docs/getting-started/theming/tokens/colors/ [eui-colors]
- OpenSearch — OUI repo (Apache-2.0 EUI fork; `$ouiSize` scale parity): https://github.com/opensearch-project/oui [oui-repo]
- OpenSearch — OUI FAQ (why forked; Sass-based; themes): https://github.com/opensearch-project/oui/blob/main/FAQ.md [oui-faq]
- EUI — Data grid in-memory (sorting/virtualization/density/row height): https://eui.elastic.co/docs/components/data-grid/advanced/in-memory/ [eui-grid-mem]
- EUI — Data grid container constraints (virtualization on constrained height/width): https://eui.elastic.co/docs/components/data-grid/container-constraints/ [eui-grid-constraints]
- EUI — In-memory tables (client sort/pagination): https://eui.elastic.co/docs/components/tables/in-memory/ [eui-inmemory]

### Microsoft (Fluent 2 / Sentinel / Security Copilot)
- Fluent 2 — Layout (4px base grid; 2/6/10 for icon alignment): https://fluent2.microsoft.design/layout [fluent-layout]
- Fluent 2 — Design tokens (global + alias two-layer): https://fluent2.microsoft.design/design-tokens [fluent-tokens]
- Fluent — Theming system / `@fluentui/react-theme` + `FluentProvider`: https://deepwiki.com/microsoft/fluentui/8.2-theming-system [fluent-theming]
- MS Learn — Prompting in Security Copilot (prompt bar, process log, sources used, debugger): https://learn.microsoft.com/en-us/copilot/security/prompting-security-copilot [ms-prompting]
- MS Learn — Promptbooks (named prompt sequences, library, required plugins): https://learn.microsoft.com/en-us/copilot/security/using-promptbooks [ms-promptbooks]
- MS Learn — Copilot in Microsoft Purview (embedded experience): https://learn.microsoft.com/en-us/purview/copilot-in-purview-overview [ms-purview]

### Elastic AI Assistant
- Elastic — AI Assistant for Security (flyout, citations, ES|QL generation): https://www.elastic.co/docs/solutions/security/ai/ai-assistant [elastic-aia]
- Elastic — AI Assistant Knowledge Base: https://www.elastic.co/docs/solutions/security/ai/ai-assistant-knowledge-base [elastic-kb]
- Elastic — Generate/customize ES|QL queries with the assistant: https://www.elastic.co/guide/en/security/current/esql-queries-assistant.html [elastic-esql]

### CrowdStrike
- CrowdStrike — Charlotte AI (agentic analyst, in-console plain-language UX): https://www.crowdstrike.com/en-us/platform/charlotte-ai/ [cs-charlotte]
- CrowdStrike — Transforms Falcon UX with Charlotte AI ("show response details" provenance toggle): https://www.crowdstrike.com/en-us/blog/crowdstrike-transforms-falcon-ux-charlotte-ai/ [cs-charlotteux]
- CrowdStrike — Charlotte AI multi-approach (multi-agent pipeline + final formatter): https://www.crowdstrike.com/en-us/blog/charlotte-ai-multi-approach/ [cs-multi]
- CrowdStrike — Project Kestrel (persona-aware unified console; NL dashboards): https://www.crowdstrike.com/en-us/platform/project-kestrel/ [cs-kestrel]
- CrowdStrike — falcon-styles (public light/dark `theme-dark` stylesheet): https://github.com/CrowdStrike/falcon-styles [cs-falconstyles]
- Gartner Peer Insights — CrowdStrike NG-SIEM reviews (dense-UI usability caution): https://www.gartner.com/reviews/market/security-information-event-management/vendor/crowdstrike/product/falcon-next-gen-siem [cs-gartner]

### Google SecOps / Chronicle
- Google — Security Operations product page: https://cloud.google.com/security/products/security-operations [gcp-secops]
- Google — Gemini in Google SecOps (NL→query, iterate, mapped syntax): https://docs.cloud.google.com/chronicle/docs/secops/gemini-secops [gcp-gemini]
- Google — Triage & Investigation Agent (true/false-positive verdict + explanation): https://docs.cloud.google.com/chronicle/docs/secops/triage-investigation-agent [gcp-tin]
- Google — Gemini Case Summary widget (3 sections: What happened / Case activity / Next & pending): https://docs.cloud.google.com/chronicle/docs/soar/investigate/working-with-cases/using-the-gemini-case-summary-widget [gcp-casesummary]
- Google — UDM Search (Column Manager; up to 1M results in-browser): https://docs.cloud.google.com/chronicle/docs/investigation/udm-search [gcp-udm]
- Google — explore entities & alerts (three-pane Security-Graph case view): https://docs.cloud.google.com/chronicle/docs/soar/investigate/working-with-cases/explore-entities-and-alerts-investigation [gcp-graph]
- Google SecOps UX updates H1 2025 (dark default; light theme added May 2025) — practitioner blog: https://medium.com/@thatsiemguy/secops-ux-updates-h1-2025-29678237b9b2 [gcp-uxblog]

### Splunk
- Splunk — Splunk UI Design System: https://splunkui.splunk.com/DesignSystem [splunk-ds]
- Splunk — `@splunk/react-ui` package overview: https://splunkui.splunk.com/Packages/react-ui/Overview [splunk-reactui]
- Splunk — "A New Way to Look Like Splunk" (UI Toolkit announcement): https://www.splunk.com/en_us/blog/platform/a-new-way-to-look-like-splunk.html [splunk-look]

### Datadog
- Datadog — Log Explorer (facet panel, virtualized list): https://docs.datadoghq.com/logs/explorer/ [dd-explorer]
- Datadog — Log Facets (left facet panel, counts, hide/declutter): https://docs.datadoghq.com/logs/explorer/facets/ [dd-facets]
- Datadog — Saved Views (named query + facet subset): https://docs.datadoghq.com/logs/explorer/saved_views/ [dd-savedviews]
- Datadog — Log Side Panel (slide-in detail preserving list context): https://docs.datadoghq.com/logs/explorer/side_panel/ [dd-sidepanel]
- Datadog — Log visualizations (Options → Content Height/Display density toggle): https://docs.datadoghq.com/logs/explorer/visualize/ [dd-visualize]
- Datadog — Cloud SIEM Signals (inline triage dropdown + bulk row actions): https://docs.datadoghq.com/security/cloud_siem/triage_and_investigate/investigate_security_signals/ [dd-signals]
- Datadog — Bits AI Security Analyst (structured side-panel investigation: Conclusion / Key evidence / Investigative steps w/ embedded queries; create-case): https://docs.datadoghq.com/bits_ai/bits_security_analyst/ [dd-bits]
