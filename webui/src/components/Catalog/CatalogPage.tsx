/**
 * Playbooks & Agents — a read-only catalog of the two declarative knowledge
 * surfaces the triage spine uses:
 *
 *   - Agent personas (`GET /api/personas`): the specialist the router can
 *     specialise the one investigator into, with its focus tools + trigger
 *     keywords.
 *   - Playbooks (`GET /api/playbooks`): the plain-text runbooks, with their match
 *     criteria, suggested tools and the RAG queries they inject.
 *
 * Both are showcase, non-editable views built from the shared `ui` primitives so
 * they read like the rest of the console. Each catalog degrades gracefully to an
 * empty/disabled state when the backend reports the feature off.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  EuiBadge,
  EuiFlexGrid,
  EuiFlexGroup,
  EuiFlexItem,
  EuiPanel,
  EuiSpacer,
  EuiTabbedContent,
  EuiText,
  EuiToolTip,
} from '@elastic/eui';
import type { AgentPersona, Playbook } from '../../lib/types';
import { api } from '../../lib/api';
import { COLORS, chartColor, tint } from '../../lib/theme';
import { humanizeToken } from '../../lib/format';
import { Card, EmptyState, ErrorCallout, Loading, PageHeader } from '../common/ui';

/** Max badges shown inline before collapsing the remainder into a "+N" pill. */
const BADGE_CAP = 6;

/**
 * Semantic icon + accent per known specialist persona, so the catalog reads like
 * the mockup (one colour/glyph per specialty) rather than a rotating palette.
 * Unknown persona ids fall back to a stable palette colour via `chartColor`. All
 * keys/icons are registered in `lib/icons.ts`.
 */
const PERSONA_STYLE: Record<string, { icon: string; accent: string }> = {
  identity_access: { icon: 'key', accent: COLORS.primary },
  web_application: { icon: 'globe', accent: COLORS.accent2 },
  network_recon: { icon: 'crosshairs', accent: COLORS.success },
  malware: { icon: 'bug', accent: COLORS.warning },
  threat_intel: { icon: 'inspect', accent: COLORS.clay },
  generalist: { icon: 'users', accent: COLORS.subdued },
};

/** The persona glyph/accent, semantic when known else a stable palette colour. */
function personaStyle(id: string, index: number): { icon: string; accent: string } {
  return PERSONA_STYLE[id] ?? { icon: 'users', accent: chartColor(index) };
}

/* ----------------------------------------------------------- badge groups -- */

const BadgeRow: React.FC<{
  label: string;
  values?: (string | number)[];
  color?: string;
  icon?: string;
  empty?: string;
  /** Cap the visible badges and collapse the overflow into a "+N" pill. */
  cap?: number;
}> = ({ label, values, color = 'hollow', icon, empty, cap }) => {
  const items = (values ?? []).map((v) => String(v)).filter(Boolean);
  if (!items.length && !empty) return null;
  const limit = typeof cap === 'number' ? cap : items.length;
  const shown = items.slice(0, limit);
  const overflow = items.length - shown.length;
  return (
    <div style={{ marginTop: 10 }}>
      <EuiText size="xs" color="subdued">
        <strong>{label}</strong>
      </EuiText>
      <EuiSpacer size="xs" />
      {items.length ? (
        <EuiFlexGroup gutterSize="xs" wrap responsive={false}>
          {shown.map((v, i) => (
            <EuiFlexItem grow={false} key={`${v}-${i}`}>
              <EuiBadge color={color} iconType={icon}>
                {v}
              </EuiBadge>
            </EuiFlexItem>
          ))}
          {overflow > 0 ? (
            <EuiFlexItem grow={false}>
              <EuiToolTip content={items.slice(limit).join(', ')}>
                <EuiBadge color="hollow">+{overflow}</EuiBadge>
              </EuiToolTip>
            </EuiFlexItem>
          ) : null}
        </EuiFlexGroup>
      ) : (
        <EuiText size="xs" color="subdued">
          <span>{empty}</span>
        </EuiText>
      )}
    </div>
  );
};

/* --------------------------------------------------------------- personas -- */

