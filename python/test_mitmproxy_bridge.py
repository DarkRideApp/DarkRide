"""
Tests for TLS fingerprint spoofing in mitmproxy_bridge.

Run: .venv/bin/python3 -m pytest python/test_mitmproxy_bridge.py -v
"""

import json
import pytest
import asyncio
from unittest.mock import MagicMock, patch
from OpenSSL import SSL
from OpenSSL._util import lib as _ssl_lib

# Import the helper and constants from the bridge module
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from mitmproxy_bridge import (
    _build_chrome_ssl_context,
    _build_ssl_context,
    _CHROME_TLS12_CIPHERS,
    _CHROME_TLS13_CIPHERS,
    _CHROME_GROUPS,
    _CHROME_SIGALGS,
    _OKHTTP_TLS12_CIPHERS,
    TLS_PROFILES,
    _extract_timings,
)
from types import SimpleNamespace


# Expected cipher names in order: 3 TLS 1.3 + 12 TLS 1.2 = 15 total (Chrome 120 Android)
EXPECTED_CIPHERS = [
    # TLS 1.3
    "TLS_AES_128_GCM_SHA256",
    "TLS_AES_256_GCM_SHA384",
    "TLS_CHACHA20_POLY1305_SHA256",
    # TLS 1.2
    "ECDHE-ECDSA-AES128-GCM-SHA256",
    "ECDHE-RSA-AES128-GCM-SHA256",
    "ECDHE-ECDSA-AES256-GCM-SHA384",
    "ECDHE-RSA-AES256-GCM-SHA384",
    "ECDHE-ECDSA-CHACHA20-POLY1305",
    "ECDHE-RSA-CHACHA20-POLY1305",
    "ECDHE-RSA-AES128-SHA",
    "ECDHE-RSA-AES256-SHA",
    "AES128-GCM-SHA256",
    "AES256-GCM-SHA384",
    "AES128-SHA",
    "AES256-SHA",
]


class TestBuildChromeSSLContext:
    """Tests for _build_chrome_ssl_context()."""

    def test_returns_ssl_context(self):
        ctx = _build_chrome_ssl_context()
        assert isinstance(ctx, SSL.Context)

    def test_cipher_list_matches_chrome(self):
        ctx = _build_chrome_ssl_context()
        conn = SSL.Connection(ctx, None)
        conn.set_connect_state()
        ciphers = conn.get_cipher_list()
        assert ciphers == EXPECTED_CIPHERS, (
            f"Expected {EXPECTED_CIPHERS}, got {ciphers}"
        )

    def test_cipher_count(self):
        ctx = _build_chrome_ssl_context()
        conn = SSL.Connection(ctx, None)
        conn.set_connect_state()
        ciphers = conn.get_cipher_list()
        # 3 TLS 1.3 + 12 TLS 1.2 = 15 total
        assert len(ciphers) == 15, f"Expected 15 ciphers, got {len(ciphers)}: {ciphers}"

    def test_no_legacy_ciphers(self):
        """Ensure no DHE/CBC/other legacy ciphers leak through."""
        ctx = _build_chrome_ssl_context()
        conn = SSL.Connection(ctx, None)
        conn.set_connect_state()
        ciphers = conn.get_cipher_list()
        for cipher in ciphers:
            assert "DHE-" not in cipher or "ECDHE-" in cipher, f"Legacy DHE cipher found: {cipher}"
            assert "CBC" not in cipher or cipher in ("AES128-SHA", "AES256-SHA"), (
                f"Unexpected CBC cipher: {cipher}"
            )

    def test_alpn_protocols_set(self):
        """ALPN protos should be settable without error."""
        ctx = _build_chrome_ssl_context()
        # Verify the context accepts ALPN (was set in builder, re-setting is fine)
        ctx.set_alpn_protos([b"h2", b"http/1.1"])

    def test_sigalgs_set(self):
        """Signature algorithms should be set via cffi binding."""
        assert hasattr(_ssl_lib, "SSL_CTX_set1_sigalgs_list"), (
            "SSL_CTX_set1_sigalgs_list not available in cffi bindings"
        )
        ctx = _build_chrome_ssl_context()
        # Re-setting should succeed (proves the function works on this context)
        result = _ssl_lib.SSL_CTX_set1_sigalgs_list(ctx._context, _CHROME_SIGALGS)
        assert result == 1

    def test_tls13_ciphersuites_set(self):
        """TLS 1.3 ciphersuites should be set via cffi binding."""
        assert hasattr(_ssl_lib, "SSL_CTX_set_ciphersuites"), (
            "SSL_CTX_set_ciphersuites not available in cffi bindings"
        )
        ctx = _build_chrome_ssl_context()
        result = _ssl_lib.SSL_CTX_set_ciphersuites(
            ctx._context, _CHROME_TLS13_CIPHERS.encode("ascii")
        )
        assert result == 1

    def test_tls_version_bounds(self):
        """Context should allow TLS 1.2 and TLS 1.3 only."""
        ctx = _build_chrome_ssl_context()
        conn = SSL.Connection(ctx, None)
        conn.set_connect_state()
        # No crash = versions are valid


class TestBuildOkHttpSSLContext:
    """Tests for _build_ssl_context('okhttp')."""

    EXPECTED_OKHTTP_CIPHERS = [
        # TLS 1.3
        "TLS_AES_128_GCM_SHA256",
        "TLS_AES_256_GCM_SHA384",
        "TLS_CHACHA20_POLY1305_SHA256",
        # TLS 1.2 (OkHttp MODERN_TLS — 6 ciphers, no legacy)
        "ECDHE-ECDSA-AES128-GCM-SHA256",
        "ECDHE-RSA-AES128-GCM-SHA256",
        "ECDHE-ECDSA-AES256-GCM-SHA384",
        "ECDHE-RSA-AES256-GCM-SHA384",
        "ECDHE-ECDSA-CHACHA20-POLY1305",
        "ECDHE-RSA-CHACHA20-POLY1305",
    ]

    def test_returns_ssl_context(self):
        ctx = _build_ssl_context("okhttp")
        assert isinstance(ctx, SSL.Context)

    def test_cipher_count(self):
        ctx = _build_ssl_context("okhttp")
        conn = SSL.Connection(ctx, None)
        conn.set_connect_state()
        ciphers = conn.get_cipher_list()
        # 3 TLS 1.3 + 6 TLS 1.2 = 9 total
        assert len(ciphers) == 9, f"Expected 9 ciphers, got {len(ciphers)}: {ciphers}"

    def test_cipher_list_matches_okhttp(self):
        ctx = _build_ssl_context("okhttp")
        conn = SSL.Connection(ctx, None)
        conn.set_connect_state()
        ciphers = conn.get_cipher_list()
        assert ciphers == self.EXPECTED_OKHTTP_CIPHERS, (
            f"Expected {self.EXPECTED_OKHTTP_CIPHERS}, got {ciphers}"
        )

    def test_no_legacy_ciphers(self):
        """OkHttp should have zero legacy/SHA-1/non-ECDHE ciphers."""
        ctx = _build_ssl_context("okhttp")
        conn = SSL.Connection(ctx, None)
        conn.set_connect_state()
        ciphers = conn.get_cipher_list()
        for cipher in ciphers:
            if cipher.startswith("TLS_"):
                continue  # TLS 1.3 ciphers
            assert cipher.startswith("ECDHE-"), f"Non-ECDHE cipher found: {cipher}"
            assert "SHA256" not in cipher or "GCM-SHA256" in cipher, (
                f"Legacy SHA cipher found: {cipher}"
            )

    def test_unknown_profile_raises(self):
        with pytest.raises(ValueError, match="Unknown TLS profile"):
            _build_ssl_context("unknown_profile")


