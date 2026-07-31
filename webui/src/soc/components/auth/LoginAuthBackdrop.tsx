/**
 * LoginAuthBackdrop — the isolated identity-canvas motion system.
 *
 * This deliberately follows Mistral's current sign-in choreography: four sparse,
 * neutral 240px tiles reveal, wait, move along a small outer lattice, and disappear.
 * Only the top and bottom tiles may leave an occasional warm directional trail. The
 * opaque authentication slab stays above the entire decorative layer, so motion never
 * crosses credential content. We retain one accessibility improvement over the live
 * reference: narrow and reduced-motion surfaces schedule no ambient animation at all.
 */
import * as React from 'react';
import { cn } from '@/lib/cn';

interface TilePosition {
  top: string;
  left: string;
  column: number;
  row: number;
}

type AmbientSide = 'top' | 'right' | 'bottom' | 'left';
type TrailDirection = 'right' | 'left' | 'down' | 'up';

interface TileState {
  positionIndex: number;
  isDefault: boolean;
  isVisible: boolean;
  isMoving: boolean;
  brandColor: string;
  showBrandColor: boolean;
  trailDirection: TrailDirection;
}

const TOP_POSITIONS: readonly TilePosition[] = [
  { top: '-240px', left: '0px', column: 0, row: -1 },
  { top: '-240px', left: '240px', column: 1, row: -1 },
];

const LEFT_POSITIONS: readonly TilePosition[] = [
  { top: '0px', left: '-240px', column: -1, row: 0 },
  { top: '0px', left: '-480px', column: -2, row: 0 },
  { top: 'calc(100% - 240px)', left: '-240px', column: -1, row: 1 },
  { top: 'calc(100% - 240px)', left: '-480px', column: -2, row: 1 },
];

const RIGHT_POSITIONS: readonly TilePosition[] = [
  { top: '0px', left: '100%', column: 2, row: 0 },
  { top: '0px', left: 'calc(100% + 240px)', column: 3, row: 0 },
  { top: 'calc(100% - 240px)', left: '100%', column: 2, row: 1 },
  { top: 'calc(100% - 240px)', left: 'calc(100% + 240px)', column: 3, row: 1 },
];

const BOTTOM_POSITIONS: readonly TilePosition[] = [
  { top: '100%', left: '0px', column: 0, row: 2 },
  { top: '100%', left: '240px', column: 1, row: 2 },
];

const TRAIL_COLOURS = [
  'var(--login-trail-gold)',
  'var(--login-trail-amber)',
  'var(--login-trail-orange)',
  'var(--login-trail-vermilion)',
  'var(--login-trail-red)',
] as const;

/** Timing values measured from the current live Mistral sign-in background. */
export const LOGIN_AMBIENT_CADENCE = Object.freeze({
  transitionMs: 1800,
  revealBaseMs: 1200,
  revealJitterMs: 3600,
  dwellBaseMs: 2600,
  dwellJitterMs: 2400,
  hideBaseMs: 3400,
  hideJitterMs: 2600,
});

const AMBIENT_MOTION_QUERY = '(min-width: 640px) and (prefers-reduced-motion: no-preference)';

function ambientMotionMatches(staticFrame: boolean): boolean {
  return !staticFrame &&
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia(AMBIENT_MOTION_QUERY).matches;
}

function useAmbientMotionEnabled(staticFrame: boolean): boolean {
  const [enabled, setEnabled] = React.useState(() => ambientMotionMatches(staticFrame));

  React.useEffect(() => {
    if (staticFrame || typeof window.matchMedia !== 'function') {
      setEnabled(false);
      return undefined;
    }

    const query = window.matchMedia(AMBIENT_MOTION_QUERY);
    const sync = () => setEnabled(query.matches);
    sync();
    query.addEventListener?.('change', sync);
    return () => query.removeEventListener?.('change', sync);
  }, [staticFrame]);

  return enabled;
}

