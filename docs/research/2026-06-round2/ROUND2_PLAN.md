# Round 2 Overhaul — Master Plan & Tracker

> **Single source of truth for Round 2.** Read this first every session. It captures
> every requested work item, acceptance criteria, the wave plan, and a live status
> log. Round 1 (Waves 1–7 + docs) is DONE and committed (`3e55887` and earlier);
> the Settings #310 crash + react-hooks lint hardening are also done (`6adf195`).
> Branch: **Testing**. Backend baseline: **649 pytest green**; webui build + 29 vitest green.

## Hard process rules (from the user, this round)
- **Opus 4.8 sub-agents ONLY.** Every `agent()` call sets `model: 'opus'`. Do NOT use
  `agentType: 'Explore'` (it downgrades to Haiku). Default workflow agent + `model:'opus'`.
- **Document everything to disk** (this file + design docs) so a context compaction never
  loses state. Update the STATUS LOG below after every wave.
- Large fleets: deep research fleet (~50+), per-feature implementation fleets, a test
  fleet, a docs fleet. Coverage + correctness over raw counts, but run genuinely large.
- Every wave: review-gated, self-verifying workflow (implement → pytest + webui build +
  vitest + eslint → fix-loop → green), then I review the diff + independently re-verify,
  then commit as a clean checkpoint.
- **12 non-negotiables intact** (esp. #3: `engine/case_manager.py` decide()/apply()
  decision logic byte-identical; #9 untrusted fencing; #1 read-only key; #2 audit;
  #10 secrets env/in-memory only). ZERO new runtime deps (backend stdlib; webui only the
  existing radix/shadcn/framer/recharts/lucide; eslint is a devDep already added).

## Current stack (post Round 1)
- Backend: FastAPI + LangGraph, `backend/app/` (auth/ rbac/ notifications/ engine/ threat/
  stores/ connectors/ agents/ api/). Auth default-OFF; seed Admin/Admin@123 when on.
- WebUI: Vite + React + **Tailwind + shadcn** (NOT EUI), `webui/src/soc/` (pages + components),
  `webui/src/ui/` (primitives), `webui/src/lib/` (api/types/format). eslint react-hooks rule on.
- Branding shows "Mphasis Agentic SOC" (operator-set). Deployed at an operator host:8080.

## WORK ITEMS (acceptance criteria)

### Bugs (fix first — user is frustrated; "fix once and for all")
- **R2-B1 Active Risk Index gauge STILL broken.** Screenshot: thin white sliver instead of
  an arc, `/100` overlapping the `WEIGHTED RISK PRESSURE` label, stray dark blob on the right.
  This is `webui/src/soc/components/RiskGauge.tsx` used by `Overview.tsx` (`size≈208`).
  Two prior "fixes" didn't hold. → Rewrite with a BULLETPROOF technique (stroke-dasharray
  progress-ring on a half-circle, or verified arc math), exact centered value, no stray caps,
  no label overlap. Add a vitest asserting geometry at scores 0/27/55/85/100 and sizes 100/208.
  ACCEPT: renders a clean colored half-gauge; value + label never overlap; no stray shapes.
- **R2-B2 MFA setup glitches.** Copy button not working; QR not scannable (manual secret works,
  so the secret/otpauth URI is correct → the QR ENCODER is producing an invalid/low-EC matrix,
  or missing quiet-zone/sizing). Files: `webui/src/soc/components/QRCode.tsx`,
  `MfaSetupCard.tsx`, `Security.tsx`. → Fix the copy-to-clipboard handler AND make the QR
  scannable (correct EC level, quiet zone ≥4 modules, integer module scaling, adequate size).
  ACCEPT: a real authenticator app scans the QR; copy button copies secret + otpauth URI.
- **R2-B3 Two "close" buttons on an open case.** Screenshot of the case-detail toolbar shows a
  send/paper-plane then what looks like `✕✕` (two close affordances). File: `CaseDetail.tsx`
  (header/toolbar). → De-duplicate: one panel-close (X) vs the case-lifecycle "Close case"
  action must be visually + semantically distinct (or remove the accidental duplicate).
  ACCEPT: exactly one panel-close control; the lifecycle "close case" is a labeled action.
- **R2-B4 Chat screen framing/UI.** Screenshot: lots of dead vertical space, composer floats,
  empty-state centered oddly. Files: `Chat.tsx`, `ChatPanel.tsx`. → Proper full-height framing,
  anchored composer, balanced empty state. ACCEPT: clean, framed, no floating/empty gaps.
- **R2-B5 "Store degraded" UX.** The amber `Store degraded` chip appears when ES/own-state is
  in-memory fallback. Make it informative (tooltip explaining what it means + that data won't
  persist) and tie into demo mode. ACCEPT: hovering explains it; not alarming in demo mode.

### Features
- **R2-F1 Login redesign.** Beautiful, clean login (`Login.tsx`). Modern split/hero layout,
  brand, subtle motion, SSO buttons, MFA step, OOBE — all preserved, much more attractive.
- **R2-F2 User profile / account self-service.** A user can edit their OWN profile: display
  name/alias, avatar (profile pic, bounded data-URL like branding logo), alternate email,
  timezone, locale, notification prefs, password, MFA, and SEE their own activity/sessions.
  New: `User` model fields (display_name, avatar_data_url, alt_email, timezone, locale, prefs),
  `GET/PUT /api/account/me`, an Account page. ACCEPT: user edits self; admin can't see secrets.
- **R2-F3 Settings IA consolidation.** Move Users / Security / SSO UNDER the Settings menu
  (they are currently separate Admin nav entries). Consolidate confusing/segregated pages
  (research-backed; only where it genuinely helps). ACCEPT: one coherent Settings home with
  Account + Admin (Users/Security/Sessions) sections gated by RBAC; nav decluttered.
