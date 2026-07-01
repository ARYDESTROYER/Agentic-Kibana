/**
 * settings-sections — the SINGLE source of truth for the Settings page (Round-5 Sett-A).
 *
 * Historically the Settings page hand-synced THREE parallel structures: a `SectionId`
 * union, a `SECTION_GROUPS` rail array, and a `SECTION_KEYS` dirty-map (in
 * `settings-dirty.ts`). This module collapses all three into one authoritative table —
 * {@link SETTINGS_SECTIONS} — an array of {@link SettingsSectionDef}
 * `{ id, group, perm, ownedKeys, title, blurb, icon, Component }`. From it we DERIVE:
 *   - {@link SectionId} (the id union),
 *   - {@link SECTION_GROUPS} (the grouped rail),
 *   - {@link SECTION_KEYS} (consumed by `settings-dirty.ts` for the per-section dot),
 *   - {@link GRID_SECTIONS} (sections that render their own full-width card grid),
 *   - the render lookup (kills the giant switch).
 *
 * Each section's renderer receives a single {@link SectionRenderContext} and picks the
 * props it needs. This keeps the registry data-driven while every section keeps its
 * exact current label / id / markup / save behaviour (Sett-B relabels later).
 *
 * IMPORTANT (import graph): this file imports the section renderer components. It is
 * imported by `settings-dirty.ts` (for `SECTION_KEYS`) — which is in turn imported by
 * `useDirtyDraft` (only for `deepEqual`). No section renderer imports `useDirtyDraft`,
 * so there is NO import cycle. `settings-dirty.ts` still owns the pure diff helpers.
 *
 * Security: this module carries no secrets and renders nothing itself; it only wires
 * operator-facing section metadata + renderer functions.
 */
import type { LucideIcon } from 'lucide-react';
import * as React from 'react';
import {
  Bell,
  Brush,
  Database,
  FileText,
  FlaskConical,
  Globe,
  Hash,
  KeyRound,
  ListTree,
  MonitorSmartphone,
  Network,
  Palette,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  UserCircle2,
  Users as UsersIcon,
  Workflow,
  Zap,
} from 'lucide-react';

import type {
  ConfiguredStatus,
  ModelsResponse,
  Preferences,
} from '@/lib/types';

import type { NavigateFn, SecProps } from './primitives';

// Section renderers (each keeps its exact former markup + behaviour).
import { GeneralSection } from './general';
import { ModelsSection } from './models';
import { KeysSection } from './keys';
import { DetectionSection } from './detection';
import { CaseIdSection } from './cases';
import { AutomationSection } from './automation';
import { StandupSection } from './standup';
import { KnowledgeSection } from './knowledge';
import { EnrichmentSection } from './enrichment';
import { AdvancedSection } from './advanced';
import { AdvancedSchemaSection } from './advanced-schema';
import { OrgSecuritySection } from './security';

// Embedded page bodies re-hosted as Settings sub-sections (unchanged wiring).
import { AccountInner } from '@/soc/pages/Account';
import { SessionsInner } from '@/soc/pages/Sessions';
import { UsersInner } from '@/soc/pages/Users';
import { AdminSessionsInner } from '@/soc/pages/AdminSessions';
import { RolesInner } from '@/soc/pages/Roles';
import { SecurityMfaInner } from '@/soc/pages/Security';
import { CustomizationSection } from '@/soc/components/CustomizationSection';
import { BrandingEditor } from '@/soc/components/BrandingEditor';
import { NotificationsEditor } from '@/soc/components/NotificationsEditor';
import { DemoModeSection } from '@/soc/components/DemoModeSection';
import { DangerZone } from '@/soc/components/DangerZone';

/* -------------------------------------------------------------- render ctx -- */

/**
 * The single context handed to every section renderer. A section reads only the fields
 * it needs; the page owns all this state. `prefs`/`update` are guaranteed non-null when
 * a renderer runs (the page early-returns before rendering a section body).
 */
