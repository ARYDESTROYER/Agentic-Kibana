/**
 * Tailwind config scoped for the shadcn/ui-based pages (Overview + Cases).
 *
 * - `preflight` is DISABLED so Tailwind's global reset never touches the other
 *   @elastic/eui pages — only opt-in utility classes are emitted.
 * - Dark mode follows the app's existing `[data-theme="dark"]` attribute (set on
 *   <html> by lib/theme.setTheme), NOT a `.dark` class.
 * - Colour tokens reference the EXISTING CSS variables (defined in index.css),
 *   which already flip on `[data-theme]` — so shadcn surfaces inherit the same
 *   dark/light theme and the runtime `--soc-accent` brand colour automatically.
 */
import tailwindcssAnimate from 'tailwindcss-animate';

export default {
  darkMode: ['selector', '[data-theme="dark"]'],
  content: ['./src/**/*.{ts,tsx}'],
  corePlugins: { preflight: false },
  theme: {
    extend: {
      colors: {
        border: 'var(--sn-border)',
        input: 'var(--sn-input)',
        ring: 'var(--sn-ring)',
        background: 'var(--sn-background)',
        foreground: 'var(--sn-foreground)',
        primary: { DEFAULT: 'var(--sn-primary)', foreground: 'var(--sn-primary-foreground)' },
        secondary: { DEFAULT: 'var(--sn-secondary)', foreground: 'var(--sn-secondary-foreground)' },
        destructive: { DEFAULT: 'var(--sn-destructive)', foreground: 'var(--sn-destructive-foreground)' },
        muted: { DEFAULT: 'var(--sn-muted)', foreground: 'var(--sn-muted-foreground)' },
        accent: { DEFAULT: 'var(--sn-accent)', foreground: 'var(--sn-accent-foreground)' },
        card: { DEFAULT: 'var(--sn-card)', foreground: 'var(--sn-card-foreground)' },
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      keyframes: {
        'accordion-down': { from: { height: '0' }, to: { height: 'var(--radix-accordion-content-height)' } },
        'accordion-up': { from: { height: 'var(--radix-accordion-content-height)' }, to: { height: '0' } },
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
      },
    },
  },
  plugins: [tailwindcssAnimate],
};
