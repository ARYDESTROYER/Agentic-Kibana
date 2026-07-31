"""Pure WCAG contrast utilities for operator branding (Round 3 / Wave 4).

This module is the BACKEND mirror of ``webui/src/soc/components/branding.api.ts``:
it computes WCAG 2.x relative luminance + contrast ratios for operator-chosen accent
colours, picks the legible (black/white) foreground for each accent, AUTO-CORRECTS the
foreground to meet AA, and flags any accent/foreground pair that still cannot pass.

It is intentionally:
  * **pure** — no I/O, no state, no globals; every function is referentially
    transparent so it is trivially unit-testable and safe to call inside a request;
  * **dependency-free** — stdlib only (mirrors the suite's "zero new runtime deps");
  * **fail-open / non-blocking** — an unparseable / blank accent yields NO warning and
    NO correction (a blank accent means "use the AA-vetted built-in"), so the branding
    save is never rejected by a contrast issue (warn, don't block — the editor surfaces
    the advisory).

WCAG thresholds used:
  * normal (small) text  → ratio >= 4.5 : 1
  * large / UI text      → ratio >= 3.0 : 1

The accent fill carries foreground text (``--primary-foreground`` in the webui). We
choose whichever of black (#000000) / white (#ffffff) maximises contrast against the
accent, and emit that exact runtime choice as the derived ``*-foreground`` value.
"""

from __future__ import annotations

import re
from typing import Any

# WCAG-AA contrast bars.
AA_NORMAL = 4.5
AA_LARGE = 3.0

# Foreground candidates we choose between (the legible pair for any accent fill).
_WHITE = "#ffffff"
_BLACK = "#000000"

_HEX_RE = re.compile(r"^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")


def parse_hex(value: str | None) -> tuple[int, int, int] | None:
    """Parse ``#rgb`` / ``#rrggbb`` (with or without a leading ``#``) → (r, g, b) in
    0-255, or ``None`` if the string is blank / not a valid hex colour. Mirrors the
    webui ``parseHex`` so both sides agree byte-for-byte on what is parseable."""
    if not value:
        return None
    s = value.strip()
    m = _HEX_RE.match(s)
    if not m:
        return None
    h = m.group(1)
    if len(h) == 3:
        h = "".join(c + c for c in h)
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))


def relative_luminance(rgb: tuple[int, int, int]) -> float:
    """WCAG 2.x relative luminance of an sRGB colour (0.0 black … 1.0 white).

    Each channel is gamma-expanded to linear light then weighted by the standard
    luminosity coefficients. Matches ``relativeLuminance`` in the webui."""

    def _lin(c: int) -> float:
        s = c / 255.0
        return s / 12.92 if s <= 0.03928 else ((s + 0.055) / 1.055) ** 2.4

    r, g, b = rgb
    return 0.2126 * _lin(r) + 0.7152 * _lin(g) + 0.0722 * _lin(b)


def contrast_ratio(fg_hex: str | None, bg_hex: str | None) -> float | None:
    """WCAG contrast ratio (1.0 … 21.0) between two hex colours, or ``None`` if either
    is unparseable. Symmetric in its arguments (the lighter colour is the numerator
    regardless of order). Mirrors the webui ``contrastRatio``."""
    fg = parse_hex(fg_hex)
    bg = parse_hex(bg_hex)
    if fg is None or bg is None:
        return None
    l1 = relative_luminance(fg)
    l2 = relative_luminance(bg)
    lighter, darker = (l1, l2) if l1 >= l2 else (l2, l1)
    return (lighter + 0.05) / (darker + 0.05)


def best_foreground(accent_hex: str | None) -> str | None:
    """Pick the legible foreground (``#ffffff`` or ``#000000``) for an accent fill —
    whichever yields the HIGHER WCAG contrast ratio against the accent. Returns
    ``None`` for a blank / unparseable accent (no correction to make).

    This is the AUTO-CORRECTION: if white-on-accent fails AA but black-on-accent
    passes (a light accent), we flip the foreground to black, and vice-versa. When
    NEITHER fully passes (a mid-tone accent) we still return the better of the two so
    the operator gets the most legible option, and the residual gap is surfaced as a
    warning by :func:`evaluate_branding_contrast`."""
    if parse_hex(accent_hex) is None:
        return None
    white_ratio = contrast_ratio(_WHITE, accent_hex) or 0.0
    black_ratio = contrast_ratio(_BLACK, accent_hex) or 0.0
    return _WHITE if white_ratio >= black_ratio else _BLACK


