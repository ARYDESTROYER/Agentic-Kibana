/**
 * Login building blocks — the brand hero, a client-side password-strength meter,
 * per-provider SSO brand icons, and a segmented one-time-code input.
 *
 * These are presentational pieces composed by `pages/Login.tsx`. They deliberately
 * add NO new dependencies and render all branding text as PLAIN text (#9): the hero
 * never uses dangerouslySetInnerHTML, the logo `alt` is empty, and the
 * wordmark/tagline are rendered as text nodes only.
 *
 * The brand-hero motion (two drifting aurora blobs + the two content entrances) is
 * implemented in PURE CSS (`@keyframes` in tailwind.config.js, classes below), NOT
 * framer-motion. This keeps framer-motion OUT of the eager login chain so it never
 * loads on first paint. All motion is neutralised by the global
 * `@media (prefers-reduced-motion: reduce)` rule in styles/theme.css.
 */
import * as React from 'react';
import { ShieldCheck } from 'lucide-react';
import { cn } from '@/lib/cn';

// --------------------------------------------------------------------------- //
// Password strength — a tiny, dependency-free zxcvbn-style heuristic.
// --------------------------------------------------------------------------- //
export interface PasswordStrength {
  /** 0 (empty) .. 4 (strong). */
  score: 0 | 1 | 2 | 3 | 4;
  /** Short human label for the current score. */
  label: string;
  /** A single, most-useful next-step hint (or "" when strong/empty). */
  hint: string;
}

const STRENGTH_LABELS = ['Too weak', 'Weak', 'Fair', 'Good', 'Strong'] as const;

/**
 * Score a password 0..4 from a handful of cheap signals (length + character
 * classes + a light repetition/sequence penalty). This is a UX nicety only — the
 * backend still enforces its own minimum — so it is intentionally approximate and
 * never blocks submission.
 */
export function scorePassword(pw: string): PasswordStrength {
  if (!pw) return { score: 0, label: '', hint: '' };

  const len = pw.length;
  const classes =
    Number(/[a-z]/.test(pw)) +
    Number(/[A-Z]/.test(pw)) +
    Number(/[0-9]/.test(pw)) +
    Number(/[^A-Za-z0-9]/.test(pw));

  let pts = 0;
  // Length is the dominant signal.
  if (len >= 8) pts += 1;
  if (len >= 12) pts += 1;
  if (len >= 16) pts += 1;
  // Character variety.
  if (classes >= 2) pts += 1;
  if (classes >= 3) pts += 1;
  // Penalise obvious low-entropy shapes.
  const repeated = /(.)\1\1/.test(pw); // 3+ of the same char in a row
  const sequential = /(?:abc|bcd|cde|def|123|234|345|456|567|678|789|qwer|asdf)/i.test(pw);
  if (repeated || sequential) pts -= 1;

  const score = Math.max(0, Math.min(4, pts)) as PasswordStrength['score'];

  let hint = '';
  if (len < 8) hint = 'Use at least 8 characters.';
  else if (classes < 3) hint = 'Mix upper, lower, numbers & symbols.';
  else if (len < 12) hint = 'Longer passwords are much stronger.';
  else if (repeated || sequential) hint = 'Avoid repeated or sequential characters.';

  return { score, label: STRENGTH_LABELS[score], hint };
}

/** Token colour per score bucket (semantic SOC scale, light/dark aware). */
const STRENGTH_BAR: Record<number, string> = {
  0: 'bg-critical',
  1: 'bg-critical',
  2: 'bg-warning',
  3: 'bg-info',
  4: 'bg-success',
};
const STRENGTH_TEXT: Record<number, string> = {
  0: 'text-critical',
  1: 'text-critical',
  2: 'text-warning',
  3: 'text-info',
  4: 'text-success',
};

/**
 * A 4-segment strength meter + label + a single next-step hint. Renders nothing
 * until the user has typed (so empty forms stay clean).
 */