export interface SectionRenderContext {
  prefs: Preferences;
  update: (p: Partial<Preferences>) => void;
  models: ModelsResponse | null;
  configured: ConfiguredStatus;
  readOnly: boolean;
  onNavigate: NavigateFn;
  /** Switch to another Settings section by id (used by the Profile → 2FA hand-off). */
  setSection: (id: SectionId) => void;
  /** Write-only secret draft state (Keys section only). */
  secretDraft: Record<string, string>;
  setSecretDraft: (d: Record<string, string>) => void;
  onSaveSecrets: () => void;
  savingSecrets: boolean;
}

/** A section renderer: given the shared context, returns the section body. */
export type SectionRenderer = (ctx: SectionRenderContext) => React.ReactElement;

/** A permission requirement (`resource:action`) gating a section. */
export interface SectionPerm {
  resource: string;
  action: string;
}

/** One Settings section — the SINGLE source of truth for id/group/perm/keys/render. */
export interface SettingsSectionDef {
  id: string;
  /** Rail group id (see {@link SECTION_GROUP_LABELS}). */
  group: SectionGroupId;
  /** When set, the section is gated by this `resource:action` grant. */
  perm?: SectionPerm;
  /**
   * The top-level `Preferences` keys this section OWNS. Drives the per-section
   * "modified" dot + is the SINGLE source `settings-dirty.ts` derives `SECTION_KEYS`
   * from. Sections whose save lifecycle is independent of the page dirty-map (the
   * embedded bodies, secret keys, enrichment) own no keys.
   */
  ownedKeys?: readonly string[];
  /** Display name (rail label + section title). */
  title: string;
  /** Short one-liner shown in search + as a subtitle. */
  blurb: string;
  icon: LucideIcon;
  /** Extra keywords so search finds a section by the settings it contains. */
  keywords?: string[];
  /**
   * True when this section renders its OWN full-width `SettingsGrid` of cards (no outer
   * Card chrome). Everything else sits on the shared single-card surface.
   */
  grid?: boolean;
  /** The section body renderer. */
  Component: SectionRenderer;
}

/* -------------------------------------------------------------- groups ----- */

/**
 * The FIVE top-level Settings groups (Round-5 Sett-B IA regroup, 6 → 5). This is the
 * single highest-leverage IA change (RESEARCH_SETTINGS_IA §3.1): the old six groups
 * (`My account` · `Configuration` · `Triage logic` · `Integrations & context` ·
 * `Administration` · `Experimental`) collapse to five, with **Security promoted to its
 * own top-level group** (`security_access`) and `Roles` split out of Users.
 *
 * Only the group ids/labels + each section's `group` + display `title` change here —
 * every section `id` stays STABLE (deep-linked via `#/settings?s=<id>`). The router
 * (Sett-B redirect map) aliases the old standalone routes onto these sections.
 */
export type SectionGroupId =
  | 'account'
  | 'general'
  | 'integrations'
  | 'security_access'
  | 'organization';

const SECTION_GROUP_ORDER: { id: SectionGroupId; label: string }[] = [
  { id: 'account', label: 'Account' },
  { id: 'general', label: 'General' },
  { id: 'integrations', label: 'Integrations' },
  { id: 'security_access', label: 'Security & access' },
  { id: 'organization', label: 'Organization' },
];

/* -------------------------------------------------------------- registry --- */

const h = React.createElement;

/**
 * The one authoritative section table. Order is authoritative (drives rail order within
 * each group). Every existing section + its exact current label/id is preserved.
 */