const PersonaCard: React.FC<{ persona: AgentPersona; index: number }> = ({ persona, index }) => {
  const { icon, accent } = personaStyle(persona.id, index);
  return (
    <Card
      title={persona.label || persona.id}
      icon={icon}
      accent={accent}
      actions={
        <EuiBadge color={tint(accent, 0.16)} style={{ color: accent }}>
          {persona.id}
        </EuiBadge>
      }
    >
      <EuiText size="s">
        <span>{persona.specialization || 'General-purpose specialist.'}</span>
      </EuiText>
      <BadgeRow
        label="Focus tools"
        values={persona.focus_tools}
        color={tint(COLORS.primary, 0.16)}
        icon="wrench"
        empty="No tool focus — uses the default toolset."
        cap={BADGE_CAP}
      />
      <BadgeRow
        label="Trigger keywords"
        values={persona.keywords}
        color="hollow"
        empty="No keywords — selected as a fallback specialist."
        cap={BADGE_CAP}
      />
    </Card>
  );
};

const PersonasCatalog: React.FC = () => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [enabled, setEnabled] = useState(true);
  const [personas, setPersonas] = useState<AgentPersona[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.getPersonas();
      setEnabled(res.enabled);
      setPersonas(res.personas ?? []);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <Loading label="Loading agent personas…" />;
  if (error) return <ErrorCallout error={error} title="Could not load personas" />;
  if (!enabled) {
    return (
      <EmptyState
        iconType="users"
        title="Multi-agent personas are disabled"
        body="The investigator runs as a single generalist. Enable the multi-agent roster on the backend to specialise it per cluster."
      />
    );
  }
  if (!personas.length) {
    return <EmptyState iconType="users" title="No personas registered" body="No specialist personas are configured." />;
  }

  return (
    <>
      <EuiText size="xs" color="subdued">
        <p>
          The router deterministically selects one specialist per cluster; it specialises the single
          investigator with the persona&apos;s focus and tool emphasis.
        </p>
      </EuiText>
      <EuiSpacer size="m" />
      <EuiFlexGrid columns={2} gutterSize="m">
        {personas.map((p, i) => (
          <EuiFlexItem key={p.id}>
            <PersonaCard persona={p} index={i} />
          </EuiFlexItem>
        ))}
      </EuiFlexGrid>
    </>
  );
};

/* -------------------------------------------------------------- playbooks -- */

const PlaybookCard: React.FC<{ playbook: Playbook }> = ({ playbook }) => {
  const m = playbook.match || {
    rule_ids: [],
    entity_types: [],
    mitre: [],
    min_event_count: null,
    any_tags: [],
  };
  return (
    <Card
      title={
        <EuiFlexGroup gutterSize="s" alignItems="center" responsive={false} wrap>
          <EuiFlexItem grow={false}>{playbook.name || playbook.id}</EuiFlexItem>
          {playbook.version ? (
            <EuiFlexItem grow={false}>
              <EuiBadge color="hollow">v{playbook.version}</EuiBadge>
            </EuiFlexItem>
          ) : null}
        </EuiFlexGroup>
      }
      icon="documents"
      accent={COLORS.accent}
      actions={
        typeof playbook.priority === 'number' ? (
          <EuiBadge color={tint(COLORS.warning, 0.18)} style={{ color: COLORS.warning }} iconType="sortUp">
            priority {playbook.priority}
          </EuiBadge>
        ) : null
      }
    >
      {playbook.description ? (
        <EuiText size="s">
          <span>{playbook.description}</span>
        </EuiText>
      ) : null}

      <EuiSpacer size="s" />
      <EuiText size="xs" color="subdued">
        <strong>Match criteria</strong>
      </EuiText>
      <EuiSpacer size="xs" />
      <EuiFlexGroup gutterSize="xs" wrap responsive={false}>
        {(m.rule_ids ?? []).map((r, i) => (
          <EuiFlexItem grow={false} key={`rule-${i}`}>
            <EuiBadge color={tint(COLORS.primary, 0.16)} style={{ color: COLORS.primary }} iconType="tableDensityNormal">
              rule: {r}
            </EuiBadge>
          </EuiFlexItem>
        ))}
        {(m.entity_types ?? []).map((e, i) => (
          <EuiFlexItem grow={false} key={`ent-${i}`}>
            <EuiBadge color={tint(COLORS.success, 0.16)} style={{ color: COLORS.success }} iconType="user">
              {humanizeToken(e)}
            </EuiBadge>
          </EuiFlexItem>
        ))}
        {(m.mitre ?? []).map((t, i) => (
          <EuiFlexItem grow={false} key={`mitre-${i}`}>
            <EuiBadge color={tint(COLORS.danger, 0.16)} style={{ color: COLORS.danger }} iconType="crosshairs">
              {t}
            </EuiBadge>
          </EuiFlexItem>
        ))}
        {(m.any_tags ?? []).map((t, i) => (
          <EuiFlexItem grow={false} key={`tag-${i}`}>
            <EuiBadge color="hollow" iconType="tag">
              {t}
            </EuiBadge>
          </EuiFlexItem>
        ))}
        {typeof m.min_event_count === 'number' ? (
          <EuiFlexItem grow={false}>
            <EuiBadge color="hollow" iconType="number">
              ≥ {m.min_event_count} events
            </EuiBadge>
          </EuiFlexItem>
        ) : null}
        {!(m.rule_ids?.length || m.entity_types?.length || m.mitre?.length || m.any_tags?.length) &&
        typeof m.min_event_count !== 'number' ? (
          <EuiFlexItem grow={false}>
            <EuiText size="xs" color="subdued">
              <span>Matches any cluster (catch-all).</span>
            </EuiText>
          </EuiFlexItem>
        ) : null}
      </EuiFlexGroup>

      <BadgeRow
        label="Suggested tools"
        values={playbook.suggested_tools}
        color={tint(COLORS.primary, 0.16)}
        icon="wrench"
        cap={BADGE_CAP}
      />

      {(playbook.rag_queries ?? []).length ? (
        <div style={{ marginTop: 10 }}>
          <EuiText size="xs" color="subdued">
            <strong>RAG queries</strong>
          </EuiText>
          <EuiSpacer size="xs" />
          <EuiFlexGroup direction="column" gutterSize="xs">
            {playbook.rag_queries.map((q, i) => (
              <EuiFlexItem grow={false} key={`rag-${i}`}>
                <span className="socMono">{q}</span>
              </EuiFlexItem>
            ))}
          </EuiFlexGroup>
        </div>
      ) : null}
    </Card>
  );
};