export const PasswordStrengthMeter: React.FC<{ password: string; className?: string }> = ({
  password,
  className,
}) => {
  const { score, label, hint } = React.useMemo(() => scorePassword(password), [password]);
  if (!password) return null;
  // Map 0..4 onto 4 visible segments (score 0 fills none; 1..4 fill that many).
  const filled = Math.min(4, Math.max(0, score));
  return (
    <div className={cn('space-y-1.5', className)} aria-live="polite">
      <div className="flex gap-1.5" aria-hidden>
        {[0, 1, 2, 3].map((i) => (
          <span
            key={i}
            className={cn(
              'h-1 flex-1 rounded-full transition-colors duration-300',
              i < filled ? STRENGTH_BAR[score] : 'bg-border',
            )}
          />
        ))}
      </div>
      <div className="flex items-center justify-between text-xs">
        <span className={cn('font-medium', STRENGTH_TEXT[score])}>{label}</span>
        {hint ? <span className="text-muted-foreground">{hint}</span> : null}
      </div>
    </div>
  );
};

// --------------------------------------------------------------------------- //
// SSO brand icons — small inline SVGs so we don't pull in an icon-brand pack.
// --------------------------------------------------------------------------- //
const GoogleIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg viewBox="0 0 24 24" className={className} aria-hidden focusable="false">
    <path
      fill="#4285F4"
      d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1Z"
    />
    <path
      fill="#34A853"
      d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23Z"
    />
    <path
      fill="#FBBC05"
      d="M5.84 14.1a6.6 6.6 0 0 1 0-4.2V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84Z"
    />
    <path
      fill="#EA4335"
      d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1A11 11 0 0 0 2.18 7.06l3.66 2.84C6.71 7.3 9.14 5.38 12 5.38Z"
    />
  </svg>
);

const MicrosoftIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg viewBox="0 0 24 24" className={className} aria-hidden focusable="false">
    <path fill="#F25022" d="M2 2h9.5v9.5H2z" />
    <path fill="#7FBA00" d="M12.5 2H22v9.5h-9.5z" />
    <path fill="#00A4EF" d="M2 12.5h9.5V22H2z" />
    <path fill="#FFB900" d="M12.5 12.5H22V22h-9.5z" />
  </svg>
);

/** Brand icon for an SSO provider type; falls back to a neutral shield glyph. */
export const SsoBrandIcon: React.FC<{ type?: string; className?: string }> = ({
  type,
  className,
}) => {
  const cls = cn('h-4 w-4', className);
  if (type === 'google') return <GoogleIcon className={cls} />;
  if (type === 'microsoft') return <MicrosoftIcon className={cls} />;
  return <ShieldCheck className={cls} aria-hidden />;
};

// --------------------------------------------------------------------------- //
// Segmented one-time-code input (6 cells) for the MFA step.
// --------------------------------------------------------------------------- //
export interface OtpInputProps {
  value: string;
  onChange: (next: string) => void;
  /** Fired when all `length` cells are filled (e.g. auto-submit). */
  onComplete?: (code: string) => void;
  length?: number;
  disabled?: boolean;
  autoFocus?: boolean;
  'aria-label'?: string;
}

/**
 * A 6-cell segmented OTP input backed by a single string value. Handles
 * type-to-advance, backspace-to-retreat, arrow navigation, and paste of a full
 * code. Only digits are accepted; the underlying value stays a plain string so
 * the existing `submitMfa` handler is unchanged.
 */
