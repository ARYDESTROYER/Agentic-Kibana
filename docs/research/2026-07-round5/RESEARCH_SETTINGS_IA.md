# Round 5 · P2 External Research — Settings + Navigation IA

> **Scope.** How to structure the TLSOC Settings surface + nav: top-level groups,
> what belongs where, how to keep the hierarchy flat, and how search/deep-links make a
> broad rail usable. Grounded against the *actual* current implementation
> (`webui/src/soc/pages/Settings.tsx`, `SettingsGrid.tsx`, `CommandPalette.tsx`,
> `router.tsx`). This is a **refinement**, not a rebuild — the console already ships the
> two-scope split, a section rail, RBAC-filtered visibility, keyword search, sticky-save,
> and a Cmd-K palette. **Zero new heavy npm deps** are required for any recommendation
> here; the one net-new UI file (`ui/collapsible.tsx`) is a ~40-line Radix copy-paste.

---

## 0. TL;DR — the decisions

1. **Keep the two-scope spine** (Personal vs Organization) as the primary axis. It maps
   1:1 to the RBAC model (`require_permission` + `<Can>`) and matches every reference
   product (GitHub, Linear, Slack, Notion, Stripe, Vercel).
2. **Keep the persistent LEFT RAIL** as the top-level Settings nav. We have ~20 sections —
   far past the 3–6 ceiling where tabs stay discoverable. Rail scales; top-level tabs do
   not.
3. **Enforce a strict TWO-LEVEL depth:** rail *group* → section *page* → in-page *cards/
   anchors*. **Never a third menu/dropdown level.** If a section grows, split it into a
   peer section or use in-page shadcn `<Tabs>` — never deepen the tree.
4. **Re-group from 6 groups → 5**, and make the highest-leverage change every reference
   product makes: **promote Security to its own top-level group** and **split Roles out of
   Users**. Rename `Configuration → General`, `Administration → Organization`.
5. **Two disclosure tiers only** (default-visible vs one "Advanced" reveal). Gate the
   default-OFF pipeline features (tuning/batch/baseline/campaigns/event-detection) behind a
   head-of-section enable toggle. Keep the **Danger Zone visible-but-guarded**, never hidden.
6. **Two complementary search surfaces, kept:** the always-visible inline rail filter
   (VS Code model) **and** settings sections as jump targets in the global Cmd-K palette
   (Linear/Raycast model). Close the four plumbing gaps (below) so both actually deep-link
   to a section *and a card*.

---

## 1. The durable rules (what the research agrees on)

Across NN/g, the multilevel-menu literature, and five reference products (GitHub, Linear,
Vercel, Stripe, Notion, Slack), the consensus is tight:

| Rule | What it says | Our status |
|---|---|---|
| **Scope is the top axis** | Separate PERSONAL (this user) from ORG/ADMIN (affects everyone). GitHub/Slack/Linear pattern. | ✅ already done |
| **Control = breadth, not aesthetics** | Tabs only for 3–6 mutually-exclusive same-level views you never compare; left-rail for many sections; single-scroll within a small, related section. | ✅ rail chosen correctly |
| **Cap at two levels** | Nav-failure rates climb sharply past two submenu levels. Broaden, don't deepen. | ✅ two-level; audit for creep |
| **Order by frequency + safety** | Most-used first; destructive last + isolated. | ⚠️ partial — see §3 ordering |
| **Progressive disclosure, 2 tiers** | Sensible defaults visible; advanced behind ONE reveal; search as the escape hatch. | ⚠️ inconsistent — see §5 |
| **Search makes breadth tolerable** | A broad rail *must* be paired with frequency-ordering + fuzzy search/jump. | ⚠️ gaps — see §6 |
| **No "Miscellaneous" bucket** | Every control gets a scope + a named group; if it doesn't fit, the taxonomy is wrong. | ⚠️ "Experimental" trending toward a catch-all |

