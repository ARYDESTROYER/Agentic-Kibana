/**
 * Login building blocks — the brand hero, a client-side password-strength meter,
 * per-provider SSO brand icons, and a segmented one-time-code input.
 *
 * These are presentational pieces composed by `pages/Login.tsx`. They deliberately
 * add NO new dependencies (framer-motion + lucide-react are already vendored) and
 * render all branding text as PLAIN text (#9): the hero never uses
 * dangerouslySetInnerHTML, the logo `alt` is empty, and the wordmark/tagline are
 * rendered as text nodes only.
 */
import * as React from 'react';
import { motion, useReducedMotion } from 'framer-motion';
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
// Brand hero — the left split panel (dark command-center aesthetic).
// --------------------------------------------------------------------------- //
export interface BrandHeroProps {
  wordmark: string;
  tagline: string;
  logoUrl: string;
  /** Optional welcome line (operator-set login subtitle). */
  subtitle?: string;
  /** Optional classification / footer line. */
  footerText?: string;
}

/** One drifting aurora blob; static when reduced-motion is requested. */
const AuroraBlob: React.FC<{
  className: string;
  color: string;
  drift: { x: number[]; y: number[]; scale: number[] };
  duration: number;
  reduce: boolean;
}> = ({ className, color, drift, duration, reduce }) => (
  <motion.div
    aria-hidden
    className={cn('pointer-events-none absolute rounded-full blur-3xl', className)}
    style={{ backgroundColor: color }}
    initial={false}
    animate={reduce ? undefined : { x: drift.x, y: drift.y, scale: drift.scale }}
    transition={
      reduce
        ? undefined
        : { duration, repeat: Infinity, repeatType: 'mirror', ease: 'easeInOut' }
    }
  />
);

/**
 * The brand hero panel. A deep slate base with a faint grid + a slow two-blob
 * aurora glow tinted by the primary accent + the secondary accent
 * (`--accent2`, falling back to the primary). All motion respects
 * prefers-reduced-motion. Hidden below `lg`; the form column carries a compact
 * brand header on small screens.
 */
export const BrandHero: React.FC<BrandHeroProps> = ({
  wordmark,
  tagline,
  logoUrl,
  subtitle,
  footerText,
}) => {
  const reduce = useReducedMotion() ?? false;
  return (
    <div className="relative hidden overflow-hidden bg-[hsl(222_28%_9%)] lg:flex lg:flex-col">
      {/* Aurora glow — two slow-drifting brand blobs. */}
      <AuroraBlob
        className="-left-24 -top-24 h-[28rem] w-[28rem] opacity-50"
        color="hsl(var(--primary) / 0.55)"
        drift={{ x: [0, 40, -10, 0], y: [0, 30, 60, 0], scale: [1, 1.12, 1.05, 1] }}
        duration={22}
        reduce={reduce}
      />
      <AuroraBlob
        className="-bottom-32 right-[-6rem] h-[30rem] w-[30rem] opacity-45"
        color="hsl(var(--accent2, var(--primary)) / 0.5)"
        drift={{ x: [0, -30, 20, 0], y: [0, -20, -50, 0], scale: [1, 1.08, 1.15, 1] }}
        duration={28}
        reduce={reduce}
      />

      {/* Faint grid + noise texture (pure CSS; no asset). */}
      <div
        aria-hidden
        className="absolute inset-0 opacity-[0.18]"
        style={{
          backgroundImage:
            'linear-gradient(hsl(0 0% 100% / 0.06) 1px, transparent 1px), linear-gradient(90deg, hsl(0 0% 100% / 0.06) 1px, transparent 1px)',
          backgroundSize: '40px 40px',
          maskImage: 'radial-gradient(120% 100% at 50% 0%, #000 30%, transparent 85%)',
          WebkitMaskImage: 'radial-gradient(120% 100% at 50% 0%, #000 30%, transparent 85%)',
        }}
      />
      {/* A soft vignette + top accent sheen. */}
      <div
        aria-hidden
        className="absolute inset-0"
        style={{
          background:
            'radial-gradient(80% 60% at 50% -10%, hsl(var(--primary) / 0.16) 0%, transparent 60%)',
        }}
      />

      {/* Content (z-10 over the glow). */}
      <div className="relative z-10 flex h-full flex-col justify-between p-12 text-white">
        <motion.div
          className="flex items-center gap-3"
          initial={reduce ? false : { opacity: 0, y: -8 }}
          animate={reduce ? undefined : { opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
        >
          <span className="flex h-11 w-11 items-center justify-center rounded-xl border border-white/15 bg-white/5 shadow-lg backdrop-blur">
            {logoUrl ? (
              <img src={logoUrl} alt="" className="h-7 w-7 rounded-md object-contain" />
            ) : (
              <ShieldCheck className="h-6 w-6 text-white" aria-hidden />
            )}
          </span>
          <span className="text-lg font-semibold tracking-tight">{wordmark}</span>
        </motion.div>

        <motion.div
          className="max-w-md"
          initial={reduce ? false : { opacity: 0, y: 12 }}
          animate={reduce ? undefined : { opacity: 1, y: 0 }}
          transition={{ duration: 0.55, delay: 0.08, ease: [0.16, 1, 0.3, 1] }}
        >
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-white/55">
            {tagline}
          </p>
          <h2 className="mt-3 text-3xl font-semibold leading-tight tracking-tight">
            {subtitle || 'Triage at machine speed, with a human in the loop.'}
          </h2>
          <p className="mt-4 text-sm leading-relaxed text-white/65">
            Audited, cost-metered agentic triage — every alert turned into a
            reviewable, explainable case.
          </p>
          <div className="mt-7 flex flex-wrap gap-2">
            {['Audited', 'Cost-metered', 'Human-reviewable'].map((chip) => (
              <span
                key={chip}
                className="rounded-full border border-white/12 bg-white/5 px-3 py-1 text-xs font-medium text-white/75 backdrop-blur"
              >
                {chip}
              </span>
            ))}
          </div>
        </motion.div>

        <div className="text-xs text-white/40">
          {footerText ? <span>{footerText}</span> : <span>Secure sign-in</span>}
        </div>
      </div>
    </div>
  );
};