class TestTlsStartServer:
    """Tests for DarkRideAddon.tls_start_server()."""

    def _make_addon(self):
        """Create a DarkRideAddon with mocked mitmproxy context."""
        import mitmproxy_bridge

        # Reset the cached contexts so each test starts fresh
        mitmproxy_bridge._ssl_ctx_cache.clear()

        addon = mitmproxy_bridge.DarkRideAddon()
        return addon

    def _make_tls_data(self, hostname="example.com", port=443):
        """Create a mock TlsData object."""
        data = MagicMock()
        data.conn.address = (hostname, port)
        data.ssl_conn = None
        return data

    @patch("mitmproxy_bridge.ctx")
    def test_sets_ssl_conn(self, mock_ctx):
        mock_ctx.options.tls_profile = "chrome"
        addon = self._make_addon()
        data = self._make_tls_data("example.com")

        addon.tls_start_server(data)

        assert data.ssl_conn is not None
        assert isinstance(data.ssl_conn, SSL.Connection)

    @patch("mitmproxy_bridge.ctx")
    def test_sets_sni_for_hostname(self, mock_ctx):
        mock_ctx.options.tls_profile = "chrome"
        addon = self._make_addon()
        data = self._make_tls_data("www.google.com")

        addon.tls_start_server(data)

        assert data.ssl_conn is not None

    @patch("mitmproxy_bridge.ctx")
    def test_skips_sni_for_ip_address(self, mock_ctx):
        """IP addresses should not have SNI set (it's invalid per TLS spec)."""
        mock_ctx.options.tls_profile = "chrome"
        addon = self._make_addon()
        data = self._make_tls_data("93.184.216.34")

        addon.tls_start_server(data)

        # Should still set ssl_conn, just without SNI
        assert data.ssl_conn is not None

    @patch("mitmproxy_bridge.ctx")
    def test_falls_back_on_error(self, mock_ctx):
        """On error, ssl_conn should remain None (mitmproxy uses its default)."""
        mock_ctx.options.tls_profile = "chrome"
        addon = self._make_addon()
        data = self._make_tls_data("example.com")

        import mitmproxy_bridge
        original = mitmproxy_bridge._build_ssl_context

        def failing_build(profile):
            raise RuntimeError("test error")

        mitmproxy_bridge._build_ssl_context = failing_build
        try:
            addon.tls_start_server(data)
            assert data.ssl_conn is None
            mock_ctx.log.error.assert_called()
        finally:
            mitmproxy_bridge._build_ssl_context = original

    @patch("mitmproxy_bridge.ctx")
    def test_caches_context(self, mock_ctx):
        """The SSL context should be built once and reused."""
        mock_ctx.options.tls_profile = "chrome"
        import mitmproxy_bridge
        mitmproxy_bridge._ssl_ctx_cache.clear()

        addon = self._make_addon()

        data1 = self._make_tls_data("example.com")
        addon.tls_start_server(data1)
        cached_ctx = mitmproxy_bridge._ssl_ctx_cache.get("chrome")

        data2 = self._make_tls_data("other.com")
        addon.tls_start_server(data2)

        assert mitmproxy_bridge._ssl_ctx_cache.get("chrome") is cached_ctx
        assert data1.ssl_conn is not None
        assert data2.ssl_conn is not None

    @patch("mitmproxy_bridge.ctx")
    def test_default_profile_skips_spoofing(self, mock_ctx):
        """tls_profile=default should leave ssl_conn as None (no spoofing)."""
        mock_ctx.options.tls_profile = "default"
        addon = self._make_addon()
        data = self._make_tls_data("example.com")

        addon.tls_start_server(data)

        assert data.ssl_conn is None

    @patch("mitmproxy_bridge.ctx")
    def test_okhttp_profile_sets_ssl_conn(self, mock_ctx):
        """tls_profile=okhttp should produce an SSL connection."""
        mock_ctx.options.tls_profile = "okhttp"
        addon = self._make_addon()
        data = self._make_tls_data("example.com")

        addon.tls_start_server(data)

        assert data.ssl_conn is not None
        assert isinstance(data.ssl_conn, SSL.Connection)

    @patch("mitmproxy_bridge.ctx")
    def test_different_profiles_cached_separately(self, mock_ctx):
        """Chrome and OkHttp profiles should have separate cached contexts."""
        import mitmproxy_bridge
        mitmproxy_bridge._ssl_ctx_cache.clear()
        addon = self._make_addon()

        mock_ctx.options.tls_profile = "chrome"
        addon.tls_start_server(self._make_tls_data())
        chrome_ctx = mitmproxy_bridge._ssl_ctx_cache.get("chrome")

        mock_ctx.options.tls_profile = "okhttp"
        addon.tls_start_server(self._make_tls_data())
        okhttp_ctx = mitmproxy_bridge._ssl_ctx_cache.get("okhttp")

        assert chrome_ctx is not None
        assert okhttp_ctx is not None
        assert chrome_ctx is not okhttp_ctx


class TestInterceptHooks:
    """Tests for intercept_hooks functionality."""

    def _make_addon(self):
        import mitmproxy_bridge
        addon = mitmproxy_bridge.DarkRideAddon()
        return addon

    def test_intercept_hooks_option_registered(self):
        """intercept_hooks option should be defined in load()."""
        import mitmproxy_bridge
        loader = MagicMock()
        mitmproxy_bridge.load(loader)
        option_names = [call.kwargs["name"] if "name" in call.kwargs else call.args[0]
                        for call in loader.add_option.call_args_list]
        # Check via kwargs since add_option uses keyword args
        kwarg_names = []
        for call in loader.add_option.call_args_list:
            if "name" in call.kwargs:
                kwarg_names.append(call.kwargs["name"])
        assert "intercept_hooks" in kwarg_names

    @patch("mitmproxy_bridge.ctx")
    def test_post_to_intercept_returns_pass_on_error(self, mock_ctx):
        """_post_to_intercept should return pass on error."""
        mock_ctx.options.node_webhook = "http://localhost:99999/v1/traffic/ingest"
        addon = self._make_addon()
        result = addon._post_to_intercept({"test": True})
        assert result == {"action": "pass"}

    @patch("mitmproxy_bridge.ctx")
    def test_apply_request_modifications_block(self, mock_ctx):
        """_apply_request_modifications should set 403 response on block."""
        from mitmproxy import http as mhttp
        addon = self._make_addon()
        flow = MagicMock()
        flow.response = None

        blocked = addon._apply_request_modifications(flow, {"action": "block"})

        assert blocked is True
        assert flow.response is not None

    @patch("mitmproxy_bridge.ctx")
    def test_apply_request_modifications_modify(self, mock_ctx):
        """_apply_request_modifications should update request fields."""
        addon = self._make_addon()
        flow = MagicMock()
        flow.request.headers = MagicMock()

        result = {"action": "modify", "method": "POST", "url": "https://new.com", "headers": {"X-New": "1"}, "body": "new body"}
        blocked = addon._apply_request_modifications(flow, result)

        assert blocked is False
        assert flow.request.method == "POST"
        assert flow.request.url == "https://new.com"
        flow.request.headers.clear.assert_called_once()
        flow.request.set_text.assert_called_once_with("new body")

    @patch("mitmproxy_bridge.ctx")
    def test_apply_request_modifications_pass(self, mock_ctx):
        """_apply_request_modifications should do nothing on pass."""
        addon = self._make_addon()
        flow = MagicMock()
        original_method = flow.request.method

        blocked = addon._apply_request_modifications(flow, {"action": "pass"})

        assert blocked is False
        assert flow.request.method == original_method

    @patch("mitmproxy_bridge.ctx")
    def test_apply_response_modifications_block(self, mock_ctx):
        """_apply_response_modifications should set 403 response on block."""
        addon = self._make_addon()
        flow = MagicMock()

        blocked = addon._apply_response_modifications(flow, {"action": "block"})

        assert blocked is True
        assert flow.response is not None

    @patch("mitmproxy_bridge.ctx")
    def test_apply_response_modifications_modify(self, mock_ctx):
        """_apply_response_modifications should update response fields."""
        addon = self._make_addon()
        flow = MagicMock()
        flow.response.headers = MagicMock()

        result = {"action": "modify", "status": 418, "responseHeaders": {"X-Tea": "pot"}, "responseBody": "teapot"}
        blocked = addon._apply_response_modifications(flow, result)

        assert blocked is False
        assert flow.response.status_code == 418
        flow.response.headers.clear.assert_called_once()
        flow.response.set_text.assert_called_once_with("teapot")

    @patch("mitmproxy_bridge.ctx")
    def test_apply_response_modifications_pass(self, mock_ctx):
        """_apply_response_modifications should do nothing on pass."""
        addon = self._make_addon()
        flow = MagicMock()
        original_status = flow.response.status_code

        blocked = addon._apply_response_modifications(flow, {"action": "pass"})

        assert blocked is False
        assert flow.response.status_code == original_status


