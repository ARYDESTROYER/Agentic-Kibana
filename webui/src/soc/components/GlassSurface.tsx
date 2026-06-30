/**
 * GlassSurface — a frosted "command-center" chrome panel.
 *
 * A backdrop-blurred, tinted surface with a hairline rim, for CHROME ONLY:
 * the app header, sheets/drawers, the command palette, hover popovers. It reads
 * the material-pack chrome vars (`--glass-tint` / `--glass-opacity` / glow) so it
 * is calm in the 'quiet' material and richer in 'command' — with NO change to the
 * underlying colour system.
 *
 * ⚠️ DO NOT use GlassSurface behind data tables, long-form text, or dense
 * dashboards — translucency over scrolling content hurts legibility. Use a solid
 * `Card`/`bg-card` for data. Glass is for transient/overlay chrome only.
 *
 * Accessibility (MANDATORY):
 *   - `@media (prefers-reduced-transparency: reduce)` → the panel becomes a fully
 *     opaque solid surface (no blur), preserving WCAG-AA text contrast. This is
 *     enforced BOTH here (the `glass-surface` class, neutralised in theme.css) and
 *     by the global media rule in theme.css (defence-in-depth).
 *   - `@media (prefers-reduced-motion: reduce)` → no transition shimmer (the global
 *     reduced-motion rule already zeroes transitions; we add no motion of our own).
 *   - The blur is purely decorative; content keeps a solid token background where
 *     it carries text, so nothing depends on the blur to be readable.
 */
import * as React from 'react';
import { cn } from '@/lib/cn';

export interface GlassSurfaceProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Blur radius preset. `sm`≈8px, `md`≈14px, `lg`≈22px. Default `md`. */
  blur?: 'sm' | 'md' | 'lg';
  /** Render a hairline rim border (default true). */
  rim?: boolean;
  /** Add a faint primary glow ring scaled by `--glow-strength` (command pack). */
  glow?: boolean;
  /** Element/tag to render as (default 'div'). Use 'header'/'aside' for semantics. */
  as?: 'div' | 'header' | 'aside' | 'section' | 'nav';
  children?: React.ReactNode;
}

const BLUR_PX: Record<NonNullable<GlassSurfaceProps['blur']>, string> = {
  sm: '8px',
  md: '14px',
  lg: '22px',
};

/**
 * Frosted chrome panel. The fill is `--glass-tint` at `--glass-opacity`; the blur
 * is applied as an inline `backdropFilter` (so it can carry the px preset) and is
 * stripped by the reduced-transparency media rule via the `glass-surface` class.
 */
export const GlassSurface = React.forwardRef<HTMLDivElement, GlassSurfaceProps>(
  ({ blur = 'md', rim = true, glow = false, as = 'div', className, style, children, ...rest }, ref) => {
    const Tag = as as 'div';
    const px = BLUR_PX[blur];
    return (
      <Tag
        ref={ref as React.Ref<HTMLDivElement>}
        className={cn(
          // The marker class theme.css uses to neutralise blur under
          // prefers-reduced-transparency. Keep it FIRST so call-site overrides win.
          'glass-surface',
          // Token-fill at the material opacity; a hairline rim; optional glow ring.
          'relative isolate',
          rim && 'border border-border/70',
          glow && 'shadow-[0_0_0_1px_hsl(var(--primary)/calc(var(--glow-strength)*0.4)),0_8px_40px_-12px_hsl(var(--primary)/calc(var(--glow-strength)*0.5))]',
          className,
        )}
        style={{
          // Translucent token fill — alpha from the material pack.
          backgroundColor: 'hsl(var(--glass-tint) / var(--glass-opacity))',
          // Decorative blur (removed under reduced-transparency by theme.css).
          backdropFilter: `blur(${px}) saturate(1.4)`,
          WebkitBackdropFilter: `blur(${px}) saturate(1.4)`,
          ...style,
        }}
        {...rest}
      >
        {children}
      </Tag>
    );
  },
);
GlassSurface.displayName = 'GlassSurface';

export default GlassSurface;
