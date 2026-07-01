# RESEARCH — Loose Coupling Patterns (Round 5 / P2)

> **Scope.** Concrete, incremental migration toward *looser coupling* across the TLSOC
> Agentic Triage Suite: (A) frontend feature slices + a feature registry, (B) backend
> router decomposition + broader SPI/entry-point registries, (C) FE↔BE contract sync via
> OpenAPI codegen. Every recommendation is chosen to be **additive, low-churn, and
> dep-conservative** — the same discipline the codebase already follows (ZERO new runtime
> deps across Rounds 1–4). Dev-only tooling is called out explicitly and justified.
>
> **Verified against the tree (2026-07-01).** The specific numbers below were checked, not
> assumed:
> - `webui/src/lib/types.ts` = **2047 lines** hand-maintained (mirror of `models.py`).
> - `backend/app/api/routes.py` = **4751 lines**, **124 endpoints** across ~40 path domains.
> - **0** `response_model=` across `backend/app/api/` (grep confirmed).
> - Chart lib is **recharts `^2.15.4`** (real dep) wrapped by `charts.tsx` + `charts-soc.tsx`.
> - ESLint = **flat config v9** (`eslint.config.js`) with `typescript-eslint` +
>   `eslint-plugin-react-hooks`; **no import/boundary plugin yet**.
> - Path alias `@/*`→`./src/*` already wired in `tsconfig.json` (verify Vitest/ESLint resolvers).
> - `main.py` already runs a **partial router loader** — a hardcoded tuple of 14 feature
>   routers mounted uniformly with `dependencies=[Depends(require_auth)]` (line ~84–99).
> - `FastAPI(...)` has **no `generate_unique_id_function`** yet.
> - Entry-point discovery (`importlib.metadata.entry_points`) exists in exactly **2**
>   subsystems: `connectors/registry.py` (178 LOC) + `enrichment/registry.py` (158 LOC).
> - `PROVIDER_REGISTRY` (LLM), `BATCH_PROVIDER_REGISTRY`, notification channels
>   (`@register_channel` + `_BUILTINS_LOADED` flag), and `ToolRegistry` are **hard-coded /
>   decorator-only — no entry-point discovery.**

---

## 0. TL;DR — the opinionated plan

**Do these, in this order. Each row is independently shippable and keeps the green baseline.**

| # | Change | Layer | Churn | New dep | Payoff |
|---|--------|-------|-------|---------|--------|
| 1 | Backend: clean `operationId`s (`generate_unique_id_function` + per-router tags) | BE | tiny (1 edit) | none | readable codegen names; prereq for #2/#7 |
| 2 | FE: `openapi-typescript` (dev-dep) → generate **request/enum/shared-model** types; re-export from `types.ts` | FE contract | low | 1 **dev**-dep | kills the drift risk on well-typed shapes |
| 3 | FE: one typed `FEATURES[]` registry → derive nav + routes + palette (delete the 3-table drift) | FE | medium (App-only first) | none | kills nav/route/palette drift class |
| 4 | FE: replace `onNavigate` prop-drill (31 pages) with `useNavigate()` from router context | FE | medium (mechanical) | none | removes navigate from every page signature |
| 5 | BE: extract ONE generic `EntryPointRegistry[T]`; re-express connectors + enrichment on it | BE | low | none | collapses ~120 LOC dup; single place for version gate |
| 6 | BE: split `routes.py` (4751 LOC / 124 eps) into ~10–12 feature routers, **one slice/PR** | BE | high (spread over PRs) | none | ends the monolith; thin handlers |
| 7 | BE: add `response_model=` to the ~10–15 highest-churn endpoints → unlock **response** codegen | BE contract | medium | none | flips generated response types from `unknown`→real |
| 8 | FE: ESLint boundary rule (`eslint-plugin-import-x` no-restricted-paths), **warn→error per feature** | FE | low | 1 **dev**-dep | mechanically enforces slice boundaries |
| 9 | BE: add entry-point discovery to notifications + LLM providers (`tlsoc.channels`, `tlsoc.llm_providers`) | BE | low | none | third-party `pip install` detachability |
| 10 | FE contract: CI **git-diff gate** (regen types, fail on diff) | CI | tiny | none | makes drift impossible to merge silently |

Rows 1–5 are the **low-churn wins**; do them first. Row 6 is the big one — sliced across PRs.
Rows 7–10 harden. Skip everything runtime-heavy (Module Federation, TanStack Query unless
justified, pluggy/stevedore) — see §5 "What NOT to do".

---

## A. Frontend — feature slices + a feature registry

### A1. Adopt **bulletproof-react-style feature folders**, NOT full 7-layer FSD

Two conventions dominate feature-modular React:

- **Feature-Sliced Design (FSD)** — a formal 7-layer methodology
  (`app → pages → widgets → features → entities → shared`), per-domain *slices*,
  *segments* (`ui/api/model/lib/config`), strict downward-only imports, and a per-slice
  public-API `index.ts`. Rigorous and self-documenting, with an official linter (Steiger).
  **But** `widgets`/`entities`/`processes` are ceremony this ~40-page console does not need.