export const SETTINGS_SECTIONS: SettingsSectionDef[] = [
  /* ---- My account (Personal) — no perm gate; embedded bodies self-scope to
   * the signed-in caller. In the auth-off default hasPermission() is true so
   * these still show (back-compat).                                          */
  {
    id: 'profile',
    group: 'account',
    title: 'Profile',
    blurb: 'Your display name, avatar, secondary email, timezone, and language.',
    icon: UserCircle2,
    keywords: ['profile', 'account', 'display name', 'avatar', 'photo', 'email', 'timezone', 'locale', 'language'],
    Component: (ctx) =>
      h(AccountInner, { onNavigateToSecurity: () => ctx.setSection('account_security') }),
  },
  {
    id: 'account_security',
    group: 'account',
    title: 'Security & two-factor',
    blurb: 'Enroll TOTP two-factor authentication for your own account.',
    icon: ShieldCheck,
    keywords: ['security', 'mfa', '2fa', 'two factor', 'totp', 'authenticator', 'password'],
    Component: () => h(SecurityMfaInner),
  },
  {
    id: 'sessions',
    group: 'account',
    title: 'Sessions & activity',
    blurb: 'Where you are signed in, and your recent account activity.',
    icon: MonitorSmartphone,
    keywords: ['sessions', 'devices', 'activity', 'sign out', 'revoke', 'login history'],
    Component: () => h(SessionsInner),
  },
  {
    id: 'customization',
    group: 'account',
    title: 'Appearance & customization',
    blurb: 'Your theme, saved views, and (admin) terminology + org defaults.',
    icon: Palette,
    keywords: ['theme', 'dark mode', 'light mode', 'appearance', 'saved views', 'views', 'terminology', 'labels', 'rename', 'customize', 'customization', 'columns'],
    // No section-level perm — every signed-in user manages their own theme + saved
    // views; the admin-only org editors self-gate inside the component.
    Component: () => h(CustomizationSection),
  },

  /* ---- General (org, low blast radius) ---------------------------------- */
  {
    id: 'general',
    group: 'general',
    title: 'Data scope',
    blurb: 'Index pattern, entity fields, severity threshold, and polling.',
    icon: Database,
    grid: true,
    keywords: ['data view', 'index', 'fields', 'polling', 'poll', 'lookback', 'timestamp', 'severity'],
    ownedKeys: [
      'data_view_pattern',
      'time_field',
      'source_ip_field',
      'user_field',
      'host_field',
      'rule_field',
      'rule_name_field',
      'severity_field',
      'severity_threshold',
      'investigate_lookback',
      'polling_enabled',
      'poll_interval_seconds',
      'poll_batch_size',
      'cold_start_lookback_minutes',
    ],
    Component: (ctx) =>
      h(GeneralSection, { prefs: ctx.prefs, update: ctx.update, onNavigate: ctx.onNavigate }),
  },
  {
    id: 'models',
    group: 'general',
    title: 'Models',
    blurb: 'The model used for each agent role.',
    icon: Sparkles,
    keywords: ['llm', 'model', 'router', 'investigator', 'formatter', 'chat', 'embedding', 'anthropic', 'openai'],
    ownedKeys: [
      'router_model',
      'investigator_model',
      'formatter_model',
      'standup_model',
      'chat_model',
      'overview_model',
      'embedding_model',
    ],
    Component: (ctx) =>
      h(ModelsSection, {
        prefs: ctx.prefs,
        update: ctx.update,
        models: ctx.models,
        onNavigate: ctx.onNavigate,
      }),
  },
  {
    id: 'detection',
    group: 'general',
    title: 'Detection',
    blurb: 'Clustering, risk weights, escalation, auto-close, and cross-source correlation.',
    icon: Workflow,
    grid: true,
    keywords: ['correlation', 'risk', 'weights', 'escalation', 'auto-close', 'autonomy', 'false positive', 'cross-source', 'entity'],
    // Both the legacy `fp_auto_close` scalar AND the live `auto_close` policy block are
    // owned here (Round-5 R1 moves the auto-close editor onto `prefs.auto_close`).
    ownedKeys: [
      'default_correlation',
      'risk_weights',
      'escalation_confidence',
      'critical_severity',
      'fp_auto_close',
      'auto_close',
      'cross_source_correlation',
    ],
    Component: (ctx) => h(DetectionSection, { prefs: ctx.prefs, update: ctx.update }),
  },
  {
    id: 'cases',
    group: 'general',
    title: 'Cases',
    blurb: 'Human-facing case-ID nomenclature and live preview.',
    icon: Hash,
    perm: { resource: 'settings', action: 'manage' },
    keywords: ['case id', 'case number', 'nomenclature', 'sequence', 'prefix', 'template'],
    ownedKeys: ['case_id_format'],
    Component: (ctx) => h(CaseIdSection, { prefs: ctx.prefs, update: ctx.update }),
  },
  {
    id: 'automation',
    group: 'general',
    title: 'Automation',
    blurb: 'Threshold rules that react to a case after the deterministic decision.',
    icon: Zap,
    perm: { resource: 'settings', action: 'manage' },
    keywords: ['automation', 'rules', 'threshold', 'tag', 'notify', 'playbook', 'proposal'],
    ownedKeys: ['threshold_automation'],
    // Full-width (no outer page Card): the section's rule-editor rows are already
    // bordered cards, so wrapping them in the shared single-card surface produced a
    // card-in-a-card. Rendering the section directly removes that double-wrap.
    grid: true,
    Component: (ctx) => h(AutomationSection, { prefs: ctx.prefs, update: ctx.update }),
  },
  {
    id: 'standup',
    group: 'general',
    title: 'Standup',
    blurb: 'The daily aggregate summary window and cadence.',
    icon: FileText,
    keywords: ['standup', 'summary', 'digest', 'aggregate', 'report'],
    ownedKeys: ['standup'],
    Component: (ctx) => h(StandupSection, { prefs: ctx.prefs, update: ctx.update }),
  },

  /* ---- Integrations (connectors + outbound + context) ------------------ */
  {
    id: 'notifications',
    group: 'integrations',
    title: 'Alerting & notifications',
    blurb: 'Outbound channels, triggers, dedup, and digests.',
    icon: Bell,
    perm: { resource: 'settings', action: 'manage' },
    keywords: ['alerting', 'notifications', 'email', 'slack', 'teams', 'webhook', 'pagerduty', 'telegram', 'channels'],
    ownedKeys: ['notifications'],
    Component: (ctx) => h(NotificationsEditor, { prefs: ctx.prefs, update: ctx.update }),
  },
  {
    id: 'enrichment',
    group: 'integrations',
    title: 'Enrichment',
    blurb: 'Threat-intel lookups (AbuseIPDB / VirusTotal / GeoIP), cached in Redis.',
    icon: Globe,
    keywords: ['enrichment', 'abuseipdb', 'virustotal', 'geoip', 'reputation', 'cache', 'ttl'],
    ownedKeys: ['enrichment'],
    Component: (ctx) => h(EnrichmentSection, { prefs: ctx.prefs, update: ctx.update }),
  },
  {
    id: 'knowledge',
    group: 'integrations',
    title: 'Knowledge & threat context',
    blurb: 'RAG retrieval, the threat-context panel, MITRE, and runbooks/playbooks.',
    icon: ShieldAlert,
    perm: { resource: 'settings', action: 'manage' },
    grid: true,
    keywords: ['rag', 'retrieval', 'knowledge', 'threat context', 'mitre', 'runbook', 'playbook', 'ioc', 'resolved cases'],
    ownedKeys: ['rag', 'threat_context'],
    Component: (ctx) =>
      h(KnowledgeSection, { prefs: ctx.prefs, update: ctx.update, onNavigate: ctx.onNavigate }),
  },

  /* ---- Security & access (org, HIGH blast radius) ----------------------- *
   * The single highest-leverage IA move (RESEARCH_SETTINGS_IA §3.1): Security is a
   * first-class top group; `Roles` is split out of Users; high-blast-radius secret
   * keys move here (GitHub's "Developer settings" split). Order = frequency + safety
   * (Users → Roles → SSO → Active sessions → Secret keys).                       */
  {
    id: 'admin_users',
    group: 'security_access',
    title: 'Users',
    blurb: 'Add accounts, assign roles, reset passwords, and enable/disable users.',
    icon: UsersIcon,
    perm: { resource: 'users', action: 'manage' },
    keywords: ['users', 'accounts', 'add user', 'reset password', 'enable', 'disable', 'admin', 'identity'],
    Component: () => h(UsersInner),
  },
  {
    // NEW section — split out of Users (RESEARCH_SETTINGS_IA §3.1). Bug #7 fix: the
    // nav gate AND this section gate on the SAME resolvable grant (`roles:manage` —
    // the only meaningful `roles` action beyond `read`, and the grant `RolesInner`
    // needs to edit the matrix). The former nav child gated on a non-existent
    // `roles:view` action; unified here.
    id: 'roles',
    group: 'security_access',
    title: 'Roles & permissions',
    blurb: 'Custom roles, the permission matrix, inheritance, and explicit denies.',
    icon: KeyRound,
    perm: { resource: 'roles', action: 'manage' },
    keywords: ['roles', 'rbac', 'permissions', 'matrix', 'grants', 'denies', 'custom role', 'inherit'],
    Component: () => h(RolesInner),
  },
  {
    id: 'security',
    group: 'security_access',
    title: 'Single sign-on & policy',
    blurb: 'Single sign-on (OIDC) providers and the token / session policy.',
    icon: ShieldCheck,
    perm: { resource: 'settings', action: 'manage' },
    keywords: ['security', 'sso', 'oidc', 'single sign-on', 'google', 'microsoft', 'session policy', 'token', 'idle', 'access ttl', 'csrf', 'rate limit'],
    ownedKeys: ['sso', 'session_policy', 'mfa'],
    Component: (ctx) =>
      h(OrgSecuritySection, { prefs: ctx.prefs, update: ctx.update, configured: ctx.configured }),
  },
  {
    id: 'admin_sessions',
    group: 'security_access',
    title: 'Active sessions',
    blurb: 'Review and force-terminate sessions across all accounts.',
    icon: Network,
    perm: { resource: 'users', action: 'manage' },
    keywords: ['sessions', 'active sessions', 'terminate', 'revoke', 'force sign out', 'admin'],
    Component: () => h(AdminSessionsInner),
  },
  {
    // MOVED here from the old Configuration group — API keys / connector secrets /
    // SSO client secrets are high-blast-radius credentials, not cosmetic prefs
    // (RESEARCH_SETTINGS_IA §3.1; reinforces #10 secret discipline).
    id: 'keys',
    group: 'security_access',
    title: 'Secret keys',
    blurb: 'Write-only API keys for Elasticsearch, LLMs, and enrichment.',
    icon: KeyRound,
    perm: { resource: 'settings', action: 'manage' },
    keywords: ['api key', 'secret', 'credentials', 'token', 'anthropic', 'openai', 'abuseipdb', 'virustotal'],
    Component: (ctx) =>
      h(KeysSection, {
        configured: ctx.configured,
        draft: ctx.secretDraft,
        setDraft: ctx.setSecretDraft,
        onSave: ctx.onSaveSecrets,
        saving: ctx.savingSecrets,
        readOnly: ctx.readOnly,
      }),
  },

  /* ---- Organization (cosmetic + advanced + destructive) ---------------- *
   * Branding → Advanced → Experimental → Danger zone. The Danger zone is a distinct,
   * red, LAST section (isolated per GitHub/Stripe/Notion convention) — it was
   * previously buried inside the Demo section.                                    */
  {
    id: 'appearance',
    group: 'organization',
    title: 'Branding',
    blurb: 'Org wordmark, logo, accent colours, and default theme.',
    icon: Brush,
    perm: { resource: 'settings', action: 'manage' },
    keywords: ['branding', 'appearance', 'theme', 'logo', 'favicon', 'colour', 'color', 'white-label', 'accent'],
    Component: (ctx) => h(BrandingEditor, { readOnly: ctx.readOnly }),
  },
  {
    id: 'advanced',
    group: 'organization',
    title: 'Advanced',
    blurb: 'Caps, kill switch, suppression rules, rule catalog, and the settings lock.',
    icon: SlidersHorizontal,
    perm: { resource: 'settings', action: 'manage' },
    grid: true,
    keywords: ['advanced', 'caps', 'kill switch', 'suppression', 'rule catalog', 'read-only', 'lock', 'budget', 'allowlist'],
    ownedKeys: [
      'caps',
      'auto_forward_allowlist',
      'background_scan_enabled',
      'rag',
      'read_only_settings_mode',
      'excluded_rules',
      'in_scope_rules',
    ],
    Component: (ctx) =>
      h(AdvancedSection, { prefs: ctx.prefs, update: ctx.update, onNavigate: ctx.onNavigate }),
  },
  {
    // Round-5 Sett-C — the schema-driven "Advanced (all settings)" generic renderer. Wires
    // the formerly-dead GET /api/settings/schema into an editable form for the LONG TAIL of
    // engine knobs (anything without a curated home), so a newly-added config field is
    // editable-by-default. Writes through the SAME `{prefs, update}` deep-merge buffer;
    // owns no `ownedKeys` (its edits light the dot on whichever section actually owns the
    // key). `demo` + `read_only_settings_mode` are read-only here (managed elsewhere).
    id: 'advanced_all',
    group: 'organization',
    title: 'All settings',
    blurb: 'Every engine preference, generated from the backend schema — the long tail of knobs.',
    icon: ListTree,
    perm: { resource: 'settings', action: 'manage' },
    grid: true,
    keywords: ['schema', 'all settings', 'advanced', 'generic', 'long tail', 'raw', 'every setting', 'knobs', 'reflector'],
    Component: (ctx) => h(AdvancedSchemaSection, { prefs: ctx.prefs, update: ctx.update }),
  },
  {
    id: 'demo',
    group: 'organization',
    title: 'Experimental & Demo',
    blurb: 'Populate the console with isolated, $0, reversible synthetic data (experimental).',
    icon: FlaskConical,
    perm: { resource: 'settings', action: 'manage' },
    keywords: ['demo', 'experimental', 'sample', 'synthetic', 'sandbox', 'simulated', 'seed', 'try it', 'preview'],
    Component: () => h(DemoModeSection),
  },
  {
    // Isolated, red, LAST (RESEARCH_SETTINGS_IA §3.1 / §5). Destructive resets are
    // never mixed with routine settings; the DangerZone component self-guards with
    // type-to-confirm + fresh-auth.
    id: 'danger',
    group: 'organization',
    title: 'Danger zone',
    blurb: 'Tiered reset of cases, sources, or the whole tenant. Never wipes env secrets.',
    icon: Trash2,
    perm: { resource: 'settings', action: 'manage' },
    keywords: ['danger', 'reset', 'factory reset', 'wipe', 'delete', 'destructive', 'revoke all', 'kill switch'],
    Component: () => h(DangerZone),
  },
];

