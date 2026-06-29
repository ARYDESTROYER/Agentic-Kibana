/**
 * TabbedPage — a thin scaffold for the Round-2 W4 page-consolidation hosts.
 *
 * Several formerly top-level pages now live as sub-views of a single host page
 * (Workspace = Chat | Investigate, Analytics = Metrics | Cost, Overview =
 * Dashboard | Standup, Intelligence = Knowledge | Memory | Catalog). This helper
 * renders an optional unified PageHeader + a segmented tab bar, and switches the
 * body between the embedded sub-pages.
 *
 * The active tab is driven by `value` (the host derives it from `NavOpts.tab` so
 * deep-links + in-app `navigate(page, { tab })` work) with a local fallback so the
 * bar stays interactive even when the route opts are not URL-persisted. All labels
 * render as plain text (#9 — these are static, operator-facing strings).
 */
import * as React from 'react';
import type { LucideIcon } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/ui/tabs';
import { PageHeader, type PageHeaderProps } from '@/soc/components/PageHeader';

export interface TabSpec {
  /** Stable tab id (matches the `NavOpts.tab` value used for deep-links). */
  value: string;
  /** Plain-text tab label. */
  label: string;
  /** Optional leading icon. */
  icon?: LucideIcon;
  /** The tab body (typically an embedded sub-page). */
  content: React.ReactNode;
}

export interface TabbedPageProps {
  /** Optional unified page header (omit for hosts whose sub-pages own a hero). */
  header?: PageHeaderProps;
  /** The sub-views, rendered as a segmented control. */
  tabs: TabSpec[];
  /** The desired active tab (usually `opts?.tab`); falls back to the first tab. */
  value?: string;
  /** Fires when the user picks a tab — hosts mirror it into the route opts. */
  onValueChange?: (value: string) => void;
}

/**
 * Resolve the active tab: the requested `value` if it names a known tab, else the
 * first tab. Kept in a controlled `Tabs` so an external deep-link change applies.
 */
export function TabbedPage({ header, tabs, value, onValueChange }: TabbedPageProps) {
  const ids = tabs.map((t) => t.value);
  const fallback = ids[0];
  const requested = value && ids.includes(value) ? value : fallback;

  // Local mirror so clicks are instant even when the host does not (or cannot)
  // round-trip the tab into the URL; an external `value` change overrides it.
  const [active, setActive] = React.useState<string>(requested);
  React.useEffect(() => {
    setActive(requested);
  }, [requested]);

  const handleChange = React.useCallback(
    (next: string) => {
      setActive(next);
      onValueChange?.(next);
    },
    [onValueChange],
  );

  return (
    <div className="space-y-6">
      {header ? <PageHeader {...header} /> : null}
      <Tabs value={active} onValueChange={handleChange}>
        <TabsList>
          {tabs.map((t) => {
            const Icon = t.icon;
            return (
              <TabsTrigger key={t.value} value={t.value} className="gap-2">
                {Icon ? <Icon className="h-4 w-4" aria-hidden /> : null}
                {t.label}
              </TabsTrigger>
            );
          })}
        </TabsList>
        {tabs.map((t) => (
          <TabsContent key={t.value} value={t.value} className="mt-6">
            {/* Mount every tab's body but keep inactive ones in the DOM via Radix
                (forceMount is off → unmounted when inactive, which resets sub-page
                state on switch; acceptable — each sub-page reloads its own data). */}
            {t.content}
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}

export default TabbedPage;
