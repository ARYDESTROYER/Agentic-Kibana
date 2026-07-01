# Round-4 Understand — 06 Webui (IA, page consolidation, 3 UI glitches, case view, login white-label, OOBE, analytics declutter, models/pricing, risk help)

> Domain: the standalone Vite+React+TS+Tailwind+shadcn/Radix SPA under `webui/src`.
> All paths absolute from repo root `/Users/ary/Documents/GitHub/Agentic-Kibana/`.
> Line anchors verified against the live tree on 2026-07-01 unless marked *(from reader, unverified)*.

---

## 0. TL;DR — the exact Round-4 surfaces in this domain

| Item | File(s) + anchor | Fix shape |
|---|---|---|
| **W0 glitch #1** hover-card clips at right edge | `webui/src/ui/hover-card.tsx:11-25` | add `collisionPadding` (expose as prop, default `8`) to `<HoverCardPrimitive.Content>`; keep `align='center'`, `sideOffset=8`, all classes |
| **W0 glitch #2** SettingsCard description wraps one-word-per-line | `webui/src/soc/components/SettingsGrid.tsx:93,96` | add `flex-1` to inner `<div className="min-w-0">` (L93) + `break-words` to `<p>` (L96) |
| **W0 glitch #3** CaseDetail Collab/Feedback tabs swapped + duplicated | `webui/src/soc/pages/CaseDetail.tsx:1615-1620` (triggers), `:1664/1697` (content), `:559-561` (state union), `:3463-3618`/`:3715-4165` (components) | fix value↔label mismatch; strip `CollaborationTab` to ONLY the grading section |
| **W0 5-factor risk (?)** help | `webui/src/soc/components/CaseTriageHeader.tsx:139-145` (`RISK_COMPONENTS`), `:198-212` (`RiskCard`+existing `HelpTip`), `:203` (dup string) | add/extend a `HelpTip` on `RiskBreakdownBars` with verbatim weights 25/20/30/15/10 + "ranks, never closes" caveat |
| **W3 Models pricing columns** | `webui/src/soc/pages/Models.api.ts` (`ModelCatalogRow`), `webui/src/soc/components/ModelsCatalog.tsx:145-161` (pricing col) | add `batch_*_per_million` fields + cache-write/batch columns |
| **W1 Usage cache/batch fields** | `webui/src/lib/types.ts` (`UsageSummary.by_model`) | additive cache/batch token+cost fields (mirror backend `UsageDoc`) |
| **W5 login white-label** | `webui/src/soc/pages/Login.tsx:66-72`, `webui/src/soc/components/auth/loginParts.tsx:398-413` (`BrandHero` hardcoded), `webui/src/lib/types.ts` (`Branding`), `theme.tsx` `DEFAULT_BRANDING`, `BrandingEditor.tsx:997-1044` | add bounded plain-text `login_*` fields |
| **W5 OOBE account-setup** | `webui/src/soc/pages/Wizard.tsx` (STEPS L87), `webui/src/soc/pages/Login.tsx` (`Mode='setup'` L61, `submitSetup` L155) | add hardening step; reuse current session (not `init-admin`) |
| **W5 ~30-page consolidation** | `webui/src/soc/nav.ts`, `webui/src/soc/App.tsx` `renderPage()` (L69-153), `webui/src/soc/pages/Settings.tsx` `*Inner` embeds | redirect standalone admin PageIds into Settings; drop dead NavGroupIds; fix phantom Analytics `models` tab |
| **W5 reset DangerZone** | `webui/src/soc/pages/Settings.tsx` experimental group (section `demo`) | net-new card + **net-new backend endpoint** |
| **W5 analytics declutter** | Overview.tsx / Metrics.tsx / Standup.tsx / Analytics.tsx host + nav children | consolidate posture (3 pages) + analytics (4-way) |