/* --------------------------------------------------- setting-level index --- *
 * Round-5 Sett-C — the SINGLE source for setting-LEVEL search + card-level deep-links.
 *
 * Each entry names a specific card WITHIN a grid section by its `anchor` (the `id=` on the
 * `SettingsCard`), so search can deepen from section-level to setting-level and a jump can
 * scroll+highlight the exact card via `#/settings?s=<section>&a=<anchor>`. This is a small
 * hand-kept table (the anchors live in the section renderers), deliberately NOT reflected
 * from the schema — it is the operator-facing label + synonyms, not the wire shape. Keep it
 * in sync when a grid section adds/renames a `SettingsCard anchor=`. */
export interface SettingAnchor {
  /** The owning section id. */
  section: SectionId;
  /** The `SettingsCard anchor=` (its DOM `id`), the `&a=` deep-link target. */
  anchor: string;
  /** Human label (the card title). */
  label: string;
  /** Extra search synonyms. */
  keywords: string[];
}

export const SETTING_ANCHORS: readonly SettingAnchor[] = [
  // General › Data scope
  { section: 'general', anchor: 'general-sources', label: 'Data sources', keywords: ['sources', 'connectors', 'feeds'] },
  { section: 'general', anchor: 'general-mapping', label: 'Default log scope & field mapping', keywords: ['index pattern', 'data view', 'field mapping', 'fields', 'entity', 'severity'] },
  { section: 'general', anchor: 'general-polling', label: 'Polling', keywords: ['poll', 'interval', 'batch size', 'lookback', 'cold start'] },
  // General › Detection
  { section: 'detection', anchor: 'detection-correlation', label: 'Correlation', keywords: ['clustering', 'group by', 'window', 'trigger after'] },
  { section: 'detection', anchor: 'detection-risk', label: 'Risk weights', keywords: ['risk', 'weights', 'severity weight', 'asset criticality'] },
  { section: 'detection', anchor: 'detection-escalation', label: 'Escalation', keywords: ['escalation', 'confidence', 'critical severity'] },
  { section: 'detection', anchor: 'detection-autoclose', label: 'Auto-close policy', keywords: ['auto-close', 'autonomy', 'false positive', 'true positive', 'needs human'] },
  { section: 'detection', anchor: 'detection-crosssource', label: 'Cross-source correlation', keywords: ['cross-source', 'link', 'shared entity', 'related cases'] },
  // Integrations › Knowledge & threat context
  { section: 'knowledge', anchor: 'knowledge-rag', label: 'Retrieval (RAG)', keywords: ['rag', 'retrieval', 'top k', 'vector', 'bm25'] },
  { section: 'knowledge', anchor: 'knowledge-threat', label: 'Threat-context panel', keywords: ['threat context', 'ioc', 'mitre', 'reputation'] },
  { section: 'knowledge', anchor: 'knowledge-corpus', label: 'Corpus & procedures', keywords: ['runbooks', 'playbooks', 'resolved cases', 'knowledge corpus'] },
  // Organization › Advanced
  { section: 'advanced', anchor: 'advanced-caps', label: 'Per-case caps', keywords: ['caps', 'budget', 'max tokens', 'max cost', 'concurrency'] },
  { section: 'advanced', anchor: 'advanced-killswitch', label: 'Kill switch', keywords: ['kill switch', 'pause', 'stop', 'disable'] },
  { section: 'advanced', anchor: 'advanced-allowlist', label: 'Auto-forward allowlist', keywords: ['allowlist', 'auto-forward', 'in-scope rules', 'excluded rules'] },
  { section: 'advanced', anchor: 'advanced-suppression', label: 'Suppression & rule catalog', keywords: ['suppression', 'rule catalog', 'detection rules'] },
  { section: 'advanced', anchor: 'advanced-lock', label: 'Settings lock', keywords: ['read-only', 'lock', 'settings lock'] },
];

