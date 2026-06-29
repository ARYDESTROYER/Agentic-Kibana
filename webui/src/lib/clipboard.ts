/**
 * clipboard — copy-to-clipboard that ALSO works in a non-secure (plain HTTP) context.
 *
 * The `tlsoc-webui` nginx is commonly reached over `http://host:8080`. The async
 * Clipboard API (`navigator.clipboard`) is only available in a *secure context*
 * (HTTPS, or `localhost`); over plain HTTP it is `undefined`, so a bare
 * `navigator.clipboard?.writeText(...)` optional-chains to `undefined` — no write,
 * no error, no feedback. Callers then show a "Copied" state for a copy that never
 * happened.
 *
 * `copyText` tries the modern API first and falls back to the legacy hidden-textarea
 * + `document.execCommand('copy')` path, which works without a secure context. It
 * NEVER throws — it resolves to a boolean so callers can drive success/failure UI
 * (e.g. a transient "Copied" badge vs. a toast).
 */

/** Legacy fallback: copy via a hidden, off-screen, read-only <textarea> + execCommand. */
function execCommandCopy(text: string): boolean {
  if (typeof document === 'undefined') return false;
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.readOnly = true;
  // Keep it out of the layout/scroll flow and invisible to the user.
  ta.setAttribute('aria-hidden', 'true');
  ta.style.position = 'fixed';
  ta.style.top = '0';
  ta.style.left = '0';
  ta.style.width = '1px';
  ta.style.height = '1px';
  ta.style.padding = '0';
  ta.style.border = 'none';
  ta.style.outline = 'none';
  ta.style.boxShadow = 'none';
  ta.style.background = 'transparent';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  let ok = false;
  try {
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, text.length);
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  } finally {
    document.body.removeChild(ta);
  }
  return ok;
}

/**
 * Copy `text` to the clipboard. Resolves `true` on success, `false` on failure.
 * Tries the async Clipboard API (secure contexts) then falls back to execCommand.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Secure-context API present but rejected (e.g. permission/focus) — fall through.
  }
  return execCommandCopy(text);
}

export default copyText;