- **bulletproof-react** — lighter: `src/app` + `src/features/<name>/{api,components,hooks,stores,types}`
  + shared `src/components|hooks|lib|utils`. Enforces the **two invariants that actually pay
  off**: (a) *no cross-feature imports*, (b) *unidirectional flow* `shared → features → app`.

**Recommendation: bulletproof-react layout.** The webui already has the seeds:
co-located `*.api.ts` builders (`CaseDetail.api.ts`, `Tuning.api.ts`, `Campaigns.api.ts`,
`Models.api.ts`, `Baseline.api.ts`, `Batch.api.ts`, `Roles.api.ts`, `Inbox.api.ts`,
`Metrics.posture.api.ts`, `Standup.report.api.ts`, `UnifiedLogs.api.ts`, `DangerZone.api.ts`)
= de-facto feature `api/` segments, and a clean 3-tier layering to formalize:
`src/ui/*` (shadcn primitives) → `src/soc/components/*` (domain shared) → `src/lib/*` (infra).

**Target layout:**

```
webui/src/
  app/            # shell/router/nav/theme/auth providers (today: soc/{App,AppShell,router,nav,theme,auth}.tsx)
  features/
    cases/{ui/, api/, model/, index.ts}
    sources/{ui/, api/, index.ts}
    ...
  shared/  (or KEEP src/lib)   # api client, cn, format, types, useEventStream — cross-feature infra
  ui/             # shadcn/Radix primitives — UNCHANGED, stays at bottom of the graph
  styles/theme.css + soc/components/palette.ts   # design tokens — UNCHANGED
```

> Keep the design system **exactly where it is**. `src/ui/*` + `styles/theme.css` +
> `palette.ts` + `charts.tsx`/`charts-soc.tsx` (recharts wrappers) are the shared/bottom
> layer — importable by everyone, pushed into **no** feature. Charts wrappers → `shared/charts`
> (or leave in `soc/components`); do not fork them into features.

### A2. SOC-domain feature slices (mapping today's flat tree)

Concrete slices from the current `pages/` + `components/` tree:

| Feature | Pages / components to move in |
|---------|-------------------------------|
| `cases` | `Cases.tsx`, `CaseDetail.tsx`+`CaseDetail.api.ts`, `CaseThread`, `CaseTasks`, `CaseActivityFeed`, `CaseTriageHeader`, `CaseHoverCard`, `TraceTimeline`, `Workspace.tsx` |
| `sources` | `Sources.tsx`, `Catalog.tsx`, `SourceEditor`, `SourceLogsSheet`, `ConnectorPicker`, `lib/connectors.ts`, `UnifiedLogsSheet`+`UnifiedLogs.api.ts` |
| `cost` | `Cost.tsx`, `Models.tsx`+`Models.api.ts`, `ModelsCatalog`, `BudgetCard`, `BatchJobs.tsx`+`Batch.api.ts` |
| `tuning` | `Tuning.tsx`+`Tuning.api.ts`, `Baseline.tsx`+`Baseline.api.ts`, `Campaigns.tsx`+`Campaigns.api.ts` |
| `metrics` | `Metrics.tsx`+`Metrics.posture.api.ts`, `Analytics.tsx`, `Standup.tsx`+`Standup.report.api.ts`, `Overview.tsx`, `Home.tsx`, `charts-soc` |
| `settings`/`admin` | `Settings.tsx`, `Users.tsx`, `Roles.tsx`+`Roles.api.ts`, `Security.tsx`, `Sessions.tsx`, `AdminSessions.tsx`, `Account.tsx`, `Approvals.tsx`, `DangerZone`+`DangerZone.api.ts`, `Audit.tsx` |
| `auth` | `Login.tsx`, MFA components, `soc/auth.tsx`, `Wizard.tsx` |
| `chat` | `Chat.tsx`, `Investigate.tsx`, `ChatPanel` |
| `notifications` | `Inbox.tsx`+`Inbox.api.ts`, `NotificationBell`, `NotificationsEditor` |
| `knowledge` | `Knowledge.tsx`, `Memory.tsx`, `Intelligence.tsx`, `Scans.tsx` |

Each becomes `src/features/<x>/index.ts` — the **only** public entry (see A3).

### A3. `index.ts` as the single public API per feature (the one load-bearing rule)

Inside a feature, files import each other by relative path. **All other features/app import
only `@/features/cases`** — never `@/features/cases/ui/CaseThread`. This is FSD's public-API
rule / bulletproof-react's enforced invariant. It creates a **refactor firewall**: move files
freely inside a feature as long as `index.ts` is stable.

- Keep each `index.ts` a **thin, explicit** re-export of only the public surface (pages, a few
  components, public types). **Do NOT** create a mega `src/features/index.ts` re-exporting
  everything — it defeats tree-shaking and invites import cycles (matters less on Vite, but
  keep the public surface reviewable in PRs).
- `soc/components/*` becomes a temporary "unsorted shared" bucket; **drain it feature-by-feature.**
  Only promote to `shared`/`lib` what **3+** features actually use.

### A4. Enforce boundaries mechanically (conventions erode without a linter)