- **R2-F4 Sessions & access policy.** Server-side session registry: each login records a
  Session {id, username, ip, user_agent/device, geo (best-effort), created_at, last_seen_at,
  current?}. Admin: list ALL users' sessions, terminate (with/without notifying the user),
  see good audit logs. User: see + terminate OWN sessions + own activity log. Admin policy:
  token TTL / idle auto-logout / absolute session lifetime / "require re-login after". JWT
  carries a session id (sid) that verify() checks against a revocation list (revoked sid =
  invalid session). New: `stores/sessions.py` (KV-doc), Session model, `/api/sessions*` +
  `/api/account/activity`, Settings → Security → Sessions UI + Account → Sessions UI.
  ACCEPT: admin views/terminates any session; user views/terminates own; policies enforced.
- **R2-F5 Demo Mode + Experimental Settings.** New Settings section "Experimental". A
  `demo_mode` toggle that: (a) hides real cases/sources/other modes; (b) seeds synthetic
  data — a spread of OLD + RECENT cases across statuses/dispositions/severities, sources,
  and (c) SIMULATES live logs/alerts (a generator that periodically emits synthetic events/
  cases while on). Reversible (off = real data returns; synthetic never pollutes real
  stores — namespaced/in-memory demo provider). Showcases EVERY feature. ACCEPT: toggle on →
  rich believable demo data + live ticking; toggle off → clean real state; clearly labeled.
- **R2-F6 Source multi-feed customization.** A source (e.g. ELK) has MULTIPLE feeds: an
  alerts feed, an all-events feed, an ignore feed, etc. Generalize/streamline
  `IndexPattern{pattern, role, auto_correlate}` into a richer per-feed model (role ∈
  events/alerts/IGNORE + per-feed query filter, field-mapping overrides, severity floor,
  auto-correlate, schedule). Streamlined SourceEditor "Feeds" UI. ACCEPT: per-feed config
  incl. an ignore feed; back-compatible with existing index_patterns.
- **R2-F7 Email: Resend + SES + templates.** Add Resend (HTTPS API) + ensure Amazon SES
  (SMTP already; add SES API option) as channels/providers. Preload STANDARD email templates
  (new-case, escalation, resolved, digest, test) with full customization (subject/body,
  variables, HTML+text, preview). ACCEPT: Resend + SES selectable; templates preloaded +
  editable + previewable; secrets in the secret tier.
- **R2-F8 Pervasive customization.** Everything heavily customizable (continue the theme):
  dashboard widgets/layout where feasible, table columns, default filters, per-user prefs,
  terminology, etc. ACCEPT: meaningfully more knobs across the product, all persisted.
- **R2-F9 UI consolidation + IA principles.** Research-backed pass to reduce segregation/
  confusion: clear nav grouping, purposeful elements, good recall, progressive disclosure,
  consolidate pages only where necessary. ACCEPT: a documented IA + a cleaner, coherent nav.
- **R2-F10 "Best of the best" additions.** Research what top SOC products include that we
  lack; add the highest-value, in-scope items. ACCEPT: a prioritized list + the top items shipped.

## WAVE PLAN (each = self-verifying workflow, Opus-only, review-gated, then commit)
- **R2-W0 Research + Diagnosis** (Opus fleet ~50): re-map current code for each area, pinpoint
  every bug, research every standard, synthesize → `ROUND2_DESIGN.md` + `ROUND2_BUGS.md`.
- **R2-W1 Critical bug fixes**: B1 gauge, B2 MFA copy+QR, B3 two-close, B4 chat framing, B5 store-degraded.
- **R2-W2 Login redesign (F1) + User profile/account (F2)**.
- **R2-W3 Sessions & access policy (F4)** (backend registry + policies + admin/user UI).
- **R2-W4 Settings IA consolidation (F3) + UI consolidation (F9)** (move Users/Security/SSO under Settings; declutter).
- **R2-W5 Demo Mode + Experimental Settings (F5)** (synthetic data + live sim).
- **R2-W6 Source multi-feed customization (F6)**.
- **R2-W7 Email Resend+SES+templates (F7) + pervasive customization (F8) + best-of-the-best (F10)**.
- **R2-Final**: full test fleet (pytest + build + vitest + eslint + render tests) + docs fleet (README/USAGE/DEPLOY/CLAUDE/Journal/CHANGELOG) + demo walkthrough update.

## STATUS LOG (append; newest last)
- 2026-06-30 — Round 2 kickoff. Plan written. Tree clean at 6adf195. Next: launch R2-W0 research+diagnosis fleet (Opus-only).
- 2026-06-30 — R2-W0 done (30-agent Opus fleet). Wrote ROUND2_BUGS.md, ROUND2_DESIGN.md, ROUND2_BEST_OF_BEST.md. Key bug root causes confirmed: gauge had a Wave-7 `<linearGradient stopColor=currentColor>` in `<defs>` (paints white) + unbounded value overlay + baseline round-cap; MFA QR `placeFormatInfo` 2nd-copy bit placement inverted (null module → unscannable) + `navigator.clipboard?` no-op over HTTP; case-detail rendered BOTH the shadcn SheetContent built-in X AND a hand-rolled header X.
- 2026-06-30 — R2-W1 done & verified: all 5 bugs fixed (gauge→dasharray ring, 21 tests; MFA QR format-info fix + clipboard fallback, 7 tests; removed duplicate close X; chat full-height frame; store-degraded tooltip). webui build clean, 50 vitest, 0 rules-of-hooks errors. Next: R2-W2 (login redesign + account self-service).
