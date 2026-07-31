"""Round 3 / Wave 4 — WCAG-AA branding contrast advisory.

Covers the new pure helper ``app.engine.contrast`` AND its wiring into
``PUT /api/branding`` (the Wave-3 gap: the BrandingEditor expects the PUT response to
carry ``contrast_warnings`` + ``auto_corrected``; previously the endpoint only echoed
the saved dump).

Discipline checks baked in:
  * the helper is PURE (same input → same output, no mutation of the argument);
  * WCAG luminance + contrast-ratio math matches KNOWN reference values
    (white/black = 21:1, white/white = 1:1, luminance of white = 1.0 / black = 0.0);
  * every parseable accent reports the exact higher-contrast derived foreground;
  * the advisory is silent when that effective pair clears AA;
  * the PUT response keeps every existing branding field intact (additive keys only)
    and the save still persists (warn, don't block).
"""

from __future__ import annotations

import math

from app.engine.contrast import (
    AA_LARGE,
    AA_NORMAL,
    best_foreground,
    contrast_ratio,
    evaluate_branding_contrast,
    parse_hex,
    relative_luminance,
)

# --------------------------------------------------------------------------- #
# Pure math — against published WCAG reference values.
# --------------------------------------------------------------------------- #


def test_parse_hex_accepts_3_and_6_digit_and_rejects_garbage() -> None:
    assert parse_hex("#ffffff") == (255, 255, 255)
    assert parse_hex("#000000") == (0, 0, 0)
    assert parse_hex("#fff") == (255, 255, 255)  # shorthand expands
    assert parse_hex("1f6feb") == (0x1F, 0x6F, 0xEB)  # leading '#' optional
    assert parse_hex("") is None
    assert parse_hex(None) is None
    assert parse_hex("not-a-hex") is None
    assert parse_hex("#12") is None
    assert parse_hex("#1234") is None  # 4 digits is not valid


def test_relative_luminance_known_endpoints() -> None:
    # White luminance is exactly 1.0, black exactly 0.0 (the sRGB→linear curve maps
    # the channel extremes to {0,1}). These are the canonical WCAG anchors.
    assert relative_luminance((255, 255, 255)) == 1.0
    assert relative_luminance((0, 0, 0)) == 0.0
    # A mid grey sits well below 0.5 (perceptual, not linear midpoint).
    grey = relative_luminance((119, 119, 119))  # #777
    assert 0.17 < grey < 0.20


def test_contrast_ratio_known_pairs() -> None:
    # The defining WCAG pair: pure white on pure black is exactly 21:1.
    assert contrast_ratio("#ffffff", "#000000") == 21.0
    # A colour against itself is exactly 1:1.
    assert contrast_ratio("#1f6feb", "#1f6feb") == 1.0
    # Ratio is symmetric in its arguments (lighter colour is always the numerator).
    a = contrast_ratio("#ffffff", "#000000")
    b = contrast_ratio("#000000", "#ffffff")
    assert a == b == 21.0
    # Unparseable inputs → None (fail-open; the caller skips them).
    assert contrast_ratio("garbage", "#000000") is None
    assert contrast_ratio("#000000", "") is None


def test_contrast_ratio_matches_independent_formula() -> None:
    # Recompute #1f6feb (azure) on white from first principles and compare.
    lum_accent = relative_luminance(parse_hex("#1f6feb"))  # type: ignore[arg-type]
    lum_white = 1.0
    expected = (max(lum_accent, lum_white) + 0.05) / (min(lum_accent, lum_white) + 0.05)
    got = contrast_ratio("#ffffff", "#1f6feb")
    assert got is not None
    assert math.isclose(got, expected, rel_tol=1e-12)
    # And it clears the AA-UI/large bar with white text (azure is an AA-vetted preset).
    assert got >= AA_LARGE


def test_best_foreground_picks_higher_contrast_side() -> None:
    # Light accent → black text is more legible.
    assert best_foreground("#ffff00") == "#000000"  # bright yellow
    assert best_foreground("#fafafa") == "#000000"  # near-white
    # Dark accent → white text wins.
    assert best_foreground("#1f6feb") == "#ffffff"
    assert best_foreground("#000000") == "#ffffff"
    # Blank / unparseable → no foreground to derive.
    assert best_foreground("") is None
    assert best_foreground("nope") is None


