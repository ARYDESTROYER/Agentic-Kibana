"""Wave 2 / F3 — TOTP MFA primitives (pure stdlib; offline).

Asserts the RFC 6238 Appendix-B SHA1 test vectors EXACTLY, the ±1 verify window,
replay rejection (matched step must advance past ``last_step``), single-use
recovery codes, the at-rest obfuscation round-trip, and the ``otpauth://`` URI shape.
"""

from __future__ import annotations

import base64
from urllib.parse import parse_qs, urlparse

from app.auth import mfa


def _seed_secret() -> str:
    # The RFC 6238 Appendix-B SHA1 seed ("12345678901234567890") as Base32.
    return base64.b32encode(mfa.RFC6238_TEST_SEED_ASCII.encode("ascii")).decode("ascii").rstrip("=")


# --------------------------------------------------------------------------- #
# RFC 6238 Appendix B (SHA1) — exact vectors
# --------------------------------------------------------------------------- #
def test_rfc6238_sha1_vectors() -> None:
    secret = _seed_secret()
    for unix_time, expected in mfa.RFC6238_SHA1_VECTORS:
        assert mfa.totp(secret, ts=unix_time, digits=6) == expected, f"ts={unix_time}"


def test_hotp_known_counter() -> None:
    # The RFC 6238 row at T=59 is time-step 1 (59 // 30); HOTP(counter=1) matches it.
    assert mfa.hotp(_seed_secret(), 1, digits=6) == "287082"


def test_generate_secret_is_valid_base32() -> None:
    s = mfa.generate_secret()
    assert s and s == s.upper()
    code = mfa.totp(s, ts=1000.0)
    ok, step = mfa.verify_totp(s, code, ts=1000.0)
    assert ok and step > 0


# --------------------------------------------------------------------------- #
# Verification window + replay
# --------------------------------------------------------------------------- #
def test_verify_window_plus_minus_one() -> None:
    secret = mfa.generate_secret()
    ts = 1_700_000_000.0
    step = int(ts // 30)
    ok_prev, m_prev = mfa.verify_totp(secret, mfa.hotp(secret, step - 1), ts=ts, window=1)
    ok_now, m_now = mfa.verify_totp(secret, mfa.hotp(secret, step), ts=ts, window=1)
    ok_next, m_next = mfa.verify_totp(secret, mfa.hotp(secret, step + 1), ts=ts, window=1)
    assert (ok_prev, m_prev) == (True, step - 1)
    assert (ok_now, m_now) == (True, step)
    assert (ok_next, m_next) == (True, step + 1)


def test_verify_outside_window_rejected() -> None:
    secret = mfa.generate_secret()
    ts = 1_700_000_000.0
    step = int(ts // 30)
    ok, matched = mfa.verify_totp(secret, mfa.hotp(secret, step + 5), ts=ts, window=1)
    assert not ok and matched == -1


def test_replay_rejected_by_last_step() -> None:
    secret = _seed_secret()
    ts = 1234.0
    code_now = mfa.totp(secret, ts=ts)
    ok, step = mfa.verify_totp(secret, code_now, ts=ts, window=1, last_step=0)
    assert ok
    # Replay: the same step is rejected once consumed (last_step = step).
    ok2, step2 = mfa.verify_totp(secret, code_now, ts=ts, window=1, last_step=step)
    assert not ok2 and step2 == step


def test_stale_in_window_code_rejected() -> None:
    # A code from an EARLIER step (still inside the window) is rejected once a later
    # step has been accepted (monotonic last_step).
    secret = mfa.generate_secret()
    ts = 1_700_000_000.0
    step = int(ts // 30)
    ok, matched = mfa.verify_totp(secret, mfa.hotp(secret, step - 1), ts=ts, window=1, last_step=step)
    assert not ok and matched == step - 1


def test_malformed_code_fails_closed() -> None:
    secret = mfa.generate_secret()
    for bad in ("", "abc", "12 34", None):
        ok, matched = mfa.verify_totp(secret, bad, ts=1_700_000_000.0)  # type: ignore[arg-type]
        assert not ok and matched == -1


# --------------------------------------------------------------------------- #
# Recovery codes — single-use
# --------------------------------------------------------------------------- #
def test_recovery_codes_single_use() -> None:
    codes = mfa.generate_recovery_codes(10)
    assert len(codes) == 10 and len(set(codes)) == 10
    hashes = [mfa.hash_recovery_code(c) for c in codes]
    assert mfa.verify_recovery_code(codes[0], hashes[0])
    assert mfa.verify_recovery_code(codes[0].replace("-", "").lower(), hashes[0])
    assert not mfa.verify_recovery_code(codes[0], hashes[1])
    assert not mfa.verify_recovery_code("WRONG-CODE", hashes[0])


def test_recovery_code_consumption_semantics() -> None:
    codes = mfa.generate_recovery_codes(3)
    hashes = [mfa.hash_recovery_code(c) for c in codes]
    used = codes[1]
    idx = next(i for i, h in enumerate(hashes) if mfa.verify_recovery_code(used, h))
    del hashes[idx]
    assert not any(mfa.verify_recovery_code(used, h) for h in hashes)


# --------------------------------------------------------------------------- #
# At-rest obfuscation round-trip
# --------------------------------------------------------------------------- #
def test_secret_obfuscation_roundtrip() -> None:
    key = "server-key-xyz"
    secret = mfa.generate_secret()
    blob = mfa.obfuscate_secret(secret, key)
    assert blob.startswith("obf1:") and secret not in blob  # not stored in the clear
    assert mfa.deobfuscate_secret(blob, key) == secret
    # A plaintext (non-prefixed) value is returned unchanged (back-compat).
    assert mfa.deobfuscate_secret(secret, key) == secret
    # The wrong key does not recover the secret.
    assert mfa.deobfuscate_secret(blob, "other-key") != secret


def test_obfuscation_is_salted() -> None:
    secret = mfa.generate_secret()
    assert mfa.obfuscate_secret(secret, "k1") != mfa.obfuscate_secret(secret, "k1")


# --------------------------------------------------------------------------- #
# Provisioning URI shape
# --------------------------------------------------------------------------- #
def test_provisioning_uri_shape() -> None:
    secret = mfa.generate_secret()
    uri = mfa.provisioning_uri(secret, "alice@example.com", "Acme SOC", digits=6, period=30)
    assert uri.startswith("otpauth://totp/")
    parsed = urlparse(uri)
    assert parsed.scheme == "otpauth" and parsed.netloc == "totp"
    assert "Acme%20SOC" in uri  # issuer percent-encoded in the label
    qs = parse_qs(parsed.query)
    assert qs["secret"] == [secret]
    assert qs["issuer"] == ["Acme SOC"]
    assert qs["algorithm"] == ["SHA1"]
    assert qs["digits"] == ["6"]
    assert qs["period"] == ["30"]
