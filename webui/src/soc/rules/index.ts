/**
 * Rules-FE barrel (Round-5 G6 · R2/R3). One import surface for the "Detection &
 * rules" subtree so downstream (the settings section, the future lifecycle/preview
 * agent) imports from `@/soc/rules` rather than reaching into individual files.
 *
 * The load-bearing entry-points a lifecycle/preview agent needs:
 *   - types            → `RuleForm` discriminated union + `RuleTier` + `RULES_PERM`.
 *   - adapter          → deterministic form ⇄ wire mapping (`decide()` byte-identical).
 *   - api              → deep-merge config writes + the pure `previewDecision` wrapper.
 */
export * from './types';
export * from './constants';
export * from './adapter';
export * as rulesApi from './api';

export { ConditionBuilder } from './ConditionBuilder';
export { RuleEditor } from './RuleEditor';
export { DetectionRulesHome } from './DetectionRulesHome';
