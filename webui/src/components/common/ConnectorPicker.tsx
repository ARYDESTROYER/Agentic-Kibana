/**
 * ConnectorPicker — pick a connector from the catalog, grouped by category
 * (SIEM / EDR-XDR / transports / queues / object-store). Used in the wizard's
 * "Add your first source" step and the Sources manager's "Add source" flow.
 */
import React, { useMemo, useState } from 'react';
import {
  EuiBadge,
  EuiFieldSearch,
  EuiFlexGrid,
  EuiFlexGroup,
  EuiFlexItem,
  EuiIcon,
  EuiPanel,
  EuiSpacer,
  EuiText,
  EuiTitle,
} from '@elastic/eui';
import type { ConnectorManifest } from '../../lib/types';
import { categoryMeta, COLORS } from '../../lib/theme';
import { EmptyState, IconChip } from './ui';

interface ConnectorPickerProps {
  connectors: ConnectorManifest[];
  selected?: string;
  onSelect: (manifest: ConnectorManifest) => void;
}

/** Stable category display order. */
const CATEGORY_ORDER = ['siem', 'edr_xdr', 'transport', 'queue', 'object_store', 'file'];

export const ConnectorPicker: React.FC<ConnectorPickerProps> = ({
  connectors,
  selected,
  onSelect,
}) => {
  const [query, setQuery] = useState('');

  // Filter against the connector name, type and description (fixed catalog text).
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return connectors;
    return connectors.filter((c) =>
      `${c.display_name} ${c.source_type} ${c.description || ''}`.toLowerCase().includes(q),
    );
  }, [connectors, query]);

  const grouped = useMemo(() => {
    const map = new Map<string, ConnectorManifest[]>();
    for (const c of filtered) {
      const cat = c.category || 'other';
      if (!map.has(cat)) map.set(cat, []);
      map.get(cat)!.push(c);
    }
    const cats = Array.from(map.keys()).sort((a, b) => {
      const ia = CATEGORY_ORDER.indexOf(a);
      const ib = CATEGORY_ORDER.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    return cats.map((cat) => ({
      cat,
      meta: categoryMeta(cat),
      items: map
        .get(cat)!
        .slice()
        .sort((a, b) => a.display_name.localeCompare(b.display_name)),
    }));
  }, [filtered]);

  return (
    <div>
      <EuiFieldSearch
        fullWidth
        placeholder="Search connectors…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        isClearable
        aria-label="Search connectors"
        append={
          <EuiText size="xs" color="subdued" style={{ alignSelf: 'center', paddingRight: 8, whiteSpace: 'nowrap' }}>
            {filtered.length} of {connectors.length} connectors
          </EuiText>
        }
      />
      <EuiSpacer size="m" />
      {grouped.length === 0 ? (
        <EmptyState
          iconType="search"
          title="No matching connectors"
          body="No connector matches your search. Try a different term or clear the search."
        />
      ) : null}
      {grouped.map(({ cat, meta, items }) => (
        <div key={cat}>
          <EuiText size="xs" color="subdued">
            <strong style={{ textTransform: 'uppercase', letterSpacing: 0.5 }}>
              {meta.label}
            </strong>
          </EuiText>
          <EuiSpacer size="s" />
          <EuiFlexGrid columns={3} gutterSize="m">
            {items.map((c) => {
              const isSel = selected === c.source_type;
              return (
                <EuiFlexItem key={c.source_type}>
                  <EuiPanel
                    hasBorder
                    paddingSize="m"
                    color={isSel ? 'primary' : 'plain'}
                    style={{ cursor: 'pointer', height: '100%' }}
                    onClick={() => onSelect(c)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e: React.KeyboardEvent) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onSelect(c);
                      }
                    }}
                    aria-pressed={isSel}
                    aria-label={`Select ${c.display_name}`}
                  >
                    <EuiFlexGroup
                      gutterSize="s"
                      alignItems="center"
                      justifyContent="spaceBetween"
                      responsive={false}
                    >
                      <EuiFlexItem grow={false}>
                        <IconChip icon={meta.icon} accent={meta.accent} />
                      </EuiFlexItem>
                      {isSel ? (
                        <EuiFlexItem grow={false}>
                          <EuiIcon type="checkInCircleFilled" color={COLORS.primary} />
                        </EuiFlexItem>
                      ) : null}
                    </EuiFlexGroup>
                    <EuiSpacer size="s" />
                    <EuiTitle size="xxs">
                      <h4>{c.display_name}</h4>
                    </EuiTitle>
                    <EuiText size="xs" color="subdued">
                      <span>{c.description || c.source_type}</span>
                    </EuiText>
                    <EuiSpacer size="xs" />
                    <div>
                      {(c.ingest_modes || []).slice(0, 3).map((m) => (
                        <EuiBadge key={m} color="hollow">
                          {m}
                        </EuiBadge>
                      ))}
                    </div>
                  </EuiPanel>
                </EuiFlexItem>
              );
            })}
          </EuiFlexGrid>
          <EuiSpacer size="l" />
        </div>
      ))}
    </div>
  );
};