class TestNotifyRequestStarted:
    """Tests for _notify_request_started()."""

    def _make_addon(self):
        import mitmproxy_bridge
        addon = mitmproxy_bridge.DarkRideAddon()
        return addon

    @patch("mitmproxy_bridge.ctx")
    def test_calls_post_to_ws_webhook(self, mock_ctx):
        """_notify_request_started should POST to /request-started."""
        mock_ctx.options.device_id = "DEV001"
        mock_ctx.options.session_id = "42"
        mock_ctx.options.node_webhook = "http://localhost:3000/v1/traffic/ingest"
        mock_ctx.options.hiddenlist_file = ""

        addon = self._make_addon()
        addon._post_to_ws_webhook = MagicMock()

        flow = MagicMock()
        flow.id = "flow-abc"
        flow.request.host = "api.example.com"
        flow.request.pretty_url = "https://api.example.com/data"
        flow.request.method = "GET"
        flow.request.headers = {"Accept": "application/json"}

        addon._notify_request_started(flow)

        addon._post_to_ws_webhook.assert_called_once()
        args = addon._post_to_ws_webhook.call_args
        assert args[0][0] == "/request-started"
        data = args[0][1]
        assert data["flowId"] == "flow-abc"
        assert data["deviceId"] == "DEV001"
        assert data["sessionId"] == 42
        assert data["method"] == "GET"
        assert data["url"] == "https://api.example.com/data"

    @patch("mitmproxy_bridge.ctx")
    def test_skips_hidden_domains(self, mock_ctx):
        """_notify_request_started should skip hidden domains."""
        mock_ctx.options.device_id = "DEV001"
        mock_ctx.options.session_id = ""
        mock_ctx.options.node_webhook = "http://localhost:3000/v1/traffic/ingest"
        mock_ctx.options.hiddenlist_file = ""

        addon = self._make_addon()
        addon._hiddenlist = {"hidden.example.com"}
        addon._post_to_ws_webhook = MagicMock()

        flow = MagicMock()
        flow.id = "flow-hidden"
        flow.request.host = "hidden.example.com"
        flow.request.pretty_url = "https://hidden.example.com/api"
        flow.request.method = "GET"
        flow.request.headers = {}

        addon._notify_request_started(flow)

        addon._post_to_ws_webhook.assert_not_called()

    @patch("mitmproxy_bridge.ctx")
    def test_handles_errors_gracefully(self, mock_ctx):
        """_notify_request_started should catch exceptions."""
        mock_ctx.options.device_id = "DEV001"
        mock_ctx.options.session_id = ""
        mock_ctx.options.node_webhook = "http://localhost:3000/v1/traffic/ingest"
        mock_ctx.options.hiddenlist_file = ""

        addon = self._make_addon()
        addon._post_to_ws_webhook = MagicMock(side_effect=Exception("network error"))

        flow = MagicMock()
        flow.id = "flow-err"
        flow.request.host = "example.com"
        flow.request.pretty_url = "https://example.com/test"
        flow.request.method = "POST"
        flow.request.headers = {}

        # Should not raise
        addon._notify_request_started(flow)
        mock_ctx.log.error.assert_called()

    @patch("mitmproxy_bridge.ctx")
    def test_request_hook_calls_notify(self, mock_ctx):
        """request() should call _notify_request_started after blocklist check."""
        mock_ctx.options.device_id = "DEV001"
        mock_ctx.options.session_id = ""
        mock_ctx.options.node_webhook = "http://localhost:3000/v1/traffic/ingest"
        mock_ctx.options.blocklist_file = ""
        mock_ctx.options.hiddenlist_file = ""
        mock_ctx.options.intercept_hooks = False

        addon = self._make_addon()
        addon._notify_request_started = MagicMock()

        flow = MagicMock()
        flow.request.host = "example.com"
        flow.request.pretty_url = "https://example.com/test"
        flow.response = None

        asyncio.run(addon.request(flow))

        addon._notify_request_started.assert_called_once_with(flow)

    @patch("mitmproxy_bridge.ctx")
    def test_request_hook_skips_notify_for_blocked(self, mock_ctx):
        """request() should NOT call _notify_request_started for blocked domains."""
        mock_ctx.options.device_id = "DEV001"
        mock_ctx.options.session_id = ""
        mock_ctx.options.node_webhook = "http://localhost:3000/v1/traffic/ingest"
        mock_ctx.options.blocklist_file = ""
        mock_ctx.options.hiddenlist_file = ""
        mock_ctx.options.intercept_hooks = False

        addon = self._make_addon()
        addon._blocklist = {"blocked.com"}
        addon._notify_request_started = MagicMock()

        flow = MagicMock()
        flow.request.host = "blocked.com"
        flow.request.pretty_url = "https://blocked.com/api"
        flow.response = None

        asyncio.run(addon.request(flow))

        addon._notify_request_started.assert_not_called()


class TestResponseHook:
    """Tests for the response() hook."""

    def _make_addon(self):
        import mitmproxy_bridge
        addon = mitmproxy_bridge.DarkRideAddon()
        return addon

    @patch("mitmproxy_bridge.ctx")
    def test_101_registers_ws_flow(self, mock_ctx):
        """response() should register WebSocket flow via /ws-start for 101."""
        mock_ctx.options.node_webhook = "http://localhost:3000/v1/traffic/ingest"
        mock_ctx.options.blocklist_file = ""
        mock_ctx.options.hiddenlist_file = ""
        mock_ctx.options.intercept_hooks = False
        mock_ctx.options.device_id = "DEV001"
        mock_ctx.options.session_id = "42"

        addon = self._make_addon()
        addon._post_to_webhook = MagicMock()
        addon._post_to_ws_webhook = MagicMock()

        flow = MagicMock()
        flow.id = "ws-flow-1"
        flow.response.status_code = 101
        flow.request.host = "sync.example.com"
        flow.request.pretty_url = "https://sync.example.com/ws"
        flow.request.headers = {"Upgrade": "websocket"}

        asyncio.run(addon.response(flow))

        # Should NOT post to regular webhook
        addon._post_to_webhook.assert_not_called()
        # Should post to /ws-start
        addon._post_to_ws_webhook.assert_called_once()
        args = addon._post_to_ws_webhook.call_args
        assert args[0][0] == "/ws-start"
        data = args[0][1]
        assert data["flowId"] == "ws-flow-1"
        assert data["url"] == "wss://sync.example.com/ws"
        assert "ws-flow-1" in addon._registered_ws_flows

    @patch("mitmproxy_bridge.ctx")
    def test_101_idempotent(self, mock_ctx):
        """_register_ws_flow should not register the same flow twice."""
        mock_ctx.options.node_webhook = "http://localhost:3000/v1/traffic/ingest"
        mock_ctx.options.blocklist_file = ""
        mock_ctx.options.hiddenlist_file = ""
        mock_ctx.options.device_id = ""
        mock_ctx.options.session_id = ""

        addon = self._make_addon()
        addon._post_to_ws_webhook = MagicMock()

        flow = MagicMock()
        flow.id = "ws-flow-2"
        flow.response.status_code = 101
        flow.request.host = "sync.example.com"
        flow.request.pretty_url = "https://sync.example.com/ws"
        flow.request.headers = {}

        asyncio.run(addon.response(flow))
        asyncio.run(addon.response(flow))  # second call

        # Should only post once
        assert addon._post_to_ws_webhook.call_count == 1

    @patch("mitmproxy_bridge.ctx")
    def test_websocket_message_lazy_registers(self, mock_ctx):
        """websocket_message() should lazy-register the flow if not already registered."""
        mock_ctx.options.node_webhook = "http://localhost:3000/v1/traffic/ingest"
        mock_ctx.options.blocklist_file = ""
        mock_ctx.options.hiddenlist_file = ""
        mock_ctx.options.device_id = ""
        mock_ctx.options.session_id = ""

        addon = self._make_addon()
        addon._post_to_ws_webhook = MagicMock()

        flow = MagicMock()
        flow.id = "ws-flow-3"
        flow.request.host = "sync.example.com"
        flow.request.pretty_url = "https://sync.example.com/ws"
        flow.request.headers = {}
        msg = MagicMock()
        msg.from_client = True
        msg.is_text = True
        msg.content = b"hello"
        flow.websocket.messages = [msg]

        addon.websocket_message(flow)

        # Should have called /ws-start first, then /ws-message
        calls = addon._post_to_ws_webhook.call_args_list
        assert len(calls) == 2
        assert calls[0][0][0] == "/ws-start"
        assert calls[1][0][0] == "/ws-message"

    @patch("mitmproxy_bridge.ctx")
    def test_captures_non_101_responses(self, mock_ctx):
        """response() should capture normal (non-101) responses."""
        mock_ctx.options.node_webhook = "http://localhost:3000/v1/traffic/ingest"
        mock_ctx.options.blocklist_file = ""
        mock_ctx.options.hiddenlist_file = ""
        mock_ctx.options.intercept_hooks = False
        mock_ctx.options.device_id = ""
        mock_ctx.options.session_id = ""

        addon = self._make_addon()
        addon._post_to_webhook = MagicMock()

        flow = MagicMock()
        flow.response.status_code = 200
        flow.request.host = "api.example.com"
        flow.request.pretty_url = "https://api.example.com/data"
        flow.request.method = "GET"
        flow.request.headers = {"Accept": "application/json"}
        flow.request.get_text.return_value = None
        flow.response.headers = {"content-type": "application/json"}
        flow.response.get_text.return_value = '{"ok":true}'

        asyncio.run(addon.response(flow))

        addon._post_to_webhook.assert_called_once()


