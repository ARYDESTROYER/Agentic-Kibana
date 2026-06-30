"""Round 3 / Wave 4 — WCAG-AA branding contrast advisory.

Covers the new pure helper ``app.engine.contrast`` AND its wiring into
``PUT /api/branding`` (the Wave-3 gap: the BrandingEditor expects the PUT response to
carry ``contrast_warnings`` + ``auto_corrected``; previously the endpoint only echoed
the saved dump).

Discipline checks baked in:
  * the helper is PURE (same input → same output, no mutation of the argument);
  * WCAG luminance + contrast-ratio math matches KNOWN reference values
    (white/black = 21:1, white/white = 1:1, luminance of white = 1.0 / black = 0.0);
  * a LOW-contrast accent yields a warning AND an auto-corrected foreground;
  * a GOOD accent yields neither;
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


def test_low_contrast_accent_warns_and_autocorrects() -> None:
    out = evaluate_branding_contrast({"accent_color": "#ffff00"})
    # The light accent fails white-text AA → corrected to a black foreground.
    assert out["auto_corrected"] == {"--primary-foreground": "#000000"}
    # …and a single plain-text warning is surfaced.
    assert len(out["contrast_warnings"]) == 1
    msg = out["contrast_warnings"][0]
    assert isinstance(msg, str)
    assert "#ffff00" in msg
    assert "4.5" in msg  # references the AA-normal bar


def test_good_accent_yields_no_advisory() -> None:
    out = evaluate_branding_contrast({"accent_color": "#1f6feb"})
    assert out["auto_corrected"] == {}
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


def test_white_passing_accent_keeps_white_default_no_correction() -> None:
    # #767676: white text reaches ~4.54:1 (>= 4.5) — keep the white default; black would
    # be a hair higher but white IS the design token and is legible. No correction/warn.
    out = evaluate_branding_contrast({"accent_color": "#767676"})
    assert out["auto_corrected"] == {}
    assert out["contrast_warnings"] == []


def test_secondary_accent_and_theme_tokens_are_each_evaluated() -> None:
    out = evaluate_branding_contrast(
        {
            "accent_color": "#ffff00",  # light → warns + corrects --primary-foreground
            "accent_color2": "#1f6feb",  # good → silent
            "theme_tokens": {"--accent": "#fafafa"},  # light → warns + corrects --accent-foreground
        }
    )
    assert out["auto_corrected"] == {
        "--primary-foreground": "#000000",
        "--accent-foreground": "#000000",
    }
    # Two warnings: the primary accent and the --accent theme token.
    assert len(out["contrast_warnings"]) == 2
    blob = " ".join(out["contrast_warnings"])
    assert "#ffff00" in blob
    assert "#fafafa" in blob
    # The good secondary accent contributes nothing.
    assert "#1f6feb" not in blob


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


def test_put_branding_low_contrast_returns_warning_and_correction(client) -> None:
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
    assert body["product_name"] == "Agentic Triage"
    # The new ADDITIVE advisory keys are present + populated.
    assert body["auto_corrected"] == {"--primary-foreground": "#000000"}
    assert isinstance(body["contrast_warnings"], list)
    assert len(body["contrast_warnings"]) == 1
    assert "#ffff00" in body["contrast_warnings"][0]
    # And the save is durable: GET reflects the persisted accent.
    assert client.get("/api/branding").json()["accent_color"] == "#ffff00"


def test_put_branding_good_accent_returns_empty_advisory(client) -> None:
    r = client.put(
        "/api/branding",
        json={"org_name": "Azure SOC", "accent_color": "#1f6feb"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["accent_color"] == "#1f6feb"
    # Additive keys present but EMPTY for a good accent.
    assert body["auto_corrected"] == {}
    assert body["contrast_warnings"] == []


def test_put_branding_default_accent_is_silent(client) -> None:
    # No accent override → the built-in AA-vetted accent → no advisory.
    r = client.put("/api/branding", json={"org_name": "Plain SOC"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["auto_corrected"] == {}
    assert body["contrast_warnings"] == []