export const OtpInput: React.FC<OtpInputProps> = ({
  value,
  onChange,
  onComplete,
  length = 6,
  disabled,
  autoFocus,
  'aria-label': ariaLabel = 'One-time code',
}) => {
  const refs = React.useRef<Array<HTMLInputElement | null>>([]);
  const digits = React.useMemo(() => {
    const arr = value.replace(/\D/g, '').slice(0, length).split('');
    while (arr.length < length) arr.push('');
    return arr;
  }, [value, length]);

  const focusCell = (i: number) => {
    const el = refs.current[Math.max(0, Math.min(length - 1, i))];
    el?.focus();
    el?.select?.();
  };

  const setAt = (index: number, char: string) => {
    const next = digits.slice();
    next[index] = char;
    const joined = next.join('').replace(/\D/g, '').slice(0, length);
    onChange(joined);
    if (joined.length === length) onComplete?.(joined);
  };

  const handleChange = (index: number, raw: string) => {
    const only = raw.replace(/\D/g, '');
    if (!only) {
      setAt(index, '');
      return;
    }
    // If the user typed/pasted multiple digits into one cell, spread them.
    if (only.length > 1) {
      const next = digits.slice();
      let cursor = index;
      for (const ch of only) {
        if (cursor >= length) break;
        next[cursor] = ch;
        cursor += 1;
      }
      const joined = next.join('').replace(/\D/g, '').slice(0, length);
      onChange(joined);
      if (joined.length === length) onComplete?.(joined);
      else focusCell(cursor);
      return;
    }
    setAt(index, only);
    focusCell(index + 1);
  };

  const handleKeyDown = (index: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace') {
      if (digits[index]) {
        setAt(index, '');
      } else if (index > 0) {
        e.preventDefault();
        setAt(index - 1, '');
        focusCell(index - 1);
      }
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      focusCell(index - 1);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      focusCell(index + 1);
    }
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, length);
    if (!text) return;
    e.preventDefault();
    onChange(text);
    if (text.length === length) onComplete?.(text);
    else focusCell(text.length);
  };

  return (
    <div className="flex items-center justify-between gap-2" role="group" aria-label={ariaLabel}>
      {digits.map((d, i) => (
        <input
          key={i}
          ref={(el) => {
            refs.current[i] = el;
          }}
          value={d}
          onChange={(e) => handleChange(i, e.target.value)}
          onKeyDown={(e) => handleKeyDown(i, e)}
          onPaste={handlePaste}
          onFocus={(e) => e.currentTarget.select()}
          inputMode="numeric"
          autoComplete={i === 0 ? 'one-time-code' : 'off'}
          maxLength={1}
          disabled={disabled}
          autoFocus={autoFocus && i === 0}
          aria-label={`${ariaLabel} digit ${i + 1}`}
          className={cn(
            'h-12 w-full min-w-0 rounded-lg border border-input bg-background text-center text-lg font-semibold text-foreground',
            'transition-colors hover:border-border',
            'focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
            'disabled:cursor-not-allowed disabled:opacity-50',
            d ? 'border-ring/60' : '',
          )}
        />
      ))}
    </div>
  );
};

// --------------------------------------------------------------------------- //
// Login white-label (#6/#9) — the CURATED layout + illustration sets.
//
// Everything an operator can pick from is DEFINED HERE IN CODE. The branding doc
// only ever carries: bounded PLAIN-TEXT copy (headline/body/chips) + an enum
// LAYOUT key + an enum ILLUSTRATION key. It never carries HTML, SVG markup, or a
// URL, so nothing operator-supplied is ever interpolated as markup (BrandHero
// renders text as plain React text nodes; the illustrations are code-authored SVG
// with no operator input). This is the whole security boundary for the login page.
// --------------------------------------------------------------------------- //

/** The three curated login arrangements (mirror `login_layout` on the backend). */
export type LoginLayout = 'split' | 'centered' | 'full';
export const LOGIN_LAYOUTS: readonly LoginLayout[] = ['split', 'centered', 'full'] as const;

/**
 * The curated login-illustration keys (mirror `login_illustration` +
 * `_LOGIN_ILLUSTRATIONS` on the backend). `''` selects the default aurora glow.
 * Each key maps to a code-defined, PURE-CSS/SVG decorative backdrop below — never a
 * URL or operator-supplied asset.
 */
export const LOGIN_ILLUSTRATIONS = [
  '',
  'shield',
  'radar',
  'grid',
  'waves',
  'aurora',
  'constellation',
  'mesh',
] as const;
export type LoginIllustration = (typeof LOGIN_ILLUSTRATIONS)[number];

/** Human labels for the illustration picker (BrandingEditor consumes this). */
export const LOGIN_ILLUSTRATION_LABELS: Record<LoginIllustration, string> = {
  '': 'Aurora (default)',
  shield: 'Shield',
  radar: 'Radar sweep',
  grid: 'Grid',
  waves: 'Waves',
  aurora: 'Aurora bloom',
  constellation: 'Constellation',
  mesh: 'Mesh',
};

/** Human labels for the layout picker (BrandingEditor consumes this). */
export const LOGIN_LAYOUT_LABELS: Record<LoginLayout, string> = {
  split: 'Split (brand hero + form)',
  centered: 'Centered card',
  full: 'Full-bleed hero',
};

/** Coerce an arbitrary string to a known layout (defensive; unknown → 'split'). */
export function asLoginLayout(v: string | undefined | null): LoginLayout {
  return v === 'centered' || v === 'full' ? v : 'split';
}

