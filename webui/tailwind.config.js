import tailwindcssAnimate from 'tailwindcss-animate';
import containerQueries from '@tailwindcss/container-queries';

/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    container: { center: true, padding: '1.5rem', screens: { '2xl': '1440px' } },
    extend: {
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        /** App canvas (one notch behind cards) + a soft elevated surface. */
        canvas: 'hsl(var(--canvas))',
        surface: 'hsl(var(--surface))',
        /** Round-3 tint aliases — a preset can nudge the backdrop/surface tint
            independently of the card colour (both default to canvas/surface). */
        'canvas-tint': 'hsl(var(--canvas-tint))',
        'surface-tint': 'hsl(var(--surface-tint))',
        /** The glass-panel base tint (consumed by GlassSurface). */
        glass: 'hsl(var(--glass-tint))',
        primary: { DEFAULT: 'hsl(var(--primary))', foreground: 'hsl(var(--primary-foreground))' },
        secondary: { DEFAULT: 'hsl(var(--secondary))', foreground: 'hsl(var(--secondary-foreground))' },
        muted: { DEFAULT: 'hsl(var(--muted))', foreground: 'hsl(var(--muted-foreground))' },
        accent: { DEFAULT: 'hsl(var(--accent))', foreground: 'hsl(var(--accent-foreground))' },
        /** NOTE: the `--destructive` token is DEAD (W0-A §1.2) — deleted from
            theme.css. Every `destructive` VARIANT (button/badge/alert) resolves to
            `--critical` directly, so there is no `destructive` color entry here. */
        card: { DEFAULT: 'hsl(var(--card))', foreground: 'hsl(var(--card-foreground))' },
        popover: { DEFAULT: 'hsl(var(--popover))', foreground: 'hsl(var(--popover-foreground))' },
        /** Optional secondary brand accent (login hero aurora). Falls back to the
            primary hue when `--accent2` is not set by branding. */
        accent2: 'hsl(var(--accent2, var(--primary)))',
        /** Semantic SOC severity / status / verdict scale (light+dark aware).
            NEW (W0-A §1.2): explicit sunken well + interactive hover + strong
            (structural/interactive) border. `--accent` stays the NEUTRAL selected
            surface; `--hover` is one notch below it for interactive hover; and
            `--border-strong` (≥3:1) is used wherever a border is the ONLY thing
            conveying a control/focus edge (form controls, focusable rows). */
        'surface-sunken': 'hsl(var(--surface-sunken))',
        hover: 'hsl(var(--hover))',
        'border-strong': 'hsl(var(--border-strong))',
        /** On-color / standalone-text companions for the 3 semantic axes (W0-A
            §1.3). `<axis>` is the solid fill; `<axis>-foreground` is AA text ON that
            fill; `<axis>-text` is the AA standalone text/tint color on a card. */
        critical: {
          DEFAULT: 'hsl(var(--critical))',
          foreground: 'hsl(var(--critical-foreground))',
          text: 'hsl(var(--critical-text))',
        },
        high: {
          DEFAULT: 'hsl(var(--high))',
          foreground: 'hsl(var(--high-foreground))',
          text: 'hsl(var(--high-text))',
        },
        medium: {
          DEFAULT: 'hsl(var(--medium))',
          foreground: 'hsl(var(--medium-foreground))',
          text: 'hsl(var(--medium-text))',
        },
        low: {
          DEFAULT: 'hsl(var(--low))',
          foreground: 'hsl(var(--low-foreground))',
          text: 'hsl(var(--low-text))',
        },
        info: {
          DEFAULT: 'hsl(var(--info))',
          foreground: 'hsl(var(--info-foreground))',
          text: 'hsl(var(--info-text))',
        },
        success: {
          DEFAULT: 'hsl(var(--success))',
          foreground: 'hsl(var(--success-foreground))',
          text: 'hsl(var(--success-text))',
        },
        warning: {
          DEFAULT: 'hsl(var(--warning))',
          foreground: 'hsl(var(--warning-foreground))',
          text: 'hsl(var(--warning-text))',
        },
        danger: {
          DEFAULT: 'hsl(var(--danger))',
          foreground: 'hsl(var(--danger-foreground))',
          text: 'hsl(var(--danger-text))',
        },
        /** Colorblind-safe categorical chart ramp (Okabe-Ito; W0-A §1.4). Used for
            IDENTITY-ARBITRARY series (per-model bars, cost). Semantic charts keep the
            severity/status/verdict tokens above. */
        'chart-1': 'hsl(var(--chart-1))',
        'chart-2': 'hsl(var(--chart-2))',
        'chart-3': 'hsl(var(--chart-3))',
        'chart-4': 'hsl(var(--chart-4))',
        'chart-5': 'hsl(var(--chart-5))',
        'chart-6': 'hsl(var(--chart-6))',
        'chart-7': 'hsl(var(--chart-7))',
        'chart-8': 'hsl(var(--chart-8))',
      },
      /** The type scale (W0-A §2.3). Redefining what `xs`/`sm`/`base` resolve to
          upgrades the whole app with zero JSX churn (806/855 usages are xs/sm).
          Line-heights are fixed rem on 4px multiples (snap to the 8px grid). */
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '0.875rem', letterSpacing: '0.02em' }], // 11/14 — badges/timestamps only
        xs: ['0.75rem', { lineHeight: '1rem', letterSpacing: '0.01em' }], // 12/16 — labels, table meta, chips
        sm: ['0.8125rem', { lineHeight: '1.125rem' }], // 13/18 — dense table cells
        base: ['0.875rem', { lineHeight: '1.25rem' }], // 14/20 — PRIMARY body/UI default
        md: ['0.9375rem', { lineHeight: '1.375rem' }], // 15/22 — comfortable reading panels
        lg: ['1rem', { lineHeight: '1.5rem' }], // 16/24 — long-form / card titles
        xl: ['1.125rem', { lineHeight: '1.5rem', fontWeight: '600' }], // 18/24 — H3
        '2xl': ['1.25rem', { lineHeight: '1.625rem', letterSpacing: '-0.01em', fontWeight: '600' }], // 20/26 — H2 page heading
        '3xl': ['1.5rem', { lineHeight: '1.875rem', letterSpacing: '-0.015em', fontWeight: '650' }], // 24/30 — H1
        '4xl': ['1.875rem', { lineHeight: '2.25rem', letterSpacing: '-0.02em', fontWeight: '650' }], // 30/36 — hero/display
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
        /** Round-3 explicit radius scale (operator-tunable via theme tokens). The
            three above stay anchored to `--radius` for back-compat; these expose
            the full scale for new chrome (xl panels, sm chips). */
        'r-sm': 'var(--radius-sm)',
        'r-md': 'var(--radius-md)',
        'r-lg': 'var(--radius-lg)',
        'r-xl': 'var(--radius-xl)',
      },
      fontFamily: {
        /* The family strings MUST match the shipped Fontsource exports (W0-A §2.1):
           Inter variable exports 'Inter Variable'; JetBrains Mono exports
           'JetBrains Mono'. 'Inter' stays as a fallback for any statically-installed
           copy, then the OS stack. */
        sans: [
          '"Inter Variable"',
          'Inter',
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'Roboto',
          'sans-serif',
        ],
        mono: ['"JetBrains Mono"', 'SFMono-Regular', 'Consolas', 'Menlo', 'monospace'],
        /** Operator-selectable display family for hero titles; falls back to the
            sans stack when `--font-display` is unset by branding. */
        display: ['var(--font-display)', '"Inter Variable"', 'Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        /* Elevation tokens (W0-A §1.5). Per-theme `--shadow-color` + composed levels
           live in theme.css so shadows are theme-correct (invisible fixed-navy on a
           dark canvas is gone) and brandable. Rule: borders for tiled/scrolled
           content; shadows only for detached floating portals.
             - elev1 → resting tiles (optional; border-first)
             - elev2 → the standard portal elevation
             - menu  → dropdown/select/context menus
             - overlay → dialog/sheet/popover portals
           `glow` stays a primary-tinted focus/brand ring (opt-in). */
        glow: '0 0 0 1px hsl(var(--primary) / 0.18), 0 4px 16px -8px hsl(var(--primary) / 0.22)',
        elev1: 'var(--elev-1)',
        elev2: 'var(--elev-2)',
        menu: 'var(--shadow-menu)',
        overlay: 'var(--shadow-overlay)',
      },
      backgroundImage: {
        /* Whisper-soft hero wash — calm, not the old command-center glow. */
        'hero-glow':
          'radial-gradient(120% 140% at 0% 0%, hsl(var(--primary) / 0.07) 0%, transparent 60%), radial-gradient(120% 140% at 100% 0%, hsl(var(--accent) / 0.05) 0%, transparent 60%)',
        'accent-bar': 'linear-gradient(90deg, hsl(var(--primary)) 0%, hsl(var(--accent)) 100%)',
      },
      /** Round-7 W0.1 — the app-wide motion dial. The `--motion-*` tokens live in
          theme.css (one place to retune tempo); these named utilities wire them into
          Tailwind so authors write `duration-base ease-premium` instead of ad-hoc
          `duration-200`. `standard` = the calm UI easing; `premium` = the confident
          entrance curve (cubic-bezier(0.16,1,0.3,1)) already used by fade/rise. Both
          resolve through a token with a literal fallback so they work even if theme.css
          has not defined the var. Reduced-motion is neutralised globally (theme.css). */
      transitionDuration: {
        fast: 'var(--motion-fast)',
        base: 'var(--motion-base)',
        slow: 'var(--motion-slow)',
      },
      transitionTimingFunction: {
        standard: 'var(--motion-ease-standard, cubic-bezier(0.2, 0, 0, 1))',
        premium: 'var(--motion-ease-premium, cubic-bezier(0.16, 1, 0.3, 1))',
      },
      keyframes: {
        'accordion-down': { from: { height: '0' }, to: { height: 'var(--radix-accordion-content-height)' } },
        'accordion-up': { from: { height: 'var(--radix-accordion-content-height)' }, to: { height: '0' } },
        shimmer: { '100%': { transform: 'translateX(100%)' } },
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        'rise-in': { from: { opacity: '0', transform: 'translateY(8px)' }, to: { opacity: '1', transform: 'translateY(0)' } },
        /* Round-7 W0.1 — a gentle grow-in for cards/gauges/count-up tiles. Opacity +
           a small scale (never below 0.96 so text stays legible mid-tween). Paired
           with the `animate-scale-in` util below; reduced-motion collapses it. */
        'scale-in': { from: { opacity: '0', transform: 'scale(0.96)' }, to: { opacity: '1', transform: 'scale(1)' } },
        /* Round-8 ★8 — the Noise-Reduction flow ribbons grow in L→R from their left
           edge (paired with `transform-box:fill-box; transform-origin:0% 50%` inline
           on each SVG <path>, plus a per-strand animation-delay stagger). Never scales
           fully to 0 so a strand is briefly visible mid-tween; reduced-motion collapses
           the duration globally (theme.css). */
        'ribbon-grow': { from: { opacity: '0', transform: 'scaleX(0.04)' }, to: { opacity: '1', transform: 'scaleX(1)' } },
        'bar-indeterminate': { '0%': { transform: 'translateX(-100%)' }, '100%': { transform: 'translateX(350%)' } },
        pulse: { '0%,100%': { opacity: '1' }, '50%': { opacity: '0.55' } },
        /* Round-5 Sett-C — the deep-link (`&a=<anchor>`) card highlight: a brief ring
           flash (color/box-shadow only, NO transform) so it is reduced-motion-safe. Under
           `prefers-reduced-motion` the global reset collapses the duration to ~0 and the JS
           driver instead paints a static ring for ~1.4s (see Settings.tsx). */
        'settings-highlight': {
          '0%': { boxShadow: '0 0 0 0 hsl(var(--ring) / 0)' },
          '12%': { boxShadow: '0 0 0 3px hsl(var(--ring) / 0.55)' },
          '100%': { boxShadow: '0 0 0 0 hsl(var(--ring) / 0)' },
        },
        /* Login brand-hero entrances (CSS replacements for the former framer-motion
           pieces, so the login screen no longer pulls framer-motion onto first paint). */
        'hero-in-down': { from: { opacity: '0', transform: 'translateY(-8px)' }, to: { opacity: '1', transform: 'translateY(0)' } },
        'hero-in-up': { from: { opacity: '0', transform: 'translateY(12px)' }, to: { opacity: '1', transform: 'translateY(0)' } },
        /* The two slow-drifting aurora blobs. `alternate` + `infinite` mirrors the
           old framer-motion `repeat: Infinity, repeatType: 'mirror'` loop. */
        'aurora-a': {
          '0%': { transform: 'translate(0,0) scale(1)' },
          '33%': { transform: 'translate(40px,30px) scale(1.12)' },
          '66%': { transform: 'translate(-10px,60px) scale(1.05)' },
          '100%': { transform: 'translate(0,0) scale(1)' },
        },
        'aurora-b': {
          '0%': { transform: 'translate(0,0) scale(1)' },
          '33%': { transform: 'translate(-30px,-20px) scale(1.08)' },
          '66%': { transform: 'translate(20px,-50px) scale(1.15)' },
          '100%': { transform: 'translate(0,0) scale(1)' },
        },
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
        shimmer: 'shimmer 1.8s ease-in-out infinite',
        'fade-in': 'fade-in 0.24s cubic-bezier(0.16,1,0.3,1) both',
        'rise-in': 'rise-in 0.24s cubic-bezier(0.16,1,0.3,1) both',
        'scale-in': 'scale-in 0.2s cubic-bezier(0.16,1,0.3,1) both',
        'ribbon-grow': 'ribbon-grow 0.5s cubic-bezier(0.16,1,0.3,1) both',
        'bar-indeterminate': 'bar-indeterminate 1.1s ease-in-out infinite',
        'settings-highlight': 'settings-highlight 1.6s cubic-bezier(0.16,1,0.3,1) both',
        'hero-in-down': 'hero-in-down 0.5s cubic-bezier(0.16,1,0.3,1) both',
        'hero-in-up': 'hero-in-up 0.55s cubic-bezier(0.16,1,0.3,1) 0.08s both',
        'aurora-a': 'aurora-a 22s ease-in-out infinite alternate',
        'aurora-b': 'aurora-b 28s ease-in-out infinite alternate',
      },
    },
  },
  plugins: [tailwindcssAnimate, containerQueries],
};