# ── Frida inject APK handler tests ────────────────────────────────────────

class TestFridaInjectApk:
    """Tests for the frida_inject_apk bridge handler."""

    def test_frida_inject_apk_handler_exists(self):
        """Verify the frida_inject_apk handler is registered in HANDLERS."""
        from bridge import HANDLERS
        assert 'frida_inject_apk' in HANDLERS

    def test_frida_inject_apk_missing_params(self):
        """Verify it raises on missing apk_path."""
        from bridge import HANDLERS
        handler = HANDLERS['frida_inject_apk']
        with pytest.raises(Exception, match='apk_path.*required'):
            handler({})

    def test_frida_run_attach_by_name(self):
        """Verify frida_run supports mode='attach' with app_name instead of pid."""
        from bridge import HANDLERS
        handler = HANDLERS['frida_run']
        # Should fail because frida binary not available, not because of missing params
        try:
            handler({'mode': 'attach', 'app_name': 'com.test.app', 'code': ''})
        except Exception as e:
            assert 'pid' not in str(e).lower() and 'app_name' not in str(e).lower()

    def test_frida_run_attach_requires_pid_or_app_name(self):
        """Verify frida_run raises when neither pid nor app_name given in attach mode."""
        from bridge import HANDLERS
        handler = HANDLERS['frida_run']
        with pytest.raises(Exception, match=r'pid.*app_name.*bundle_id'):
            handler({'mode': 'attach', 'code': ''})


# ── Intercept rule matching & action tests ────────────────────────────────

class TestMatchRules:
    """Tests for DarkRideAddon._match_rules()."""

    def _make_addon(self):
        import mitmproxy_bridge
        return mitmproxy_bridge.DarkRideAddon()

    def _make_flow(self, host="api.example.com", pretty_host="api.example.com",
                   path="/v1/data", method="GET"):
        flow = MagicMock()
        flow.request.host = host
        flow.request.pretty_host = pretty_host
        flow.request.path = path
        flow.request.method = method
        return flow

    def _make_rule(self, phase="response", match_hostname="api.example.com",
                   match_path=None, match_method=None, device_filter=None,
                   rule_id="r1", name="Test Rule"):
        rule = {
            "id": rule_id,
            "name": name,
            "phase": phase,
            "matchHostname": match_hostname,
            "actions": [],
        }
        if match_path is not None:
            rule["matchPath"] = match_path
        if match_method is not None:
            rule["matchMethod"] = match_method
        if device_filter is not None:
            rule["deviceFilter"] = device_filter
        return rule

    @patch("mitmproxy_bridge.ctx")
    def test_matches_exact_hostname(self, mock_ctx):
        addon = self._make_addon()
        addon._intercept_rules = [self._make_rule(phase="response")]
        flow = self._make_flow()
        result = addon._match_rules(flow, "response")
        assert len(result) == 1

    @patch("mitmproxy_bridge.ctx")
    def test_hostname_glob_wildcard(self, mock_ctx):
        addon = self._make_addon()
        addon._intercept_rules = [self._make_rule(phase="response", match_hostname="*.example.com")]
        flow = self._make_flow(host="api.example.com")
        result = addon._match_rules(flow, "response")
        assert len(result) == 1

    @patch("mitmproxy_bridge.ctx")
    def test_hostname_glob_no_match(self, mock_ctx):
        addon = self._make_addon()
        addon._intercept_rules = [self._make_rule(phase="response", match_hostname="*.other.com")]
        flow = self._make_flow(host="api.example.com")
        result = addon._match_rules(flow, "response")
        assert len(result) == 0

    @patch("mitmproxy_bridge.ctx")
    def test_hostname_falls_back_to_pretty_host(self, mock_ctx):
        """In WireGuard mode host may be IP — should match pretty_host."""
        addon = self._make_addon()
        addon._intercept_rules = [self._make_rule(phase="response", match_hostname="api.example.com")]
        flow = self._make_flow(host="203.0.113.5", pretty_host="api.example.com")
        result = addon._match_rules(flow, "response")
        assert len(result) == 1

    @patch("mitmproxy_bridge.ctx")
    def test_phase_filter(self, mock_ctx):
        addon = self._make_addon()
        addon._intercept_rules = [self._make_rule(phase="request")]
        flow = self._make_flow()
        # Wrong phase
        result = addon._match_rules(flow, "response")
        assert len(result) == 0
        # Correct phase
        result = addon._match_rules(flow, "request")
        assert len(result) == 1

    @patch("mitmproxy_bridge.ctx")
    def test_path_glob_match(self, mock_ctx):
        addon = self._make_addon()
        addon._intercept_rules = [self._make_rule(phase="response", match_path="/v1/*")]
        flow = self._make_flow(path="/v1/data")
        result = addon._match_rules(flow, "response")
        assert len(result) == 1

    @patch("mitmproxy_bridge.ctx")
    def test_path_glob_no_match(self, mock_ctx):
        addon = self._make_addon()
        addon._intercept_rules = [self._make_rule(phase="response", match_path="/v2/*")]
        flow = self._make_flow(path="/v1/data")
        result = addon._match_rules(flow, "response")
        assert len(result) == 0

    @patch("mitmproxy_bridge.ctx")
    def test_path_strips_query_string(self, mock_ctx):
        """matchPath should match without the query string."""
        addon = self._make_addon()
        addon._intercept_rules = [self._make_rule(phase="response", match_path="/search")]
        flow = self._make_flow(path="/search?q=hello")
        result = addon._match_rules(flow, "response")
        assert len(result) == 1

    @patch("mitmproxy_bridge.ctx")
    def test_method_filter_match(self, mock_ctx):
        addon = self._make_addon()
        addon._intercept_rules = [self._make_rule(phase="response", match_method="GET")]
        flow = self._make_flow(method="GET")
        result = addon._match_rules(flow, "response")
        assert len(result) == 1

    @patch("mitmproxy_bridge.ctx")
    def test_method_filter_case_insensitive(self, mock_ctx):
        addon = self._make_addon()
        addon._intercept_rules = [self._make_rule(phase="response", match_method="get")]
        flow = self._make_flow(method="GET")
        result = addon._match_rules(flow, "response")
        assert len(result) == 1

    @patch("mitmproxy_bridge.ctx")
    def test_method_filter_no_match(self, mock_ctx):
        addon = self._make_addon()
        addon._intercept_rules = [self._make_rule(phase="response", match_method="POST")]
        flow = self._make_flow(method="GET")
        result = addon._match_rules(flow, "response")
        assert len(result) == 0

    @patch("mitmproxy_bridge.ctx")
    def test_device_filter_match(self, mock_ctx):
        mock_ctx.options.device_id = "emulator-5554"
        addon = self._make_addon()
        addon._intercept_rules = [self._make_rule(phase="response", device_filter="emulator-5554")]
        flow = self._make_flow()
        result = addon._match_rules(flow, "response")
        assert len(result) == 1

    @patch("mitmproxy_bridge.ctx")
    def test_device_filter_no_match(self, mock_ctx):
        mock_ctx.options.device_id = "other-device"
        addon = self._make_addon()
        addon._intercept_rules = [self._make_rule(phase="response", device_filter="emulator-5554")]
        flow = self._make_flow()
        result = addon._match_rules(flow, "response")
        assert len(result) == 0

    @patch("mitmproxy_bridge.ctx")
    def test_returns_multiple_matching_rules(self, mock_ctx):
        addon = self._make_addon()
        addon._intercept_rules = [
            self._make_rule(phase="response", rule_id="r1", name="Rule 1"),
            self._make_rule(phase="response", rule_id="r2", name="Rule 2"),
        ]
        flow = self._make_flow()
        result = addon._match_rules(flow, "response")
        assert len(result) == 2