/** Coerce an arbitrary string to a known illustration key (unknown → ''). */
export function asLoginIllustration(v: string | undefined | null): LoginIllustration {
  return (LOGIN_ILLUSTRATIONS as readonly string[]).includes(v ?? '')
    ? ((v ?? '') as LoginIllustration)
    : '';
}

/**
 * One drifting aurora blob (pure CSS). The drift loop runs via the `animationClass`
 * keyframe; the global reduced-motion rule freezes it for users who ask for less
 * motion. No JS animation library is pulled in.
 */
const AuroraBlob: React.FC<{
  className: string;
  color: string;
  animationClass: string;
}> = ({ className, color, animationClass }) => (
  <div
    aria-hidden
    className={cn('pointer-events-none absolute rounded-full blur-3xl', animationClass, className)}
    style={{ backgroundColor: color }}
  />
);

/**
 * The curated decorative backdrop for a login-illustration key. PURE code-authored
 * CSS/SVG — no operator input reaches these (the branding doc only carries the KEY).
 * All layers are `aria-hidden` and pointer-events:none; every one tints from the
 * `--primary` / `--accent2` brand vars so it still tracks the org accent. The `''`
 * (default) key renders the two-blob aurora glow the login has always used.
 */
export const LoginIllustration: React.FC<{ variant?: LoginIllustration }> = ({
  variant = '',
}) => {
  const key = asLoginIllustration(variant);

  // A faint square grid + top-vignette mask, shared by several variants.
  const gridLayer = (size = 40, opacity = 0.18) => (
    <div
      aria-hidden
      className="absolute inset-0"
      style={{
        opacity,
        backgroundImage:
          'linear-gradient(hsl(0 0% 100% / 0.06) 1px, transparent 1px), linear-gradient(90deg, hsl(0 0% 100% / 0.06) 1px, transparent 1px)',
        backgroundSize: `${size}px ${size}px`,
        maskImage: 'radial-gradient(120% 100% at 50% 0%, #000 30%, transparent 85%)',
        WebkitMaskImage: 'radial-gradient(120% 100% at 50% 0%, #000 30%, transparent 85%)',
      }}
    />
  );

  // The default aurora — two brand-tinted drifting blobs + grid + vignette.
  const auroraLayers = (
    <>
      <AuroraBlob
        className="-left-24 -top-24 h-[28rem] w-[28rem] opacity-50"
        color="hsl(var(--primary) / 0.55)"
        animationClass="animate-aurora-a"
      />
      <AuroraBlob
        className="-bottom-32 right-[-6rem] h-[30rem] w-[30rem] opacity-45"
        color="hsl(var(--accent2, var(--primary)) / 0.5)"
        animationClass="animate-aurora-b"
      />
      {gridLayer(40, 0.18)}
      <div
        aria-hidden
        className="absolute inset-0"
        style={{
          background:
            'radial-gradient(80% 60% at 50% -10%, hsl(var(--primary) / 0.16) 0%, transparent 60%)',
        }}
      />
    </>
  );

  if (key === 'shield') {
    return (
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        {auroraLayers}
        <ShieldCheck
          className="absolute right-[-3rem] top-1/2 h-[36rem] w-[36rem] -translate-y-1/2 animate-aurora-a text-white/[0.05]"
          aria-hidden
        />
      </div>
    );
  }

  if (key === 'radar') {
    return (
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        {gridLayer(48, 0.14)}
        <svg
          className="absolute left-1/2 top-1/2 h-[42rem] w-[42rem] -translate-x-1/2 -translate-y-1/2 text-white/10"
          viewBox="0 0 200 200"
          fill="none"
          aria-hidden
        >
          {[30, 55, 80].map((r) => (
            <circle key={r} cx="100" cy="100" r={r} stroke="currentColor" strokeWidth="0.5" />
          ))}
          <line x1="100" y1="100" x2="100" y2="20" stroke="currentColor" strokeWidth="0.5" />
          <line x1="100" y1="100" x2="180" y2="100" stroke="currentColor" strokeWidth="0.5" />
        </svg>
        <div
          aria-hidden
          className="absolute left-1/2 top-1/2 h-[42rem] w-[42rem] origin-center -translate-x-1/2 -translate-y-1/2 animate-aurora-a"
          style={{
            background:
              'conic-gradient(from 200deg, hsl(var(--primary) / 0.28) 0deg, transparent 60deg)',
            borderRadius: '9999px',
            maskImage: 'radial-gradient(circle, #000 0%, #000 40%, transparent 41%)',
            WebkitMaskImage: 'radial-gradient(circle, #000 0%, #000 40%, transparent 41%)',
          }}
        />
      </div>
    );
  }

  if (key === 'grid') {
    return (
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        {gridLayer(32, 0.28)}
        <div
          aria-hidden
          className="absolute inset-0"
          style={{
            background:
              'radial-gradient(70% 55% at 50% 0%, hsl(var(--primary) / 0.22) 0%, transparent 60%)',
          }}
        />
      </div>
    );
  }

  if (key === 'waves') {
    return (
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        <svg
          className="absolute inset-x-0 bottom-0 h-2/3 w-full text-white/[0.07]"
          viewBox="0 0 400 200"
          preserveAspectRatio="none"
          fill="none"
          aria-hidden
        >
          {[0, 24, 48, 72].map((dy) => (
            <path
              key={dy}
              d={`M0 ${120 + dy} C 80 ${90 + dy}, 160 ${150 + dy}, 240 ${120 + dy} S 400 ${100 + dy}, 400 ${120 + dy}`}
              stroke="currentColor"
              strokeWidth="1"
            />
          ))}
        </svg>
        <div
          aria-hidden
          className="absolute inset-0"
          style={{
            background:
              'radial-gradient(90% 60% at 50% 110%, hsl(var(--accent2, var(--primary)) / 0.28) 0%, transparent 60%)',
          }}
        />
      </div>
    );
  }

  if (key === 'constellation') {
    // A small, fixed set of code-defined nodes/edges — deterministic, no operator data.
    const nodes = [
      [40, 50], [90, 30], [140, 70], [70, 110], [150, 130],
      [30, 140], [120, 160], [180, 60],
    ];
    const edges: Array<[number, number]> = [
      [0, 1], [1, 2], [2, 7], [0, 3], [3, 6], [2, 4], [4, 6], [3, 5],
    ];
    return (
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        {gridLayer(48, 0.1)}
        <svg
          className="absolute left-1/2 top-1/2 h-[40rem] w-[40rem] -translate-x-1/2 -translate-y-1/2 text-white/12"
          viewBox="0 0 210 190"
          fill="none"
          aria-hidden
        >
          {edges.map(([a, b], i) => (
            <line
              key={i}
              x1={nodes[a][0]}
              y1={nodes[a][1]}
              x2={nodes[b][0]}
              y2={nodes[b][1]}
              stroke="currentColor"
              strokeWidth="0.5"
            />
          ))}
          {nodes.map(([x, y], i) => (
            <circle key={i} cx={x} cy={y} r="2" fill="hsl(var(--primary) / 0.9)" />
          ))}
        </svg>
      </div>
    );
  }

  if (key === 'mesh') {
    return (
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        <AuroraBlob
          className="left-[10%] top-[-6rem] h-[24rem] w-[24rem] opacity-40"
          color="hsl(var(--primary) / 0.5)"
          animationClass="animate-aurora-a"
        />
        <AuroraBlob
          className="right-[-4rem] top-[30%] h-[22rem] w-[22rem] opacity-35"
          color="hsl(var(--accent2, var(--primary)) / 0.45)"
          animationClass="animate-aurora-b"
        />
        <AuroraBlob
          className="bottom-[-8rem] left-[20%] h-[26rem] w-[26rem] opacity-30"
          color="hsl(var(--primary) / 0.4)"
          animationClass="animate-aurora-a"
        />
      </div>
    );
  }

  // '' (default) and 'aurora' both render the classic two-blob aurora glow.
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      {auroraLayers}
    </div>
  );
};

