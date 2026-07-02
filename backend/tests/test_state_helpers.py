"""Tests for state.py utility functions.

Covers _coerce_bool, _source_es_overrides, parse_user_agent,
client_ip_from, and geo_for_ip — all dependency-free helpers.
"""

from __future__ import annotations

from unittest.mock import MagicMock

from app.state import _coerce_bool, _source_es_overrides, client_ip_from, geo_for_ip, parse_user_agent


class TestCoerceBool:
    def test_bool_passthrough(self):
        assert _coerce_bool(True) is True
        assert _coerce_bool(False) is False

    def test_string_falsy_values(self):
        assert _coerce_bool("false") is False
        assert _coerce_bool("FALSE") is False
        assert _coerce_bool("0") is False
        assert _coerce_bool("no") is False
        assert _coerce_bool("off") is False
        assert _coerce_bool("") is False

    def test_string_truthy_values(self):
        assert _coerce_bool("true") is True
        assert _coerce_bool("1") is True
        assert _coerce_bool("yes") is True
        assert _coerce_bool("on") is True
        assert _coerce_bool("anything else") is True

    def test_none_defaults_to_true(self):
        assert _coerce_bool(None) is True
        assert _coerce_bool(None, default=False) is False

    def test_int_coerces(self):
        assert _coerce_bool(0) is False
        assert _coerce_bool(1) is True
        assert _coerce_bool(42) is True

    def test_default_applied_for_none_only(self):
        assert _coerce_bool(False, default=True) is False


class TestSourceEsOverrides:
    def test_empty_when_no_es_settings(self):
        assert _source_es_overrides({}) == {}

    def test_extracts_es_url(self):
        result = _source_es_overrides({"es_url": "https://es.example:9200"})
        assert result["es_url"] == "https://es.example:9200"

    def test_extracts_es_api_key(self):
        result = _source_es_overrides({"es_api_key": "mykey"})
        assert result["es_api_key"] == "mykey"

    def test_coerces_es_verify_certs(self):
        result = _source_es_overrides({"es_verify_certs": "false"})
        assert result["es_verify_certs"] is False

    def test_extracts_es_ca_cert(self):
        result = _source_es_overrides({"es_ca_cert": "/path/to/ca.pem"})
        assert result["es_ca_cert"] == "/path/to/ca.pem"

    def test_full_overrides(self):
        merged = {
            "es_url": "https://es.example:9200",
            "es_api_key": "key123",
            "es_verify_certs": "true",
            "es_ca_cert": "/etc/ca.pem",
        }
        result = _source_es_overrides(merged)
        assert result["es_url"] == "https://es.example:9200"
        assert result["es_api_key"] == "key123"
        assert result["es_verify_certs"] is True
        assert result["es_ca_cert"] == "/etc/ca.pem"


class TestParseUserAgent:
    def test_empty_ua(self):
        assert parse_user_agent("") == {"ua_browser": "", "ua_os": "", "client_type": ""}
        assert parse_user_agent(None) == {"ua_browser": "", "ua_os": "", "client_type": ""}

    def test_chrome_on_windows(self):
        result = parse_user_agent(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        )
        assert result["ua_browser"] == "Chrome"
        assert result["ua_os"] == "Windows"
        assert result["client_type"] == "browser"

    def test_firefox_on_macos(self):
        result = parse_user_agent(
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:121.0) Gecko/20100101 Firefox/121.0"
        )
        assert result["ua_browser"] == "Firefox"
        assert result["ua_os"] == "macOS"
        assert result["client_type"] == "browser"

    def test_safari_on_iphone(self):
        result = parse_user_agent(
            "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) "
            "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1"
        )
        assert result["ua_browser"] == "Safari"
        assert result["ua_os"] == "iOS"
        assert result["client_type"] == "mobile"

    def test_curl(self):
        result = parse_user_agent("curl/8.4.0")
        assert result["ua_browser"] == "curl"
        assert result["client_type"] == "api"

    def test_python_requests(self):
        result = parse_user_agent("python-requests/2.31.0")
        assert result["ua_browser"] == "python-requests"
        assert result["client_type"] == "api"

    def test_edge_on_windows_11(self):
        result = parse_user_agent(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0"
        )
        assert result["ua_browser"] == "Edge"
        assert result["client_type"] == "browser"

    def test_opera(self):
        result = parse_user_agent(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 OPR/106.0.0.0"
        )
        assert result["ua_browser"] == "Opera"
        assert result["client_type"] == "browser"

    def test_android_chrome(self):
        result = parse_user_agent(
            "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/120.0.6099.144 Mobile Safari/537.36"
        )
        assert result["ua_os"] == "Android"
        assert result["client_type"] == "mobile"

    def test_unknown_ua_produces_empty_labels(self):
        result = parse_user_agent("totally-unknown-device/1.0")
        assert result["ua_browser"] == ""
        assert result["ua_os"] == ""
        assert result["client_type"] == ""


class FakeRequest:
    """Minimal Starlette Request stand-in for testing client_ip_from."""

    def __init__(self, headers: dict | None = None, client_host: str = ""):
        self.headers = headers or {}
        self.client = MagicMock(host=client_host) if client_host else None


class TestClientIpFrom:
    def test_xff_first_hop_returned(self):
        req = FakeRequest(headers={"x-forwarded-for": "203.0.113.5, 10.0.0.1"})
        assert client_ip_from(req) == "203.0.113.5"

    def test_no_xff_uses_peer(self):
        req = FakeRequest(client_host="10.0.0.1")
        assert client_ip_from(req) == "10.0.0.1"

    def test_empty_xff_falls_to_peer(self):
        req = FakeRequest(headers={"x-forwarded-for": ""}, client_host="10.0.0.1")
        assert client_ip_from(req) == "10.0.0.1"

    def test_empty_all_returns_empty(self):
        req = FakeRequest()
        assert client_ip_from(req) == ""

    def test_malformed_request_returns_empty(self):
        result = client_ip_from(object())
        assert result == ""


class TestGeoForIp:
    def test_empty_ip(self):
        assert geo_for_ip("") == {"ip_city": "", "ip_country": ""}
        assert geo_for_ip(None) == {"ip_city": "", "ip_country": ""}

    def test_loopback_is_local(self):
        result = geo_for_ip("127.0.0.1")
        assert result["ip_country"] == "Local network"

    def test_private_ip_is_local(self):
        result = geo_for_ip("10.0.0.1")
        assert result["ip_country"] == "Local network"
        result = geo_for_ip("192.168.1.1")
        assert result["ip_country"] == "Local network"
        result = geo_for_ip("172.16.0.1")
        assert result["ip_country"] == "Local network"

    def test_link_local_is_local(self):
        result = geo_for_ip("169.254.1.1")
        assert result["ip_country"] == "Local network"

    def test_public_ip_returns_empty(self):
        result = geo_for_ip("8.8.8.8")
        assert result["ip_country"] == ""
        assert result["ip_city"] == ""

    def test_invalid_ip_returns_empty(self):
        result = geo_for_ip("not-an-ip")
        assert result["ip_country"] == ""
        assert result["ip_city"] == ""

    def test_ipv6_loopback_is_local(self):
        result = geo_for_ip("::1")
        assert result["ip_country"] == "Local network"

    def test_ipv6_unique_local_is_local(self):
        result = geo_for_ip("fd00::1")
        assert result["ip_country"] == "Local network"