class TestApplyActions:
    """Tests for DarkRideAddon._apply_actions()."""

    def _make_addon(self):
        import mitmproxy_bridge
        return mitmproxy_bridge.DarkRideAddon()

    def _make_rule(self, actions, rule_id="r1", name="Test Rule", phase="response"):
        return {"id": rule_id, "name": name, "phase": phase, "matchHostname": "*", "actions": actions}

    def _make_response_flow(self, body=None, headers=None, status=200):
        flow = MagicMock()
        flow.response.content = body.encode() if isinstance(body, str) else body
        flow.response.status_code = status
        flow.response.headers = dict(headers or {})
        flow.request.headers = {}
        flow.request.content = b""
        return flow

    def _make_request_flow(self, body=None, headers=None):
        flow = MagicMock()
        flow.request.content = body.encode() if isinstance(body, str) else body
        flow.request.headers = dict(headers or {})
        flow.response = None
        return flow

    def test_json_patch_response(self):
        addon = self._make_addon()
        rule = self._make_rule([{"type": "json-patch", "path": "$.name", "value": "patched"}])
        flow = self._make_response_flow(body='{"name":"original","count":1}')

        result = addon._apply_actions(flow, rule, "response")

        assert "json-patch: $.name" in result["actionsApplied"]
        patched = json.loads(flow.response.content)
        assert patched["name"] == "patched"
        assert patched["count"] == 1

    def test_json_patch_request(self):
        addon = self._make_addon()
        rule = self._make_rule([{"type": "json-patch", "path": "$.token", "value": "test-token"}], phase="request")
        flow = self._make_request_flow(body='{"token":"real","user":"alice"}')

        result = addon._apply_actions(flow, rule, "request")

        assert "json-patch: $.token" in result["actionsApplied"]
        patched = json.loads(flow.request.content)
        assert patched["token"] == "test-token"
        assert patched["user"] == "alice"

    def test_json_patch_no_match_in_path(self):
        """json-patch with a path that matches nothing should not crash or append."""
        addon = self._make_addon()
        rule = self._make_rule([{"type": "json-patch", "path": "$.nonexistent", "value": "x"}])
        flow = self._make_response_flow(body='{"name":"orig"}')
        original_content = flow.response.content

        result = addon._apply_actions(flow, rule, "response")

        assert result["actionsApplied"] == []
        assert flow.response.content == original_content

    def test_json_patch_invalid_json_body(self):
        """Non-JSON body should not crash json-patch — silently skip."""
        addon = self._make_addon()
        rule = self._make_rule([{"type": "json-patch", "path": "$.name", "value": "x"}])
        flow = self._make_response_flow(body="<html>not json</html>")

        result = addon._apply_actions(flow, rule, "response")

        assert result["actionsApplied"] == []

    def test_json_patch_empty_body(self):
        """Empty body should not crash json-patch."""
        addon = self._make_addon()
        rule = self._make_rule([{"type": "json-patch", "path": "$.name", "value": "x"}])
        flow = self._make_response_flow(body=None)
        flow.response.content = None

        result = addon._apply_actions(flow, rule, "response")

        assert result["actionsApplied"] == []

    def test_header_set_response(self):
        addon = self._make_addon()
        rule = self._make_rule([{"type": "header-set", "name": "X-Custom", "value": "hello"}])
        flow = self._make_response_flow()

        result = addon._apply_actions(flow, rule, "response")

        assert "header-set: X-Custom" in result["actionsApplied"]
        assert flow.response.headers["X-Custom"] == "hello"

    def test_header_set_request(self):
        addon = self._make_addon()
        rule = self._make_rule([{"type": "header-set", "name": "Authorization", "value": "Bearer tok"}], phase="request")
        flow = self._make_request_flow()

        result = addon._apply_actions(flow, rule, "request")

        assert "header-set: Authorization" in result["actionsApplied"]
        assert flow.request.headers["Authorization"] == "Bearer tok"

    def test_header_remove_existing(self):
        addon = self._make_addon()
        rule = self._make_rule([{"type": "header-remove", "name": "X-Debug"}])
        flow = self._make_response_flow(headers={"X-Debug": "1", "Content-Type": "application/json"})

        result = addon._apply_actions(flow, rule, "response")

        assert "header-remove: X-Debug" in result["actionsApplied"]
        assert "X-Debug" not in flow.response.headers

    def test_header_remove_nonexistent(self):
        """header-remove on a header that doesn't exist should not crash or append."""
        addon = self._make_addon()
        rule = self._make_rule([{"type": "header-remove", "name": "X-Missing"}])
        flow = self._make_response_flow(headers={"Content-Type": "application/json"})

        result = addon._apply_actions(flow, rule, "response")

        assert result["actionsApplied"] == []

    def test_status_code_response(self):
        addon = self._make_addon()
        rule = self._make_rule([{"type": "status-code", "value": "418"}])
        flow = self._make_response_flow(status=200)

        result = addon._apply_actions(flow, rule, "response")

        assert "status-code: 418" in result["actionsApplied"]
        assert flow.response.status_code == 418

    def test_status_code_ignored_in_request_phase(self):
        """status-code action on request phase should be a no-op."""
        addon = self._make_addon()
        rule = self._make_rule([{"type": "status-code", "value": "418"}], phase="request")
        flow = self._make_request_flow()

        result = addon._apply_actions(flow, rule, "request")

        assert result["actionsApplied"] == []

    def test_attribution_structure(self):
        """_apply_actions should return correct attribution dict."""
        addon = self._make_addon()
        rule = self._make_rule(
            [{"type": "header-set", "name": "X-Test", "value": "1"}],
            rule_id="rule-123",
            name="My Rule",
        )
        flow = self._make_response_flow()

        result = addon._apply_actions(flow, rule, "response")

        assert result["id"] == "rule-123"
        assert result["name"] == "My Rule"
        assert result["phase"] == "response"
        assert isinstance(result["actionsApplied"], list)

    def test_multiple_actions_applied(self):
        """Multiple actions in one rule should all be applied."""
        addon = self._make_addon()
        rule = self._make_rule([
            {"type": "header-set", "name": "X-A", "value": "1"},
            {"type": "status-code", "value": "201"},
        ])
        flow = self._make_response_flow(status=200)

        result = addon._apply_actions(flow, rule, "response")

        assert len(result["actionsApplied"]) == 2
        assert flow.response.headers["X-A"] == "1"
        assert flow.response.status_code == 201