# --------------------------------------------------------------------------- #
# evaluate_branding_contrast — the advisory shape used by PUT /api/branding.
# --------------------------------------------------------------------------- #


def test_light_accent_derives_black_without_a_residual_warning() -> None:
    out = evaluate_branding_contrast({"accent_color": "#ffff00"})
    # The light accent receives the exact black foreground the webui applies.
    assert out["auto_corrected"] == {"--primary-foreground": "#000000"}
    # The effective black/yellow pair clears AA, so there is no unresolved warning.
    assert out["contrast_warnings"] == []


def test_dark_accent_reports_the_derived_white_foreground() -> None:
    out = evaluate_branding_contrast({"accent_color": "#1f6feb"})
    assert out["auto_corrected"] == {"--primary-foreground": "#ffffff"}
    assert out["contrast_warnings"] == []


def test_blank_and_default_accents_are_silent() -> None:
    # An empty accent means "use the AA-vetted built-in" → nothing to evaluate.
    out = evaluate_branding_contrast({"accent_color": "", "accent_color2": ""})
    assert out == {"auto_corrected": {}, "contrast_warnings": []}
    # A doc with no accent fields at all is also silent.
    assert evaluate_branding_contrast({}) == {
        "auto_corrected": {},
        "contrast_warnings": [],
    }


def test_mid_accent_chooses_maximum_contrast_even_when_white_already_passes() -> None:
    # #767676: both candidates clear ~4.5, but black is slightly stronger. This is the
    # regression pair that used to disagree with the webui's maximum-contrast choice.
    out = evaluate_branding_contrast({"accent_color": "#767676"})
    assert best_foreground("#767676") == "#000000"
    assert out["auto_corrected"] == {"--primary-foreground": "#000000"}
    assert out["contrast_warnings"] == []


def test_secondary_accent_and_theme_tokens_are_each_evaluated() -> None:
    out = evaluate_branding_contrast(
        {
            "accent_color": "#ffff00",  # light → black --primary-foreground
            "accent_color2": "#1f6feb",  # dark → white --accent2-foreground
            "theme_tokens": {"--accent": "#fafafa"},
        }
    )
    assert out["auto_corrected"] == {
        "--primary-foreground": "#000000",
        "--accent2-foreground": "#ffffff",
        "--accent-foreground": "#000000",
    }
    assert out["contrast_warnings"] == []


def test_helper_is_pure_and_does_not_mutate_input() -> None:
    doc = {"accent_color": "#ffff00", "theme_tokens": {"--accent": "#fafafa"}}
    import copy

    snapshot = copy.deepcopy(doc)
    first = evaluate_branding_contrast(doc)
    second = evaluate_branding_contrast(doc)
    assert doc == snapshot  # argument untouched
    assert first == second  # referentially transparent


def test_aa_bars_are_the_published_thresholds() -> None:
    assert AA_NORMAL == 4.5
    assert AA_LARGE == 3.0


# --------------------------------------------------------------------------- #
# Wiring — PUT /api/branding now annotates the response (additive keys only).
# --------------------------------------------------------------------------- #