**Biggest risk:** the router/nav layer is a two-source-of-truth system — `nav.ts` declares `PageId`/`PAGE_IDS` (the router's hash allowlist) and `App.tsx:renderPage()` is the *only* page dispatcher; a consolidation that deletes a `PageId` breaks `#/users`, `#/cost`, `#/account` deep-links, Cmd-K jumps, and `UserMenu.onNavigate('account'|'security'|'sessions')`. **Redirect, never delete.**

---

## 1. How the webui works today, end to end

### 1.1 Boot + provider stack (`webui/src/soc/App.tsx`)
- `App` (L243-257) fixes provider nesting: **`ThemeProvider > TooltipProvider > AuthProvider > PrefsProvider > DemoProvider > RouterProvider > Boot`**. This order is load-bearing (do not reorder).
- `Boot` (L155-241) gate: `GET /api/auth/me` → if `authEnabled && !isAuth` render `<Login>`; then `GET /api/setup/status` → if `!setup_complete || forceWizard` render `<Wizard>`; else `<AppShell>` wrapping `<ErrorBoundary resetKey={page}><Suspense key={page} fallback={<PageSkeleton/>}>{renderPage(...)}</Suspense></ErrorBoundary>` + `<ReauthDialog active={authEnabled}>`.
- `renderPage(page,opts,navigate,onRerunWizard)` (L69-153) is the **single page-dispatch switch** — ~26 `React.lazy()` chunks (L35-60); `Login`+`Wizard` stay EAGER (own first paint). Host pages `overview/chat/metrics/intelligence` render tabbed scaffolds; leaf ids (`dashboard`→Home tab, `playbooks`→Intelligence tab, `cost`/`standup`/`investigate`/`knowledge`/`memory`/`catalog`) have standalone deep-link arms too; standalone arms `models/roles/inbox/account/sessions/admin_sessions/settings/security/users/audit`; default → Home/overview.

### 1.2 Router (`webui/src/soc/router.tsx`)
- Hash router (`#/<id>`). `pageFromHash()` (L34) parses via `isPageId`; unknown/empty → `'overview'`.
- `Navigate = (page:PageId, opts?:NavOpts)=>void`. **opts (tab/status/caseId/section) are kept in React state, NOT the URL, and cleared on `hashchange` (L57-62)** — pages rely on opts surviving an in-app navigate but resetting on a raw deep-link/refresh.

### 1.3 Nav model (`webui/src/soc/nav.ts`) — the ONE nav source
- `PageId` (L48-74) = 26-member routable-id union (router validates hash against it).
- `NavGroupId` (L76-84) = 8 members; **only 6 used** (`overview/triage/intelligence/analytics/notifications/platform`). `'automation'` + `'admin'` (L83-84) are **DEAD** (declared, never assigned to a group).
- `NAV_GROUPS` (L133-270): the rail. Overview{overview[+dashboard,standup]}, Triage{cases, chat/Workspace[+chat,investigate], scans, approvals}, Intelligence{intelligence[+knowledge,memory,playbooks]}, Analytics{metrics[+metrics,cost,**models**]}, Notifications{inbox}, Platform{sources, audit(perm `audit:view`), settings[+users,security,roles,sessions]}.
- Derived: `NAV_ITEMS` (L273), `NAV_CHILDREN` (L276), `HIDDEN_ROUTE_IDS` (L290-306), `PAGE_IDS` (L313-319, dedup of item+child+hidden ids), `navItem()`/`navParentOf()`/`navLabel()`/`isPageId()` (L326-355).
- **`CommandPalette` (`components/CommandPalette.tsx:50,165`) also enumerates from `NAV_GROUPS`** — any nav change flows into Cmd-K automatically. Keep `NAV_GROUPS` the single source.

### 1.4 App shell chrome (`webui/src/soc/AppShell.tsx`)
- `AppShell` (L355): `NavSidebar` rail + top bar (breadcrumb = `productName + navItem(page)?.label ?? navLabel(page)`, health pill, theme toggle, notification bell, user menu, Cmd-K).
- `healthView(health,err)` (L103-158) maps `GET /api/health` → pill (Healthy/In-memory store/State store unreachable/Backend unreachable); `demoActive` mutes non-critical health to 'Demo mode' (L397-410).
- `useHealth()` (L168-197): 15 s poll, err after 2 fails. `UserMenu` (L263-353): avatar menu → `onNavigate('account'|'security'|'sessions')` + Appearance theme radios (`usePrefs.setThemeMode`) + Log out.
- `NavSidebar` (`components/NavSidebar.tsx:521`) + `useNavPrefs()` (L109): expanded drawer vs collapsed icon-rail; `filterGroups()` (L213) RBAC-filters items+children; persists `{nav_collapsed,nav_open_groups}` to localStorage (`soc.nav.collapsed`/`soc.nav.openGroups`) + `PUT /api/prefs/user`. Hydrates SYNCHRONOUSLY from localStorage (avoids first-paint flash); keeps `aria-current='page'` single-current invariant + `#socMain` skip-target (WCAG).

### 1.5 Theme + branding (`webui/src/soc/theme.tsx`, `theme-tokens.ts`)
- `ThemeProvider` (L156) + `useTheme()` → `{theme,isDark,setTheme,toggle,branding,material,ready}`; `applyBranding()` (L129) delegates tokens to `theme-tokens.applyBranding` (allow-listed CSS vars) + `applyMaterialClass/applyFavicon/applyDocumentTitle`; STORAGE_KEY `'soc.theme'`.
- `DEFAULT_BRANDING` (L32) currently includes `login_subtitle`, `footer_text`, `support_url`, `dark_mode_default`.
- `theme-tokens.ts`: `ALLOWED_TOKENS` (exhaustive writable css-var allow-list — the #9/#10 security boundary), `sanitizeTokenValue()` (rejects `{}<>\;@`, `url(`, `expression(`, comments, >200 chars; `--font-display` FONT_ALLOWLIST), `applyBranding(branding,target)→Material`, `MATERIAL_PACKS{quiet,command}`, `ACCENT_PRESETS[6]`. **Pure module (no React), unit-tested directly; writes via `element.style.setProperty`, never innerHTML.** `GET /api/branding` failure path swallows the error and keeps defaults.

### 1.6 Auth/RBAC (`webui/src/soc/auth.tsx`)
- `AuthProvider` (L54) + `useAuth()` → `{authEnabled,rbacEnabled,isAuthenticated,username,role,mustChangePassword,matrix,hasPermission,refresh,logout}`.
- **`hasPermission()` (L114-125) back-compat: returns `true` when `!authEnabled || !rbacEnabled`; `super_admin`→true; else `matrix[role][resource]` includes action or `'*'`.** Every `NavItem.perm`, `<Can>`, route gate, and the CI route-auth test depend on this. The login-off default MUST stay fully navigable.
- `useUnauthorizedRedirect()` (L167) wires the global 401→login handler.

### 1.7 The API/types contract layer (`webui/src/lib/`)
- `api.ts`: the ONE typed fetch client. `request<T>(method,path,{body,query,_retried})` — `credentials:'include'`, `ApiError{status,message,body}` on non-2xx (status 0 = network), 401→`onUnauthorized` bounce, single `reauth_required` step-up retry (`_retried` guard, skips `auth/reauth`). `buildQuery()` DROPS `undefined/null/''` (optional query args omitted, not blank). `API_BASE='/api'`.
- **`api.getModels()` → `GET /api/models` is the LEGACY per-role provider picker** — DISTINCT from the pricing catalog `GET /api/llm/models` in `Models.api.ts`. Keep both; do not merge.
- `types.ts` (2047 lines) mirrors backend Pydantic for SHARED surfaces. **Round-3 per-feature types live in co-located `soc/**/*.api.ts` (Models.api.ts, Inbox.api.ts, Roles.api.ts, Standup.report.api.ts, Metrics.posture.api.ts, CaseDetail.api.ts, EnrichmentProviders.api.ts, NotificationBell.api.ts) — NOT in `lib/types.ts`.** Follow that pattern for new Round-4 batch/pricing clients to avoid parallel-build contention on `api.ts`.
- `types.ts` is loose-by-design (index signatures on `Case`/`Preferences`/`Metrics`/`UsageSummary`) — add fields additively; absence never breaks.
- `useEventStream.ts`: pure-transport SSE hook, default-OFF; PROBEs (`204`→stay polling), then `EventSource(withCredentials)`; CHANNELS `['message','inapp','case.activity','agent','overflow']`; `MAX_COLD_FAILURES=4` give-up. **Payloads are NEVER rendered (#9); it only nudges refetch.**

---

## 2. The three UI glitches — exact fix surface

### 2.1 Glitch #1 — hover-card clips at right viewport edge
**File:** `webui/src/ui/hover-card.tsx` (VERIFIED live).
```tsx
// L8-28 (verified)
const HoverCardContent = React.forwardRef<...>(
  ({ className, align = 'center', sideOffset = 8, ...props }, ref) => (
    <HoverCardPrimitive.Portal>
      <HoverCardPrimitive.Content ref={ref} align={align} sideOffset={sideOffset}
        className={cn('z-50 w-80 rounded-lg border ... shadow-elev2 outline-none', ...)}
        {...props} />
    </HoverCardPrimitive.Portal>
));
```
- Radix `@radix-ui/react-hover-card@^1.1.17`: `avoidCollisions` defaults **true** but `collisionPadding` defaults **0** → the fixed `w-80` (320px) card sits flush against the right edge and looks clipped. Content is **Portalled** (L12) so ancestor `overflow:hidden` is NOT the cause; the fix is `collisionPadding`, not `avoidCollisions`.
- **FIX:** add `collisionPadding` to the destructured props (default `8`, exposed as prop like `sideOffset`) and pass it to `<HoverCardPrimitive.Content collisionPadding={collisionPadding}>`. Keep exports `{ HoverCard, HoverCardTrigger, HoverCardContent }` (L31), `align='center'`, `sideOffset=8`, `displayName` (L29), all base classes.
- **Consumers:** `CaseHoverCard.tsx`, `Cases.tsx`, `Scans.tsx`. Note: `ui/tooltip.tsx` + `ui/popover.tsx` (both `sideOffset=4`) also omit `collisionPadding` and back `HelpTip` — the new RiskGauge (?) popover near a panel edge may want the same; consider standardizing (out of strict scope, but low-risk).

### 2.2 Glitch #2 — SettingsCard description wraps one-word-per-line
**File:** `webui/src/soc/components/SettingsGrid.tsx` (VERIFIED live).
```tsx
// L86-101 (verified)
<header className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
  <div className="flex min-w-0 items-start gap-3">
    {Icon ? (<span ...>...</span>) : null}
    <div className="min-w-0">                                        {/* L93 — needs flex-1 */}
      <h3 className="text-sm font-semibold tracking-tight text-foreground">{title}</h3>
      {description ? (
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{description}</p>  {/* L96 — needs break-words */}
      ) : null}
    </div>
  </div>
  ...
</header>
```
- Inside the parent flex header, the inner text `<div>` has `min-w-0` but no `flex-1` (doesn't grow to fill width), and the `<p>` lacks `break-words` (a long unbroken word/URL/env-var collapses to one word per line).
- **FIX (className-only, additive):** L93 `'min-w-0'` → `'min-w-0 flex-1'`; L96 add `'break-words'`. `cn` (`@/lib/cn`) dedupes safely.
- **Do the fix in the primitive** — W5 adds many more `SettingsCard`s in the consolidated Settings; every page inherits it. Keep public API (`SettingsGrid`/`SettingsCard`/`StickySaveBar`/`SettingsTOC` named exports + default export `SettingsGrid` L247), `displayName`s, the `<section id={anchor}>`+`scroll-mt-24` anchor contract (SettingsTOC deep-links), and the `wide/'full'` col-span mapping (L81).

### 2.3 Glitch #3 — CaseDetail Collaboration/Feedback tabs swapped + duplicated
**File:** `webui/src/soc/pages/CaseDetail.tsx` (VERIFIED live).

The tab **VALUE names are inverted vs their human labels**:
```tsx
// Triggers L1615-1620 (verified)
<TabsTrigger value="thread"> <Users .../> Collaboration </TabsTrigger>   // value 'thread' → labeled Collaboration
<TabsTrigger value="collab"> <Star  .../> Feedback      </TabsTrigger>   // value 'collab'  → labeled Feedback

// Content L1664-1699 (verified)
<TabsContent value="thread"><CollaborationThreadTab .../></TabsContent>  // real #4 collab surface (GOOD)
<TabsContent value="collab"><CollaborationTab .../></TabsContent>        // legacy feedback+dup surface
```
- Tab **state union** at `:559-561` = `'overview'|'why'|'threat'|'trace'|'thread'|'collab'|'chat'` (default `'overview'`); stale `//` comment at `:572` ("lazy on the Thread tab").
- `CollaborationThreadTab` (`:3463-3618`) = modern Round-3 #4: `<CaseThread>` discussion + `<AssigneePicker>` + `<CaseTasks>` + `<CaseActivityFeed>`. **GOOD.** Tabs are LAZY (`loadThread/loadActivity` fire on tab change, not on open).
- `CollaborationTab` (`:3715-4165`) = LEGACY Wave-3, shown under the "Feedback"-labeled tab. Renders THREE sections, TWO of which DUPLICATE the thread tab: (1) Ownership assignee `<Input>`+`<TagInput>` (`:3872-3921`); (2) **"Rate the AI decision" feedback grading (`:3924-4095`) — the ONLY non-duplicated part**; (3) a "Notes" comment thread+composer (`:4098-4162`). Uses legacy `api.caseComment/caseTags/caseAssign` (writes to `c.comments/c.tags/c.assignee`); the modern tab uses `AssigneePicker` + thread endpoints.

**FIX (two parts):**
1. **Un-swap the values** so value matches label/component. Rename in lockstep at **4 sites** (missing one silently blanks a tab): state union `:559-561`, each `TabsTrigger value` (`:1615/:1618`), each `TabsContent value` (`:1664/:1697`), and the `setTab` default/cast (`:1598`). Suggested: `value='collab'`→the thread tab (Collaboration), `value='feedback'`→grading. Keep the lazy-load trigger wired to whatever value now shows the thread.
2. **Strip the duplication:** reduce `CollaborationTab` to ONLY the "Rate the AI decision" grading section (`:3924-4095`); drop its Ownership (`:3872-3921`) and "Notes" (`:4098-4162`) blocks (they exist, better, in the thread tab's `AssigneePicker` + `CaseThread`). Note `CollaborationTab` keeps OWN local assignee/tags/comment state synced via `useEffect` (`:3815-3844`) — removing means those writes route through the modern `AssigneePicker`/`CaseThread` instead (don't just delete and lose note-adding).

**Do NOT break these tests:** `case-detail-close.test.tsx` expects EXACTLY ONE control named `/^close$/i` (the shadcn `SheetContent` built-in X; the footer dismiss is labeled **'Dismiss'** at `:1712`, NOT 'Close') PLUS one `/^close case/i` lifecycle button.

---

## 3. Case view cleanup — single CTA + Close-with-disposition

### 3.1 Today (`webui/src/soc/pages/CaseDetail.tsx`)
- Lifecycle footer `:1708-1740`: 'Dismiss' ghost (`:1711-1713`, `onClose`) + `headerActions.map` one `<Button>` per action, each `<Can>`-gated via `ACTION_PERMISSION` (`:202-213`), opening a confirm dialog via `openAction(a)`.
- Confirm dialog `:1746-1888`: single shared confirm-with-fields `<Dialog>`; conditionally renders resolution/tags/assignee/priority/disposition/reason on `pending.fields`; primary disabled only when `disposition` required-but-empty (`:1877-1880`).
- `ActionKind` (`:187-197`): `close|confirm_fp|escalate|deescalate|reopen|acknowledge|hold|resume|resolve|set_disposition` (+ `set_status` used by bulk).
- `ALL_ACTIONS` (`:239-343`) = 10 `ActionDef` records; `actionsForStatus` (`:363-404`) — **open-ish states return SEVEN buttons** (`escalate`(fill), `resolve`, `close`, `confirm_fp`, `hold`, `set_disposition`, `acknowledge`) with overlapping semantics, no single primary CTA.
- `runAction` (`:1098-1149`) builds `CaseActionInput {action,note?,resolution?,assignee?,priority?,tags?,disposition?,reason?}` → `api.caseActionExec(id,input)`.
- `ACTION_PERMISSION` (`:202-213`): `close/confirm_fp/resolve/reopen`→`cases:close`; rest→`cases:write`.
- `DISPOSITION_OPTIONS` (`:216-223`): `true_positive|false_positive|benign|suspicious|duplicate|undetermined` (mirrors backend `Disposition`).

### 3.2 Round-4 change (single CTA + unified Close-with-disposition)
- Collapse `actionsForStatus`' 7-button open-ish array (`:395-403`) → **one primary CTA + an overflow**, and merge `close`/`confirm_fp` (take resolution/tags) with `set_disposition` (takes a `Disposition`) into ONE **Close-with-disposition** flow. The confirm dialog already renders both disposition and resolution fields, so this is a **UI-shape change over the SAME `CaseActionInput` wire keys.**
- **A unified CTA must still send an EXISTING action string** (e.g. `'close'` or `'confirm_fp'`) + a `disposition` field — do NOT invent a new action verb (`_ACTION_STATUS` in `backend/app/api/routes.py:3127-3139` consumes the existing verbs).
- Pre-seed `disposition` always (today `openAction` pre-seeds from `c.disposition` only when `fields` include 'disposition', `:1085-1087`); if disposition becomes mandatory, extend the disabled-guard at `:1877-1880`.

### 3.3 Cases list + bulk (`webui/src/soc/pages/Cases.tsx`)
- `runBulk` (`:560-596`) → `api.cases.bulk(ids,input)` → `POST cases/bulk`; `api.cases.bulk` posts `{...input, ids}` (ids spread INTO body). `BulkResult {results:[{id,ok,error?}]}`.
- Bulk-bar handlers (`:1148-1157`): onAcknowledge→`{action:'acknowledge'}`, onClose→`{action:'close',resolution}`, onResolve→`{action:'resolve',reason}`, onAssign→`{action:'escalate',assignee}`, **onAddTag→`{action:'acknowledge',tags:[tag]}`** (tags ride an acknowledge), onSetStatus→`{action:'set_status',status}`, onSetDisposition→`{action:'set_disposition',disposition}`.
- Filters (`:166-322`): `CaseFilters{search,status,severity?,verdict?,assignee}`; ANY/UNASSIGNED sentinels; `buildFacets/healFilters` self-heal stale facets (list can't silently empty); selection dropped on invisible rows (`:540-547`).
- **Test contract:** `cases-bulk.test.tsx` expects bulk-bar `aria-label='Bulk actions'`, a 'Select all rows' checkbox, and Acknowledge → `api.cases.bulk(ids,{action:'acknowledge'})`.

### 3.4 Approvals (HITL) (`webui/src/soc/pages/Approvals.tsx`)
- `decide` (`:461-483`) → `api.approveProposal/rejectProposal`; `kindBand` (`:91-96`) classifies `suppression`(tuning)/`memory`/`other`; `errMsg` (`:123-127`) maps 403→'requires admin', 404→'no longer exists', 409→'already decided'. Approve is server-enforced admin — keep the 403/404/409 inline surfacing; don't client-side hide by guessing role.

---

## 4. Risk (?) help — the 5-factor affordance

### 4.1 Where it lands (`webui/src/soc/components/CaseTriageHeader.tsx`, VERIFIED live)
- `RISK_COMPONENTS` (`:139-145`, verified): `volume/velocity/reputation/diversity/asset_criticality` — the 5-factor keys (must match `risk.py` `RiskBreakdown` fields + `/triage` `breakdown` payload keys). NO weights/help today.
- `RiskBreakdownBars` (`:148`) iterates them; `RiskCard` (`:198-212`) renders `<RiskGauge score size={108}/>` + `RiskBreakdownBars` and holds ONE bare `<HelpTip text={help} label="What risk means"/>` at `:212`.
- `help` string (`:201-203`, verified): `risk.inputs?.definition || 'Deterministic 0-100 risk: a weighted blend of event volume, velocity, entity reputation, rule diversity and asset criticality.'` — **the backend `risk.inputs.definition` is authoritative; L203 is only the fallback.**

### 4.2 The fix
- Attach a `HelpTip` to the risk breakdown (a second (?) on `RiskBreakdownBars`, or extend the existing `RiskCard` `HelpTip` text) authored **VERBATIM from `backend/app/engine/risk.py`** with the honest weights **25/20/30/15/10** (percentages of `config.py:RiskWeights` `volume=0.25 velocity=0.20 reputation=0.30 diversity=0.15 asset_criticality=0.10` — **Reputation heaviest at 0.30**) PLUS the caveat **"risk only ranks, never closes"** (`risk.py`/`priority.py` never feed `decide()`).
- The duplicated definition string lives at **`CaseTriageHeader.tsx:203` AND `backend/app/engine/priority.py:262`** (byte-identical, no shared constant). `priority.py` is served as `risk.inputs.definition` and is authoritative; if you edit the human-facing copy, update BOTH or they diverge.
- **RiskGauge itself is dumb/presentational** — `webui/src/soc/components/RiskGauge.tsx` contains NO HelpTip; do NOT add the (?) inside it. `RiskGauge.test.tsx` locks: exactly 2 `<path>`s (muted track + `currentColor` progress with dashoffset), NO `<linearGradient>`/`<defs>`, finite `d`, 4-band `bandOf` thresholds 80/60/35. Do not regress.
- `HelpTip` (`components/HelpTip.tsx`): `{text,link,code,label='More information',className}`; renders a Tooltip when `text<=80 chars` & no link/code, else a Popover (`usePopover` L52). **Reuse this component — the 5-factor text will exceed 80 chars → a Popover** (which is why the popover `collisionPadding` note in §2.1 is relevant here). Render as plain children (#9), never markup.

---

## 5. Login white-label (W5)

### 5.1 Today
- `Login.tsx` (`:63`) — `Mode='signin'|'setup'|'change'|'mfa'` (`:61`); reads `branding.org_name/product_name/logo_data_url/login_subtitle/footer_text/support_url` (`:66-72`, http(s)-gated). SSO buttons from `api.auth.sso.providers()`.
- `BrandHero` (`loginParts.tsx:398-413`) **HARDCODES** the headline fallback ('Triage at machine speed…'), body, and chips `['Audited','Cost-metered','Human-reviewable']`. Only `login_subtitle` feeds the `h2` (and it overrides the headline, so an operator can't set both a headline and a sub-line — `login_subtitle` is also reused in `Login.tsx:272` `descByMode.signin`).
- Backend `BrandingConfig` (`config.py:637`) login fields today: `login_subtitle`/`footer_text` (≤400 chars, `config.py:766`), `support_url` (http(s), ≤2000, `config.py:773`). NO headline/body/chips/layout fields.

### 5.2 The fix (bounded plain-text only, #9/#6)
- Add bounded plain-text `login_*` fields (e.g. `login_headline`, `login_body`, `login_chips[]`) to: `BrandingConfig` (`config.py:637`, mirror the 400-char plain-text validator, **no raw HTML/SVG**); `Branding` in `webui/src/lib/types.ts` (currently only `login_subtitle`); `DEFAULT_BRANDING` in `theme.tsx:32` (default `''`); `BrandingDoc` in `branding.api.ts` (the structural superset that deliberately does NOT import `lib/types.ts`); `BrandingEditor.tsx:997-1044` "Login & messaging" block; and thread through `Login.tsx`→`BrandHero` props.
- `GET/PUT /api/branding` is PUBLIC/pre-auth readable → safe to read before login, but operator-set → keep bounded + render every string as a plain React text node (`BrandHero` never uses `dangerouslySetInnerHTML`). New fields default `''`, back-compat with old docs.
- These are login **copy** (text), NOT CSS tokens — do NOT add them to `theme-tokens.ts ALLOWED_TOKENS`.

---

## 6. OOBE + first-run (W5 account-setup step)

- **The Wizard does NOT create an admin.** `Wizard.tsx` STEPS (`:87`) = welcome/sources/keys/done; `WelcomeStep` sets `deploymentName`+`demoMode`; `KeysStep`→`api.updateSecrets` (KEY_FIELDS `:661` = anthropic/openai/embedding keys only); `finish()`→`api.putSettings({deployment_name,demo_mode})`+`api.completeSetup()`. The Wizard `demoMode` toggle is UI-only (non-destructive; real Demo Mode lives in Settings→Experimental).
- **Admin creation is entirely in `Login.tsx` `Mode='setup'`** — entered when `setup.status().needs_user` (`:100`); `submitSetup` (`:155`) checks `pw.length>=8` + `password===confirm`, then `api.setup.initAdmin(username,password)` → `api.auth.login`. `PasswordStrengthMeter`/`scorePassword` (in `loginParts.tsx`) are imported/rendered but **advisory only — never gate submission**.
- **Flow order (App.tsx Boot):** with auth ON, `<Login>` (which owns create-first-admin) renders BEFORE `<Wizard>`, so the admin already exists before the Wizard runs. With auth OFF there is no Login, `needs_user` is always false, so the OOBE admin step never appears and the Wizard is the sole first-run surface.
- **W5 account-setup step** must handle both: either add a 5th `Wizard` step that **reuses the current session** (`api.auth.changePassword` + `api.auth.mfa.setup/confirm`), NOT `init-admin`; or enrich the Login 'setup' path to use `scorePassword`/`PasswordStrengthMeter` as a submission gate + an optional `MfaSetupCard` step after account creation. Respect the Boot ordering (setup-status only runs after auth resolves).
- Wire contracts to preserve: `GET /api/setup/status` keys (`setup_complete/needs_user/seeded_default/auth_enabled/rbac_enabled/user_count/configured/data_view_pattern/entity_mapping/es_connected`, `routes.py:169`); `POST /api/setup/init-admin` `{username,password}` + **409-when-user-exists guard** (`routes.py:207`, single-use bootstrap — do NOT weaken); `POST /api/setup/complete`, `POST /api/setup/secrets`. Keep `Login.Mode` union + submit handlers unchanged (presentation-only per the file header).

---

## 7. ~30-page consolidation + analytics declutter (W5)

### 7.1 Admin-page duplication (the core W5 target)
`Account / Sessions / Users / AdminSessions / Security` (and `Knowledge`) each exist as **BOTH** a standalone `renderPage` arm (`App.tsx:136-149`) **AND** an `*Inner` embed in Settings (`Settings.tsx` imports `AccountInner/SessionsInner/UsersInner/AdminSessionsInner/SecurityMfaInner/SecuritySsoInner/SecurityInner`). Two homes for the same UI.
- **FIX:** pick ONE home (Settings sections); make the standalone PageIds **redirect** into Settings via `renderPage` arms + a deep-link map (e.g. `navigate('settings',{section:'admin_users'})`), NOT by deleting PageIds. Keeping the ids preserves `#/users` deep-links, Cmd-K, and `UserMenu.onNavigate('account'|'security'|'sessions')`.
- The `*Inner` export pattern is a **live contract** — if a page is consolidated its `Inner` export must remain (or `Settings.tsx` imports update in lockstep). `SecuritySsoInner` has a controlled (`update` prop) vs uncontrolled split keyed on `Boolean(update)` — Settings relies on the controlled path.
- Settings hash: `#/settings?s=<sectionId>` (`sectionFromHash` regex `[a-z_]`); `admin_users`/`admin_sessions`/`account_security` deep-links must keep resolving.

### 7.2 Dead code + phantom tab
- Drop DEAD `NavGroupId` `'automation'` + `'admin'` (`nav.ts:83-84`).
- **PHANTOM Analytics `models` tab:** nav declares a `models` child under Analytics (`nav.ts:202-204`, stale comment L195 "Analytics = Dashboard | Cost | Models") but `Analytics.tsx` host has only `dashboard|cost` tabs; `models` actually routes to standalone `<Models/>` (`App.tsx:101-104`). Round-4 broadens the Models catalog UI — decide whether Models becomes a real Analytics tab OR stays standalone, and fix the nav child so it isn't a phantom tab.

### 7.3 Analytics split 4 ways / posture on 3 pages
- Posture (MTTA/MTTR/dwell/SLA/aging) is rendered in **`Overview.tsx`**, **`Metrics.tsx`** (own `operational|performance|posture` tabs), and **`Standup.tsx`** (SLA/aging) = 3 pages. Analytics host (`Analytics.tsx`) surfaces only `metrics+cost`. Analytics itself is split across Metrics operational / Cost / Overview KPIs / Standup = 4 ways; **Cost is the designated single home**.
- Shared source of truth to preserve: `Metrics.posture.api.ts` (`fetchPosture/fetchMitreCoverage/navigatorLayerUrl/PostureResponse/MitreCoverageResponse`) + `posture.format.ts` (`humanizeMinutes/ratioPct/deltaView`) are imported by BOTH `Metrics.tsx` AND `Overview.tsx`. Consolidate by editing host wrappers + nav children (all route through `renderPage`); **keep the single `fetchPosture`/`posture.format` source — do not re-derive client-side.** (MITRE coverage in Metrics is fetched with `window_hours=0` = ALL cases, independent of the operational window selector — keep it decoupled.)

### 7.4 Reset DangerZone (W5)
- There is currently **NO platform-reset DangerZone** (only demo reset via `api.demo.reset()` in `DemoBanner`, and the `advanced-killswitch` card in `AdvancedSection`). W5 adds a reset card under the existing Settings **Experimental** group (section `demo`, `Settings.tsx:~360`/`~2515`).
- **This needs a NET-NEW backend endpoint** (no reset endpoint exists beyond `/api/demo/reset`). The reset **MUST NOT touch the deterministic `decide()` (#3) or the two ES clients (#1)**. Demo Mode is managed ONLY by `/api/demo/*` (settings PUT re-injects the live demo block server-side, `routes.py:~663`) — a demo-scoped reset uses `demo.reset()/disable()`, not a settings write.
- Settings hooks constraint: `visibleGroups/flatVisible` useMemos MUST stay above the loading/`!prefs` early returns (React #310 warning at `Settings.tsx:~2339`); a new section needs a `perm` + `keywords` (RBAC + search filter, `:~2364`). `GRID_SECTIONS` (general/detection/knowledge/advanced) render their own full-width `SettingsCard` grid — a new grid-style section must join `GRID_SECTIONS` or it double-wraps.

---

## 8. Models catalog + pricing columns (W3) — the webui touch

- `Models.tsx`: `default Models()` behind `ProtectedRoute resource='models' action='read'`; Tabs `catalog|cost|providers`; `PriceOverrideDialog` (`PUT/DELETE llm/models/{id}/pricing`), `TestCallDialog` (`POST llm/models/test`), `CostEstimator` (`POST cost/estimate`), `ProvidersGrid` (`GET llm/providers`).
- `Models.api.ts`: `ModelCatalogRow` (`id,label,provider,context_window,max_output,modalities,capabilities,input_per_million,output_per_million,cache_write_per_million,cache_read_per_million,base_url,pricing_source,assigned_roles,price_overridden` — **NO batch field yet**); `ModelsCatalogResponse.overrides` carries `{input,output}`; `modelsApi.{catalog,providers,test,setPricing,clearPricing,estimate,getBudget,putBudget,budgetStatus}`.
- `ModelsCatalog.tsx:145-161`: the pricing column (header 'Price / 1M') shows only in/out + optional cache-read; `capabilityChips()` derives a 'Cache' chip when cache present. **THIS is where W3 adds cache-write + batch columns.** Reuse `fmtMoney` + `tabular-nums` and null-guard (cache/batch may be null) like the existing cache-read guard.
- **FIX:** add `batch_*_per_million` field(s) to `ModelCatalogRow` (additive; backend `routes_models.py:llm_models()` L76 builds from `pricing.py:model_catalog()` L139 which emits cache_write/read but no batch yet — W3 backend adds batch there). New pricing columns are read-only display (no perm); any new override control needs `models:manage`.
- `Models` is a SEPARATE rail child + standalone route; `Analytics.tsx` does NOT host it (see §7.2 phantom tab).

### 8.1 W1 Usage cache/batch fields
- `UsageSummary` in `lib/types.ts`: `by_model` rows carry only `{key,cost,tokens,calls}` — no cache/batch breakdown. W1 (backend `UsageDoc` cache/batch token fields) requires ADDING cache/batch token+cost fields here (loose index signature → additive, safe). **Mirror backend `UsageDoc` field names exactly** (CLAUDE.md keeps `types.ts` in sync with `models.py`). Do not remove/rename existing `by_model/by_surface/by_role/cost_over_time` keys.

---

## 9. Invariants this domain enforces (and where)

- **#1 (two ES clients `_ro`/`_mgmt`)** — the webui never talks to ES directly; only via `/api`. The **W5 reset endpoint must not reset/rewire the two ES clients.** No webui code selects ES keys.
- **#3 (deterministic `decide()` is the ONLY closer)** — these UIs only POST analyst actions; `set_disposition`/`acknowledge` keep status (`_ACTION_STATUS = None`). Nothing in the UI may imply the LLM closes a case. The AI is a first-class *author* in `CaseThread` but can only RECOMMEND. Risk-help copy must keep the "ranks, never closes" caveat. Models/Settings/BudgetGate never feed `decide()`.
- **#4 (cursor durability / signature idempotency)** — surfaced only via the feed model in `SourceEditor.tsx` (`FeedRole events|alerts|ignore`, per-feed cursor, `severity_floor` blocks auto-forward but NEVER drops, IGNORE excludes at ingest). The UI must not imply otherwise. `auto_correlate` MUST keep being written by `feedToWire()` for back-compat alongside the `correlate/auto_investigate` split.
- **#6 (one gateway → one UsageDoc per call)** — the webui only DISPLAYS usage/pricing; W1/W3 add cache/batch fields to `UsageSummary`/`ModelCatalogRow` for display. No client mutation of ledger semantics.
- **#9 (untrusted text fenced/escaped)** — **enforced pervasively in this domain:** every case/AI/operator/proposal/branding/username/health/log/model-id/audit/inbox string renders as a plain React text node, `InlineCode`, or `<pre>` CodeBlock — **NO `dangerouslySetInnerHTML` anywhere** in Cases/CaseDetail/Chat/Approvals/Inbox/Audit/Login/BrandHero/HelpTip. `theme-tokens.ts` `sanitizeTokenValue` + `ALLOWED_TOKENS` are the CSS-var boundary. `useEventStream` payloads are never rendered. New login white-label fields + risk-help copy MUST render as plain children. The `@mention` highlighter in `CaseThread` is non-markup.

---

## 10. Contracts a refactor MUST preserve (checklist)

1. **`PageId` union (`nav.ts:48-74`) + `PAGE_IDS` (L313) + `isPageId`** — the router hash allowlist. Consolidation keeps the id (redirect, don't delete) or `#/users`/`#/cost`/`#/account` + Cmd-K + `UserMenu` jumps break. `pageFromHash()` unknown/empty → `'overview'`.
2. **`Navigate(page, opts?)` semantics** — opts NOT URL-serialized, cleared on `hashchange`. Host-page tab wire keys: `navigate('overview',{tab:'standup'})`/`('chat',{tab:'investigate'})`/`('metrics',{tab:'cost'})`/`('intelligence',{tab:'memory'})`.
3. **`renderPage()` (`App.tsx:69-153`) is the SOLE page dispatcher** — adding/moving a page needs BOTH a `PageId` in `nav.ts` AND an arm here. Host arms + standalone deep-link arms must stay coherent.
4. **`hasPermission()` back-compat** (`auth off || rbac off → true`, `super_admin → true`) — every nav/route gate + CI route-auth test depend on it.
5. **`*Inner` exports** consumed by `Settings.tsx` (`AccountInner/SessionsInner/UsersInner/AdminSessionsInner/SecurityMfaInner/SecuritySsoInner/SecurityInner`) — keep signatures.
6. **`CaseActionInput` wire keys** (`{action,note,reason,resolution,assignee,priority,tags,disposition,status,level}`, `types.ts:1539-1570`) map 1:1 to backend `CaseAction` (`routes.py:3102-3120`); `ActionKind` string verbs consumed by `_ACTION_STATUS` (`routes.py:3127-3139`) — don't rename. `api.cases.bulk` posts `{...input, ids}`.
7. **`DISPOSITION_OPTIONS`** mirror backend `Disposition`; `CaseStatus`/`Disposition`/`role events|alerts|ignore` string unions stable.
8. **Test labels:** `case-detail-close.test.tsx` (exactly one `/^close$/i`, footer dismiss = 'Dismiss', one `/^close case/i`); `cases-bulk.test.tsx` (`aria-label='Bulk actions'`, 'Select all rows', Acknowledge wire).
9. **Branding wire** — additive `login_*` only, `''`-default, PUBLIC/pre-auth readable, bounded plain-text (≤400/≤2000), no raw HTML/SVG; keep existing keys; `theme.theme` webui type is `'dark'|'light'|'system'|''` vs backend Literal (no `''`) — `default_theme` is authoritative.
10. **`api.getModels()` (GET /api/models, legacy per-role) ≠ `Models.api.ts` catalog (GET /api/llm/models)** — keep both. `ModelCatalogRow`/`UsageSummary` fields additive, never renamed.
11. **`theme-tokens.ts ALLOWED_TOKENS`** — new themeable var needs BOTH `theme.css` (`:root` + `.dark`) AND `ALLOWED_TOKENS` (or it's silently dropped) + usually `tailwind.config`. `--accent2` must stay UNSET in `theme.css` (tailwind fallback to `--primary`). `MATERIAL_PACKS.quiet` must not write `--glass-opacity`.
12. **`SettingsGrid` primitive API** + `<section id={anchor}>`+`scroll-mt-24`; **glitch fixes are className-only, no API change.**
13. **`HoverCardContent` exports/defaults** (`{HoverCard,HoverCardTrigger,HoverCardContent}`, `align='center'`, `sideOffset=8`, `displayName`); only ADD `collisionPadding`.
14. **`buildQuery()` drops `undefined/null/''`**; `ApiError` shape; 401 bounce + single reauth retry — new endpoints go through `request()`. New Round-4 batch/pricing clients go in co-located `*.api.ts`, NOT `lib/api.ts` (avoid parallel-build contention).

---

## 11. Risks / gotchas

- **Router two-source-of-truth** (biggest): `nav.ts` declares ids, `App.renderPage` dispatches them. Deleting a `PageId` in a consolidation breaks deep-links/Cmd-K/UserMenu. Redirect, never delete.
- **Tab-value rename requires 4 lockstep edits** (state union, both triggers, both content, setTab cast) — miss one and a tab silently blanks.
- **`CollaborationThreadTab` tabs are LAZY** — moving which value shows the thread must keep the lazy-load trigger wired to the new active value.
- **Footer 'Close' is now 'Dismiss'** — the only `/^close$/i` control is the shadcn `SheetContent` X. Don't add a second 'Close'-named control (breaks the test).
- **`login_subtitle` is dual-consumed** (`BrandHero` h2 headline `loginParts.tsx:398` AND `Login.tsx:272` `descByMode.signin`) — adding a distinct `login_headline` must disambiguate these.
- **Branding failure path is load-bearing** — `theme.tsx` swallows `GET /api/branding` errors and keeps `DEFAULT_BRANDING`; new `login_*` fields must default `''` and tolerate absence.
- **`BrandingDoc` (branding.api.ts) is a deliberate LOCAL superset of `BrandingConfig`** (intentionally not importing `lib/types.ts`) — new login keys go there + in `BrandingConfig`; keep them in sync manually.
- **Boot ordering**: setup-status runs only after auth resolves (skips while `showLogin`). An account-setup step must respect this or it flashes Login→Wizard incorrectly.
- **`NavSidebar` hydrates collapse/open-group SYNCHRONOUSLY from localStorage** — a refactor moving this must keep the sync-read (avoids a rail flash).
- **`CommandPalette` re-enumerates `NAV_GROUPS`** — dropping dead groups/renaming items flows into Cmd-K automatically; keep `NAV_GROUPS` the single nav source.
- **Risk-help string is duplicated** (`CaseTriageHeader.tsx:203` + `priority.py:262`, byte-identical, no shared constant) — editing the human copy must touch both; the backend `risk.inputs.definition` is served/authoritative.
- **`Sources.tsx:summarisePatterns()` (L~76) drops the `ignore` role** from the source-card summary even though `SourceEditor` fully supports it — the card under-reports feed config (cosmetic, but W5 consolidation may want to surface it).
- **`Metrics.tsx` has two `humanizeMinutes`** (a local L~100 + imported `humanizeMins`) — duplicate helper.
- **Reset DangerZone needs a net-new backend endpoint** — none exists beyond `/api/demo/reset`; it must not touch `decide()` (#3) or the two ES clients (#1).
- **`ui/tooltip.tsx`/`ui/popover.tsx` also omit `collisionPadding`** (both back `HelpTip`) — the new RiskGauge (?) popover (text >80 chars → Popover) may clip near a panel edge; consider the same fix.