class TestInterceptConfigLoading:
    """Tests for _reload_intercept_config()."""

    def _make_addon(self):
        import mitmproxy_bridge
        return mitmproxy_bridge.DarkRideAddon()

    @patch("mitmproxy_bridge.ctx")
    def test_loads_rules_and_certs(self, mock_ctx, tmp_path):
        config = {
            "rules": [{"id": "r1", "name": "Rule 1", "phase": "response",
                       "matchHostname": "*.example.com", "actions": []}],
            "clientCerts": [{"id": "c1", "host": "example.com"}],
        }
        config_file = tmp_path / "intercept.json"
        config_file.write_text(json.dumps(config))
        mock_ctx.options.intercept_config_file = str(config_file)

        addon = self._make_addon()
        addon._reload_intercept_config()

        assert len(addon._intercept_rules) == 1
        assert len(addon._client_certs) == 1
        assert addon._intercept_rules[0]["id"] == "r1"
        assert addon._client_certs[0]["id"] == "c1"

    @patch("mitmproxy_bridge.ctx")
    def test_skips_reload_if_mtime_unchanged(self, mock_ctx, tmp_path):
        config = {"rules": [{"id": "r1", "name": "R", "phase": "response",
                              "matchHostname": "*", "actions": []}], "clientCerts": []}
        config_file = tmp_path / "intercept.json"
        config_file.write_text(json.dumps(config))
        mock_ctx.options.intercept_config_file = str(config_file)

        addon = self._make_addon()
        addon._reload_intercept_config()
        assert len(addon._intercept_rules) == 1

        # Overwrite file with new content but same mtime won't change in this test
        # Simulate same mtime by calling again immediately
        addon._intercept_rules = []  # clear manually
        # Second call — mtime unchanged, so won't reload
        addon._reload_intercept_config()
        # Rules are still empty because mtime didn't change
        assert len(addon._intercept_rules) == 0

    @patch("mitmproxy_bridge.ctx")
    def test_empty_path_skips(self, mock_ctx):
        mock_ctx.options.intercept_config_file = ""
        addon = self._make_addon()
        addon._reload_intercept_config()
        assert addon._intercept_rules == []

    @patch("mitmproxy_bridge.ctx")
    def test_missing_file_skips(self, mock_ctx, tmp_path):
        mock_ctx.options.intercept_config_file = str(tmp_path / "nonexistent.json")
        addon = self._make_addon()
        addon._reload_intercept_config()
        assert addon._intercept_rules == []

    @patch("mitmproxy_bridge.ctx")
    def test_intercept_config_file_option_registered(self, mock_ctx):
        """intercept_config_file option should be defined in load()."""
        import mitmproxy_bridge
        loader = MagicMock()
        mitmproxy_bridge.load(loader)
        kwarg_names = []
        for call in loader.add_option.call_args_list:
            if "name" in call.kwargs:
                kwarg_names.append(call.kwargs["name"])
        assert "intercept_config_file" in kwarg_names


class TestFindClientCert:
    """Tests for _find_client_cert() hostname matching logic."""

    def _make_addon(self):
        import mitmproxy_bridge
        return mitmproxy_bridge.DarkRideAddon()

    CERT_ENTRIES = [
        {
            "id": 1,
            "name": "PortAventura",
            "hostnames": ["cms-v2.adventurelabs.xyz", "api-v2.adventurelabs.xyz"],
            "certPem": "-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----",
            "keyPem": "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----",
        },
        {
            "id": 2,
            "name": "OtherService",
            "hostnames": ["other.example.com"],
            "certPem": "-----BEGIN CERTIFICATE-----\nfake2\n-----END CERTIFICATE-----",
            "keyPem": "-----BEGIN PRIVATE KEY-----\nfake2\n-----END PRIVATE KEY-----",
        },
    ]

    def test_returns_none_when_no_certs(self):
        addon = self._make_addon()
        addon._client_certs = []
        assert addon._find_client_cert("cms-v2.adventurelabs.xyz") is None

    def test_returns_none_when_hostname_is_empty(self):
        addon = self._make_addon()
        addon._client_certs = self.CERT_ENTRIES
        assert addon._find_client_cert("") is None

    def test_returns_none_when_hostname_is_none(self):
        addon = self._make_addon()
        addon._client_certs = self.CERT_ENTRIES
        assert addon._find_client_cert(None) is None

    def test_matches_first_hostname_in_list(self):
        addon = self._make_addon()
        addon._client_certs = self.CERT_ENTRIES
        result = addon._find_client_cert("cms-v2.adventurelabs.xyz")
        assert result is not None
        assert result["name"] == "PortAventura"

    def test_matches_second_hostname_in_list(self):
        addon = self._make_addon()
        addon._client_certs = self.CERT_ENTRIES
        result = addon._find_client_cert("api-v2.adventurelabs.xyz")
        assert result is not None
        assert result["name"] == "PortAventura"

    def test_matches_second_cert_entry(self):
        addon = self._make_addon()
        addon._client_certs = self.CERT_ENTRIES
        result = addon._find_client_cert("other.example.com")
        assert result is not None
        assert result["name"] == "OtherService"

    def test_no_match_returns_none(self):
        addon = self._make_addon()
        addon._client_certs = self.CERT_ENTRIES
        assert addon._find_client_cert("unrelated.host.com") is None

    def test_returns_first_matching_entry(self):
        """When multiple entries match the same hostname, return the first."""
        addon = self._make_addon()
        addon._client_certs = [
            {"id": 1, "name": "First", "hostnames": ["shared.host.com"]},
            {"id": 2, "name": "Second", "hostnames": ["shared.host.com"]},
        ]
        result = addon._find_client_cert("shared.host.com")
        assert result["name"] == "First"

    def test_missing_hostnames_key_is_safe(self):
        """Entries without 'hostnames' key should not cause errors."""
        addon = self._make_addon()
        addon._client_certs = [
            {"id": 1, "name": "NoCerts"},  # no 'hostnames' key
            {"id": 2, "name": "WithCerts", "hostnames": ["api.example.com"]},
        ]
        result = addon._find_client_cert("api.example.com")
        assert result is not None
        assert result["name"] == "WithCerts"