You are on **flat config v9** with `typescript-eslint` + `eslint-plugin-react-hooks`, and
**no import plugin**. Add one **dev-only** enforcer (pick ONE — do not run two):

- **`eslint-plugin-import-x`** (maintained flat-config-native fork of `eslint-plugin-import`)
  → rule `import-x/no-restricted-paths` with bulletproof-react zones: block feature→feature
  (target each feature from `./src/features`, except its own dir) and enforce direction
  (features cannot import `app`; shared cannot import `features`/`app`). **Simplest; verbose as
  features grow.** Recommended starting point.
- **`eslint-plugin-boundaries`** — tag each folder with an element type
  (`feature`/`shared`/`app`/`ui`) once, then declare an allow-list of type→type imports.
  **Scales better past ~8–10 features** (conceptually identical to Nx `@nx/enforce-module-boundaries`
  tags). Use this if you expect the feature count to grow.

**Roll-out: `warn` first, flip to `error` per feature as it is carved out.** A global `error`
on day one red-walls all ~40 pages and pressures `// eslint-disable`.

> **Resolver gotcha:** the `@/*` alias is resolved by Vite + tsconfig, but **Vitest and the
> ESLint import resolver must also know it** or the boundary rule silently no-ops. Verify
> `eslint-import-resolver-typescript` (or the flat-config resolver settings) + the Vitest alias
> when wiring the plugin.

