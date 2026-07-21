---
title: Console UI standard
description: The current enforceable visual, interaction, loading, navigation, and accessibility contract for every Agentic SOC Console page.
---

# Console UI standard

This is the current implementation contract for the Agentic SOC Console. It turns the
Security Command Center visual language into reusable rules for every route. New work
must use these primitives; existing pages migrate toward them as they are touched.

## Migration contract

The shared shell, navigation rail, route-loading fallback, in-app Documentation
index, Case Manager, Settings frame, and Entity investigation workflow are the
current reference surfaces. Other routes remain supported while they move to this
grammar incrementally; a page is not called migrated merely because the shell around
it changed.

When touching an older page, include its loading/empty/error states, menus and
popovers, both themes, narrow layout, and keyboard path in the same change. Remove
page-local card, color, spacing, and motion inventions rather than layering new chrome
over them. Keep deep links and permissions stable, and record any intentional legacy
route in the feature registry and operator documentation.

## Visual character

The Console is a calm SOC command surface: near-black dark mode, quiet light mode,
hairline dividers, dense but readable information, and semantic color only when the
meaning warrants it. Avoid decorative gradients, nested cards, heavy resting shadows,
large rounded marketing panels, emoji status symbols, and animation that competes with
case state.

- Use `background`, `surface`, `card`, `border`, `foreground`, and
  `muted-foreground` tokens from `theme.css`; never add page-local hex colors.
- Use the shared severity/status/verdict/risk palette. Color supplements an icon or
  label; it never carries meaning alone.
- Prefer transparent sections separated by `border-border` over card-inside-card
  layouts. A card is reserved for a selectable record, contained editor, dialog, or
  genuinely independent widget.
- Controls are compact and squared/quiet (`Button`, `Select`, `SegmentedControl`,
  `TimeRangePicker`); keep one visual grammar in light and dark themes.

## Page anatomy

Every routed page follows the same order:

1. `PageContainer` owns the width (`fixed`, `wide`, `fluid`, or `prose`).
2. One `PageHeader` owns title, description, status metadata, and primary actions.
3. Optional controls occupy one compact `ControlBar`/`FilterBar` band.
4. Content is organized into flat sections or shared data/table/chart components.
5. Loading, empty, denied, error, and partial-data states occupy the same geometry as
   the final content so the layout does not jump.

Do not repeat a page title inside the first content panel. Do not add an eyebrow such
as “Decision brief” when the actual outcome heading is already explicit. A nested
workflow can have its own section label only when it adds information.

## Queue and detail workspaces

A desktop list/detail split uses one hairline, focusable separator rather than two
unrelated cards. Pointer resizing and keyboard resizing are the same operation: Arrow
keys make a documented small step, Shift+Arrow a larger step, Home/End reach the safe
bounds, and double-click resets. Clamp both panes to usable minimums, persist only a
presentation preference locally, and remove the handle below the desktop breakpoint;
compact layouts use an explicit back-to-list path.

Row selection is independent of row navigation. “Select visible” means the filtered
rows in the loaded client window and never implies every server match. Mixed bulk
operations expose progress and per-record partial failures; successful records leave
the selection while failures remain retryable. Permission hiding in the Console is
guidance—the API must recheck every action.

## Navigation and information architecture

`src/soc/registry.tsx` is the only feature registry. It derives routes, the left rail,
and command-palette destinations. Add, rename, gate, hide, or deprecate a feature there;
do not hand-build a second nav list.

- Primary navigation contains distinct operator jobs, not alternate reports over the
  same objects. Legacy destinations may stay hidden and routable for bookmarks during a
  transition.
- The collapsed rail remains icon-complete and keyboard accessible; expansion uses the
  shared reduced-motion-aware transition.
- Product documentation is a bottom utility destination, separate from operational
  feature groups.
- The in-app **Documentation** destination opens the version-matched Help Center
  shipped with the application at `/docs/<major.minor>/`; it never substitutes a
  GitHub directory for product help. Generate that static site from the same Markdown
  and accepted source identity as the application instead of copying articles into
  React components or maintaining a second manual.
- Installed documentation is authoritative for the running build and does not carry
  a blanket freshness warning. Latest Stable, Development, “View source”, and “Edit
  this page” are secondary destinations with explicit version/channel context.
- Deep links remain stable. If a page is consolidated, add an explicit redirect or a
  hidden compatibility route and document the replacement.

## Motion and loading

Every lazy route renders the shared route fallback immediately. Pages with data loads
use shaped `Skeleton` blocks or the domain component's loading state; never show a blank
canvas or only the word “Loading”. Use the existing lazy `motion` boundary and
`LoadingBar`; do not add another animation dependency.

Motion explains state change: route entry, disclosure, row insertion/removal, or a
terminal live marker. It does not decorate static content. Honor
`prefers-reduced-motion`; no required information depends on animation. Only the newest
terminal timeline marker pulses.

## Theme and appearance

System, Light, and Dark are the three supported modes. All appearance entry points use
the same `PrefsProvider.setThemeMode` path so first paint, the signed-in preference, and
the visible selection agree. Test every changed surface in both themes; hard-coded
light-only dropdowns, popovers, tooltips, and native-looking menu surfaces are defects.

## Forms, Settings, and dangerous actions

Settings uses one searchable section rail and one active-section heading. Related fields
sit in flat `SettingsCard` bands; do not wrap the entire section in another card. Dirty
state is visible per section and saved through the single sticky Save/Discard bar.

Secrets remain write-only. Destructive or externally consequential actions require a
clear label, scoped confirmation, permission gate, and audited backend operation. Never
place deterministic case decisions behind an LLM-generated button.

## Accessibility and verification

- Keyboard focus is always visible; use the shared focus ring.
- Icon-only controls have an accessible name and a target of at least 24×24 CSS pixels.
- Radix primitives provide menu, dialog, radio, tabs, tooltip, and focus behavior.
- Render source/log/user text as plain text. Truncation has an accessible full-value
  path (hover/focus detail, title, or expanded view).
- Maintain WCAG AA token contrast in both themes and never disable paste.

Before handoff, run typecheck, lint, design gates, focused tests, the complete Console
suite, and the production build. Use the in-app browser to inspect both themes, a narrow
viewport, hover/focus behavior, lazy-route loading, and console errors. Update this
standard when a deliberate shared pattern changes; do not let implementation and the
document drift.