/* -------------------------------------------------------------- derived ---- */

/** The stable section id union — DERIVED from the registry (single source). */
export type SectionId =
  | 'profile'
  | 'account_security'
  | 'sessions'
  | 'customization'
  | 'general'
  | 'models'
  | 'keys'
  | 'detection'
  | 'cases'
  | 'automation'
  | 'standup'
  | 'notifications'
  | 'security'
  | 'admin_users'
  | 'roles'
  | 'admin_sessions'
  | 'knowledge'
  | 'enrichment'
  | 'appearance'
  | 'advanced'
  | 'advanced_all'
  | 'demo'
  | 'danger';

/** All sections, in registry (rail) order. */
export const ALL_SECTIONS: SettingsSectionDef[] = SETTINGS_SECTIONS;

/** Fast id → section lookup (replaces the render switch). */
export const SECTION_BY_ID: Record<string, SettingsSectionDef> = Object.fromEntries(
  SETTINGS_SECTIONS.map((s) => [s.id, s]),
);

/** Grouped, rail-ordered view derived from the registry. */
export interface SectionGroup {
  id: SectionGroupId;
  label: string;
  sections: SettingsSectionDef[];
}

export const SECTION_GROUPS: SectionGroup[] = SECTION_GROUP_ORDER.map((g) => ({
  id: g.id,
  label: g.label,
  sections: SETTINGS_SECTIONS.filter((s) => s.group === g.id),
})).filter((g) => g.sections.length > 0);

