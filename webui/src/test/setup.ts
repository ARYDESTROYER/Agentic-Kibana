/**
 * Vitest global setup (dev-only — not part of the production bundle).
 *
 * Imports jest-dom matchers (`toBeInTheDocument`, …) and stubs a couple of
 * browser APIs that EUI touches at render time but jsdom does not implement.
 */
import '@testing-library/jest-dom/vitest';

// EUI's responsive hooks read `window.matchMedia`, which jsdom omits.
if (typeof window !== 'undefined' && !window.matchMedia) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}

// Some EUI components observe element resize; jsdom lacks ResizeObserver.
if (typeof window !== 'undefined' && !(window as any).ResizeObserver) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// jsdom does not implement the 2D canvas context; some EUI widgets call it to
// measure text. Return a permissive stub so they don't throw at render time.
if (typeof HTMLCanvasElement !== 'undefined') {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  HTMLCanvasElement.prototype.getContext = (() =>
    ({
      font: '',
      measureText: () => ({ width: 0 }),
      fillRect: () => {},
      clearRect: () => {},
      getImageData: () => ({ data: [] }),
      putImageData: () => {},
      createImageData: () => [],
      setTransform: () => {},
      drawImage: () => {},
      save: () => {},
      restore: () => {},
      beginPath: () => {},
      moveTo: () => {},
      lineTo: () => {},
      closePath: () => {},
      stroke: () => {},
      fill: () => {},
      translate: () => {},
      scale: () => {},
      rotate: () => {},
      arc: () => {},
      fillText: () => {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any) as any;
}
