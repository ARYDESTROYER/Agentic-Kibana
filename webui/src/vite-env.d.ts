/// <reference types="vite/client" />

declare module '*.css?url' {
  const url: string;
  export default url;
}

// EUI ships its `es/` build as plain JS with no co-located type declarations.
// We import the icon registry + individual icon assets directly (see
// src/lib/icons.ts) to statically register glyphs; declare those deep paths so
// strict-mode `noImplicitAny` is satisfied. The component shape is opaque to us
// (we only forward it into `appendIconComponentCache`), so `unknown` is enough.
declare module '@elastic/eui/es/components/icon/icon' {
  export const appendIconComponentCache: (
    map: Record<string, unknown>,
  ) => void;
}
declare module '@elastic/eui/es/components/icon/assets/*' {
  export const icon: unknown;
}