def test_put_branding_light_accent_returns_derived_foreground(client) -> None:
    r = client.put(
        "/api/branding",
        json={"org_name": "Lemon SOC", "accent_color": "#ffff00"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    # The save still persisted the operator's chosen accent (warn, don't block).
    assert body["org_name"] == "Lemon SOC"
    assert body["accent_color"] == "#ffff00"
    # Existing branding fields are intact (a representative defaulted field).
    assert body["product_name"] == ""
    # The additive response reports the exact runtime foreground choice.
    assert body["auto_corrected"] == {"--primary-foreground": "#000000"}
    assert body["contrast_warnings"] == []
    # And the save is durable: GET reflects the persisted accent.
    assert client.get("/api/branding").json()["accent_color"] == "#ffff00"


def test_put_branding_dark_accent_returns_derived_white_foreground(client) -> None:
    r = client.put(
        "/api/branding",
        json={"org_name": "Azure SOC", "accent_color": "#1f6feb"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["accent_color"] == "#1f6feb"
    assert body["auto_corrected"] == {"--primary-foreground": "#ffffff"}
    assert body["contrast_warnings"] == []


def test_put_branding_default_accent_is_silent(client) -> None:
    # No accent override → the built-in AA-vetted accent → no advisory.
    r = client.put("/api/branding", json={"org_name": "Plain SOC"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["auto_corrected"] == {}
    assert body["contrast_warnings"] == []


# --------------------------------------------------------------------------- #
# Round-5 W0-A A7 — server-side theme_tokens allow-list + sanitizer (mirror of
# the webui theme-tokens.ts ALLOWED_TOKENS + sanitizeTokenValue, #9/#10).
# --------------------------------------------------------------------------- #


def _tokens(**tokens):
    from app.config import BrandingConfig

    return BrandingConfig(theme_tokens=dict(tokens)).theme_tokens


def test_theme_tokens_keeps_allow_listed_and_drops_unknown() -> None:
    out = _tokens(**{
        "--primary": "210 90% 50%",   # allow-listed → kept
        "--radius": "0.5rem",         # allow-listed → kept
        "--background": "0 0% 0%",    # NOT allow-listed (only tints are) → dropped
        "--evil": "red",              # unknown → dropped
    })
    assert out == {"--primary": "210 90% 50%", "--radius": "0.5rem"}


def test_theme_tokens_normalises_bare_keys() -> None:
    # A key without the leading '--' is normalised, then allow-list-checked.
    assert _tokens(radius="0.625rem") == {"--radius": "0.625rem"}


def test_theme_tokens_drops_derived_foreground_and_text_tokens() -> None:
    # The complete measured semantic axis is NOT operator-writable. Accepting only
    # its fill would break the fixed foreground/text contrast and CVD pairings.
    out = _tokens(**{
        "--critical": "358 75% 45%",           # semantic fill → dropped
        "--critical-foreground": "0 0% 0%",     # derived → dropped
        "--critical-text": "358 75% 42%",       # derived → dropped
    })
    assert out == {}


def test_theme_tokens_drops_every_semantic_fill_compatibly() -> None:
    out = _tokens(**{
        "--critical": "0 0% 100%",
        "--high": "0 0% 100%",
        "--medium": "0 0% 100%",
        "--low": "0 0% 100%",
        "--info": "0 0% 100%",
        "--success": "0 0% 100%",
        "--warning": "0 0% 100%",
        "--radius": "0.5rem",
    })
    # Legacy payloads remain loadable: unsafe appearance keys are ignored rather
    # than making the whole BrandingConfig fail validation.
    assert out == {"--radius": "0.5rem"}


def test_theme_tokens_drops_unsafe_values() -> None:
    out = _tokens(**{
        "--primary": "red; } body { display:none",  # declaration break-out → dropped
        "--ring": "url(javascript:alert(1))",        # url() → dropped
        "--accent2": "expression(alert(1))",          # expression() → dropped
        "--canvas-tint": "blue /* x */",              # comment marker → dropped
        "--radius": "0.5rem",                         # safe value → kept
    })
    assert out == {"--radius": "0.5rem"}


def test_theme_tokens_font_display_restricted_to_enum() -> None:
    # A vetted enum KEY stays stable on the wire; the browser expands it at the
    # DOM boundary. This keeps the Settings Select stable after save/reload.
    ok = _tokens(**{"--font-display": "inter"})
    assert ok == {"--font-display": "inter"}
    # Current and legacy full stacks are accepted and canonicalised.
    current = _tokens(
        **{
            "--font-display": (
                "'Inter Variable', 'Inter', ui-sans-serif, system-ui, -apple-system, "
                "'Segoe UI', Roboto, sans-serif"
            )
        }
    )
    legacy = _tokens(
        **{
            "--font-display": (
                "'Inter', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', "
                "Roboto, sans-serif"
            )
        }
    )
    assert current == {"--font-display": "inter"}
    assert legacy == {"--font-display": "inter"}
    assert _tokens(**{"--font-display": "Comic Sans, cursive"}) == {}


def test_theme_tokens_still_raises_on_too_many() -> None:
    import pytest
    from app.config import BrandingConfig

    with pytest.raises(ValueError):
        BrandingConfig(theme_tokens={f"--k{i}": "x" for i in range(201)})