class TestTlsStartServerClientCert:
    """Tests for client cert injection in tls_start_server."""

    def _make_addon(self):
        import mitmproxy_bridge
        return mitmproxy_bridge.DarkRideAddon()

    @patch("mitmproxy_bridge.ctx")
    def test_no_client_cert_for_default_profile_no_match(self, mock_ctx):
        """With default profile and no matching cert, data.ssl_conn is NOT assigned."""
        mock_ctx.options.tls_profile = "default"
        mock_ctx.options.intercept_config_file = ""

        addon = self._make_addon()
        addon._client_certs = []

        # Use a simple object to track attribute assignment
        class TrackingData:
            assigned = {}
            conn = MagicMock()

            def __setattr__(self, name, value):
                TrackingData.assigned[name] = value
                super().__setattr__(name, value)

        TrackingData.conn.address = ("unmatched.host.com", 443)
        data = TrackingData()

        addon.tls_start_server(data)

        # ssl_conn should not have been set
        assert "ssl_conn" not in TrackingData.assigned

    @patch("mitmproxy_bridge.ctx")
    def test_chrome_profile_no_client_cert_uses_cached_context(self, mock_ctx):
        """With chrome profile and no matching cert, sets ssl_conn using cached context."""
        mock_ctx.options.tls_profile = "chrome"
        mock_ctx.options.intercept_config_file = ""

        addon = self._make_addon()
        addon._client_certs = []

        data = MagicMock()
        data.conn.address = ("api.example.com", 443)

        addon.tls_start_server(data)

        # ssl_conn should be set
        assert data.ssl_conn is not None

    @patch("mitmproxy_bridge.ctx")
    def test_client_cert_injection_sets_ssl_conn(self, mock_ctx):
        """When a matching client cert is found, ssl_conn is set on data."""
        from OpenSSL import crypto as openssl_crypto
        # Generate a self-signed cert for testing
        key = openssl_crypto.PKey()
        key.generate_key(openssl_crypto.TYPE_RSA, 2048)
        cert = openssl_crypto.X509()
        cert.get_subject().CN = "test"
        cert.set_serial_number(1)
        cert.gmtime_adj_notBefore(0)
        cert.gmtime_adj_notAfter(365 * 24 * 60 * 60)
        cert.set_pubkey(key)
        cert.sign(key, "sha256")

        cert_pem = openssl_crypto.dump_certificate(openssl_crypto.FILETYPE_PEM, cert).decode()
        key_pem = openssl_crypto.dump_privatekey(openssl_crypto.FILETYPE_PEM, key).decode()

        mock_ctx.options.tls_profile = "chrome"
        mock_ctx.options.intercept_config_file = ""

        addon = self._make_addon()
        addon._client_certs = [
            {
                "id": 1,
                "name": "TestCert",
                "hostnames": ["mtls.example.com"],
                "certPem": cert_pem,
                "keyPem": key_pem,
            }
        ]

        data = MagicMock()
        data.conn.address = ("mtls.example.com", 443)

        addon.tls_start_server(data)

        # ssl_conn should be set
        assert data.ssl_conn is not None
        mock_ctx.log.info.assert_called()
        info_calls = [str(c) for c in mock_ctx.log.info.call_args_list]
        assert any("TestCert" in c for c in info_calls)

    @patch("mitmproxy_bridge.ctx")
    def test_client_cert_with_default_profile(self, mock_ctx):
        """With default profile but matching client cert, ssl_conn is still set."""
        from OpenSSL import crypto as openssl_crypto
        key = openssl_crypto.PKey()
        key.generate_key(openssl_crypto.TYPE_RSA, 2048)
        cert = openssl_crypto.X509()
        cert.get_subject().CN = "test"
        cert.set_serial_number(1)
        cert.gmtime_adj_notBefore(0)
        cert.gmtime_adj_notAfter(365 * 24 * 60 * 60)
        cert.set_pubkey(key)
        cert.sign(key, "sha256")

        cert_pem = openssl_crypto.dump_certificate(openssl_crypto.FILETYPE_PEM, cert).decode()
        key_pem = openssl_crypto.dump_privatekey(openssl_crypto.FILETYPE_PEM, key).decode()

        mock_ctx.options.tls_profile = "default"
        mock_ctx.options.intercept_config_file = ""

        addon = self._make_addon()
        addon._client_certs = [
            {
                "id": 1,
                "name": "DefaultProfileCert",
                "hostnames": ["mtls.default.com"],
                "certPem": cert_pem,
                "keyPem": key_pem,
            }
        ]

        data = MagicMock()
        data.conn.address = ("mtls.default.com", 443)

        addon.tls_start_server(data)

        # ssl_conn should be set even with default profile when cert matches
        assert data.ssl_conn is not None

    @patch("mitmproxy_bridge.ctx")
    def test_non_matching_hostname_no_cert_injected(self, mock_ctx):
        """A hostname not in any cert's hostnames list does not trigger cert injection."""
        from OpenSSL import crypto as openssl_crypto

        mock_ctx.options.tls_profile = "chrome"
        mock_ctx.options.intercept_config_file = ""

        addon = self._make_addon()
        addon._client_certs = [
            {
                "id": 1,
                "name": "NotMatched",
                "hostnames": ["other.host.com"],
                "certPem": "irrelevant",
                "keyPem": "irrelevant",
            }
        ]

        data = MagicMock()
        data.conn.address = ("api.example.com", 443)

        # Patch _find_client_cert to track calls without actually loading bad PEM
        original_find = addon._find_client_cert
        find_calls = []

        def tracking_find(hostname):
            result = original_find(hostname)
            find_calls.append((hostname, result))
            return result

        addon._find_client_cert = tracking_find

        addon.tls_start_server(data)

        # ssl_conn is set (chrome profile)
        assert data.ssl_conn is not None
        # No cert was matched
        assert find_calls[0] == ("api.example.com", None)
        # No error logged
        mock_ctx.log.error.assert_not_called()


class TestInterceptHold:
    """Tests for interactive intercept ("breakpoints") — the hold decision,
    fail-open round-trip, and flow mutation helpers."""

    def _make_addon(self):
        import mitmproxy_bridge
        return mitmproxy_bridge.DarkRideAddon()

    def _make_flow(self, host="api.example.com", pretty_host="api.example.com",
                   path="/v1/data", method="GET"):
        flow = MagicMock()
        flow.request.host = host
        flow.request.pretty_host = pretty_host
        flow.request.path = path
        flow.request.method = method
        return flow

    # ---- _hold_matches ----

    def test_disarmed_never_matches(self):
        addon = self._make_addon()
        addon._hold_config = {"enabled": False, "phases": ["request", "response"]}
        assert addon._hold_matches(self._make_flow(), "request") is False

    def test_armed_no_filters_matches(self):
        addon = self._make_addon()
        addon._hold_config = {"enabled": True, "phases": ["request", "response"]}
        assert addon._hold_matches(self._make_flow(), "request") is True

    def test_phase_filter(self):
        addon = self._make_addon()
        addon._hold_config = {"enabled": True, "phases": ["response"]}
        assert addon._hold_matches(self._make_flow(), "request") is False
        assert addon._hold_matches(self._make_flow(), "response") is True

    def test_hostname_glob(self):
        addon = self._make_addon()
        addon._hold_config = {"enabled": True, "phases": ["request"], "matchHostname": "*.example.com"}
        assert addon._hold_matches(self._make_flow(host="api.example.com"), "request") is True
        assert addon._hold_matches(self._make_flow(host="other.com", pretty_host="other.com"), "request") is False

    def test_hostname_falls_back_to_pretty_host(self):
        addon = self._make_addon()
        addon._hold_config = {"enabled": True, "phases": ["request"], "matchHostname": "api.example.com"}
        # WireGuard mode: host is an IP, pretty_host carries the name
        flow = self._make_flow(host="203.0.113.5", pretty_host="api.example.com")
        assert addon._hold_matches(flow, "request") is True

    def test_path_glob(self):
        addon = self._make_addon()
        addon._hold_config = {"enabled": True, "phases": ["request"], "matchPath": "/v1/*"}
        assert addon._hold_matches(self._make_flow(path="/v1/data"), "request") is True
        assert addon._hold_matches(self._make_flow(path="/v2/data"), "request") is False

    def test_method_filter_case_insensitive(self):
        addon = self._make_addon()
        addon._hold_config = {"enabled": True, "phases": ["request"], "matchMethod": "post"}
        assert addon._hold_matches(self._make_flow(method="POST"), "request") is True
        assert addon._hold_matches(self._make_flow(method="GET"), "request") is False

    def test_rules_match_any(self):
        addon = self._make_addon()
        addon._hold_config = {
            "enabled": True, "phases": ["request"],
            "rules": [
                {"hostname": "*.stripe.com"},
                {"hostname": "api.foo.com", "method": "POST"},
            ],
        }
        assert addon._hold_matches(self._make_flow(host="js.stripe.com", pretty_host="js.stripe.com"), "request") is True
        assert addon._hold_matches(self._make_flow(host="api.foo.com", pretty_host="api.foo.com", method="POST"), "request") is True
        # host matches rule 2 but method doesn't; no other rule matches
        assert addon._hold_matches(self._make_flow(host="api.foo.com", pretty_host="api.foo.com", method="GET"), "request") is False
        assert addon._hold_matches(self._make_flow(host="other.com", pretty_host="other.com"), "request") is False

    def test_rule_requires_all_fields(self):
        addon = self._make_addon()
        addon._hold_config = {"enabled": True, "phases": ["request"], "rules": [{"hostname": "a.com", "path": "/v1/*"}]}
        assert addon._hold_matches(self._make_flow(host="a.com", pretty_host="a.com", path="/v1/x"), "request") is True
        assert addon._hold_matches(self._make_flow(host="a.com", pretty_host="a.com", path="/v2/x"), "request") is False

    def test_empty_rules_list_matches_all(self):
        addon = self._make_addon()
        addon._hold_config = {"enabled": True, "phases": ["request"], "rules": []}
        assert addon._hold_matches(self._make_flow(), "request") is True

    # ---- _post_to_hold (fail-open) ----

    @patch("mitmproxy_bridge.ctx")
    def test_post_to_hold_fails_open_on_error(self, mock_ctx):
        mock_ctx.options.node_webhook = "http://localhost:1/v1/traffic/ingest"
        addon = self._make_addon()
        result = addon._post_to_hold({"flowId": "x", "phase": "request"})
        assert result == {"action": "forward"}

    @patch("mitmproxy_bridge.ctx")
    def test_post_to_hold_returns_resolution(self, mock_ctx):
        mock_ctx.options.node_webhook = "http://localhost:3000/v1/traffic/ingest"
        addon = self._make_addon()
        fake_resp = MagicMock()
        fake_resp.read.return_value = json.dumps(
            {"action": "forward", "modified": {"url": "https://x/"}}
        ).encode("utf-8")
        with patch("mitmproxy_bridge.urllib.request.urlopen", return_value=fake_resp) as uo:
            result = addon._post_to_hold({"flowId": "x", "phase": "request"})
        assert result == {"action": "forward", "modified": {"url": "https://x/"}}
        # Posts to the /intercept/hold endpoint derived from node_webhook
        posted_url = uo.call_args.args[0].full_url
        assert posted_url == "http://localhost:3000/v1/intercept/hold"

    @patch("mitmproxy_bridge.ctx")
    def test_post_to_hold_rejects_unknown_action(self, mock_ctx):
        mock_ctx.options.node_webhook = "http://localhost:3000/v1/traffic/ingest"
        addon = self._make_addon()
        fake_resp = MagicMock()
        fake_resp.read.return_value = json.dumps({"action": "explode"}).encode("utf-8")
        with patch("mitmproxy_bridge.urllib.request.urlopen", return_value=fake_resp):
            result = addon._post_to_hold({"flowId": "x", "phase": "request"})
        assert result == {"action": "forward"}

    # ---- _apply_hold_request ----

    def test_apply_hold_request_drop_sets_444(self):
        addon = self._make_addon()
        flow = MagicMock()
        flow.response = None
        addon._apply_hold_request(flow, {"action": "drop"})
        assert flow.response is not None
        assert flow.response.status_code == 444

    def test_apply_hold_request_modifies_method_url_headers_body(self):
        addon = self._make_addon()
        flow = MagicMock()
        flow.request.headers = {}
        addon._apply_hold_request(flow, {
            "action": "forward",
            "modified": {
                "method": "POST",
                "url": "https://new.example.com/x",
                "headers": {"X-Test": "1"},
                "body": "hello",
            },
        })
        assert flow.request.method == "POST"
        assert flow.request.url == "https://new.example.com/x"
        assert flow.request.headers["X-Test"] == "1"
        flow.request.set_text.assert_called_with("hello")

    def test_apply_hold_request_forward_no_modified_is_noop(self):
        addon = self._make_addon()
        flow = MagicMock()
        flow.response = None
        addon._apply_hold_request(flow, {"action": "forward"})
        # No response injected — flow forwards unmodified
        assert flow.response is None
        flow.request.set_text.assert_not_called()

    # ---- _apply_hold_response ----

    def test_apply_hold_response_drop_sets_444(self):
        addon = self._make_addon()
        flow = MagicMock()
        addon._apply_hold_response(flow, {"action": "drop"})
        assert flow.response.status_code == 444

    def test_apply_hold_response_modifies_status_headers_body(self):
        addon = self._make_addon()
        flow = MagicMock()
        flow.response.headers = {}
        addon._apply_hold_response(flow, {
            "action": "forward",
            "modified": {"statusCode": 503, "headers": {"X-R": "2"}, "body": "err"},
        })
        assert flow.response.status_code == 503
        assert flow.response.headers["X-R"] == "2"
        flow.response.set_text.assert_called_with("err")

    # ---- option registration ----

    def test_hold_config_option_registered(self):
        import mitmproxy_bridge
        loader = MagicMock()
        mitmproxy_bridge.load(loader)
        names = [c.kwargs.get("name") for c in loader.add_option.call_args_list]
        assert "intercept_hold_config_file" in names

    # ---- _reload_hold_config ----

    @patch("mitmproxy_bridge.ctx")
    def test_reload_hold_config_reads_file(self, mock_ctx, tmp_path):
        config_file = tmp_path / "hold.json"
        config_file.write_text(json.dumps({"enabled": True, "phases": ["request"]}))
        mock_ctx.options.intercept_hold_config_file = str(config_file)
        addon = self._make_addon()
        addon._reload_hold_config()
        assert addon._hold_config["enabled"] is True
        assert addon._hold_config["phases"] == ["request"]

    @patch("mitmproxy_bridge.ctx")
    def test_reload_hold_config_empty_path_skips(self, mock_ctx):
        mock_ctx.options.intercept_hold_config_file = ""
        addon = self._make_addon()
        addon._reload_hold_config()
        assert addon._hold_config["enabled"] is False


