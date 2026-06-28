import tailwindcssAnimate from 'tailwindcss-animate';

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
        primary: { DEFAULT: 'hsl(var(--primary))', foreground: 'hsl(var(--primary-foreground))' },
        secondary: { DEFAULT: 'hsl(var(--secondary))', foreground: 'hsl(var(--secondary-foreground))' },
        muted: { DEFAULT: 'hsl(var(--muted))', foreground: 'hsl(var(--muted-foreground))' },
        accent: { DEFAULT: 'hsl(var(--accent))', foreground: 'hsl(var(--accent-foreground))' },
        destructive: { DEFAULT: 'hsl(var(--destructive))', foreground: 'hsl(var(--destructive-foreground))' },
        card: { DEFAULT: 'hsl(var(--card))', foreground: 'hsl(var(--card-foreground))' },
        popover: { DEFAULT: 'hsl(var(--popover))', foreground: 'hsl(var(--popover-foreground))' },
        /** Semantic SOC severity / status / verdict scale (light+dark aware). */
        critical: 'hsl(var(--critical))',
        high: 'hsl(var(--high))',
        medium: 'hsl(var(--medium))',
        low: 'hsl(var(--low))',
        info: 'hsl(var(--info))',
        success: 'hsl(var(--success))',
        warning: 'hsl(var(--warning))',
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'SFMono-Regular', 'Consolas', 'Menlo', 'monospace'],
      },
      boxShadow: {
        glow: '0 0 0 1px hsl(var(--primary) / 0.25), 0 8px 30px -8px hsl(var(--primary) / 0.35)',
        elev1: '0 1px 2px hsl(222 47% 4% / 0.18), 0 2px 8px hsl(222 47% 4% / 0.14)',
        elev2: '0 12px 40px -12px hsl(222 47% 4% / 0.45)',
      },
      backgroundImage: {
        'hero-glow':
          'radial-gradient(120% 140% at 0% 0%, hsl(var(--primary) / 0.18) 0%, transparent 55%), radial-gradient(120% 140% at 100% 0%, hsl(var(--accent) / 0.14) 0%, transparent 55%)',
        'accent-bar': 'linear-gradient(90deg, hsl(var(--accent)) 0%, hsl(var(--primary)) 100%)',
      },
      keyframes: {
        'accordion-down': { from: { height: '0' }, to: { height: 'var(--radix-accordion-content-height)' } },
        'accordion-up': { from: { height: 'var(--radix-accordion-content-height)' }, to: { height: '0' } },
        shimmer: { '100%': { transform: 'translateX(100%)' } },
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        'rise-in': { from: { opacity: '0', transform: 'translateY(8px)' }, to: { opacity: '1', transform: 'translateY(0)' } },
        'bar-indeterminate': { '0%': { transform: 'translateX(-100%)' }, '100%': { transform: 'translateX(350%)' } },
        pulse: { '0%,100%': { opacity: '1' }, '50%': { opacity: '0.55' } },
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
        shimmer: 'shimmer 1.25s ease-in-out infinite',
        'fade-in': 'fade-in 0.24s cubic-bezier(0.16,1,0.3,1) both',
        'rise-in': 'rise-in 0.24s cubic-bezier(0.16,1,0.3,1) both',
        'bar-indeterminate': 'bar-indeterminate 1.1s ease-in-out infinite',
      },
    },
  },
  plugins: [tailwindcssAnimate],
};