def _round2(x: float) -> float:
    """Round a ratio to 2 dp for stable, readable wire values."""
    return round(x * 100) / 100


# --------------------------------------------------------------------------- #
# Accent → derived foreground tokens. We name the derived css-vars so the webui's
# auto_corrected map keys line up with the design-token system (``--primary`` ↔
# ``--primary-foreground``). The accent fill in BOTH light + dark carries the same
# foreground colour: we pick by the accent's own luminance, theme-independent — a
# light accent wants black text in either theme — so one correction covers both
# themes. The contrast we evaluate is foreground-on-accent (the legibility of text
# ON the accent fill), not accent-on-theme-background, so no theme background is
# needed here.
# --------------------------------------------------------------------------- #

# (config field name, derived-foreground css-var token) for the operator accents.
_ACCENT_TOKENS: tuple[tuple[str, str], ...] = (
    ("accent_color", "--primary-foreground"),
    ("accent_color2", "--accent2-foreground"),
)

# theme_tokens keys that hold an accent FILL and want a paired *-foreground. Only the
# well-known accent vars are auto-paired (we never invent foregrounds for arbitrary
# operator tokens). The value here is the derived-foreground token name.
_TOKEN_FOREGROUNDS: dict[str, str] = {
    "--primary": "--primary-foreground",
    "--accent": "--accent-foreground",
    "--accent2": "--accent2-foreground",
    "--ring": "--primary-foreground",
}


def _accent_candidates(branding: dict[str, Any]) -> list[tuple[str, str, str]]:
    """Collect (label, accent_hex, foreground_token) for every operator accent on a
    branding dict — the two top-level accents plus any accent-bearing theme_tokens.
    Blank / unparseable accents are skipped (nothing to evaluate or correct)."""
    out: list[tuple[str, str, str]] = []
    seen: set[str] = set()
    for field, fg_token in _ACCENT_TOKENS:
        hexval = str(branding.get(field) or "").strip()
        if hexval and parse_hex(hexval) is not None and fg_token not in seen:
            out.append((field, hexval, fg_token))
            seen.add(fg_token)
    tokens = branding.get("theme_tokens") or {}
    if isinstance(tokens, dict):
        for key, fg_token in _TOKEN_FOREGROUNDS.items():
            hexval = str(tokens.get(key) or "").strip()
            if hexval and parse_hex(hexval) is not None and fg_token not in seen:
                out.append((key, hexval, fg_token))
                seen.add(fg_token)
    return out


def evaluate_branding_contrast(branding: dict[str, Any]) -> dict[str, Any]:
    """Evaluate the operator accents on a branding dict and return the WCAG advisory.

    Returns a dict with two ADDITIVE keys for the PUT /api/branding response:

      * ``auto_corrected`` — ``{css-var-foreground-token: "#000000"|"#ffffff"}`` for
        every parseable accent. The value is the same higher-contrast black/white
        foreground that the webui derives at runtime, including mid-tone accents where
        white technically passes but black is still the stronger pair.
      * ``contrast_warnings`` — a list of plain-text strings, present only when the
        selected higher-contrast foreground still cannot clear the AA-normal bar
        (4.5:1). The webui renders each string as text (#9: no markup).

    Pure + non-blocking: a branding doc with no parseable accents returns empty
    advisories, so the save is never rejected on contrast grounds."""
    auto_corrected: dict[str, str] = {}
    warnings: list[str] = []

    for label, accent_hex, fg_token in _accent_candidates(branding):
        # Mirror the webui exactly: always select the higher-contrast black/white
        # foreground, even when the other candidate already happens to clear 4.5:1.
        fg = best_foreground(accent_hex)
        if fg is None:
            continue
        auto_corrected[fg_token] = fg
        best_ratio = contrast_ratio(fg, accent_hex) or 0.0
        if best_ratio >= AA_NORMAL:
            continue

        rounded = _round2(best_ratio)
        foreground_name = "white" if fg == _WHITE else "black"
        if best_ratio < AA_LARGE:
            warnings.append(
                f"Accent {accent_hex} ({label}): the best {foreground_name} foreground "
                f"reaches only {rounded}:1 — below the WCAG-AA minimum of 3:1 for "
                f"UI/large text. Choose a different accent."
            )
        else:
            warnings.append(
                f"Accent {accent_hex} ({label}): the best {foreground_name} foreground "
                f"reaches {rounded}:1 — it meets AA for large/UI text (3:1) but is "
                f"below the 4.5:1 needed for small text. Choose a higher-contrast accent."
            )

    return {"auto_corrected": auto_corrected, "contrast_warnings": warnings}
