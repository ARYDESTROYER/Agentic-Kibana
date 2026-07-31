import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';

import {
  LOGIN_AMBIENT_CADENCE,
  LoginAuthBackdrop,
} from '../auth/LoginAuthBackdrop';

type AmbientSide = 'top' | 'right' | 'bottom' | 'left';

const AMBIENT_SIDES: AmbientSide[] = ['top', 'right', 'bottom', 'left'];

function ambientTiles(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>('[data-login-ambient-tile]'),
  );
}

function tileForSide(container: HTMLElement, side: AmbientSide): HTMLElement {
  const tile = container.querySelector<HTMLElement>(
    `[data-login-ambient-tile][data-login-ambient-side="${side}"]`,
  );
  expect(tile).not.toBeNull();
  return tile as HTMLElement;
}

function trailForSide(container: HTMLElement, side: 'top' | 'bottom'): HTMLElement {
  const trail = tileForSide(container, side).querySelector<HTMLElement>(
    '[data-login-ambient-trail]',
  );
  expect(trail).not.toBeNull();
  return trail as HTMLElement;
}

function isNeutralCarrier(tile: HTMLElement): boolean {
  return (
    tile.style.backgroundColor.includes('var(--login-tile-default)') ||
    tile.style.backgroundColor.includes('var(--login-tile-muted)')
  );
}

function expectMistralStructure(ambient: HTMLElement) {
  const tiles = ambientTiles(ambient);
  expect(tiles).toHaveLength(4);
  expect(ambient.querySelector('[data-login-ambient-anchor]')).toBeNull();
  expect(ambient.querySelector('.login-auth-accent')).toBeNull();

  for (const tile of tiles) {
    expect(tile).toHaveClass('login-auth-cell', 'h-[240px]', 'w-[240px]');
    expect(tile.style.width).toBe('');
    expect(tile.style.height).toBe('');
    expect(tile.style.transform).toBe('');
    expect(isNeutralCarrier(tile)).toBe(true);
  }

  const trails = Array.from(
    ambient.querySelectorAll<HTMLElement>('[data-login-ambient-trail]'),
  );
  expect(trails).toHaveLength(2);
  expect(trails.every((trail) => trail.classList.contains('login-auth-trail'))).toBe(true);
  expect(tileForSide(ambient, 'top').querySelectorAll('[data-login-ambient-trail]')).toHaveLength(1);
  expect(tileForSide(ambient, 'bottom').querySelectorAll('[data-login-ambient-trail]')).toHaveLength(1);
  expect(tileForSide(ambient, 'left').querySelector('[data-login-ambient-trail]')).toBeNull();
  expect(tileForSide(ambient, 'right').querySelector('[data-login-ambient-trail]')).toBeNull();

  const warmNodes = Array.from(ambient.querySelectorAll<HTMLElement>('*')).filter(
    (node) => node.style.backgroundColor.includes('var(--login-trail-'),
  );
  expect(warmNodes).toHaveLength(2);
  expect(warmNodes.every((node) => node.hasAttribute('data-login-ambient-trail'))).toBe(true);
}

