// @ts-check
/**
 * Minimal, SCOPED ESLint flat config for the webui.
 *
 * The single load-bearing goal is the React Rules-of-Hooks guard:
 *   `react-hooks/rules-of-hooks` = "error".
 * That rule catches the React #310 class of bug ("Rendered more hooks than
 * during the previous render") that fires when a hook (useState, useMemo,
 * useEffect, useCallback, useRef, useId, or a custom use-prefixed hook such as
 * useAuth) runs AFTER a conditional early return in the same component —
 * exactly the pattern Wave 7's loading-skeleton early returns introduced.
 *
 * Everything else is intentionally kept quiet so this config does NOT erupt
 * with hundreds of unrelated style errors:
 *   - we do NOT extend the full recommended TS/JS rule sets,
 *   - `react-hooks/exhaustive-deps` is "warn" (not "error") to avoid flooding.
 * This is a focused hooks guard, not a full lint overhaul.
 *
 * Round-5 W0-E E4 adds `eslint-plugin-jsx-a11y` at "warn" (NOT "error"): it surfaces
 * accessibility issues (missing alt text, label association, aria misuse, …) as advisory
 * warnings so the A11Y-PASS wave can burn them down, WITHOUT breaking `npm run lint`
 * (which must stay at 0 ERRORS — only `react-hooks/rules-of-hooks` is an error). A future
 * wave may promote individual a11y rules to "error" as surfaces are cleaned (warn→error
 * rollout, DESIGN_STANDARD §12 / IMPLEMENTATION E4).
 */
import reactHooks from 'eslint-plugin-react-hooks';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // Only lint the app source; ignore build output, deps, and configs.
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', '*.config.{js,ts}'],
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    // Don't flag pre-existing `// eslint-disable …` comments as unused just
    // because this scoped config doesn't enable the rule they silence.
    linterOptions: {
      reportUnusedDisableDirectives: 'off',
    },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      'react-hooks': reactHooks,
      // Accessibility lint (W0-E E4) — surfaces a11y issues as advisory warnings.
      'jsx-a11y': jsxA11y,
      // Registered so the codebase's existing inline
      // `// eslint-disable-next-line @typescript-eslint/...` directives resolve
      // to a known rule (otherwise ESLint 9 errors on the unknown rule name).
      // The rules below are deliberately left OFF — this config is a hooks
      // guard, not a TypeScript style overhaul.
      '@typescript-eslint': tseslint.plugin,
    },
    rules: {
      // THE guard — keep this as an error forever.
      'react-hooks/rules-of-hooks': 'error',
      // Helpful but noisy; warn-only so it never blocks and never floods.
      'react-hooks/exhaustive-deps': 'warn',
      // Accessibility: the plugin's recommended rule set, downgraded to WARN so the
      // lint gate stays at 0 ERRORS (only rules-of-hooks is an error). This spreads the
      // recommended config's rules and forces every one to "warn" (the recommended set
      // marks some as "error"; we do not want those to break `npm run lint` yet).
      ...Object.fromEntries(
        Object.keys(jsxA11y.configs.recommended.rules).map((rule) => [rule, 'warn']),
      ),
      // Off (registered only so existing disable-directives are recognised).
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
);
