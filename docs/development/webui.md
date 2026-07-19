---
title: Console development
description: TLSOC Console architecture, design system, API contracts, accessibility, and development workflow for version 0.1.
---

# Console development

The TLSOC Console is a standalone React 18 and TypeScript SPA built by Vite. It uses
Tailwind CSS, shadcn-style wrappers around Radix primitives, and a shared SOC component
layer. It calls the TLSOC API through relative `/api/*` paths.

## Set up the Console

Use Node 22 and the committed lockfile:

```bash
cd webui
npm ci
npm run dev
```

The Vite server proxies `/api` to `http://localhost:8088` by default. Override the
development target without changing source:

```bash
BACKEND_URL=http://127.0.0.1:9000 npm run dev
```

## Source layout

| Path | Responsibility |
|---|---|
| `src/soc/pages/` | Route-level product pages and settings sections |
| `src/soc/components/` | Reusable TLSOC domain components, charts, editors, guards, and feedback states |
| `src/soc/registry.tsx` | Single feature registry that derives navigation, routes, and command-palette entries |
| `src/soc/AppShell.tsx`, `nav`, `router`, `theme`, `auth` | Application shell, navigation, routing, theming, and session context |
| `src/ui/` | Low-level shadcn/Radix primitives; wrap and compose these instead of forking |
| `src/lib/api.ts` | HTTP client and error normalization |
| `src/lib/types.ts` | Hand-maintained product/domain contracts mirrored from backend models |
| `src/lib/api-types.gen.ts` | Generated types from the committed OpenAPI snapshot; never hand-edit |
| `src/styles/theme.css` | Light/dark design tokens and semantic color axes |

## Design-system rules

Use existing tokens and components so new work remains consistent in both themes and
under organization branding.

- Layout follows the shared spacing/grid and page-container primitives.
- Severity, status, verdict, and risk colors come from the semantic palette, not
  ad-hoc hex values.
- Low-level interactions use the existing Radix wrappers for focus management,
  keyboard behavior, dialogs, selects, tabs, and tooltips.
- Pages compose `PageHeader`, cards/tiles, data tables, empty states, skeletons,
  error states, and permission guards from the SOC layer.
- Heavy pages, charts, dashboard editing, and motion remain lazy so they do not enter
  the first-load bundle unnecessarily.

Do not reintroduce Elastic UI or Kibana packages. The archived plugin is not a source
of current UI patterns.

## Data and API contracts

All API calls go through `src/lib/api.ts`; non-2xx responses become `ApiError` with
the server `detail`. Display server- and source-derived text as plain text. Do not use
HTML injection to render log records, case evidence, imported knowledge, user names,
or branding strings.

When the backend contract changes:

```bash
cd webui
npm run gen:types
npm run check:types
```

`gen:types` imports the backend offline, writes `openapi.json`, and regenerates
`src/lib/api-types.gen.ts`. It does not replace `src/lib/types.ts`; update that file
when its hand-maintained domain projection changes. Commit both generated files with
the backend change.

## Add a page or feature

1. Add the route-level page under the appropriate `src/soc` domain.
2. Register its route, navigation, command-palette label, permission, and lazy import
   in the single feature registry where applicable.
3. Add typed calls to `src/lib/api.ts`; do not fetch directly inside presentation components.
4. Use shared loading, empty, error, and permission states.
5. Add keyboard/focus behavior and accessible names before visual polish.
6. Test the allowed, denied, loading, empty, error, and populated states.
7. Verify both themes, narrow viewports, reduced motion, and long/untrusted strings.

## Required Console checks

```bash
npm run typecheck
npm run lint
npm run gates
npm test
npm run build
```

The production build runs TypeScript checking before Vite. Lint includes React hook
ordering and accessibility rules. Design gates protect architecture, tokens, bundle
boundaries, and other repository-wide UI constraints.

See [Testing](testing.md) for the full cross-stack gate and
[API reference](../reference/api.md) for the runtime surface.