function chooseNextPosition(
  positions: readonly TilePosition[],
  currentIndex: number,
): { nextIndex: number; direction: TrailDirection } {
  const current = positions[currentIndex];
  if (!current) return { nextIndex: currentIndex, direction: 'right' };

  const candidates = positions
    .map((position, positionIndex) => ({ position, positionIndex }))
    .filter(({ position, positionIndex }) => (
      positionIndex !== currentIndex &&
      (position.top === current.top || position.left === current.left)
    ));
  const selected = candidates[Math.floor(Math.random() * candidates.length)];
  if (!selected) return { nextIndex: currentIndex, direction: 'right' };

  const next = selected.position;
  const direction: TrailDirection = next.column > current.column
    ? 'right'
    : next.column < current.column
      ? 'left'
      : next.row > current.row
        ? 'down'
        : 'up';
  return { nextIndex: selected.positionIndex, direction };
}

function trailStyle(
  direction: TrailDirection,
  active: boolean,
  color: string,
): React.CSSProperties {
  const common: React.CSSProperties = {
    backgroundColor: color,
    width: '100%',
    height: '100%',
  };
  if (direction === 'right') {
    return {
      ...common,
      top: 0,
      left: '-100%',
      transform: `scaleX(${active ? 1 : 0})`,
      transformOrigin: 'right',
    };
  }
  if (direction === 'left') {
    return {
      ...common,
      top: 0,
      right: '-100%',
      transform: `scaleX(${active ? 1 : 0})`,
      transformOrigin: 'left',
    };
  }
  if (direction === 'down') {
    return {
      ...common,
      top: '-100%',
      left: 0,
      transform: `scaleY(${active ? 1 : 0})`,
      transformOrigin: 'bottom',
    };
  }
  return {
    ...common,
    bottom: '-100%',
    left: 0,
    transform: `scaleY(${active ? 1 : 0})`,
    transformOrigin: 'top',
  };
}

function AmbientTile({
  index,
  side,
  positions,
  initialPositionIndex,
  delayOffset,
  allowBrandColor = false,
  motionEnabled,
  staticFrame,
}: {
  index: number;
  side: AmbientSide;
  positions: readonly TilePosition[];
  initialPositionIndex: number;
  delayOffset: number;
  allowBrandColor?: boolean;
  motionEnabled: boolean;
  staticFrame: boolean;
}) {
  const [tile, setTile] = React.useState<TileState>({
    positionIndex: initialPositionIndex,
    isDefault: false,
    isVisible: staticFrame,
    isMoving: staticFrame && allowBrandColor,
    brandColor: TRAIL_COLOURS[index % TRAIL_COLOURS.length] ?? TRAIL_COLOURS[0],
    showBrandColor: staticFrame && allowBrandColor,
    trailDirection: index === 3 ? 'left' : 'right',
  });

  React.useEffect(() => {
    if (!motionEnabled) {
      setTile((current) => ({
        ...current,
        positionIndex: initialPositionIndex,
        isDefault: index % 2 === 0,
        isVisible: staticFrame,
        isMoving: staticFrame && allowBrandColor,
        showBrandColor: staticFrame && allowBrandColor,
        trailDirection: index === 3 ? 'left' : 'right',
      }));
      return undefined;
    }

    let cancelled = false;
    let revealTimer: number | undefined;
    let moveTimer: number | undefined;
    let settleTimer: number | undefined;
    let hideTimer: number | undefined;

    const schedule = () => {
      const revealDelay = LOGIN_AMBIENT_CADENCE.revealBaseMs + delayOffset +
        Math.random() * LOGIN_AMBIENT_CADENCE.revealJitterMs;
      revealTimer = window.setTimeout(() => {
        if (cancelled) return;
        setTile((current) => ({
          ...current,
          isDefault: Math.random() > 0.5,
          isVisible: true,
        }));

        const dwellDelay = LOGIN_AMBIENT_CADENCE.dwellBaseMs +
          Math.random() * LOGIN_AMBIENT_CADENCE.dwellJitterMs;
        moveTimer = window.setTimeout(() => {
          if (cancelled) return;
          setTile((current) => {
            const { nextIndex, direction } = chooseNextPosition(positions, current.positionIndex);
            return {
              positionIndex: nextIndex,
              isDefault: Math.random() > 0.5,
              isVisible: true,
              isMoving: true,
              brandColor: TRAIL_COLOURS[
                Math.floor(Math.random() * TRAIL_COLOURS.length)
              ] ?? TRAIL_COLOURS[0],
              showBrandColor: allowBrandColor && Math.random() > 0.65,
              trailDirection: direction,
            };
          });

          settleTimer = window.setTimeout(() => {
            if (cancelled) return;
            setTile((current) => ({ ...current, isMoving: false }));
          }, LOGIN_AMBIENT_CADENCE.transitionMs);

          hideTimer = window.setTimeout(() => {
            if (cancelled) return;
            setTile((current) => ({ ...current, isVisible: false }));
            schedule();
          }, LOGIN_AMBIENT_CADENCE.hideBaseMs +
            Math.random() * LOGIN_AMBIENT_CADENCE.hideJitterMs);
        }, dwellDelay);
      }, revealDelay);
    };

    schedule();
    return () => {
      cancelled = true;
      if (revealTimer !== undefined) window.clearTimeout(revealTimer);
      if (moveTimer !== undefined) window.clearTimeout(moveTimer);
      if (settleTimer !== undefined) window.clearTimeout(settleTimer);
      if (hideTimer !== undefined) window.clearTimeout(hideTimer);
    };
  }, [allowBrandColor, delayOffset, index, initialPositionIndex, motionEnabled, positions, staticFrame]);

  const position = positions[tile.positionIndex];
  const trailActive = tile.isMoving && tile.showBrandColor;
  return (
    <span
      data-login-ambient-tile={index}
      data-login-ambient-side={side}
      data-login-ambient-visible={tile.isVisible ? 'true' : 'false'}
      data-login-ambient-moving={tile.isMoving ? 'true' : 'false'}
      aria-hidden="true"
      className="login-auth-cell pointer-events-none absolute z-10 h-[240px] w-[240px]"
      style={{
        top: position?.top,
        left: position?.left,
        backgroundColor: tile.isDefault
          ? 'var(--login-tile-default)'
          : 'var(--login-tile-muted)',
        opacity: tile.isVisible ? 1 : 0,
      }}
    >
      {allowBrandColor ? (
        <span
          data-login-ambient-trail
          data-login-ambient-trail-active={trailActive ? 'true' : 'false'}
          aria-hidden="true"
          className="login-auth-trail absolute"
          style={trailStyle(tile.trailDirection, trailActive, tile.brandColor)}
        />
      ) : null}
    </span>
  );
}

