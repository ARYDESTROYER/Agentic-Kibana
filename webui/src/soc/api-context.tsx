/**
 * ApiProvider / useApi — a tiny dependency-injection seam for the API client
 * (Round-5 Coupling-A / RESEARCH_COUPLING §A7).
 *
 * The console has exactly ONE API client — the `api` singleton in `@/lib/api`, which
 * owns all the cross-cutting behaviour (`credentials:'include'`, `ApiError`, the
 * `setUnauthorizedHandler` reauth-retry). Historically pages imported that singleton
 * directly, which is fine at runtime but leaves no seam to inject a fake in a test.
 *
 * This context provides that seam WITHOUT changing runtime behaviour: the default
 * value IS the real singleton, so a component that calls `useApi()` outside a provider
 * (or inside `<ApiProvider>` with no override) gets exactly the singleton it would have
 * imported. A test wraps the tree in `<ApiProvider value={fakeApi}>` to inject a stub.
 *
 * This is DI, NOT a state store (the React-Context perf trap): the value is a stable
 * singleton, so consumers never re-render from it. Server state stays in the co-located
 * `*.api.ts` builders; personal state stays in the prefs store.
 */
import * as React from 'react';
import { api as defaultApi } from '@/lib/api';

/** The shape of the injectable client — structurally the real singleton. */
export type ApiClient = typeof defaultApi;

/** Default = the real singleton, so `useApi()` works with or without a provider. */
const ApiContext = React.createContext<ApiClient>(defaultApi);

/**
 * Provide an API client to the tree. Omit `value` (or pass the singleton) in the app;
 * pass a fake in a test to intercept every `useApi()` call under it.
 */
export const ApiProvider: React.FC<{ value?: ApiClient; children: React.ReactNode }> = ({
  value,
  children,
}) => <ApiContext.Provider value={value ?? defaultApi}>{children}</ApiContext.Provider>;

/** Access the injected API client (defaults to the real `@/lib/api` singleton). */
export function useApi(): ApiClient {
  return React.useContext(ApiContext);
}