/** Sections that render their OWN full-width SettingsGrid (no outer Card chrome). */
export const GRID_SECTIONS: ReadonlySet<string> = new Set(
  SETTINGS_SECTIONS.filter((s) => s.grid).map((s) => s.id),
);

/** Type guard: is a string a known section id? */
export function isSectionId(v: string): v is SectionId {
  return v in SECTION_BY_ID;
}

/**
 * The per-section dirty-map: section id → the top-level Preferences keys it OWNS.
 * DERIVED from the registry so `settings-dirty.ts` never hand-syncs it again. Only
 * sections that declare `ownedKeys` appear (the embedded bodies / secret keys /
 * enrichment manage their own save lifecycle and own no page-dirty keys).
 */
export const SECTION_KEYS: Record<string, readonly string[]> = Object.fromEntries(
  SETTINGS_SECTIONS.filter((s) => s.ownedKeys && s.ownedKeys.length > 0).map((s) => [
    s.id,
    s.ownedKeys as readonly string[],
  ]),
);

/* ------------------------------------------------------- search / jump ----- *
 * Round-5 Sett-C — shared search helpers used by BOTH the Settings rail filter and the
 * Cmd-K palette so their RBAC filter + matching stay identical (single source). */

/** A Cmd-K / rail jump target: a whole section, or a specific card within one. */
export interface SettingsJumpTarget {
  section: SectionId;
  /** When set, the target is a specific card (`&a=<anchor>`); else the section head. */
  anchor?: string;
  /** Label shown in the palette / result list. */
  label: string;
  /** The section's own title (for grouping / "in <section>" context). */
  sectionTitle: string;
  icon: LucideIcon;
  /** The gating grant (mirrors the section perm) — the caller RBAC-filters on it. */
  perm?: SectionPerm;
}

