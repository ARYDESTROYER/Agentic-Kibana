# Round 2 — Wave 1 Critical Bug Fixes

All fixes are additive/presentational and preserve the 12 non-negotiables. None
touch `case_manager.decide()`/`apply()`, none change prompt fencing (#9), none
add runtime deps. Each bug below has: root cause, exact fix, files, and a
regression test. Test harness: dev-only Vitest + @testing-library/react
(`webui/vitest.config.ts`) for webui; `pytest -q` for backend.

---

## BUG-1 — Active Risk Index gauge renders a faint sliver + overflowing "/100" + stray blob

**Files:** `webui/src/soc/components/RiskGauge.tsx`,
`webui/src/soc/components/__tests__/RiskGauge.test.tsx` (new),
consumer: `webui/src/soc/pages/Overview.tsx:559`.

**Root cause (three stacked defects; arc coordinate math is NOT the problem):**
1. **Dead color via `currentColor`-in-`<defs>`.** The progress path's stroke is a
   gradient (`stroke="url(#gauge-grad-…)"`, line 147) whose stops are
   `stopColor="currentColor"` (lines 122-123). Those `<stop>` elements live inside
   `<defs>`, so per SVG painting rules `currentColor` resolves against the color
   inherited down the `<defs>` tree (the `<svg>`'s `color` = document foreground),
   NOT against the referencing path's `className={TEXT_CLASS[band]}` (line 148).
   The `text-critical` class on the path is therefore inert for the stroke. The arc
   paints in foreground (near-white in dark theme) at 0.55→1.0 opacity = the faint
   white sliver. Only the value text (line 162, `text-*` applied directly to its
   own fill) shows color.
2. **Centered-value overflow.** The value overlay is `absolute inset-x-0` with only
   a `top` anchor and no height bound (lines 157-159: `style={{ top: cy - r*0.5 }}`).
   At size=208 that is top≈58 in a box of height h≈116, number at `size*0.24`≈50px
   plus a stacked `/100` runs past the box bottom, colliding with Overview's
   external "WEIGHTED RISK PRESSURE" label (`gap-1`, Overview.tsx:560-562).
3. **Stray start-cap blob.** Both track and progress use `strokeLinecap="round"`
   (lines 138,150). The progress arc's START cap at the 180° baseline is a
   protruding half-disc; the clip rect (height=cy) only clips below the baseline,
   not this in-bowl cap. Painted in foreground (defect #1) it reads as a foreign
   dark blob.

**Exact fix — rewrite as a dash-offset progress ring on a fixed half-circle:**
- Keep the props (`score, label, size, className`) and the clamp at line 81.
- Geometry once: `stroke=Math.max(8,Math.round(size*0.07))`,
  `pad=Math.max(2,Math.round(stroke/2))`, `cx=w/2`, `r=w/2 - stroke/2 - pad`,
  `cy=stroke/2 + pad + r`, `h=cy + Math.ceil(stroke/2)`. One fixed half-circle
  `d = M ${cx-r} ${cy} A ${r} ${r} 0 0 1 ${cx+r} ${cy}` for BOTH track and progress.
  `len = Math.PI * r`.
- Track path: `className="stroke-muted"`, `fill="none"`, `strokeWidth={stroke}`,
  round caps OK (symmetric).
- Progress path: SAME `d`, `fill="none"`, `strokeWidth={stroke}`,
  `strokeLinecap="round"`, `strokeDasharray={len}`,
  `strokeDashoffset={(1-frac)*len}` with `frac=clamped/100`. **Color fix:** drop the
  gradient + `currentColor` entirely; set `stroke="currentColor"` on the element AND
  `className={cn('transition-[stroke-dashoffset] duration-500', TEXT_CLASS[band])}`
  so `text-critical → color:hsl(var(--critical)) → currentColor` resolves on the
  SAME element. Keep `TEXT_CLASS` as the LAST `cn()` arg so tailwind-merge does not
  strip it. Optional depth wash = `stroke-opacity`, never a defs gradient.
- Value overlay: replace lines 157-173 with a flex container that fills the bowl and
  is height-bounded: wrapper `pointer-events-none absolute inset-0 flex flex-col
  items-center justify-end` + `style={{ height: cy, paddingBottom: pad }}` (or
  `justify-center` with `height: cy`). Cap font `fontSize = Math.min(size*0.22,
  cy*0.5)`. Render `/100` INLINE as a smaller suffix on the SAME line (number span +
  `text-muted-foreground` span `ml-1 self-end`) — removes the second line that
  overflowed.
- Remove the now-unused `arcPath`/`point` helpers (lines 21-50), the
  `<linearGradient>` (119-124), `gradId`, and the second arc. Keep `React.useId`
  only if still needed for `clipId`/`titleId`. Keep `TEXT_CLASS` literals + the
  `stroke-muted` literal in source so Tailwind JIT still emits them.

**Regression test (RiskGauge.test.tsx):**
- (A) Geometry/NaN: for `size ∈ {100,208}`, `score ∈ {0,27,55,85,100}`, query both
  `<path>`; assert `d` has no `NaN` and matches `/^M [\d.-]+ [\d.-]+ A/`; assert
  progress `strokeDasharray` parses to finite `== PI*r`, `strokeDashoffset` finite
  in `[0,len]` `== (1-clamp(score)/100)*len` (score 0 → offset==len, 100 → 0).
- (B) Color: progress `<path>` carries the band class (85→`text-critical`,
  55→`text-medium`, 27→`text-low`) AND `stroke="currentColor"` (NOT a `url(#...)`).
- (C) No-overlap: at size=208 the value overlay container is height-bounded
  (`inset-0`/`height<=cy` + `justify-*`); value + `/100` share one line (exactly one
  text node with the rounded score + suffix on the same line).
- (D) Cap: assert there is no second `<linearGradient>` in `<defs>`.

**Risks:** only consumer is `Overview.tsx:559` (size=208); props unchanged. Keep
`TEXT_CLASS` last in `cn()`. Verify caps in both themes.

---

## BUG-2 — MFA QR is unscannable + Copy buttons silently no-op on HTTP

**Files:** `webui/src/soc/components/QRCode.tsx`,
`webui/src/soc/components/MfaSetupCard.tsx`, `webui/src/soc/pages/Security.tsx`,
`webui/src/lib/clipboard.ts` (new).

### 2a — QR unscannable (wrong second format-info placement)
**Root cause:** In `placeFormatInfo()` (QRCode.tsx:226-241) the 15-bit format string
is BCH-correct and the FIRST (top-left) copy is correct, but the SECOND copy is
inverted vs ISO/IEC 18004. The code writes bits 0..7 down the vertical bottom-left
(`m[size-1-i][8]`, i<8) and bits 8..14 across only 7 horizontal columns
(`m[8][size-15+i]`, i>=8). Spec is the reverse: bits 0..7 along the HORIZONTAL
top-right strip (8 cols `size-1..size-8`), bits 8..14 up the VERTICAL bottom-left
(7 cells). Consequences: (a) column `size-8` of the top-right strip is reserved by
`reserveFormatAreas` (line 222) so the data pass skips it, but is never assigned a
format bit → a permanent `null` module every version; (b) a conformant reader
reconstructs `0x4f51` vs expected `0x45f9` (mask 4) → copies disagree → corrupt
symbol. The otpauth bitstream is otherwise correct, which is why manual entry works.

**Exact fix:** replace the inner second-copy block so the horizontal top-right strip
carries bits 0..7 and the vertical bottom-left carries bits 8..14:
```js
for (let i = 0; i < 15; i++) {
  const bit = ((fmt >> i) & 1);
  // first copy around TL finder (UNCHANGED)
  if (i < 6) m[8][i] = bit;
  else if (i === 6) m[8][7] = bit;
  else if (i === 7) m[8][8] = bit;
  else if (i === 8) m[7][8] = bit;
  else m[14 - i][8] = bit;
  // second copy: bits 0..7 horizontal top-right (cols size-1..size-8),
  //              bits 8..14 vertical bottom-left
  if (i < 8) m[8][size - 1 - i] = bit;
  else m[size - 15 + i][8] = bit;
}
```
Keep the dark module `m[size-8][8] = 1`. After the fix the matrix has ZERO null
cells for versions 1-10 and both copies decode to `FORMAT_INFO_M[chosenMask]`.
Optional dev guard: after building, assert no cell is null.

### 2b — Copy button silent no-op on non-secure context (HTTP)
**Root cause:** `navigator.clipboard?.writeText(...)` with optional chaining and no
fallback (MfaSetupCard.tsx:56, Security.tsx:87). The nginx `tlsoc-webui` is reached
over `http://host:8080`; the Clipboard API requires a secure context (localhost
excepted), so `navigator.clipboard` is undefined → optional chain short-circuits to
`undefined`, no write, no error, no feedback.

**Exact fix:** add `webui/src/lib/clipboard.ts` exporting
`async function copyText(text: string): Promise<boolean>` that tries
`navigator.clipboard?.writeText` then falls back to a hidden textarea +
`document.execCommand('copy')` (readOnly, append, select, execCommand, remove;
try/catch → return false). Use it in `CopyButton` (MfaSetupCard) and `CopyField`
(Security): `await copyText(text)`; on success set Copied state, on failure surface
a toast (Security already imports `sonner`). Optionally route `CodeBlock.tsx:99` and
`Standup.tsx:177` through the same helper.

**Regression test:**
- QR: call `encodeQR` with `otpauth://totp/AgenticSOC:admin?secret=JBSWY3DPEHPK3PXP&issuer=AgenticSOC&algorithm=SHA1&digits=6&period=30`. Assert
  (1) non-null matrix; (2) version 7 → 45×45 (`matrix.length===45`, every row 45);
  (3) NO null/undefined module anywhere; (4) both 15-bit format copies decode equal
  AND equal `FORMAT_INFO_M[chosenMask]`; (5) SVG viewBox total `=== count + 2*margin`
  with `margin>=4`.
- Clipboard: mock `navigator` without `clipboard` + stub `document.execCommand`;
  click copy; assert the execCommand fallback fired and Copied/feedback state set.

**Risks:** only the second-copy branch changes — do NOT touch the top-left branch or
the dark module. Re-verify mask selection penalty + a real phone authenticator. The
execCommand fallback is the pragmatic HTTP fix; HTTPS is the long-term fix.

---

## BUG-3 — Duplicate close (X) control in the case-detail Sheet header

**Files:** `webui/src/soc/pages/CaseDetail.tsx` (shared primitive:
`webui/src/ui/sheet.tsx:100-110`).

**Root cause:** Two panel-close X controls stack in the top-right. (1) `SheetContent`
ALWAYS renders a built-in `SheetPrimitive.Close` X at `right-4 top-4`
(sheet.tsx:100-110). (2) CaseDetail hand-rolls a second "Close the sheet" X in its
header icon row right after the Send/Notify button (CaseDetail.tsx:1297-1310). Both
dismiss the panel (`onClose` directly vs Radix `onOpenChange(false)` which CaseDetail
also wires to `onClose`, 953-956). The "send" icon is the Notify button (line 1290),
NOT a lifecycle control; the labeled "Close case" lifecycle action is already a
separate footer button (1422-1453). The bug is purely the redundant header X.

**Exact fix:** delete the entire "Close the sheet" block in CaseDetail.tsx — the
comment at 1297 plus the `<Tooltip>…</Tooltip>` wrapping the `aria-label="Close"`
Button (1298-1310). Keep the `SheetContent` built-in X as the single dismiss. Leave
the Send/Notify button (1276-1295) and the footer "Close case" action (1422-1453)
untouched. After removal, verify the `X` import (line 64) is still used (it is — the
footer "Dismiss" button) so `tsc --noEmit` does not fail. Optional polish: if the
built-in X (`right-4 top-4`) overlaps the Notify/Export icons given the header's
`px-6 py-4`, add right padding to the header icon-row container.

**Regression test:** render CaseDetail (mock `api.getCase` → minimal open case, stub
lazy loaders). Assert `screen.getAllByRole('button', { name: /close/i })` has
length 1 (the built-in SheetPrimitive.Close sr-only "Close"). Equivalently assert
the header icon row no longer contains an `aria-label="Close"` button. Fails today
(two), passes after removal.

**Risks:** confirm the built-in X is visible/clickable (not covered by header
z-index). Do NOT remove the footer "Dismiss" button (1424-1426).

---

## BUG-4 — Chat page does not fill the viewport (broken full-height flex chain)

**Files:** `webui/src/soc/AppShell.tsx`, `webui/src/soc/components/ChatPanel.tsx`
(optional framing only), `webui/src/soc/pages/Chat.tsx` (verify, no change).

**Root cause:** The percentage-height chain is severed at the AppShell content slot.
`html,body,#root{height:100%}` (theme.css:104-108) is the only definite-height
ancestor. The shell root is `min-h-screen` (AppShell.tsx:255) — a `min-height` gives
children no definite height to resolve `h-full` against. `<main className="flex-1">`
(399) is `display:block`. The content wrapper (400) `mx-auto w-full max-w-[1400px]
px-4 py-6 …` has NO height/flex class → auto height. So Chat's `h-full min-h-0
flex-col` (Chat.tsx:39) resolves `height:100%` against an auto-height parent and
collapses to content height; ChatPanel's `flex-1` transcript has no surplus to
absorb, the empty-state floats high, the `shrink-0` composer (1034) trails the short
content mid-screen, and `<main>` (flex-1, taller) shows dead space below.

**Exact fix (all must land together):**
- AppShell.tsx:255 — `flex min-h-screen …` → `flex h-screen min-h-screen
  overflow-hidden bg-canvas text-foreground` (definite height + inner-scroll).
- AppShell.tsx:292 — main column add `min-h-0`: `flex min-w-0 flex-1 flex-col min-h-0`.
- AppShell.tsx:399 — `<main>` `flex-1` → `flex min-h-0 flex-1 flex-col overflow-y-auto`.
- AppShell.tsx:400 — content wrapper add `flex h-full flex-col`:
  `mx-auto flex h-full w-full max-w-[1400px] flex-col px-4 py-6 animate-fade-in sm:px-6`.
- ChatPanel: structure already correct once the chain is fixed (root 962, transcript
  990-996, composer 1034). Optional framing: wrap transcript content + composer in
  `mx-auto w-full max-w-3xl` (guard with the existing `compact` prop so the
  case-flyout embed is not double-constrained).

**Regression test (`webui/src/soc/__tests__/chat-layout.test.tsx`):** render
`<AppShell page="chat"><Chat/></AppShell>` and assert the load-bearing class chain
(jsdom has no layout engine, so assert classNames): (1) shell root has `h-screen`;
(2) `<main>` has `flex-1` + `overflow-y-auto` + `min-h-0`; (3) the `max-w-[1400px]`
wrapper has `h-full` + `flex` + `flex-col`; (4) Chat root retains `h-full min-h-0
flex-col`; (5) ChatPanel transcript has `flex-1` + `overflow-y-auto`, composer has
`shrink-0`. Optional Playwright: composer bottom within a few px of viewport bottom.

**Risks:** the whole app becomes fixed-viewport inner-scroll; verify long pages
(Cases/Metrics) still scroll inside `<main>` (they will: `overflow-y-auto`+`min-h-0`).
`overflow-hidden` on the shell is safe because Radix/shadcn overlays portal to body.
All three classes must land together or the fix is partial. Guard the optional
max-width with `compact`.

---

## BUG-5 — "Store degraded" health chip under-explains and mislabels the in-memory case

**Files:** `webui/src/soc/AppShell.tsx`, `webui/src/lib/types.ts` (optional),
`backend/app/api/routes.py:60-68` (optional, additive).

**Root cause:** The amber "Store degraded" chip is the catch-all `else` of
`healthView()` (AppShell.tsx:75-98), firing whenever it is not an outright
backend-unreachable error AND `health?.es_connected` is falsy. `es_connected` =
`await state.es.ping()`, `store_type` = `type(state.es).__name__` (routes.py:62-68).
Defects: (1) the only explanation is a tooltip with the raw Python class name
(`Store: <ClassName>`, lines 92-97/361) — never says what degraded means, the
persistence consequence, or how to fix it; (2) amber `warning` tone applied
unconditionally with no muted/demo handling. Correctness nuance: the in-memory ES
fallback `InMemoryESClient.ping()` returns `True` (fake.py:68-69) → reports
`es_connected:true` → shows GREEN "Healthy", NOT the amber chip. So the amber chip
actually only fires on a real ES/SQL ping failure (genuine connectivity) or a missing
`es_connected`. The label both under-explains and partly mis-describes; the
non-persistent in-memory state is silently shown as "Healthy".

**Exact fix (pure presentation):**
- Enrich the `HealthView` model: add `title` (short), `help` (multi-line: meaning +
  persistence consequence + how to fix), `muted?: boolean`.
- Add `const isInMemoryStore = (t?: string) => t === 'InMemoryESClient';`. When
  `es_connected` is true BUT store_type is `InMemoryESClient`, return a NEW muted
  tone "In-memory store" with help: "Own-state runs in memory (no Elasticsearch/SQL
  backend connected). Cases, cursors and audit will NOT persist across a backend
  restart. To persist, set STATE_BACKEND=elasticsearch or postgres (see DEPLOY.md)."
- Keep amber `warning` ONLY for genuine degraded (`es_connected` falsy, real
  backend): relabel to "State store unreachable" with help including `store_type` +
  a "check connection/credentials; see docs/TROUBLESHOOTING.md".
- Keep `critical` for `err` (backend unreachable) with richer help.
- Add a muted tone to `TONE_PILL` (e.g. `muted: 'border-border text-muted-foreground'`),
  `bg-card` as today.
- Replace the bare TooltipContent (361) with a richer body: bold `title` + `help`
  paragraph rendered as PLAIN text (store_type is backend-derived — never markup,
  #9) + a "How to fix" line. Prefer a shadcn Popover (click) for the longer copy, or
  Tooltip with `max-width` + `whitespace-pre-line`.
- Optional additive backend: add `persistent: boolean` to `/api/health` and drive the
  muted branch off `health.persistent === false` instead of the class-name match.

**Regression test:** extract/export `healthView()` and unit-test (Vitest):
(1) `healthView(null,true)` → `critical`, backend-unreachable;
(2) `({es_connected:true, store_type:'RealESClient'},false)` → `success`/Healthy;
(3) `({es_connected:true, store_type:'InMemoryESClient'},false)` → muted tone, help
mentions "will not persist" (catches today's mislabel);
(4) `({es_connected:false, store_type:'RealESClient'},false)` → `warning`, help
includes store_type + a how-to-fix hint. Backend pytest: `GET /api/health` returns
`store_type=='InMemoryESClient'` under fake-ES wiring (pins the UI string match).

**Risks:** hardcoding `'InMemoryESClient'` couples UI to a backend symbol — mitigate
with the additive `persistent` field. store_type stays PLAIN text (#9). Muting the
in-memory case calms a genuinely mis-deployed prod stack, but a real ES/SQL ping
failure still surfaces amber. If switching Tooltip→Popover, keep keyboard a11y.
