import { SOURCE_MARK_CATALOG } from './assets/source-marks';

/**
 * JSON-safe contract for tooling that needs to discover the Console's reusable
 * visual primitives. It is source metadata only: there is deliberately no running
 * MCP server or network transport in version 0.1.12.
 */
export const DESIGN_SYSTEM_CATALOG = {
  schemaVersion: '1.0.0',
  product: 'Agentic SOC',
  package: '@/design-system',
  status: 'source-catalog',
  tokens: [
    { id: 'color.background', cssVariable: '--background', role: 'page canvas' },
    { id: 'color.surface', cssVariable: '--surface', role: 'raised control surface' },
    { id: 'color.card', cssVariable: '--card', role: 'contained record or editor' },
    { id: 'color.border', cssVariable: '--border', role: 'hairline separation' },
    { id: 'color.foreground', cssVariable: '--foreground', role: 'primary text' },
    { id: 'color.muted-foreground', cssVariable: '--muted-foreground', role: 'secondary text' },
    { id: 'color.primary', cssVariable: '--primary', role: 'focus and operator action' },
    { id: 'motion.fast', cssVariable: '--motion-fast', role: 'small interaction timing' },
    { id: 'motion.standard', cssVariable: '--motion-standard', role: 'state transition timing' },
  ],
  components: [
    {
      id: 'feedback.loading-state',
      module: '@/design-system/loading',
      exportName: 'LoadingState',
      purpose: 'Centered blocking load for a page, panel, or empty table',
      variants: ['page', 'panel', 'table', 'inline'],
      accessibility: ['role=status', 'aria-busy=true', 'visible label', 'reduced-motion safe'],
    },
    {
      id: 'feedback.loading-glyph',
      module: '@/design-system/loading',
      exportName: 'LoadingGlyph',
      purpose: 'Single Fluent/Material-style indeterminate progress ring used inside LoadingState',
      variants: ['sm', 'md', 'lg'],
      accessibility: ['decorative inside a named LoadingState', 'static partial arc under reduced motion'],
    },
    {
      id: 'feedback.loading-bar',
      module: '@/design-system/loading-bar',
      exportName: 'LoadingBar',
      purpose: 'Non-blocking refresh indicator while existing content stays usable',
      variants: ['sm', 'default'],
      accessibility: ['role=progressbar', 'accessible label', 'reduced-motion safe'],
    },
    {
      id: 'asset.source-mark',
      module: '@/design-system/source-mark',
      exportName: 'SourceMark',
      purpose: 'Theme-adaptive vector identity for connector/source types',
      variants: ['sourceType', 'decorative', 'label'],
      accessibility: ['role=img by default', 'decorative mode for adjacent labels'],
    },
    {
      id: 'surface.card',
      module: '@/ui/card',
      exportName: 'Card',
      purpose: 'Border-first contained record, editor, or independent widget surface',
      variants: ['default', 'flat', 'elevation=none', 'elevation=sm'],
      accessibility: ['semantic content slots', 'no resting elevation by default'],
    },
    {
      id: 'navigation.tabs',
      module: '@/ui/tabs',
      exportName: 'Tabs',
      purpose: 'Compact squared navigation between peer panels',
      variants: ['TabsList', 'TabsTrigger', 'TabsContent'],
      accessibility: ['Radix tab semantics', 'roving keyboard focus', 'visible focus ring'],
    },
    {
      id: 'control.segmented',
      module: '@/soc/components/SegmentedControl',
      exportName: 'SegmentedControl',
      purpose: 'Compact single-value selector that is not page navigation',
      variants: ['sm', 'md', 'fitted'],
      accessibility: ['radiogroup semantics', 'arrow-key selection', 'visible focus ring'],
    },
    {
      id: 'layout.control-bar',
      module: '@/soc/components/ControlBar',
      exportName: 'ControlBar',
      purpose: 'Three-zone operational heading and action row',
      variants: ['flat', 'bordered', 'plain', 'sticky', 'primary/secondary slots', 'simple-action overflow'],
      accessibility: [
        'labelled control group when named',
        'primary-first responsive wrapping',
        'focus-managed labelled overflow menu',
      ],
    },
    {
      id: 'layout.filter-bar',
      module: '@/soc/components/FilterBar',
      exportName: 'FilterBar',
      purpose: 'Flat hairline band for filters, refresh state, and result metadata',
      variants: ['default', 'sticky', 'FilterBarGroup'],
      accessibility: ['labelled toolbar', 'responsive wrapping'],
    },
    {
      id: 'data.table',
      module: '@/soc/components/DataTable',
      exportName: 'DataTable',
      purpose: 'Bounded operational record table with sorting, selection, and paging',
      variants: ['compact', 'comfortable', 'selectable', 'paginated'],
      accessibility: ['named table', 'aria-sort', 'keyboard rows', 'announced selection'],
    },
    {
      id: 'feedback.empty-state',
      module: '@/soc/components/EmptyState',
      exportName: 'EmptyState',
      purpose: 'Compact shaped no-data or inline failure state',
      variants: ['default', 'compact', 'error'],
      accessibility: ['plain-text content', 'alert semantics for error variant'],
    },
    {
      id: 'settings.section',
      module: '@/soc/components/SettingsGrid',
      exportName: 'SettingsCard',
      purpose: 'Flat divider-led settings section without nested-card chrome',
      variants: ['default', 'wide', 'full'],
      accessibility: ['real section heading', 'stable deep-link anchor'],
    },
  ],
  assets: SOURCE_MARK_CATALOG,
  futureAgentInterface: {
    catalogExport: 'DESIGN_SYSTEM_CATALOG',
    transport: 'none',
    note: 'This serialisable catalog can back a future MCP resource/tool, but version 0.1.12 ships no MCP server.',
  },
} as const;

export type DesignSystemCatalog = typeof DESIGN_SYSTEM_CATALOG;