/** The haystack for one section (title + blurb + keywords), lower-cased once. */
function sectionHaystack(s: SettingsSectionDef): string {
  return [s.title, s.blurb, ...(s.keywords ?? [])].join(' ').toLowerCase();
}

/**
 * All jump targets — every section PLUS every setting-level card anchor — as a flat list,
 * in rail order. The caller (rail filter / palette) applies its own RBAC filter via each
 * target's `perm`, then substring-matches `label`/keywords. Section targets come first so a
 * bare section jump ranks above its cards.
 */
export function allJumpTargets(): SettingsJumpTarget[] {
  const sectionTargets: SettingsJumpTarget[] = SETTINGS_SECTIONS.map((s) => ({
    section: s.id as SectionId,
    label: s.title,
    sectionTitle: s.title,
    icon: s.icon,
    perm: s.perm,
  }));
  const anchorTargets: SettingsJumpTarget[] = SETTING_ANCHORS.map((a) => {
    const parent = SECTION_BY_ID[a.section];
    return {
      section: a.section,
      anchor: a.anchor,
      label: a.label,
      sectionTitle: parent?.title ?? a.section,
      icon: parent?.icon ?? SlidersHorizontal,
      perm: parent?.perm,
    };
  });
  return [...sectionTargets, ...anchorTargets];
}