// --------------------------------------------------------------------------- //
// Brand hero — the left split panel (dark command-center aesthetic).
// --------------------------------------------------------------------------- //
export interface BrandHeroProps {
  wordmark: string;
  tagline: string;
  logoUrl: string;
  /**
   * The hero HEADLINE (operator-set `login_headline`, plain text). Falls back to a
   * built-in line when blank. NOTE: distinct from `subtitle` — the headline is the
   * big line; `subtitle` is the legacy welcome line reused as the form description.
   */
  headline?: string;
  /** The hero BODY copy (operator-set `login_body`, plain text). Blank → built-in. */
  body?: string;
  /** The feature chips (operator-set `login_chips`, plain text). Empty → built-in. */
  chips?: string[];
  /** Legacy welcome line — kept for back-compat; only used when `headline` is blank. */
  subtitle?: string;
  /** Optional classification / footer line. */
  footerText?: string;
  /** The curated backdrop illustration key. */
  illustration?: LoginIllustration;
  /**
   * How the hero fills its container:
   *  - 'panel'    — the left column of the split layout (default).
   *  - 'full'     — a full-bleed backdrop the form floats over ('full' layout).
   *  - 'backdrop' — a decorative-only band behind the centered card (no copy).
   */
  variant?: 'panel' | 'full' | 'backdrop';
}