function installMotionPreference(matches: boolean) {
  const addEventListener = vi.fn();
  const removeEventListener = vi.fn();
  const matchMedia = vi.fn().mockReturnValue({
    matches,
    media: '(min-width: 640px) and (prefers-reduced-motion: no-preference)',
    onchange: null,
    addEventListener,
    removeEventListener,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  } satisfies MediaQueryList);

  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: matchMedia,
  });

  return { addEventListener, matchMedia, removeEventListener };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('LoginAuthBackdrop', () => {
  it('renders the sparse Mistral carrier and trail topology without detached colour tiles', () => {
    const media = installMotionPreference(false);
    const setTimeoutSpy = vi.spyOn(window, 'setTimeout');
    const setIntervalSpy = vi.spyOn(window, 'setInterval');
    const { container, unmount } = render(<LoginAuthBackdrop />);

    const ambient = container.querySelector<HTMLElement>('[data-login-ambient-grid]');
    expect(ambient).not.toBeNull();
    expect(ambient).toHaveAttribute('aria-hidden', 'true');
    expect(ambient).toHaveAttribute('data-login-ambient-cadence', 'mistral');
    expect(ambient).toHaveClass('pointer-events-none', 'hidden', 'sm:block');
    expect(
      Array.from(ambient?.querySelectorAll<HTMLElement>('[data-login-guide]') ?? [])
        .map((guide) => guide.dataset.loginGuide)
        .sort(),
    ).toEqual(['bottom', 'left', 'right', 'top']);
    expect(
      Array.from(ambient?.querySelectorAll<HTMLElement>('[data-login-ambient-tile]') ?? [])
        .map((tile) => tile.dataset.loginAmbientTile)
        .sort(),
    ).toEqual(['0', '1', '2', '3']);
    expectMistralStructure(ambient as HTMLElement);

    const tiles = ambientTiles(ambient as HTMLElement);
    expect(tiles.every((tile) => tile.style.opacity === '0')).toBe(true);
    expect(tiles.every((tile) => tile.dataset.loginAmbientVisible === 'false')).toBe(true);
    expect(tiles.every((tile) => tile.dataset.loginAmbientMoving === 'false')).toBe(true);
    expect(
      Array.from(ambient?.querySelectorAll<HTMLElement>('[data-login-ambient-trail]') ?? [])
        .every((trail) => trail.dataset.loginAmbientTrailActive === 'false'),
    ).toBe(true);
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    expect(setIntervalSpy).not.toHaveBeenCalled();
    expect(media.matchMedia).toHaveBeenCalledWith(
      '(min-width: 640px) and (prefers-reduced-motion: no-preference)',
    );

    unmount();
    expect(media.addEventListener).toHaveBeenCalledWith('change', expect.any(Function));
    expect(media.removeEventListener).toHaveBeenCalledWith('change', expect.any(Function));
  });

  it('keeps the Branding preview timer-free while showing one representative trail per horizontal edge', () => {
    installMotionPreference(true);
    const setTimeoutSpy = vi.spyOn(window, 'setTimeout');
    const setIntervalSpy = vi.spyOn(window, 'setInterval');
    const { container, unmount } = render(<LoginAuthBackdrop staticFrame />);

    const ambient = container.querySelector<HTMLElement>('[data-login-ambient-grid]');
    expect(ambient).not.toBeNull();
    expectMistralStructure(ambient as HTMLElement);
    const tiles = ambientTiles(ambient as HTMLElement);
    expect(tiles.every((tile) => tile.style.opacity === '1')).toBe(true);
    expect(tiles.every((tile) => tile.dataset.loginAmbientVisible === 'true')).toBe(true);
    expect(tileForSide(container, 'top').dataset.loginAmbientMoving).toBe('true');
    expect(tileForSide(container, 'bottom').dataset.loginAmbientMoving).toBe('true');
    expect(tileForSide(container, 'left').dataset.loginAmbientMoving).toBe('false');
    expect(tileForSide(container, 'right').dataset.loginAmbientMoving).toBe('false');
    expect(trailForSide(container, 'top')).toHaveAttribute(
      'data-login-ambient-trail-active',
      'true',
    );
    expect(trailForSide(container, 'bottom')).toHaveAttribute(
      'data-login-ambient-trail-active',
      'true',
    );
    expect(trailForSide(container, 'top').style.transform).toBe('scaleX(1)');
    expect(trailForSide(container, 'bottom').style.transform).toBe('scaleX(1)');
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    expect(setIntervalSpy).not.toHaveBeenCalled();

    unmount();
  });

  it('uses the measured cadence ranges and exact per-side reveal offsets', () => {
    expect(LOGIN_AMBIENT_CADENCE).toEqual({
      transitionMs: 1800,
      revealBaseMs: 1200,
      revealJitterMs: 3600,
      dwellBaseMs: 2600,
      dwellJitterMs: 2400,
      hideBaseMs: 3400,
      hideJitterMs: 2600,
    });

    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    installMotionPreference(true);
    const { container, unmount } = render(<LoginAuthBackdrop />);

    const visibleSides = () => AMBIENT_SIDES.filter(
      (side) => tileForSide(container, side).dataset.loginAmbientVisible === 'true',
    ).sort();

    expect(visibleSides()).toEqual([]);
    act(() => vi.advanceTimersByTime(1199));
    expect(visibleSides()).toEqual([]);
    act(() => vi.advanceTimersByTime(1));
    expect(visibleSides()).toEqual(['left']);
    act(() => vi.advanceTimersByTime(1199));
    expect(visibleSides()).toEqual(['left']);
    act(() => vi.advanceTimersByTime(1));
    expect(visibleSides()).toEqual(['left', 'top']);
    act(() => vi.advanceTimersByTime(1399));
    expect(visibleSides()).toEqual(['left', 'top']);
    act(() => vi.advanceTimersByTime(1));
    expect(visibleSides()).toEqual(['left', 'right', 'top']);
    act(() => vi.advanceTimersByTime(1599));
    expect(visibleSides()).toEqual(['left', 'right', 'top']);
    act(() => vi.advanceTimersByTime(1));
    expect(visibleSides()).toEqual(['bottom', 'left', 'right', 'top']);

    unmount();
  });

  it('moves across two horizontal endpoints and within the side 2x2 lattices without changing tile size', () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    installMotionPreference(true);
    const { container, unmount } = render(<LoginAuthBackdrop />);

    const top = tileForSide(container, 'top');
    const left = tileForSide(container, 'left');
    const right = tileForSide(container, 'right');
    const bottom = tileForSide(container, 'bottom');
    expect({ top: top.style.top, left: top.style.left }).toEqual({ top: '-240px', left: '0px' });
    expect({ top: left.style.top, left: left.style.left }).toEqual({ top: '0px', left: '-240px' });
    expect({ top: right.style.top, left: right.style.left }).toEqual({
      top: '0px',
      left: 'calc(100% + 240px)',
    });
    expect({ top: bottom.style.top, left: bottom.style.left }).toEqual({
      top: '100%',
      left: '240px',
    });

    act(() => vi.advanceTimersByTime(3800));
    expect({ top: left.style.top, left: left.style.left }).toEqual({ top: '0px', left: '-480px' });
    expect(left.dataset.loginAmbientMoving).toBe('true');
    act(() => vi.advanceTimersByTime(1200));
    expect({ top: top.style.top, left: top.style.left }).toEqual({ top: '-240px', left: '240px' });
    act(() => vi.advanceTimersByTime(1400));
    expect({ top: right.style.top, left: right.style.left }).toEqual({ top: '0px', left: '100%' });
    act(() => vi.advanceTimersByTime(1600));
    expect({ top: bottom.style.top, left: bottom.style.left }).toEqual({ top: '100%', left: '0px' });

    for (const tile of [top, left, right, bottom]) {
      expect(tile).toHaveClass('h-[240px]', 'w-[240px]');
      expect(tile.style.width).toBe('');
      expect(tile.style.height).toBe('');
      expect(tile.style.transform).toBe('');
      expect(isNeutralCarrier(tile)).toBe(true);
    }

    unmount();
  });

  it('can move the side carriers within the same column of their 2x2 lattices', () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.99);
    installMotionPreference(true);
    const { container, unmount } = render(<LoginAuthBackdrop />);

    act(() => vi.advanceTimersByTime(12_500));
    expect({
      top: tileForSide(container, 'left').style.top,
      left: tileForSide(container, 'left').style.left,
    }).toEqual({ top: 'calc(100% - 240px)', left: '-240px' });
    expect({
      top: tileForSide(container, 'right').style.top,
      left: tileForSide(container, 'right').style.left,
    }).toEqual({ top: 'calc(100% - 240px)', left: 'calc(100% + 240px)' });

    unmount();
  });

  it('activates a warm trail only above the measured 65 percent random threshold', () => {
    const renderAtRandom = (randomValue: number) => {
      vi.useFakeTimers();
      vi.spyOn(Math, 'random').mockReturnValue(randomValue);
      installMotionPreference(true);
      const view = render(<LoginAuthBackdrop />);
      act(() => vi.advanceTimersByTime(9000));
      return view;
    };

    const inactive = renderAtRandom(0.65);
    expect(tileForSide(inactive.container, 'top').dataset.loginAmbientMoving).toBe('true');
    expect(trailForSide(inactive.container, 'top')).toHaveAttribute(
      'data-login-ambient-trail-active',
      'false',
    );
    expect(trailForSide(inactive.container, 'top').style.transform).toBe('scaleX(0)');
    inactive.unmount();
    vi.useRealTimers();
    vi.restoreAllMocks();

    const active = renderAtRandom(0.66);
    expect(tileForSide(active.container, 'top').dataset.loginAmbientMoving).toBe('true');
    expect(trailForSide(active.container, 'top')).toHaveAttribute(
      'data-login-ambient-trail-active',
      'true',
    );
    expect(trailForSide(active.container, 'top').style.transform).toBe('scaleX(1)');
    expect(isNeutralCarrier(tileForSide(active.container, 'top'))).toBe(true);
    active.unmount();
  });

  it('clears every reveal, move, settle, hide, and recursive timer on unmount', () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    installMotionPreference(true);
    const view = render(
      <React.StrictMode>
        <LoginAuthBackdrop />
      </React.StrictMode>,
    );

    act(() => vi.advanceTimersByTime(8500));
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