/**
 * Substring-search the jump targets. `hasPerm` gates a target the caller can't reach; a
 * blank query returns the SECTION targets only (no card noise). Deepens the filter from
 * section-level to setting-level: a term like "auto-close" or "kill switch" now surfaces
 * the exact card, not just its parent section.
 */
export function searchJumpTargets(
  query: string,
  hasPerm: (resource: string, action: string) => boolean,
): SettingsJumpTarget[] {
  const q = query.trim().toLowerCase();
  const targets = allJumpTargets().filter(
    (t) => !t.perm || hasPerm(t.perm.resource, t.perm.action),
  );
  if (!q) return targets.filter((t) => !t.anchor);
  return targets.filter((t) => {
    if (t.anchor) {
      const anchor = SETTING_ANCHORS.find((a) => a.anchor === t.anchor);
      const hay = [t.label, ...(anchor?.keywords ?? [])].join(' ').toLowerCase();
      return hay.includes(q);
    }
    const def = SECTION_BY_ID[t.section];
    return def ? sectionHaystack(def).includes(q) : false;
  });
}

/**
 * Does a section match a query at SECTION or SETTING level? Used by the rail to decide
 * whether to show a section (a match on any of its cards keeps the section visible).
 */
export function sectionMatchesQuery(def: SettingsSectionDef, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (sectionHaystack(def).includes(q)) return true;
  // Setting-level: any card anchor under this section whose label/keywords match.
  return SETTING_ANCHORS.some(
    (a) =>
      a.section === def.id &&
      [a.label, ...a.keywords].join(' ').toLowerCase().includes(q),
  );
}

/**
 * The matching card anchors under a section for a query (empty when none / blank query).
 * Lets the rail render a sub-list of matched settings beneath a section.
 */
export function matchedAnchorsForSection(sectionId: string, query: string): SettingAnchor[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return SETTING_ANCHORS.filter(
    (a) => a.section === sectionId && [a.label, ...a.keywords].join(' ').toLowerCase().includes(q),
  );
}

// Re-export the primitive contract types for section-file convenience.
export type { NavigateFn, SecProps };