**Optional safety net:** `dependency-cruiser` (dev-dep) can both assert "no feature→feature" in
CI and render an SVG of the module graph so you can *see* remaining cross-feature edges
mid-migration. Nice-to-have, not required. (`steiger` is the official FSD linter — only worth it
if you fully commit to FSD's layer taxonomy, which we are **not**.)

### A5. A single **feature registry** to kill the 3-table drift

Today three parallel tables must be kept in sync by hand — the drift source:

1. `nav.ts` — `NAV_GROUPS` / `NAV_ITEMS` (declarative, has `perm` RBAC gates).
2. `App.tsx` — ~35 `React.lazy(() => import('./pages/X'))` declarations **+** a ~90-line
   `renderPage` switch.
3. `router.tsx` / `nav.ts` — the `PageId` union + `HIDDEN_ROUTE_IDS` manual bookkeeping.

**Bug class this causes (observed in the tree):** a page can be code-split but missing from nav,
or dropped from nav yet still deep-linkable via a stale hash (e.g. `#/tuning`).

**Fix — ONE typed registry** at `webui/src/soc/features/registry.ts`:

```ts
interface FeatureModule {
  id: PageId;
  route: { element: React.LazyExoticComponent<React.ComponentType> };
  nav?: { group: NavGroupId; label: string; icon: LucideIcon; parent?: PageId; order?: number };
  perm?: NavPerm;                       // RBAC grant (existing shape)
  enabled?: (ctx: FeatureCtx) => boolean; // capability predicate — see A6
}
export const FEATURES: FeatureModule[] = [ /* one entry per feature/page */ ];
```

- **Derive** `NAV_GROUPS`, the router's `PageId` set, and the Cmd-K palette entries **from
  `FEATURES`** — stop hand-maintaining three tables.
- **Replace** the `renderPage` switch (a textbook "if-else hell → registry" refactor):
  ```ts
  const feature = FEATURES.find(f => f.id === page);
  const El = feature?.route.element; // render inside the existing <Suspense>
  // unknown/disabled → fall through to Overview (same as router.tsx pageFromHash today)
  ```
- **Keep icons as lucide component refs** (not string keys) — `nav.ts` already stores component
  types precisely to avoid a string→icon lookup.
- **Keep `element` a `LazyExoticComponent`** so per-route code-splitting is preserved (do NOT
  switch to eager imports while refactoring the switch — it bloats the initial bundle).
- **Encode deep-link behaviors as explicit entries** (host pages with pre-selected tabs, e.g.
  `playbooks → Intelligence#catalog`, and hidden-but-routable fallbacks) so nav semantics don't
  regress.

**Migration is non-breaking:** build `FEATURES`, have `nav.ts`'s `NAV_GROUPS` and `App.tsx`'s
switch **derive** from it *behind the current exports* (`NAV_ITEMS`, `PAGE_IDS` keep their
signatures) — one PR, no consumer changes. Delete the hand-written tables in a follow-up PR.

### A6. Capability flags as a **predicate** (VS Code `when`-clause idea)

`enabled?(ctx: { hasPermission; prefs; demoMode })` is evaluated **once** in the shell and MUST
feed **nav visibility + route resolution + palette** from that one evaluation. This structurally
prevents the "gated in nav but reachable by deep-link / still in Cmd-K" drift.

- Round-4 tuning/campaigns/baseline/batch are already default-OFF in `Preferences` — gate their
  `FEATURES` entry with e.g. `enabled: ctx => ctx.prefs.threshold_tuning.enabled`. Fetch toggles
  from the existing `/api/prefs/effective` (or `/api/settings/schema`) at boot into a small React
  context; the registry reads it. **No backend change.**
- **Keep the three axes distinct** — do NOT collapse into one boolean: RBAC grant
  (`hasPermission` → your *Unauthorized* view: "exists but you lack permission"), backend feature
  toggle (`prefs` → *hidden entirely*), and demo-mode. Conflating them loses the "exists vs
  disabled" distinction.

### A7. Decouple pages from the API client + from `App` (DI, not more props)

- **Stop prop-drilling `navigate`.** Pages already run under `<RouterProvider>`; replace the
  `onNavigate` prop (**31 pages**) with the existing `useNavigate()` hook. Keep `onNavigate` as
  an *optional* prop only where a page is embedded/tested in isolation.
- **Client via DI for testability.** Expose the singleton `api` through a tiny `ApiProvider` /
  `useApi()` context (default provider value = the existing singleton, so nothing breaks; tests
  inject a fake). **Preserve all cross-cutting behavior inside that one client** —
  `credentials:'include'`, `ApiError`, `setUnauthorizedHandler`, the reauth-retry — so pages
  never re-implement it. **Do NOT** turn Context into a *state* store (the Context perf trap):
  Context = DI (client / navigate / theme / auth); server state stays in the `.api.ts` layer;
  personal state stays in the prefs store.

### A8. Data layer — standardize on co-located `.api.ts`; TanStack Query is *optional*, justify it

The `.api.ts` builder pattern is the right seam and already half-adopted (12 files). Two paths:

- **Zero-runtime-dep path (default given the constraint):** keep the thin `request()` layer;
  every page gets a sibling `<Page>.api.ts` typed builder over `api.get/post`. Standardize the
  28 pages that import `@/lib/api` directly to go through their builder. You still get the
  consistency + testability win with **no new runtime bytes**.
- **TanStack Query path (`@tanstack/react-query`, ~13KB gz, one real runtime dep + a provider):**
  removes hand-rolled loading/error/refetch, dedup, cache invalidation; wrap each `.api.ts`
  builder in `useQuery`/`useMutation`; retrieve the `QueryClient` via hook (not a global) for
  testability. **This violates the "no new runtime deps" default** — adopt **only** with a
  deliberate decision recorded in `Journal.md`/`ROADMAP.md`. If unacceptable, do NOT adopt it;
  the builder path above delivers ~80% of the value at 0 bytes.

---

## B. Backend — router decomposition + broader SPIs

### B1. Split `routes.py` (4751 LOC, 124 endpoints, ~40 domains) — package-by-feature

The community consensus (zhanymkanov `fastapi-best-practices`, Netflix Dispatch) is
**package-by-feature**, *not* package-by-layer. You already do the right thing for **15 feature
routers** (each exposes `router`, mounted with `dependencies=[Depends(require_auth)]`). This is a
**completion + consistency job**, not a rewrite. Given app size, the **flat
`routes_<feature>.py`** variant you already run is the correct altitude — do **not** explode into
per-feature `{router,service,schemas,deps,models,constants,exceptions}.py` × 40.

**Carve `routes.py` by top-level path prefix into ~10–12 routers:**

| New router | Endpoints (approx) |
|------------|--------------------|
| `routes_cases.py` | cases (~17) |
| `routes_auth.py` | auth + sessions + account (~24) |
| `routes_sources.py` | sources + connectors + ingest + logs (~15) |
| `routes_rag.py` | rag + memory + knowledge (~11) |
| `routes_prefs.py` | prefs + views + terminology (~13) |
| `routes_settings.py` | settings + branding (~7) |
| `routes_playbooks.py` | playbooks + proposals + scans (~8) |
| `routes_chat.py` | chat + investigate + overview + standup (~4) |
| `routes_demo.py` | demo (4) |
| `routes_misc.py` | personas + runbooks + feedback + threat (small) |

Each = `router = APIRouter(prefix="/api")` (or a sub-prefix like `/api/cases`), matching the 15
existing routers.

**Behavior-preserving slices, one feature per PR:**
1. Cut the endpoints **+ their local Pydantic models + helpers** into `routes_<feature>.py`
   (models must move **with** their handlers — leaving them imported back from `routes.py`
   recreates the coupling and risks cycles).
2. Add the import + `include_router(..., dependencies=[Depends(require_auth)])`.
3. Run `pytest -q` (**must stay green at 1461**) after **each** slice. Paths stay
   **byte-identical** → the webui/nginx `/api` proxy contract and `types.ts` are untouched
   (additive/path-stable is safe per CLAUDE.md).

### B2. Thin handlers (parse → delegate → return)

Many handlers embed business logic today. Push it into the **existing service layer**: `AppState`
+ the `*_service` objects (`pipeline`, `ingest_service`, `standup_service`, `overview_service`)
+ `stores/` (repository half). A router should call `state.<service>.do(...)` and return. This
**keeps the deterministic engine and `decide()` out of the HTTP layer — protecting
non-negotiable #3.** (Sharding the monolith into fat handlers is only sharding, not decoupling.)

### B3. Cut `Depends` boilerplate with `Annotated` aliases (deps.py)

```python
State = Annotated[AppState, Depends(get_state)]
RequireCasesView = Annotated[None, Depends(require_permission("cases:view"))]
```
Then `async def list_cases(state: State)` instead of the repeated
`state: AppState = Depends(get_state)` across 124 handlers. Pure mechanical win, no dep. Also add
a per-feature **dependency-as-validator** (`valid_case_id(case_id) -> Case` that 404s once,
reused across the ~17 cases endpoints) — FastAPI caches a dependency result within one request.

### B4. Finish the router **loader** (it already exists, partially)

`main.py` already loops a **hardcoded tuple** of 14 feature routers, mounting each uniformly with
`require_auth`. Upgrade it to a **deterministic auto-discovery loader** so "add a feature" = "drop
a `routes_*.py` file":

```python
import pkgutil, importlib
from . import api as api_pkg
for _, name, _ in sorted(pkgutil.iter_modules(api_pkg.__path__)):  # SORTED = deterministic order
    if not name.startswith("routes_"):        # allowlist convention
        continue
    mod = importlib.import_module(f"{api_pkg.__name__}.{name}")
    router = getattr(mod, "router", None)
    if router is not None:
        app.include_router(router, dependencies=[Depends(require_auth)])  # UNIFORM auth mount
```

**Invariants (non-negotiable):**
- **SORT** module names — `pkgutil` order is filesystem-dependent.
- **RAISE** on import failure — do NOT print+skip (the common Medium example swallows errors; a
  broken feature must fail loudly at boot).
- The loader **must apply `dependencies=[Depends(require_auth)]` uniformly** — a router mounted
  without it silently de-auths its endpoints.
- Keep `PUBLIC_API_PATHS` / `PUBLIC_GET_PATHS` / ingest-regex in `deps.py`, and rely on the
  existing **`test_route_auth_coverage`** test as the tripwire (it already fails if any `/api`
  route bypasses auth or any non-GET lacks a `require_permission` gate). Run it after every slice.

### B5. Clean `operationId`s (prereq for good codegen)

In `main.py`, pass `FastAPI(generate_unique_id_function=custom_generate_unique_id)` where the fn
is e.g. `f"{route.tags[0]}-{route.name}"`, and ensure each router carries a stable `tags=[...]`.
This makes generated client method/type names read like `cases-list` instead of
`list_cases_api_cases_get`, and prevents a rename storm on the FE later. One small edit; do it
**before** the first codegen run (§C).

### B6. Extract ONE generic `EntryPointRegistry[T]` (enabling refactor)

`connectors/registry.py` (178 LOC) and `enrichment/registry.py` (158 LOC) copy the same logic
verbatim: `register()` (with an "overridden by" log), `get()`, `manifests()` (per-item try/except
so one bad plugin can't break listing), `_discover(group)` (`importlib.metadata.entry_points(group=...)`
+ `ep.load()` + warn-on-failure), and a lazy singleton. Factor into
`app/plugins/registry.py`:

```python
class EntryPointRegistry(Generic[T]):
    def __init__(self, group: str, key_attr: str, spi_type: type[T]): ...
    def register(self, impl): ...          # with "overridden by" log + intentional precedence
    def get(self, key) -> T: ...
    def manifests(self) -> list[Manifest]: # per-item try/except
    def _discover(self) -> None:           # entry_points(group=...) + ep.load() + warn-on-fail
```

Re-express both existing registries on top of it — **byte-identical behavior**, ~120 LOC of
duplication collapse to one tested helper. This is the enabler for B7. **Prefer stdlib
`importlib.metadata` over pluggy/stevedore** — every feature you'd want is already ~40 LOC per
registry, and both frameworks are new runtime deps (violates the constraint).

**Add a version-compat gate** — the one production-essential the current registries lack: put an
`api_version` on each `*Manifest` (`ProviderManifest.version` already exists) and in `_discover`,
**skip + warn** on any entry point whose declared major API version ≠ core `PLUGIN_API_VERSION`.
~6 lines; prevents a stale third-party plugin loading against an incompatible SPI and blowing up
deep in a request.

### B7. Add entry-point discovery to more subsystems (detachability)

Highest-value → lower:

1. **Notification channels** — keep `@register_channel` + `_load_builtins()` for built-ins (keep
   the `_BUILTINS_LOADED` flag pattern — you already hit + fixed the partial-registry bug), but
   add a `tlsoc.channels` group and call `_discover("tlsoc.channels")` inside `ensure_registered()`.
   Then `pip install tlsoc-channel-opsgenie` appears in the catalog with zero core change — just
   like connectors. Declare built-ins under `[project.entry-points."tlsoc.channels"]` in
   `pyproject.toml` so in-tree + third-party load through one path.
2. **LLM `PROVIDER_REGISTRY`** — wrap the hard-coded name→factory dict with a
   `tlsoc.llm_providers` group; keep built-in anthropic/openai/azure/bedrock/vertex/mock factories
   in-tree (byte-identical `_provider_kwargs` path) and *merge* discovered ones. A discovered
   provider that can't construct still fails cleanly at call time. **Do NOT touch the gateway's
   single-ledger-write choke point (#6)** — providers return raw completions to the gateway; they
   never write `UsageDoc`s themselves. (Mirror for `BATCH_PROVIDER_REGISTRY` if desired.)
3. **State store + OCSF mapper (follow-on wave, more invasive):** today `state_backend` is a hard
   `if/elif` and OCSF mapping is fixed functions. Define a `StateStoreFactory` SPI and an
   `OcsfMapper` SPI (`classmethod handles(source_type)` → `to_ocsf(record)`), keyed registries,
   then optional `tlsoc.state_backends` / `tlsoc.ocsf_mappers` groups. Biggest coupling win for
   OCSF (per-vendor mappers become `pip install`-able) — **schedule separately**, not the first cut.

**Standardize group naming + document it:** `tlsoc.connectors`, `tlsoc.enrichers` (keep the
existing name for back-compat), `tlsoc.channels`, `tlsoc.llm_providers`, `tlsoc.ocsf_mappers`,
`tlsoc.state_backends`. Add a short "Writing a TLSOC plugin" doc (pyproject snippet + the SPI ABC).

**Do NOT** add discovery to subsystems that only ever have **one implementation per key** with a
hook framework — a keyed registry is the right altitude. Reserve **pluggy** strictly for a future
*true hook pipeline* (many plugins contributing to one multi-stage event, e.g. pre/post-investigate
hooks) — the only shape the registry pattern handles poorly.

**Discovery invariants:** one bad plugin must never break startup/listing (preserve the
try/except-with-warning in the generic refactor); keep a **stable sort** so discovery never
changes deterministic ordering (enrichment already sorts by name — #4-adjacent); make built-in-vs-
third-party precedence **explicit and documented**, not load-order-dependent; a third-party
plugin must still go through the gateway (#6) and the UNTRUSTED fencing (#9) — the SPI boundary
should make that structurally unavoidable.

---

## C. Contract sync — OpenAPI codegen (FE types ← BE Pydantic)

**Verdict: adopt `openapi-typescript` — incrementally, with a prerequisite.** FE/BE type sync via
OpenAPI codegen is the 2025–2026 default for FastAPI + React (FastAPI documents it officially).
`openapi-typescript` is the right tool here because the webui uses a **plain typed fetch wrapper**
(no React Query/SWR/axios) — a **types-only** generator fits without pulling a client runtime or
hooks. It is **dev-dep only; types are stripped at build → 0 runtime bytes** (satisfies the "no
heavy npm deps" constraint).

### C1. The hard prerequisite (or codegen is near-worthless for responses)

Endpoints return `dict[str, Any]` with **0 `response_model=`** across `backend/app/api/`
(grep-confirmed). FastAPI therefore emits **empty response schemas** → generated response bodies
would be `unknown`/`Record<string,never>`, no better than the 2047-line hand-mirror. **Request
bodies ARE well-typed** (Pydantic `body:` params like `BulkCaseAction`) and generate cleanly today.

### C2. Phased adoption

- **Phase 0 — backend `operationId`s** (§B5): do first so generated names are readable.
- **Phase 1 (immediate, low effort):** add `openapi-typescript` as a **devDependency** + an npm
  script `gen:types` that reads a **committed** `openapi.json` (dump statically — see C3) into
  `webui/src/lib/api-types.gen.ts`. Immediately get correct types for **all request bodies + enums
  + shared models** (`UserRole`, `CaseStatus`, `Disposition`, `Verdict`, `BulkCaseAction`, …).
  Re-export the generated types from `lib/types.ts` and **delete the hand-written duplicates
  interface-by-interface**, keeping named aliases so `import type { Case } from '@/lib/types'`
  keeps working. Do **not** big-bang `delete types.ts` — `openapi-typescript` emits
  index-signature-heavy `paths`/`components` types and a one-shot delete explodes `tsc`.
- **Phase 2 (incremental, high value):** add `response_model=` to the ~10–15 highest-churn /
  most-consumed endpoints first — `/api/cases` (list+detail), `/api/sources`, `/api/metrics`,
  `/api/settings`, `/api/health`. Each flips that endpoint's generated response type from
  `unknown` → a real interface; migrate the matching hand-written interface to re-export the
  generated one. Endpoints that genuinely return dynamic/loose JSON (settings schema, search,
  some dict blobs) may **never** get a clean `response_model` — keep those as hand-typed shims.

### C3. Offline-safe generation + CI drift gate

- **Dump `openapi.json` statically** (a tiny script that imports `app` and writes `app.openapi()`
  to a file) — do NOT depend on a running stack; this sandbox blocks the full stack and the webui
  build must work offline (CLAUDE.md §6a).
- **Commit** both `openapi.json` and `api-types.gen.ts` — PR diffs then show contract changes, and
  `vite build` never needs a live backend.
- **CI git-diff gate** (the whole point — kills silent drift): in `.github/workflows/ci.yml`, add
  a step that regenerates and runs `git diff --exit-code webui/src/lib/api-types.gen.ts` — fail the
  build if regeneration changed the committed file. This directly enforces the existing
  "keep `types.ts` in sync with `models.py`" rule in CLAUDE.md.

### C4. Tool choice — why `openapi-typescript`, not the alternatives

| Tool | Output | Fit here |
|------|--------|----------|
| **`openapi-typescript`** | types only, 0 runtime | ✅ **BEST** — matches the existing fetch wrapper, dev-dep only |
| `@hey-api/openapi-ts` | types + SDK functions + optional TanStack Query | FastAPI-blessed, but generates a `src/client/` runtime that duplicates your `api.ts` + 12 `.api.ts` builders — reserve for a greenfield rewrite |
| `openapi-fetch` (companion) | ~6KB typed fetch wrapper | viable middle path if you later want typed call-sites; still a tiny runtime dep |
| Orval | functions + React-Query/SWR hooks + MSW mocks (~2600 files) | no React Query in repo; default client doesn't throw on 4xx/5xx (footgun) — no fit |
| Kubb | operation-level split (~3877 files) | heaviest, 12× slower gen — overkill |
| openapi-generator (Java) | polyglot | JVM in CI, verbose — overkill for a TS-only need |

### C5. The Pydantic-v2 nullability gotcha (test before trusting)

Pydantic v2 renders `Optional[T]` as `anyOf: [{...}, {type: null}]` and drops it from `required`;
`openapi-typescript` maps that to `T | null` + optional `?`. Where the backend **omits** a key vs
**sends explicit null** inconsistently, generated `?` vs `| null` will mismatch reality — the #1
FastAPI-codegen friction point. Confirm on a few models (e.g. `Case` with optional
`assignee`/`tags`) before trusting output. Also watch for **duplicate schema names across routers**
(same class name in different modules) — FastAPI appends suffixes → confusing generated names;
another reason to add `response_model`s + clean `operationId`s deliberately.

---

## 4. Sequenced migration plan (each step protects the green baseline)

**Wave 1 — low-churn, no runtime dep (do together):**
1. BE `generate_unique_id_function` + per-router tags (§B5). *Backend edit; `pytest -q` green.*
2. FE `openapi-typescript` dev-dep + `gen:types` + commit `openapi.json`/`api-types.gen.ts`;
   swap request/enum/shared types (§C2 Phase 1). *No page changes; `tsc` clean.*
3. FE `FEATURES[]` registry deriving nav+routes+palette **behind existing exports** (§A5).
   *App-only first; `vitest` green.*
4. FE `useNavigate()` replacing `onNavigate` prop-drill (31 pages) (§A7). *Mechanical.*
5. BE extract generic `EntryPointRegistry[T]`; re-express connectors+enrichment (§B6). *Byte-identical.*

**Wave 2 — router decomposition (spread across PRs):**
6. Upgrade `main.py` to a deterministic auto-discovery loader (§B4).
7. Split `routes.py` **one feature per PR** (§B1–B3): cut endpoints+models+helpers → thin handler →
   `Annotated` aliases → `pytest -q` (1461) + `test_route_auth_coverage` after each slice.
8. Extract shared helpers to `api/_common.py` (query building, `entity_query`, `scope_filters`) —
   don't copy-paste into each feature router.

**Wave 3 — harden + detachability:**
9. FE ESLint boundary rule (`eslint-plugin-import-x` no-restricted-paths), **warn → error per
   feature** as each slice lands (§A4). Verify Vitest/ESLint alias resolvers.
10. BE add `response_model=` to top ~10–15 endpoints → unlock response codegen (§C2 Phase 2).
11. BE entry-point discovery for notifications + LLM providers (§B7).
12. CI git-diff drift gate for generated types (§C3); optional `dependency-cruiser` graph check.

**Deferred (own wave, more invasive):** State-store + OCSF-mapper SPIs (§B7.3); TanStack Query
(§A8) *only if* the runtime dep is deliberately approved.

---

## 5. What NOT to do (pitfalls + rejected options)

- **No big-bang rewrite** — FE (all ~40 pages/60 components) or BE (all 124 endpoints) at once
  churns every import, breaks `git blame`, stalls for weeks. Strangler-fig, one slice/PR, CI-gated.
- **No runtime plugin loader** (Module Federation / dynamic `import(url)`) for **first-party**
  code — arbitrary-code-execution surface, breaks TS type-safety at the boundary, build complexity;
  buys nothing over compile-time `React.lazy` for a single bundle. Runtime `import(url)` is for
  *untrusted third-party* plugins only.
- **No full 7-layer FSD** — `widgets`/`entities`/`processes` + empty `ui/api/model/lib/config`
  segments for tiny features = folders with one file each. Only create a segment with real content.
- **No global `error` on the boundary rule day one** — red-walls the app, invites
  `// eslint-disable`. `warn` → `error` per feature.
- **No mega barrel `src/features/index.ts`** — defeats tree-shaking, invites import cycles. Thin,
  explicit per-feature `index.ts`.
- **No pushing the design system into a feature** — `src/ui/*`, tokens, `palette.ts`, recharts
  wrappers are SHARED at the bottom of the graph; pushing them into a feature creates upward
  imports and breaks the unidirectional rule.
- **No shared-bucket sprawl** — only promote to `shared`/`lib` what **3+** features use.
- **No two boundary enforcers** — running `import-x/no-restricted-paths` AND
  `eslint-plugin-boundaries` (AND steiger) = duplicate/conflicting errors + slow lint. Pick ONE.
- **No forgotten test/fixture co-location** — `__tests__` + `.api.ts` specs move WITH the feature.
- **No pluggy/stevedore** — new runtime deps; the ~40-LOC stdlib `importlib.metadata` registry
  already covers discovery + enabled-filtering + load-failure isolation + driver selection.
- **No TanStack Query without a deliberate decision** — it is a real runtime dep + a provider
  (violates the default); the `.api.ts` builder path gives ~80% of the value at 0 bytes.
- **No fat handlers post-split** — if you shard files but keep business logic in handlers you've
  only sharded the monolith; push logic into `AppState`/services so `decide()`/#3 stays out of HTTP.
- **No swallowed import errors in the loader** — RAISE, don't print+skip; SORT for determinism.
- **No dropped `require_auth` on a moved router** — the loader must mount it uniformly; keep
  `test_route_auth_coverage` as the tripwire.
- **No big-bang `types.ts` delete** — migrate interface-by-interface with re-export aliases; the
  file's intentional additive/forward-compat looseness must survive (generated types are stricter).
- **No trusting generated response types before `response_model=` exists** — you'll get `unknown`.

---

## Sources (best of the set)

**Frontend slices / boundaries**
- Feature-Sliced Design — <https://feature-sliced.design/> · overview
  <https://feature-sliced.design/docs/get-started/overview> · ESLint config
  <https://feature-sliced.design/blog/mastering-eslint-config>
- bulletproof-react project structure —
  <https://github.com/alan2207/bulletproof-react/blob/master/docs/project-structure.md>
- Enforce module boundaries (`no-restricted-imports`/paths) —
  <https://timdeschryver.dev/bits/enforce-module-boundaries-with-no-restricted-imports> ·
  Nx recipe <https://nx.dev/technologies/eslint/eslint-plugin/recipes/enforce-module-boundaries>
- Steiger (FSD linter) — <https://github.com/feature-sliced/steiger>
- Robin Wieruch, React folder structure — <https://www.robinwieruch.de/react-folder-structure/>

**Plugin / feature registry (React)**
- Backstage frontend system (plugins/extensions/RouteRef) —
  <https://backstage.io/docs/frontend-system/architecture/plugins/> ·
  <https://backstage.io/docs/frontend-system/architecture/extensions/>
- VS Code contribution points + `when`-clauses —
  <https://code.visualstudio.com/api/references/contribution-points> ·
  <https://code.visualstudio.com/api/references/when-clause-contexts>
- Function Registry pattern (React) —
  <https://techhub.iodigital.com/articles/function-registry-pattern-react>
- react-pluggable — <https://react-pluggable.github.io/>

**FE dependency inversion + contract sync**
- FastAPI "Generating Clients" (operationId pattern) —
  <https://fastapi.tiangolo.com/advanced/generate-clients/>
- FastAPI `response_model` — <https://fastapi.tiangolo.com/tutorial/response-model/>
- openapi-typescript / openapi-fetch — <https://openapi-ts.dev/> ·
  <https://openapi-ts.dev/openapi-fetch/>
- Codegen tool comparison —
  <https://dev.to/nyaomaru/which-openapi-codegen-should-you-choose-openapi-typescript-vs-hey-api-vs-orval-vs-kubb-100p>
- Contract tests with TS + OpenAPI codegen —
  <https://dev.to/tsirlucas/contract-tests-with-typescript-and-openapi-codegen-4o7g>
- Context as DI (not state) —
  <https://testdouble.com/insights/react-context-for-dependency-injection-not-state-management>

**Backend modular / SPI**
- FastAPI bigger-applications — <https://fastapi.tiangolo.com/tutorial/bigger-applications/>
- zhanymkanov/fastapi-best-practices — <https://github.com/zhanymkanov/fastapi-best-practices>
- Netflix Dispatch (package-by-feature at scale) — <https://github.com/Netflix/dispatch>
- Layered architecture + DI (FastAPI) —
  <https://blog.dotcs.me/posts/fastapi-dependency-injection-x-layers>
- Auto-registering routes (loader pattern) —
  <https://medium.com/@bhagyarana80/how-i-built-a-plugin-driven-fastapi-backend-that-auto-registers-routes-e815a7298c29>
- Python plugin systems / entry points —
  <https://packaging.python.org/en/latest/guides/creating-and-discovering-plugins/> ·
  <https://docs.python.org/3/library/importlib.metadata.html> ·
  <https://sedimental.org/plugin_systems.html>
- pluggy (only if a real hook pipeline) — <https://github.com/pytest-dev/pluggy>

**Internal references (already-good patterns to generalize)**
- `backend/app/connectors/registry.py` + `backend/app/enrichment/registry.py` — the
  manifest + ABC + entry-point + lazy-singleton reference implementation to factor into one helper.
- `backend/app/main.py` (~L84–99) — the existing hardcoded router-loader tuple to auto-discover.
- webui `*.api.ts` co-located builders + the `ui`/`soc/components`/`lib` 3-tier split — the
  de-facto feature seams to formalize.