export function LoginAuthBackdrop({
  className,
  staticFrame = false,
}: {
  className?: string;
  staticFrame?: boolean;
}) {
  const motionEnabled = useAmbientMotionEnabled(staticFrame);

  return (
    <div
      data-login-ambient-grid
      data-login-ambient-cadence="mistral"
      aria-hidden="true"
      className={cn('pointer-events-none absolute inset-0 z-0 hidden sm:block', className)}
    >
      <AmbientTile
        index={0}
        side="top"
        delayOffset={1200}
        initialPositionIndex={0}
        positions={TOP_POSITIONS}
        allowBrandColor
        motionEnabled={motionEnabled}
        staticFrame={staticFrame}
      />
      <AmbientTile
        index={1}
        side="left"
        delayOffset={0}
        initialPositionIndex={0}
        positions={LEFT_POSITIONS}
        motionEnabled={motionEnabled}
        staticFrame={staticFrame}
      />
      <AmbientTile
        index={2}
        side="right"
        delayOffset={2600}
        initialPositionIndex={1}
        positions={RIGHT_POSITIONS}
        motionEnabled={motionEnabled}
        staticFrame={staticFrame}
      />
      <AmbientTile
        index={3}
        side="bottom"
        delayOffset={4200}
        initialPositionIndex={1}
        positions={BOTTOM_POSITIONS}
        allowBrandColor
        motionEnabled={motionEnabled}
        staticFrame={staticFrame}
      />

      <span className="login-auth-side-mask login-auth-side-mask--left" />
      <span className="login-auth-side-mask login-auth-side-mask--right" />
      {(['top', 'bottom', 'left', 'right'] as const).map((edge) => (
        <span
          key={edge}
          data-login-guide={edge}
          className={`login-auth-guide login-auth-guide--${edge}`}
        />
      ))}
    </div>
  );
}