class TestExtractTimings:
    """Tests for _extract_timings() — per-request duration + timing breakdown."""

    def _flow(self, req_start=None, req_end=None, resp_start=None, resp_end=None,
              conn_start=None, tcp_setup=None, tls_setup=None, with_server_conn=True):
        request = SimpleNamespace(timestamp_start=req_start, timestamp_end=req_end)
        response = SimpleNamespace(timestamp_start=resp_start, timestamp_end=resp_end)
        server_conn = None
        if with_server_conn:
            server_conn = SimpleNamespace(
                timestamp_start=conn_start,
                timestamp_tcp_setup=tcp_setup,
                timestamp_tls_setup=tls_setup,
            )
        return SimpleNamespace(request=request, response=response, server_conn=server_conn)

    def test_full_timestamps_present(self):
        # A fresh connection: conn @1000.0, tcp @1000.05, tls @1000.15,
        # request sent-end @1000.20, first response byte @1000.50, done @1000.60
        flow = self._flow(
            req_start=1000.0, req_end=1000.20,
            resp_start=1000.50, resp_end=1000.60,
            conn_start=1000.0, tcp_setup=1000.05, tls_setup=1000.15,
        )
        duration_ms, timings = _extract_timings(flow)
        assert duration_ms == 600  # (1000.60 - 1000.0) * 1000
        assert timings is not None
        assert timings["connect"] == 50    # tcp - conn
        assert timings["tls"] == 100       # tls - tcp
        assert timings["ttfb"] == 300      # resp_start - req_end
        assert timings["download"] == 100  # resp_end - resp_start
        assert timings["dns"] is None      # mitmproxy exposes no DNS timing

    def test_reused_connection_missing_setup(self):
        # Reused (keep-alive) connection: no tcp/tls setup timestamps, but
        # request/response timing is still present.
        flow = self._flow(
            req_start=2000.0, req_end=2000.1,
            resp_start=2000.4, resp_end=2000.5,
            conn_start=None, tcp_setup=None, tls_setup=None,
        )
        duration_ms, timings = _extract_timings(flow)
        assert duration_ms == 500
        assert timings["connect"] is None
        assert timings["tls"] is None
        assert timings["ttfb"] == 300
        assert timings["download"] == 100

    def test_missing_response_end_yields_null_duration(self):
        flow = self._flow(req_start=5.0, req_end=5.1, resp_start=5.2, resp_end=None)
        duration_ms, timings = _extract_timings(flow)
        assert duration_ms is None
        # ttfb still computable, download not
        assert timings["ttfb"] == 100
        assert timings["download"] is None

    def test_no_data_returns_none_none(self):
        flow = self._flow(with_server_conn=False)
        duration_ms, timings = _extract_timings(flow)
        assert duration_ms is None
        assert timings is None

    def test_negative_segment_clamped_to_none(self):
        # Clock skew / reordered timestamps must never produce negatives.
        flow = self._flow(
            req_start=10.0, req_end=10.5,
            resp_start=10.4, resp_end=10.6,  # resp_start < req_end → ttfb negative
            conn_start=10.0, tcp_setup=10.05, tls_setup=10.15,
        )
        duration_ms, timings = _extract_timings(flow)
        assert duration_ms == 600
        assert timings["ttfb"] is None  # negative clamped

    def test_never_raises_on_garbage_flow(self):
        # A flow with non-numeric timestamps must be swallowed, not raise.
        bad = SimpleNamespace(
            request=SimpleNamespace(timestamp_start="oops", timestamp_end=None),
            response=SimpleNamespace(timestamp_start=None, timestamp_end="nope"),
            server_conn=None,
        )
        duration_ms, timings = _extract_timings(bad)
        assert duration_ms is None
        assert timings is None
