/**
 * errorMessage — the ONE place that turns any caught value into readable text.
 *
 * Round-5 W0-B B5: promotes the ad-hoc `errMessage` helpers that were copy-pasted
 * across ~25 pages into a single shared function built on the `ApiError` the typed
 * client throws (`lib/api.ts`). Every load/error surface (and the shared `<LoadError>`
 * component) routes through this so the wording is consistent and #9-safe: the message
 * is always rendered as PLAIN text by the caller — never as HTML.
 *
 * Precedence, most→least specific:
 *   1. `ApiError`   — use its `.message` (the backend `detail`, already extracted by
 *      the client). We do NOT append the status code: the message is the human string,
 *      the status is available on the error object for callers that want it.
 *   2. any `Error`  — use `.message` (falls back to the class name when empty).
 *   3. a `string`   — use it verbatim when non-blank.
 *   4. anything else — a best-effort `JSON.stringify`, else the `fallback`.
 *
 * The `fallback` (default "Something went wrong.") is returned for `null`/`undefined`,
 * empty strings, un-stringifiable values, and empty-message errors, so a caller can
 * always show *something*.
 */
import { ApiError } from './api';

export function errorMessage(e: unknown, fallback = 'Something went wrong.'): string {
  // ApiError first — its `message` is the backend `detail` the client already extracted.
  if (e instanceof ApiError) {
    const m = e.message?.trim();
    return m || fallback;
  }
  if (e instanceof Error) {
    const m = e.message?.trim();
    return m || e.name || fallback;
  }
  if (typeof e === 'string') {
    const m = e.trim();
    return m || fallback;
  }
  if (e === null || e === undefined) return fallback;
  try {
    const s = JSON.stringify(e);
    // `undefined`/functions stringify to `undefined`; treat that as no message.
    return s && s !== 'undefined' && s !== '{}' ? s : fallback;
  } catch {
    return fallback;
  }
}
