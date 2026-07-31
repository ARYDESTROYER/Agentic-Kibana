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
import {
  ShieldCheck,
  Eye,
  EyeOff,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import { Input, type InputProps } from '@/ui/input';

// --------------------------------------------------------------------------- //
// Login controls — one local grammar for every credential field.
//
// These are deliberately login-specific rather than another global Input variant:
// the 48px target and quieter fill belong to the identity surface,
// while the Console's dense tables and filters continue to use the 36px base Input.
// --------------------------------------------------------------------------- //

const LOGIN_CONTROL_CLASS = cn(
  'login-auth-control h-12 rounded-md border-input bg-background text-lg shadow-none sm:text-base',
  'transition-[border-color,background-color,box-shadow] duration-150',
  'placeholder:text-muted-foreground/70 hover:border-border-strong',
  'focus-visible:bg-background focus-visible:ring-2 focus-visible:ring-ring',
);

export interface LoginTextInputProps extends InputProps {
  /** Optional context glyph. Ordinary sign-in fields stay icon-free and editorial. */
  icon?: LucideIcon;
}

/**
 * A calm text field for the identity surface. Optional context glyphs are reserved
 * for setup/recovery states; ordinary sign-in stays icon-free and editorial. The
 * native input remains the only focusable control and retains base keyboard semantics.
 */
export const LoginTextInput = React.forwardRef<HTMLInputElement, LoginTextInputProps>(
  ({ icon: Icon, className, ...props }, ref) => (
    <div className="group relative">
      {Icon ? (
        <Icon
          className={cn(
            'pointer-events-none absolute left-3.5 top-1/2 z-10 h-4 w-4 -translate-y-1/2',
            'text-muted-foreground transition-colors group-focus-within:text-primary',
          )}
          aria-hidden
        />
      ) : null}
      <Input
        ref={ref}
        className={cn(LOGIN_CONTROL_CLASS, Icon ? 'pl-10' : 'px-3.5', className)}
        {...props}
      />
    </div>
  ),
);
LoginTextInput.displayName = 'LoginTextInput';

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
// Standalone-text tints use the AA-tuned `-text` triad member (theme.css §1.3): the
// solid `--{axis}` FILL fails 4.5:1 as small text on the light card, so the label
// colour must come from `--{axis}-text` (measured AA in both themes).
const STRENGTH_TEXT: Record<number, string> = {
  0: 'text-critical-text',
  1: 'text-critical-text',
  2: 'text-warning-text',
  3: 'text-info-text',
  4: 'text-success-text',
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
  // Map 0..4 onto 4 visible segments. A non-empty password is always ≥1 filled
  // segment so a score-0 "Too weak" shows a single red bar (distinct from the empty
  // / untyped all-`bg-border` state) instead of reading as no reaction.
  const filled = Math.max(1, Math.min(4, score));
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
// PasswordInput — a masked credential field with a functional reveal (eye) toggle.
// The toggle only ever reveals what the user is CURRENTLY typing;
// there is no persisted secret to echo. Used by every password field on the login
// surface (sign-in / create-admin / change-password). The reveal state is local so
// each field toggles independently. `autoComplete` is caller-set (never defaulted)
// so a manager fills the right credential (`current-password`/`new-password`).
// --------------------------------------------------------------------------- //
export interface PasswordInputProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  /** REQUIRED — never defaulted (current-password vs new-password matters for autofill). */
  autoComplete: string;
  name?: string;
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  autoFocus?: boolean;
  /** Forwarded to the input for a11y wiring (e.g. a policy-hint paragraph). */
  ariaDescribedBy?: string;
  /** Forwarded when a credential failure belongs to this field. */
  ariaInvalid?: React.AriaAttributes['aria-invalid'];
}

export const PasswordInput = React.forwardRef<HTMLInputElement, PasswordInputProps>(({
  id,
  value,
  onChange,
  autoComplete,
  name,
  placeholder,
  disabled,
  required,
  autoFocus,
  ariaDescribedBy,
  ariaInvalid,
}, ref) => {
  const [reveal, setReveal] = React.useState(false);
  return (
    <div className="group relative">
      <Input
        ref={ref}
        id={id}
        type={reveal ? 'text' : 'password'}
        className={cn(LOGIN_CONTROL_CLASS, 'pl-3.5 pr-11')}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete}
        name={name}
        placeholder={placeholder}
        aria-describedby={ariaDescribedBy}
        aria-invalid={ariaInvalid}
        disabled={disabled}
        required={required}
        /* eslint-disable-next-line jsx-a11y/no-autofocus -- deliberate focus placement on the primary field of a focused login flow; behavior-preserving */
        autoFocus={autoFocus}
      />
      <button
        type="button"
        onClick={() => setReveal((r) => !r)}
        disabled={disabled}
        aria-label={reveal ? 'Hide password' : 'Show password'}
        aria-pressed={reveal}
        className={cn(
          'absolute right-1 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground',
          'transition-colors hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          'disabled:pointer-events-none disabled:opacity-50',
        )}
      >
        {reveal ? <EyeOff className="h-4 w-4" aria-hidden /> : <Eye className="h-4 w-4" aria-hidden />}
      </button>
    </div>
  );
});
PasswordInput.displayName = 'PasswordInput';

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

  // Returns the new collapsed value so callers can move focus to the cell that
  // ACTUALLY holds the next empty slot. `digits` is always front-packed (gaps are
  // stripped by `onChange`), so focusing `index + 1` blindly overshoots when a gap
  // cell was clicked; callers clamp against `joined.length` instead.
  const setAt = (index: number, char: string): string => {
    const next = digits.slice();
    next[index] = char;
    const joined = next.join('').replace(/\D/g, '').slice(0, length);
    onChange(joined);
    if (joined.length === length) onComplete?.(joined);
    return joined;
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
      else focusCell(joined.length);
      return;
    }
    const joined = setAt(index, only);
    // Never move past the last filled cell: a digit typed into a gap re-packs to the
    // front, so the caret follows it instead of overshooting to the clicked index+1.
    focusCell(Math.min(index + 1, joined.length));
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
          /* eslint-disable-next-line jsx-a11y/no-autofocus -- deliberate focus placement on the primary field of a focused dialog/login flow; behavior-preserving */
          autoFocus={autoFocus && i === 0}
          aria-label={`${ariaLabel} digit ${i + 1}`}
          className={cn(
            LOGIN_CONTROL_CLASS,
            'w-full min-w-0 px-0 text-center font-mono text-lg font-semibold',
            'focus-visible:outline-none',
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
 * `_LOGIN_ILLUSTRATIONS` on the backend). `''` selects the default signal field.
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
  '': 'Signal field (default)',
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
  split: 'Split workspace',
  centered: 'Centered',
  full: 'Wide workspace',
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
 * The curated decorative backdrop for a login-illustration key. PURE code-authored
 * CSS/SVG — no operator input reaches these (the branding doc only carries the KEY).
 * All layers are `aria-hidden` and pointer-events:none; every one tints from the
 * `--primary` brand var so it still tracks the org accent. Every variant now belongs
 * to the same quiet signal-diagram grammar: static hairlines, nodes and topology. The
 * wire keys stay compatible, but no variant depends on blur, gradients, or perpetual
 * decorative motion.
 */
export const LoginIllustration: React.FC<{ variant?: LoginIllustration }> = ({
  variant = '',
}) => {
  const key = asLoginIllustration(variant);

  // A faint square grid shared by several variants.
  const gridLayer = (size = 40, opacity = 0.18) => (
    <div
      aria-hidden
      className="absolute inset-0"
      style={{
        opacity,
        backgroundImage:
          'linear-gradient(hsl(var(--foreground) / 0.055) 1px, transparent 1px), linear-gradient(90deg, hsl(var(--foreground) / 0.055) 1px, transparent 1px)',
        backgroundSize: `${size}px ${size}px`,
      }}
    />
  );

  const signalField = (
    <>
      {gridLayer(36, 0.5)}
      <svg
        className="absolute -right-24 bottom-8 h-[34rem] w-[44rem] text-foreground/[0.08]"
        viewBox="0 0 720 520"
        fill="none"
        aria-hidden
      >
        <path d="M20 406 C164 406 190 320 310 320 S466 214 700 214" stroke="currentColor" />
        <path d="M20 448 C194 448 230 376 360 376 S520 302 700 302" stroke="currentColor" />
        <path d="M112 96 H288 L364 170 H612" stroke="currentColor" />
        <path d="M176 148 H262 L336 222 H558" stroke="currentColor" />
        {[['112', '96'], ['288', '96'], ['364', '170'], ['612', '170'], ['310', '320'], ['466', '214'], ['360', '376'], ['520', '302']].map(
          ([cx, cy], index) => (
            <circle
              key={`${cx}-${cy}`}
              cx={cx}
              cy={cy}
              r={index === 3 || index === 5 ? 5 : 3}
              fill={index === 3 || index === 5 ? 'hsl(var(--primary))' : 'currentColor'}
            />
          ),
        )}
      </svg>
    </>
  );

  if (key === 'shield') {
    return (
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        {signalField}
        <ShieldCheck
          className="absolute right-[-3rem] top-1/2 h-[34rem] w-[34rem] -translate-y-1/2 text-foreground/[0.035]"
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
          className="absolute left-1/2 top-1/2 h-[42rem] w-[42rem] -translate-x-1/2 -translate-y-1/2 text-foreground/10"
          viewBox="0 0 200 200"
          fill="none"
          aria-hidden
        >
          {[30, 55, 80].map((r) => (
            <circle key={r} cx="100" cy="100" r={r} stroke="currentColor" strokeWidth="0.5" />
          ))}
          <line x1="100" y1="100" x2="100" y2="20" stroke="currentColor" strokeWidth="0.5" />
          <line x1="100" y1="100" x2="180" y2="100" stroke="currentColor" strokeWidth="0.5" />
          <path d="M100 100 L146 34 A80 80 0 0 1 178 118 Z" fill="hsl(var(--primary) / 0.08)" />
          <circle cx="146" cy="58" r="2.5" fill="hsl(var(--primary))" />
        </svg>
      </div>
    );
  }

  if (key === 'grid') {
    return (
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        {gridLayer(32, 0.28)}
        <div className="absolute left-[18%] top-[22%] h-1.5 w-1.5 rounded-full bg-primary" />
        <div className="absolute bottom-[25%] right-[20%] h-1.5 w-1.5 rounded-full bg-primary" />
      </div>
    );
  }

  if (key === 'waves') {
    return (
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        <svg
          className="absolute inset-x-0 bottom-0 h-2/3 w-full text-foreground/[0.08]"
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
          className="absolute left-1/2 top-1/2 h-[40rem] w-[40rem] -translate-x-1/2 -translate-y-1/2 text-foreground/12"
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
        {gridLayer(56, 0.14)}
        <svg className="absolute inset-0 h-full w-full text-foreground/10" viewBox="0 0 800 600" fill="none" aria-hidden>
          <path d="M0 490 L160 350 L300 430 L470 240 L630 330 L800 170" stroke="currentColor" />
          <path d="M0 390 L180 250 L330 320 L490 150 L670 240 L800 110" stroke="currentColor" />
          {[['160', '350'], ['300', '430'], ['470', '240'], ['630', '330'], ['180', '250'], ['490', '150']].map(([cx, cy], index) => (
            <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="4" fill={index === 2 || index === 5 ? 'hsl(var(--primary))' : 'currentColor'} />
          ))}
        </svg>
      </div>
    );
  }

  // '' (default) and 'aurora' now share the restrained signal field. The legacy
  // key remains valid for saved branding documents.
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      {signalField}
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
 * The brand context pane. It uses the same theme surface grammar as the Console and
 * spends its space on product context, operator assurances, and a restrained trust
 * path instead of a marketing gradient or floating dashboard fragments.
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
        className="absolute inset-0 overflow-hidden bg-surface"
      >
        <LoginIllustration variant={illustration} />
      </div>
    );
  }

  const isFull = variant === 'full';
  const rootClass = isFull
    ? 'absolute inset-0 flex flex-col overflow-hidden bg-surface'
    : 'relative hidden overflow-hidden border-r border-border bg-surface lg:flex lg:flex-col';

  return (
    <div className={rootClass}>
      <LoginIllustration variant={illustration} />

      {/* Content (z-10 over the glow). */}
      <div
        className={cn(
          'relative z-10 flex h-full flex-col justify-between p-10 text-foreground xl:p-14',
          isFull && 'mx-auto w-full max-w-6xl',
        )}
      >
        <div className="flex items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-border bg-card">
              {logoUrl ? (
                <img src={logoUrl} alt="" className="h-6 w-6 rounded-sm object-contain" />
              ) : (
                <ShieldCheck className="h-5 w-5 text-primary" aria-hidden />
              )}
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold tracking-tight">{wordmark}</p>
              <p className="mt-0.5 truncate font-mono text-xs uppercase tracking-[0.16em] text-muted-foreground">
                {tagline}
              </p>
            </div>
          </div>
          <span className="hidden items-center gap-2 font-mono text-xs uppercase tracking-[0.16em] text-muted-foreground xl:flex">
            <span className="h-1.5 w-1.5 rounded-full bg-status-closed" aria-hidden />
            Secure access
          </span>
        </div>

        <div className="max-w-xl py-10">
          <p className="font-mono text-xs font-medium uppercase tracking-[0.18em] text-primary">
            Operator access / Agentic SOC
          </p>
          <h2 className="mt-4 max-w-[34rem] whitespace-pre-line text-4xl font-semibold leading-[1.08] tracking-[-0.035em] lg:text-5xl 2xl:text-6xl">
            {heroHeadline}
          </h2>
          <p className="mt-5 max-w-[33rem] whitespace-pre-line text-base leading-6 text-muted-foreground">
            {heroBody}
          </p>
          {heroChips.length > 0 ? (
            <div className="mt-8 grid border-y border-border sm:grid-cols-3">
              {heroChips.map((chip, i) => (
                <div
                  key={`${chip}-${i}`}
                  className="min-w-0 border-b border-border py-3 pr-3 last:border-b-0 sm:border-b-0 sm:border-l sm:px-4 sm:first:border-l-0 sm:first:pl-0"
                >
                  <span className="block font-mono text-xs text-muted-foreground">
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <span className="mt-1 block truncate text-xs font-medium text-foreground" title={chip}>
                    {chip}
                  </span>
                </div>
              ))}
            </div>
          ) : null}

          <div className="mt-8" aria-label="Trust path">
            <p className="font-mono text-xs uppercase tracking-[0.16em] text-muted-foreground">
              Trust path
            </p>
            <div className="mt-3 grid grid-cols-[auto_1fr_auto_1fr_auto] items-center gap-2" aria-hidden>
              <span className="h-2 w-2 rounded-full border border-primary bg-primary/15" />
              <span className="h-px bg-border" />
              <span className="h-2 w-2 rounded-full border border-primary bg-primary/15" />
              <span className="h-px bg-border" />
              <span className="h-2 w-2 rounded-full bg-primary" />
            </div>
            <div className="mt-2 grid grid-cols-3 gap-4 text-xs leading-4 text-muted-foreground">
              <span>Read-only telemetry</span>
              <span className="text-center">Reviewable evidence</span>
              <span className="text-right">Code decision</span>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between gap-4 border-t border-border pt-4 font-mono text-xs uppercase tracking-[0.14em] text-muted-foreground">
          <span>{footerText || 'Session activity is audited'}</span>
          <span className="hidden sm:inline">Human authority preserved</span>
        </div>
      </div>
    </div>
  );
};
