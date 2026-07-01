/**
 * Rules-FE lifecycle barrel (Round-5 G6 · R5). One import surface for the per-rule
 * lifecycle surface — test/preview, immutable version ledger + diff + rollback, and
 * the enabled/disabled/shadow state control.
 *
 * Consumers (the "Detection & rules" home) import from `@/soc/rules/lifecycle`:
 *   - `RuleLifecycleSheet` — the whole surface in a Sheet (Preview + History + state).
 *   - `RulePreviewPanel`   — the read-only, no-LLM match-count preview (standalone).
 *   - `RuleVersionLedger`  — the immutable version list + diff + rollback (standalone).
 *   - `DiffView`           — the dep-free red/green field diff.
 *   - `LifecycleStateChip` / `RuleHealthChip` — the row chips + `deriveHealth`.
 *
 * Nothing here calls `decide()` (#3); the preview never bills the LLM (#6); every
 * value renders plain (#9); state changes + rollbacks are append-only audited (#2).
 */
export * from './types';
export { diffConfigs, hasChanges } from './diff';
export { predicatesForPreview } from './preview-adapter';
export type { PreviewPredicate } from './preview-adapter';
export { DiffView } from './DiffView';
export { LifecycleStateChip, RuleHealthChip, deriveHealth } from './chips';
export { RulePreviewPanel } from './RulePreviewPanel';
export { RuleVersionLedger } from './RuleVersionLedger';
export { RuleLifecycleSheet } from './RuleLifecycleSheet';