const DEFAULT_HEADLINE = 'Triage at machine speed, with a human in the loop.';
const DEFAULT_BODY =
  'Audited, cost-metered agentic triage — every alert turned into a reviewable, explainable case.';
const DEFAULT_CHIPS = ['Audited', 'Cost-metered', 'Human-reviewable'];

/**
 * The brand hero panel. A deep slate base with a curated illustration backdrop
 * tinted by the primary accent + the secondary accent (`--accent2`, falling back to
 * the primary). All motion is pure CSS and respects prefers-reduced-motion (global
 * rule in styles/theme.css).
 *
 * SECURITY (#6/#9): every text field (wordmark/tagline/headline/body/chips/footer)
 * is operator-set → rendered as a PLAIN React text node (never dangerouslySetInnerHTML).
 * The illustration is a CODE key selecting a code-authored backdrop — no operator
 * markup/URL ever reaches the DOM.
 */
export const BrandHero: React.FC<BrandHeroProps> = ({
  wordmark,
  tagline,
  logoUrl,
  headline,
  body,
  chips,
  subtitle,
  footerText,
  illustration = '',
  variant = 'panel',
}) => {
  const heroHeadline = (headline || '').trim() || (subtitle || '').trim() || DEFAULT_HEADLINE;
  const heroBody = (body || '').trim() || DEFAULT_BODY;
  const heroChips = chips && chips.length > 0 ? chips : DEFAULT_CHIPS;

  // 'backdrop' is decoration only — no copy, no logo, just the illustration band.
  if (variant === 'backdrop') {
    return (
      <div
        aria-hidden
        className="absolute inset-0 overflow-hidden bg-[hsl(222_28%_9%)]"
      >
        <LoginIllustration variant={illustration} />
      </div>
    );
  }

  const isFull = variant === 'full';
  const rootClass = isFull
    ? 'absolute inset-0 flex flex-col overflow-hidden bg-[hsl(222_28%_9%)]'
    : 'relative hidden overflow-hidden bg-[hsl(222_28%_9%)] lg:flex lg:flex-col';

  return (
    <div className={rootClass}>
      <LoginIllustration variant={illustration} />

      {/* Content (z-10 over the glow). */}
      <div
        className={cn(
          'relative z-10 flex h-full flex-col justify-between p-12 text-white',
          isFull && 'mx-auto w-full max-w-4xl',
        )}
      >
        <div className="flex animate-hero-in-down items-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-xl border border-white/15 bg-white/5 shadow-lg backdrop-blur">
            {logoUrl ? (
              <img src={logoUrl} alt="" className="h-7 w-7 rounded-md object-contain" />
            ) : (
              <ShieldCheck className="h-6 w-6 text-white" aria-hidden />
            )}
          </span>
          <span className="text-lg font-semibold tracking-tight">{wordmark}</span>
        </div>

        <div className="max-w-md animate-hero-in-up">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-white/55">
            {tagline}
          </p>
          <h2 className="mt-3 whitespace-pre-line text-3xl font-semibold leading-tight tracking-tight">
            {heroHeadline}
          </h2>
          <p className="mt-4 whitespace-pre-line text-sm leading-relaxed text-white/65">
            {heroBody}
          </p>
          {heroChips.length > 0 ? (
            <div className="mt-7 flex flex-wrap gap-2">
              {heroChips.map((chip, i) => (
                <span
                  key={`${chip}-${i}`}
                  className="rounded-full border border-white/12 bg-white/5 px-3 py-1 text-xs font-medium text-white/75 backdrop-blur"
                >
                  {chip}
                </span>
              ))}
            </div>
          ) : null}
        </div>

        <div className="text-xs text-white/40">
          {footerText ? <span>{footerText}</span> : <span>Secure sign-in</span>}
        </div>
      </div>
    </div>
  );
};