const PlaybooksCatalog: React.FC = () => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [enabled, setEnabled] = useState(true);
  const [playbooks, setPlaybooks] = useState<Playbook[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.getPlaybooks();
      setEnabled(res.enabled);
      setPlaybooks(res.playbooks ?? []);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <Loading label="Loading playbooks…" />;
  if (error) return <ErrorCallout error={error} title="Could not load playbooks" />;
  if (!enabled) {
    return (
      <EmptyState
        iconType="documents"
        title="Playbooks are disabled"
        body="Enable the plain-text runbook loader on the backend to inject TRUSTED playbook guidance into investigations."
      />
    );
  }
  if (!playbooks.length) {
    return (
      <EmptyState
        iconType="documents"
        title="No playbooks loaded"
        body="Drop Markdown runbooks into the backend's runbooks directory to populate this catalog."
      />
    );
  }

  return (
    <>
      <EuiText size="xs" color="subdued">
        <p>
          Plain-text runbooks selected by match criteria and injected as TRUSTED guidance into the
          investigator (and indexed into RAG). Higher priority wins ties.
        </p>
      </EuiText>
      <EuiSpacer size="m" />
      <EuiFlexGrid columns={2} gutterSize="m">
        {playbooks.map((p) => (
          <EuiFlexItem key={p.id}>
            <PlaybookCard playbook={p} />
          </EuiFlexItem>
        ))}
      </EuiFlexGrid>
    </>
  );
};

/* ------------------------------------------------------------------ page --- */

export const CatalogPage: React.FC = () => {
  const tabs = [
    {
      id: 'personas',
      name: 'Agent personas',
      content: (
        <>
          <EuiSpacer size="l" />
          <PersonasCatalog />
        </>
      ),
    },
    {
      id: 'playbooks',
      name: 'Playbooks',
      content: (
        <>
          <EuiSpacer size="l" />
          <PlaybooksCatalog />
        </>
      ),
    },
  ];

  return (
    <div className="socPageEnter">
      <PageHeader
        icon="inspect"
        accent={COLORS.accent}
        eyebrow="Knowledge"
        title="Playbooks & Agents"
        description="The declarative knowledge the triage spine uses — specialist personas and plain-text runbooks. Read-only."
      />
      <EuiPanel hasBorder paddingSize="l">
        <EuiTabbedContent tabs={tabs} initialSelectedTab={tabs[0]} />
      </EuiPanel>
    </div>
  );
};