**Sources:** NN/g [Tabs, Used Right](https://www.nngroup.com/articles/tabs-used-right/),
[Flat vs Deep Hierarchy](https://www.nngroup.com/articles/flat-vs-deep-hierarchy/),
[Complex App Design](https://www.nngroup.com/articles/complex-application-design/),
[Progressive Disclosure](https://www.nngroup.com/articles/progressive-disclosure/);
[Boundev multilevel-menu guide](https://www.boundev.ai/blog/multilevel-menu-design-ux-guide);
[Fresh Consulting — flatter navigation](https://www.freshconsulting.com/insights/blog/uiux-principle-23-flatter-navigation-is-better-than-deeper-navigation/).

---

## 2. Reference-product IA (what the leaders actually do)

The single most useful analog is **Linear's 2024 sidebar redesign**, which groups its
rail into four labeled buckets — **Account · Features · Administration · Your teams** —
that map almost exactly onto our world. The others reinforce the same idioms:

- **Linear** — four labeled rail buckets; RBAC hides whole groups (admins see *more*, not a
  separate app); notifications grouped by channel; **admin management as data-rich tables**;
  a per-section *summary landing* ("what's enabled") before drill-in; Cmd-K is the real
  cross-app discovery layer, **not** an in-settings search box.
  [changelog](https://linear.app/changelog/2024-12-18-personalized-sidebar) ·
  [members/roles](https://linear.app/docs/members-roles)
- **GitHub** — scope by **URL namespace** (`/settings` vs `/orgs/:org/settings`); a
  grouped scrolling rail; **"Developer settings" split out** for tokens/keys; the canonical
  **"Danger Zone"** red-bordered destructive block.
  [personal](https://docs.github.com/en/account-and-profile/how-tos/account-settings) ·
  [org](https://docs.github.com/en/organizations/managing-organization-settings)
- **Stripe** — three buckets (Personal · Account/Business · Product settings); "Team &
  security" + "Branding" under Account; per-product config grouped away from account.
  [dashboard basics](https://docs.stripe.com/dashboard/basics) ·
  [roles](https://docs.stripe.com/get-started/account/teams/roles)
- **Notion** — org rail *General · People · Security · Identity/provisioning · Connections ·
  Data & compliance · Billing*; **Security & Identity are first-class top groups**, not
  buried under "advanced". [workspace settings](https://www.notion.com/help/workspace-settings)
- **Slack** — literally labels the two scopes "**Organization settings**" vs "**Workspace
  settings**"; a stable rail with a **dedicated "Roles & permissions"** item separate from
  People. [admin dashboard](https://slack.com/help/articles/115005594006-Guide-to-the-Slack-admin-dashboard)
- **Vercel** — the **team switcher IS the scope selector**; personal Account behind the
  avatar. [accounts](https://vercel.com/docs/accounts)
- **VS Code** — the reference for **broad-but-searchable**: category tree + single-scroll of
  grouped controls + pinned search + `@tag:`/`@modified` scoping + per-setting deep-links +
  a modified-indicator bar. [settings docs](https://code.visualstudio.com/docs/getstarted/settings)
- **Statsig Settings 2.0** — the canonical *flattening* case study: killed 3–4-level nesting
  via a **main-nav + sub-nav scope switcher** so Team/Project/Org variants of one setting sit
  side-by-side instead of buried. [case study](https://www.statsig.com/blog/settings-page-design-2025)

**Takeaway that recurs everywhere:** *deep search-within-settings is NOT a strong native
pattern.* GitHub/Linear/Vercel all lean on the **global command palette** as the discovery
mechanism and keep the in-page search as a light filter. We already ship both — we just need
to wire them to actually land on a section and a card.

---

## 3. Recommended IA (concrete)

### 3.1 Top-level groups: 6 → 5, with Security promoted

**Current (6 groups, 20 sections):** `My account` · `Configuration` · `Triage logic` ·
`Integrations & context` · `Administration` · `Experimental`.

**Recommended (5 groups):**

```
Account            (personal scope — chip: "You")
  ├─ Profile                       profile           (no perm)
  ├─ Security & two-factor         account_security  (no perm — self MFA)
  ├─ Sessions & activity           sessions          (no perm — caller-scoped)
  └─ Appearance & customization    customization     (no perm; org editors self-gate)

General            (org, low blast radius — chip: "Organization")
  ├─ Data scope & polling          general
  ├─ Models & LLM                  models
  ├─ Detection & correlation       detection
  ├─ Cases (nomenclature)          cases
  ├─ Automation                    automation
  └─ Standup                       standup

Integrations       (org — connectors + outbound + context)
  ├─ Sources & feeds               sources    ← NEW rail entry (own the multi-feed layer)
  ├─ Alerting & notifications      notifications
  ├─ Enrichment                    enrichment
  └─ Knowledge & threat context    knowledge

Security & access  (org, HIGH blast radius — chip: "Organization")   ← NEW GROUP
  ├─ Users                         admin_users   (users:manage)
  ├─ Roles & permissions           roles         ← NEW section (split from Users)
  ├─ Single sign-on (SSO)          security_sso  (settings:manage)
  ├─ Session & token policy        security_policy (settings:manage)
  ├─ Active sessions (all users)   admin_sessions (users:manage)
  └─ Secret keys & tokens          keys          ← MOVED here from Configuration

Organization       (org — cosmetic + advanced + destructive)
  ├─ Branding & appearance         appearance
  ├─ Advanced                      advanced      (progressive-disclosed engine toggles)
  ├─ Experimental (Demo mode)      demo          (collapsed by default)
  └─ Danger zone                   danger        ← isolated, red, at the very end
```

**Why these moves (each is a documented reference-product pattern):**

- **Promote Security → its own group** — *single highest-leverage change.* Notion
  ("Security"/"Identity"), Slack ("Security"), Stripe ("Team & security") all elevate
  security to a first-class top group. We currently bury SSO + token/session policy under
  "Administration" (`security` section at Settings.tsx:323). Split the current dense
  `security` section into two peer sections — **Single sign-on** and **Session & token
  policy** — or keep it one section with **in-page shadcn `<Tabs>` [SSO | Sessions | Policy]**.
- **Split `Roles & permissions` out of `admin_users`** — Slack ships a dedicated rail item;
  we have custom roles + a permission matrix (`routes_roles`). Keep the Users table about
  *identity*; give the matrix its own page room. (Linear/Slack: identity vs grants are two
  places.)
- **Move `Secret keys` into Security & access** — GitHub's "Developer settings" split.
  API keys, connector secrets, SSO client secrets are **high-blast-radius credentials** and
  should not sit next to Models in a cosmetic-feeling "Configuration" group. Reinforces
  non-negotiable #10 secret discipline (UI shows `configured ✓`, never values).
- **Rename `Configuration → General`** and **`Administration → Organization`** — matches the
  widely-recognized Notion/Slack vocabulary ("General" is the first org tab everywhere;
  "Organization" is the scope label). **Keep section `id`s stable** — they're deep-linked via
  `#/settings?s=<id>` and hash-synced (Settings.tsx:2188, 2220). *Change display `label` only.*
- **Give `Sources & feeds` a rail entry** — it's a first-class object with CRUD + a multi-feed
  layer (Linear's "data-rich admin tables" pattern). It earns a page (see §4).
- **Isolate a real `Danger zone`** — the tiered reset / factory-reset / revoke-all
  (`routes_reset`, already `require_fresh_auth` + type-to-confirm). GitHub/Stripe/Notion all
  cordon destructive actions in a distinct red block at the end. Today it lives inside
  "Advanced" (`DangerZone.tsx`); pull it to its own predictable, last-position section.

### 3.2 Ordering (frequency + safety)

Within each group, order by touch-frequency, destructive last:

- **Integrations:** Sources → Notifications (touched often) → Enrichment → Knowledge.
- **Security & access:** Users → Roles → SSO → Session/token policy → Active sessions →
  Secret keys.
- **Organization:** Branding → Advanced → Experimental → **Danger zone (last, isolated)**.

### 3.3 Scope legibility (cheap, no dep)

Single-tenant SOC → no scope *switcher* dropdown; instead:

- A **static labeled rail header** per scope: `Account · You` and
  `Organization · <brand name>` (from `BrandingConfig`), with a divider between the personal
  and org groups (Linear's labeled-bucket idiom without a switcher).
- An inline **scope chip** on each section header — `You` vs `Organization` — using the
  existing `Badge` primitive. This resolves the genuinely-ambiguous settings (theme,
  terminology, saved views) that a pure two-scope split can't (Notion's org-vs-workspace
  labeling in copy). No new dep.

---

## 4. Page vs Tab vs Section vs Inline — the decision rule

A hard, count-driven rule (from setproduct + NN/g), so future additions slot in without
debate:

| Signal | Use |
|---|---|
| 1 binary / 1–3 related fields, anchored to current task | **Inline** toggle/field in a `SettingsCard` |
| 3–6 co-equal sibling *views of the same object*, never compared side-by-side | **In-page `<Tabs>`** (shadcn `ui/tabs`) — e.g. `Models [Providers \| Pricing \| Budget]`, `Security [SSO \| Sessions \| Policy]`, Case detail `[Overview \| Why \| Trace \| Collab]` |
| A cohesive cluster of related fields read/edited in one glance | **Section** (single-scroll of `Card`s + sticky save) — the default TLSOC pattern |
| First-class object w/ rows+CRUD **OR** long-form config **OR** own sub-structure **OR** a different permission scope | **Its own page** (a rail destination, deep-linkable) |

**A setting earns its own page when ANY of:** it's a distinct object (Users, Roles, Sources,
Models, Notifications, Playbooks); it's long-form (token/session policy, `AutoClosePolicy`,
Branding); it has its own sub-tabs; or it lives at a different scope. → confirms Sources,
Roles, and the split Security sections deserve pages, and confirms *not* to modal-ize config
that has sub-structure or needs a URL (Smashing decision tree).

**Guardrails:** never > ~5–7 tabs (they wrap and stop being scannable → promote to rail
sections); never mix in-page tabs with navigation tabs in one control (disorienting); never
nest `<Tabs>` inside `<Tabs>`.

---

## 5. Progressive disclosure (advanced/rare/experimental)

**We are ~80% there** — Radix `Accordion` already powers "Advanced — field mapping" /
"Setup help" in `SourceEditor`, and there's an "Advanced" section + a `DangerZone`. Standardize
on what exists; add one small primitive.

**Rules (NN/g):**

1. **Exactly TWO tiers.** Default-visible vs one "Advanced" reveal. **Never 3+** (nested
   accordions tank usability). Audit `SourceEditor` for any second-level creep.
2. **Gate default-OFF pipeline features behind a head-of-section enable toggle.** Threshold
   tuning, LLM batch/flex, baseline, campaigns, event-detection are all pipeline-affecting
   and default OFF. Show the enable toggle (default OFF) at the section head; reveal detailed
   config only after enable. This protects novices from misconfiguring the engine (and is
   why these belong under a clearly-labeled `Advanced` / `Experimental` block, not sprayed
   across General).
3. **Danger Zone is visible-but-guarded, NOT hidden.** Kill switch, factory reset,
   revoke-all → distinct red block + type-to-confirm + `require_fresh_auth`. Hiding a safety
   control behind "Advanced" is *worse* than showing it guarded (GitHub/Stripe convention).
4. **Search/anchors must defeat disclosure.** A search match or a `SettingsTOC` click or a
   `&a=<anchor>` deep-link onto a collapsed card MUST auto-**expand** it before scrolling —
   otherwise disclosure hides capability (the core VS Code lesson). VS Code's `@tag:advanced`
   / "Commonly Used" is the model.
5. **Persist per-user disclosure state** in the existing `UserPrefsStore` (zero-migration KV)
   so an analyst who opens "Advanced" keeps it open across sessions; default new users
   collapsed.

**Primitives (no new heavy dep):**

- **Vendor `webui/src/ui/collapsible.tsx`** — Radix `@radix-ui/react-collapsible`, MIT,
  ~40 lines mirroring the existing `ui/accordion.tsx`. Use for single "Show advanced options"
  reveals inside a `SettingsCard`/form.
- **Keep `Accordion` for grouping SEVERAL rare sections**, and set **`type="multiple"`** for
  settings groups so opening one section doesn't collapse another the user is comparing.
- Build one reusable **`AdvancedDisclosure`** wrapper enforcing the WAI-ARIA Disclosure
  contract (real `<button aria-expanded aria-controls>`, region id, Enter/Space) — Radix gives
  this for free. Reuse the existing chevron affordance
  (`[&[data-state=open]>svg]:rotate-180`) and the accordion keyframes gated on
  `prefers-reduced-motion`.

**A11y note that matters:** put `aria-expanded` on the **trigger button**, never on the
region — WebAIM 2023 found 58% of expandable widgets get this wrong (Radix does it correctly;
don't hand-roll `div onClick`).

**Sources:** NN/g [Progressive Disclosure](https://www.nngroup.com/articles/progressive-disclosure/);
[W3C WAI-ARIA Disclosure pattern](https://www.w3.org/WAI/ARIA/apg/patterns/disclosure/);
[shadcn Collapsible](https://ui.shadcn.com/docs/components/radix/collapsible) /
[Accordion](https://ui.shadcn.com/docs/components/radix/accordion);
[VS Code settings](https://code.visualstudio.com/docs/getstarted/settings).

---

## 6. Search + deep-links (make the broad rail usable)

**Keep BOTH surfaces** (they're complementary, not redundant):

- **Inline rail filter INSIDE Settings** (VS Code model) — for focused reconfiguration.
- **Settings sections as jump targets in the global Cmd-K palette** (Linear/Raycast model) —
  for cross-app jumps. This is the *real* cross-product discovery mechanism.

The console already has: keyword-driven rail filter over `name/blurb/keywords`
(Settings.tsx:2353), deep-linkable sections via `#/settings?s=<id>` (2188/2220 + a passing
render test), per-card anchors (`SettingsCard id={anchor}`), an IntersectionObserver
scroll-spy TOC (`useActiveAnchor`, 434), and a mounted-once cmdk `CommandPalette`
(`shouldFilter={false}`, MIT, already vendored).

**Four gaps to close (all zero-dep):**

1. **Palette → section deep-link is broken.** `router.tsx pageFromHash` splits the hash on
   `/[?&/]/` (line 36) and the hashchange handler force-clears `opts` (line 56–59), so
   `navigate('settings', {section})` silently loses the section. **Fix:** don't route the
   section through transient nav `opts`; write the full hash directly —
   `window.location.hash = '#/settings?s=detection'` — which Settings.tsx already re-parses
   via `sectionFromHash()`. (Cleaner alt: teach the router to preserve a whitelisted `?s=`/
   `&a=` suffix for `settings`.) Add a Vitest mirroring the existing
   `settings.render.test.tsx` `#/settings?s=admin_users` case.
2. **Sections aren't registered as palette targets.** Lift `SECTION_GROUPS` + `keywords` out
   of Settings.tsx into a shared `soc/pages/settings-sections.ts` (single source of truth),
   import in BOTH the page and `CommandPalette`, add a **"Settings" CommandGroup** built from
   it, RBAC-filtered with the *same* `hasPermission()` so the palette never advertises a
   section a user can't open.
3. **No card-level deep-link.** Add `#/settings?s=detection&a=detection-autoclose`. Anchors
   already exist; `SettingsTOC` already `scrollIntoView()`s them. On mount/hashchange, parse
   optional `&a=`, `getElementById(a)?.scrollIntoView()` + a brief **highlight ring**
   (a `data-flash` class that fades — **not color-only**, respects `prefers-reduced-motion`).
   Guard the scroll with a post-render effect keyed on `section+anchor+loading` (the target
   card renders after the async prefs fetch).
4. **Inline filter is section-level only.** Deepen it to **setting-level**: build a flat index
   of individual controls (`label + help/keywords + section id + card anchor`); a query like
   `"objection window"` should list the CONTROL and deep-link to `?s=detection&a=…` + flash.
   Keep the grouped rail as the no-query default; switch to a flat results list when a query
   is present (VS Code behavior). Optionally add `@`-scoping: `@modified` (reuse the existing
   dirty set), `@advanced`/`@experimental` (tag those sections).

**Do NOT:** add `kbar` or a second command layer (redundant with cmdk — violates the no-new-
heavy-dep rule); build a bespoke deep-search when the palette is the documented mechanism;
let the inline filter grab Cmd-K (the global palette owns Cmd-K app-wide — make the inline
filter a plain always-visible input, optionally focusable with `/` when Settings is active);
encode any secret/`configured` boolean in a URL (URLs carry `?s=`/`&a=` ids only, #9).

**Sources:** [uxpatterns.dev command palette](https://uxpatterns.dev/patterns/advanced/command-palette);
[cmdk](https://www.npmjs.com/package/cmdk);
[VS Code settings search](https://code.visualstudio.com/docs/getstarted/settings);
in-repo: `Settings.tsx`, `CommandPalette.tsx`, `router.tsx`, `SettingsGrid.tsx`,
`ui/command.tsx`, `__tests__/settings.render.test.tsx`.

---

## 7. Cross-cutting implementation notes

- **Rules-of-Hooks:** the RBAC-visibility + section-jump `useMemo`s MUST stay above the
  `loading/!prefs` early returns (Settings.tsx:2340 comment) or React throws #310. Any new
  search/disclosure hooks must be hoisted the same way.
- **Stable ids:** rename display `label`s only; if an `id` must change, ship a redirect alias
  (deep links + the palette jump target both key on id).
- **Code-split per section** (`React.lazy` / route-level) so the broad rail doesn't bloat the
  initial SPA bundle — a bundle win, zero new deps.
- **Registry-of-truth:** drive the rail, hub cards, palette index, and search off one
  `settings-sections.ts` (+ the existing `GET /api/settings/schema`) so adding a setting is a
  single entry, not edits across nav + page + index.
- **Landing summaries** (Linear): each org group's landing can show a read-only summary
  (`3 sources · 12 users · 5 roles · budget $X/mo`) via existing `StatCard`/`KpiTile` before
  drill-in — situational awareness with no new dep.
- **Validate the regroup** with a lightweight card sort / tree test on the section labels
  (NN/g method) before shipping the rename — cheap insurance against "where would I look
  for X" mismatches.

---

## 8. Pitfalls checklist (things this design explicitly avoids)

- ❌ Top-level tabs (would overflow past 6 → carousels/hidden tabs).
- ❌ A third menu/dropdown level (nav-failure rates spike past two levels).
- ❌ Tabs for settings a user must compare across (taxes STM).
- ❌ Mixing in-page tabs with navigation tabs in one control.
- ❌ A "Miscellaneous"/dumping-ground section (force scope + named group; if it won't fit, the
  taxonomy is wrong — watch the "Experimental" group).
- ❌ Exposing all default-OFF engine toggles at once (progressive-disclose them).
- ❌ Destructive actions inline with routine settings (isolate the Danger Zone).
- ❌ A broad flat rail with no search/ordering (users miss the best option — NN/g).
- ❌ RBAC by greying/disabling (leaks admin-feature existence + dead links) — **remove whole
  groups** for roles that lack the grant; keep the `restricted()` placeholder only for
  high-value sections where discoverability matters.
- ❌ Losing scope context (always show the active scope chip + highlighted rail item).
- ❌ Mixing high-blast-radius credentials into cosmetic prefs (Secret keys → Security group).
- ❌ Adding a new dep when Radix Collapsible/Accordion + cmdk already cover it.

---

## 9. Sources (best-of)

**IA / grouping / flattening:**
[NN/g Flat vs Deep](https://www.nngroup.com/articles/flat-vs-deep-hierarchy/) ·
[NN/g Tabs Used Right](https://www.nngroup.com/articles/tabs-used-right/) ·
[NN/g Complex App Design](https://www.nngroup.com/articles/complex-application-design/) ·
[Statsig Settings 2.0](https://www.statsig.com/blog/settings-page-design-2025) ·
[setproduct Settings UI](https://www.setproduct.com/blog/settings-ui-design) ·
[techinterview scalable settings](https://www.techinterview.org/post/3233475401/build-settings-page-architecture-that-scales/)

**Reference products:**
[Linear sidebar redesign](https://linear.app/changelog/2024-12-18-personalized-sidebar) ·
[GitHub org settings](https://docs.github.com/en/organizations/managing-organization-settings) ·
[Stripe dashboard](https://docs.stripe.com/dashboard/basics) ·
[Notion workspace settings](https://www.notion.com/help/workspace-settings) ·
[Slack admin dashboard](https://slack.com/help/articles/115005594006-Guide-to-the-Slack-admin-dashboard) ·
[Vercel accounts](https://vercel.com/docs/accounts)

**Progressive disclosure + search + a11y:**
[NN/g Progressive Disclosure](https://www.nngroup.com/articles/progressive-disclosure/) ·
[W3C WAI-ARIA Disclosure](https://www.w3.org/WAI/ARIA/apg/patterns/disclosure/) ·
[VS Code Settings](https://code.visualstudio.com/docs/getstarted/settings) ·
[shadcn Collapsible](https://ui.shadcn.com/docs/components/radix/collapsible) ·
[cmdk](https://www.npmjs.com/package/cmdk) ·
[uxpatterns command palette](https://uxpatterns.dev/patterns/advanced/command-palette)

**In-repo anchors:** `webui/src/soc/pages/Settings.tsx` (SECTION_GROUPS ~172, sectionFromHash
2188, hash sync 2220, RBAC useMemo 2348) · `webui/src/soc/components/SettingsGrid.tsx` ·
`webui/src/soc/components/CommandPalette.tsx` · `webui/src/soc/router.tsx` (pageFromHash 34,
opts-clear 56) · `webui/src/ui/command.tsx` · `webui/src/soc/__tests__/settings.render.test.tsx`.
