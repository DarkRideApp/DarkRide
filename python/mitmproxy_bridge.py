"""
mitmproxy addon script for DarkRide.

Captures HTTP request/response data and forwards it to the Node.js
webhook endpoint as fire-and-forget POST requests.

Usage:
    mitmdump -s mitmproxy_bridge.py --set node_webhook=http://localhost:3000/v1/traffic/ingest
"""

import asyncio
import base64
import fnmatch
import json
import os
import socket
import urllib.request
from urllib.parse import urlparse
from mitmproxy import http, dns, ctx
from mitmproxy.tls import ClientHelloData, TlsData
from OpenSSL import SSL, crypto as openssl_crypto
from OpenSSL._util import ffi as _ssl_ffi, lib as _ssl_lib


# Max body size to send to webhook (1 MB). Larger bodies are truncated.
MAX_BODY_BYTES = 1 * 1024 * 1024

# Max WebSocket payload size to forward (1 MB). Larger payloads are truncated.
MAX_WS_PAYLOAD_BYTES = 1 * 1024 * 1024

# Max image size to capture as binary (2 MB). Larger images are skipped.
MAX_IMAGE_BYTES = 2 * 1024 * 1024

# Content-type prefixes that are images (eligible for binary capture)
IMAGE_CONTENT_PREFIXES = ("image/",)

# Content-types treated as binary (body replaced with a size summary)
BINARY_CONTENT_PREFIXES = (
    "image/", "video/", "audio/", "application/octet-stream",
    "application/zip", "application/gzip", "application/protobuf",
    "application/grpc", "application/x-protobuf",
)

# ---------------------------------------------------------------------------
# TLS fingerprint spoofing — selectable profiles
#
# mitmproxy creates upstream TLS connections using Python's default OpenSSL
# settings, producing a JA3 fingerprint that anti-bot systems blocklist.
# We replace the upstream TLS context with one matching a specific client's
# cipher list, curves, ALPN, and signature algorithms.
#
# Available profiles:
#   chrome  — Chrome 120 on Android (15 ciphers, includes legacy SHA-1)
#   okhttp  — OkHttp 4.x / Retrofit (9 ciphers, modern-only, no SHA-1)
#   default — No spoofing (skip tls_start_server entirely)
# ---------------------------------------------------------------------------

# Shared TLS 1.3 ciphersuites (same for chrome and okhttp)
_TLS13_CIPHERS = "TLS_AES_128_GCM_SHA256:TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256"

# Chrome 120 Android TLS 1.2 cipher list (12 ciphers, includes legacy SHA-1)
_CHROME_TLS12_CIPHERS = (
    "ECDHE-ECDSA-AES128-GCM-SHA256:"
    "ECDHE-RSA-AES128-GCM-SHA256:"
    "ECDHE-ECDSA-AES256-GCM-SHA384:"
    "ECDHE-RSA-AES256-GCM-SHA384:"
    "ECDHE-ECDSA-CHACHA20-POLY1305:"
    "ECDHE-RSA-CHACHA20-POLY1305:"
    "ECDHE-RSA-AES128-SHA:"
    "ECDHE-RSA-AES256-SHA:"
    "AES128-GCM-SHA256:"
    "AES256-GCM-SHA384:"
    "AES128-SHA:"
    "AES256-SHA"
)

# OkHttp 4.x ConnectionSpec.MODERN_TLS — TLS 1.2 ciphers (6, modern-only)
_OKHTTP_TLS12_CIPHERS = (
    "ECDHE-ECDSA-AES128-GCM-SHA256:"
    "ECDHE-RSA-AES128-GCM-SHA256:"
    "ECDHE-ECDSA-AES256-GCM-SHA384:"
    "ECDHE-RSA-AES256-GCM-SHA384:"
    "ECDHE-ECDSA-CHACHA20-POLY1305:"
    "ECDHE-RSA-CHACHA20-POLY1305"
)

_SHARED_GROUPS = b"x25519:P-256:P-384"
_SHARED_SIGALGS = (
    b"ECDSA+SHA256:RSA-PSS+SHA256:RSA+SHA256:"
    b"ECDSA+SHA384:RSA-PSS+SHA384:RSA+SHA384:"
    b"RSA-PSS+SHA512:RSA+SHA512"
)

# Profile definitions: each has a TLS 1.2 cipher string
TLS_PROFILES = {
    "chrome": _CHROME_TLS12_CIPHERS,
    "okhttp": _OKHTTP_TLS12_CIPHERS,
}

# Backwards-compat aliases for existing imports in tests
_CHROME_TLS13_CIPHERS = _TLS13_CIPHERS
_CHROME_GROUPS = _SHARED_GROUPS
_CHROME_SIGALGS = _SHARED_SIGALGS

# Cached contexts — one per profile name, built once and reused
_ssl_ctx_cache: dict = {}


def _build_ssl_context(profile_name: str):
    """Build an OpenSSL context for the given TLS profile.

    Uses pyOpenSSL's internal cffi bindings (_ssl_lib) to call OpenSSL functions
    on the same library instance that created the SSL_CTX. This is required
    because newer cryptography (46.x+) statically links OpenSSL into its Rust
    binding — calling the system libssl via ctypes on these pointers segfaults.
    """
    tls12_ciphers = TLS_PROFILES.get(profile_name)
    if tls12_ciphers is None:
        raise ValueError(f"Unknown TLS profile: {profile_name}")

    ctx_ssl = SSL.Context(SSL.TLS_CLIENT_METHOD)

    # TLS version bounds: 1.2 minimum, 1.3 maximum
    ctx_ssl.set_min_proto_version(SSL.TLS1_2_VERSION)
    ctx_ssl.set_max_proto_version(SSL.TLS1_3_VERSION)

    # Set TLS 1.2 cipher list
    ctx_ssl.set_cipher_list(tls12_ciphers.encode("ascii"))

    # Set TLS 1.3 ciphersuites via cffi binding
    if hasattr(_ssl_lib, "SSL_CTX_set_ciphersuites"):
        _ssl_lib.SSL_CTX_set_ciphersuites(
            ctx_ssl._context, _TLS13_CIPHERS.encode("ascii")
        )

    # Set signature algorithms via cffi binding
    if hasattr(_ssl_lib, "SSL_CTX_set1_sigalgs_list"):
        _ssl_lib.SSL_CTX_set1_sigalgs_list(ctx_ssl._context, _SHARED_SIGALGS)

    # Set elliptic curve groups — SSL_CTX_set1_groups_list may not be exposed
    # in cffi bindings; try it, and fall back gracefully. OpenSSL 3.x defaults
    # already put x25519 and P-256 first, so this is a nice-to-have.
    if hasattr(_ssl_lib, "SSL_CTX_set1_groups_list"):
        _ssl_lib.SSL_CTX_set1_groups_list(ctx_ssl._context, _SHARED_GROUPS)

    # ALPN: h2, http/1.1
    ctx_ssl.set_alpn_protos([b"h2", b"http/1.1"])

    # Disable certificate verification — mitmproxy handles cert logic separately
    ctx_ssl.set_verify(SSL.VERIFY_NONE, lambda *_: True)

    return ctx_ssl


def _build_chrome_ssl_context():
    """Build an OpenSSL context mimicking Chrome 120 on Android.

    Backwards-compatible wrapper around _build_ssl_context('chrome').
    """
    return _build_ssl_context("chrome")


# ---------------------------------------------------------------------------
# Async event-loop-level upstream proxy support
#
# mitmproxy 8.x ignores `data.server.via` in WireGuard/transparent mode.
# Workaround: monkey-patch the asyncio event loop's `sock_connect` method
# to route ALL outgoing TCP connections through our local HTTP CONNECT proxy
# (SocksProxyServer). This works because BaseEventLoop.create_connection()
# calls self.sock_connect() in Python 3.7+. Fully async — does not block
# the event loop during the CONNECT handshake.
# ---------------------------------------------------------------------------

_proxy_config = None  # (host, port) — set when proxy is activated
_patch_applied = False


async def _proxied_sock_connect(original_func, loop, sock, address):
    """Async sock_connect replacement: route non-local TCP through HTTP CONNECT proxy."""
    global _proxy_config

    # Only intercept TCP streams when proxy is active
    if not _proxy_config or sock.type != socket.SOCK_STREAM:
        return await original_func(sock, address)

    try:
        host, port = str(address[0]), int(address[1])
    except (IndexError, TypeError, ValueError):
        return await original_func(sock, address)

    # Skip proxy for localhost (webhook, internal comms)
    if host in ("127.0.0.1", "localhost", "::1", "0.0.0.0"):
        return await original_func(sock, address)

    proxy_host, proxy_port = _proxy_config

    try:
        # Step 1: TCP connect to our local HTTP CONNECT proxy
        await original_func(sock, (proxy_host, proxy_port))

        # Step 2: Send HTTP CONNECT request
        connect_req = f"CONNECT {host}:{port} HTTP/1.1\r\nHost: {host}:{port}\r\n\r\n"
        await loop.sock_sendall(sock, connect_req.encode("ascii"))

        # Step 3: Read the proxy's response
        response = b""
        while b"\r\n\r\n" not in response and len(response) < 4096:
            chunk = await loop.sock_recv(sock, 4096)
            if not chunk:
                raise ConnectionError("HTTP CONNECT proxy closed connection")
            response += chunk

        # Verify 200 OK
        status_line = response.split(b"\r\n")[0].decode("ascii", errors="replace")
        if "200" not in status_line:
            raise ConnectionError(f"HTTP CONNECT proxy rejected: {status_line}")
    except Exception as e:
        ctx.log.error(f"[DarkRide] Proxy connect to {host}:{port} failed: {e}")
        raise


def _activate_proxy(proxy_url):
    """Parse proxy URL and monkey-patch the running asyncio event loop's sock_connect."""
    global _proxy_config, _patch_applied
    parsed = urlparse(proxy_url)
    _proxy_config = (parsed.hostname or "127.0.0.1", parsed.port or 8080)

    if _patch_applied:
        return

    loop = asyncio.get_running_loop()
    original_sock_connect = loop.sock_connect

    async def patched_sock_connect(sock, address):
        return await _proxied_sock_connect(original_sock_connect, loop, sock, address)

    loop.sock_connect = patched_sock_connect
    _patch_applied = True


def _extract_timings(flow):
    """Compute per-request duration + a best-effort timing breakdown from a
    completed mitmproxy HTTP flow.

    Returns a (duration_ms, timings) tuple:
      - duration_ms: int milliseconds from request start to response end, or
        None when either timestamp is missing.
      - timings: dict with dns/connect/tls/ttfb/download segment durations in
        ms (each None when it can't be computed), or None when there is no
        usable timing data at all.

    Defensive by design: a missing attribute yields None for that piece and
    never raises. Reused (keep-alive) connections routinely lack the TCP/TLS
    setup timestamps, so those segments come back None. Synthetic flows (DNS,
    TLS_FAIL) have no real flow.response and are handled by their own callers,
    which never invoke this helper.
    """
    try:
        req = getattr(flow, "request", None)
        resp = getattr(flow, "response", None)
        req_start = getattr(req, "timestamp_start", None) if req is not None else None
        req_end = getattr(req, "timestamp_end", None) if req is not None else None
        resp_start = getattr(resp, "timestamp_start", None) if resp is not None else None
        resp_end = getattr(resp, "timestamp_end", None) if resp is not None else None

        duration_ms = None
        if req_start is not None and resp_end is not None:
            duration_ms = round((resp_end - req_start) * 1000)

        server_conn = getattr(flow, "server_conn", None)
        conn_start = getattr(server_conn, "timestamp_start", None) if server_conn is not None else None
        tcp_setup = getattr(server_conn, "timestamp_tcp_setup", None) if server_conn is not None else None
        tls_setup = getattr(server_conn, "timestamp_tls_setup", None) if server_conn is not None else None

        def seg(a, b):
            """Duration a->b in ms, or None if either endpoint missing/negative."""
            if a is None or b is None:
                return None
            ms = round((b - a) * 1000)
            return ms if ms >= 0 else None

        timings = {
            # mitmproxy does not expose DNS resolution timing on the flow.
            "dns": None,
            "connect": seg(conn_start, tcp_setup),
            "tls": seg(tcp_setup, tls_setup),
            "ttfb": seg(req_end, resp_start),
            "download": seg(resp_start, resp_end),
        }

        # Nothing useful to report — keep the payload clean.
        if duration_ms is None and all(v is None for v in timings.values()):
            return None, None
        return duration_ms, timings
    except Exception:
        return None, None


def _truncate_body(body: str | None, content_type: str | None) -> str | None:
    """Truncate or skip body based on size and content type."""
    if body is None:
        return None

    # Replace binary content with a summary
    if content_type:
        ct_lower = content_type.lower()
        for prefix in BINARY_CONTENT_PREFIXES:
            if ct_lower.startswith(prefix):
                return f"[binary {content_type}, {len(body)} chars]"

    if len(body) > MAX_BODY_BYTES:
        return body[:MAX_BODY_BYTES] + f"\u2026[truncated, {len(body)} total]"

    return body


class DarkRideAddon:
    def __init__(self):
        self._blocklist: set = set()
        self._blocklist_mtime: float = 0.0
        self._blocklist_path: str = ""
        self._hiddenlist: set = set()
        self._hiddenlist_mtime: float = 0.0
        self._hiddenlist_path: str = ""
        self._hidden_ws_flows: set = set()
        self._registered_ws_flows: set = set()
        self._intercept_rules: list = []
        self._client_certs: list = []
        self._intercept_config_path: str = ""
        self._intercept_config_mtime: float = 0.0
        # Interactive intercept ("breakpoints") — armed config reloaded by mtime.
        self._hold_config: dict = {"enabled": False, "phases": ["request", "response"]}
        self._hold_config_path: str = ""
        self._hold_config_mtime: float = 0.0

    def _reload_blocklist(self):
        """Reload the blocklist JSON file if it has changed on disk."""
        try:
            file_path = ctx.options.blocklist_file
        except Exception:
            return
        if not file_path:
            return
        if file_path != self._blocklist_path:
            self._blocklist_path = file_path
            self._blocklist_mtime = 0.0
        try:
            mtime = os.path.getmtime(file_path)
        except OSError:
            return
        if mtime == self._blocklist_mtime:
            return
        self._blocklist_mtime = mtime
        try:
            with open(file_path, "r") as f:
                domains = json.load(f)
            self._blocklist = set(domains) if isinstance(domains, list) else set()
            ctx.log.info(f"[DarkRide] Reloaded blocklist: {len(self._blocklist)} domains")
        except Exception as e:
            ctx.log.error(f"[DarkRide] Failed to read blocklist: {e}")

    def _is_blocked(self, hostname: str) -> bool:
        """Check if hostname is blocked (exact or subdomain match)."""
        if not self._blocklist or not hostname:
            return False
        hostname = hostname.lower().rstrip(".")
        if hostname in self._blocklist:
            return True
        parts = hostname.split(".")
        for i in range(1, len(parts)):
            parent = ".".join(parts[i:])
            if parent in self._blocklist:
                return True
        return False

    def _reload_hiddenlist(self):
        """Reload the hiddenlist JSON file if it has changed on disk."""
        try:
            file_path = ctx.options.hiddenlist_file
        except Exception:
            return
        if not file_path:
            return
        if file_path != self._hiddenlist_path:
            self._hiddenlist_path = file_path
            self._hiddenlist_mtime = 0.0
        try:
            mtime = os.path.getmtime(file_path)
        except OSError:
            return
        if mtime == self._hiddenlist_mtime:
            return
        self._hiddenlist_mtime = mtime
        try:
            with open(file_path, "r") as f:
                domains = json.load(f)
            self._hiddenlist = set(domains) if isinstance(domains, list) else set()
            ctx.log.info(f"[DarkRide] Reloaded hiddenlist: {len(self._hiddenlist)} domains")
        except Exception as e:
            ctx.log.error(f"[DarkRide] Failed to read hiddenlist: {e}")

    def _is_hidden(self, hostname: str) -> bool:
        """Check if hostname is hidden (exact or subdomain match)."""
        if not self._hiddenlist or not hostname:
            return False
        hostname = hostname.lower().rstrip(".")
        if hostname in self._hiddenlist:
            return True
        parts = hostname.split(".")
        for i in range(1, len(parts)):
            parent = ".".join(parts[i:])
            if parent in self._hiddenlist:
                return True
        return False

    def _reload_intercept_config(self):
        """Reload the intercept config JSON file if it has changed on disk."""
        try:
            file_path = ctx.options.intercept_config_file
        except Exception:
            return
        if not file_path:
            return
        if file_path != self._intercept_config_path:
            self._intercept_config_path = file_path
            self._intercept_config_mtime = 0.0
        try:
            mtime = os.path.getmtime(file_path)
        except OSError:
            return
        if mtime == self._intercept_config_mtime:
            return
        self._intercept_config_mtime = mtime
        try:
            with open(file_path, "r") as f:
                config = json.load(f)
            self._intercept_rules = config.get("rules", []) if isinstance(config, dict) else []
            self._client_certs = config.get("clientCerts", []) if isinstance(config, dict) else []
            ctx.log.info(
                f"[DarkRide] Loaded {len(self._intercept_rules)} intercept rules "
                f"and {len(self._client_certs)} client certs"
            )
        except Exception as e:
            ctx.log.error(f"[DarkRide] Failed to read intercept config: {e}")

    def _reload_hold_config(self):
        """Reload the interactive-intercept armed config if it changed on disk."""
        try:
            file_path = ctx.options.intercept_hold_config_file
        except Exception:
            return
        if not file_path:
            return
        if file_path != self._hold_config_path:
            self._hold_config_path = file_path
            self._hold_config_mtime = 0.0
        try:
            mtime = os.path.getmtime(file_path)
        except OSError:
            return
        if mtime == self._hold_config_mtime:
            return
        self._hold_config_mtime = mtime
        try:
            with open(file_path, "r") as f:
                config = json.load(f)
            if isinstance(config, dict):
                self._hold_config = config
            else:
                self._hold_config = {"enabled": False, "phases": ["request", "response"]}
            ctx.log.info(
                f"[DarkRide] Interactive intercept "
                f"{'ARMED' if self._hold_config.get('enabled') else 'disarmed'}"
            )
        except Exception as e:
            ctx.log.error(f"[DarkRide] Failed to read hold config: {e}")

    def _hold_matches(self, flow, phase: str) -> bool:
        """Decide locally whether this flow should be held for a manual verdict.

        Runs on the hot path for every request/response, so it must stay cheap
        and never do I/O. Only when it returns True does the addon make the
        blocking POST /intercept/hold round-trip.
        """
        cfg = self._hold_config
        if not cfg or not cfg.get("enabled"):
            return False
        phases = cfg.get("phases") or ["request", "response"]
        if phase not in phases:
            return False
        # Rules take precedence: hold when the flow matches ANY rule. An empty
        # rule list means match-all. Fall back to the legacy single-match fields
        # only when no `rules` key is present.
        rules = cfg.get("rules")
        if rules is not None:
            if len(rules) == 0:
                return True
            return any(self._rule_matches(flow, r) for r in rules)
        return self._rule_matches(flow, {
            "hostname": cfg.get("matchHostname"),
            "path": cfg.get("matchPath"),
            "method": cfg.get("matchMethod"),
        })

    def _rule_matches(self, flow, rule: dict) -> bool:
        """Does a flow satisfy one rule? All set fields must match (AND)."""
        match_hostname = rule.get("hostname")
        if match_hostname:
            host = getattr(flow.request, "host", "") or ""
            pretty = getattr(flow.request, "pretty_host", "") or ""
            if not (fnmatch.fnmatch(host, match_hostname) or fnmatch.fnmatch(pretty, match_hostname)):
                return False
        match_path = rule.get("path")
        if match_path:
            raw_path = getattr(flow.request, "path", "") or ""
            path_no_qs = raw_path.split("?")[0]
            if not fnmatch.fnmatch(path_no_qs, match_path):
                return False
        match_method = rule.get("method")
        if match_method:
            req_method = getattr(flow.request, "method", "") or ""
            if req_method.upper() != str(match_method).upper():
                return False
        return True

    def _post_to_hold(self, data: dict) -> dict:
        """Blocking long-poll to Node for a held-flow verdict.

        Fails OPEN (forward unmodified) on ANY error or timeout so a device's
        traffic is never permanently stuck. Called via run_in_executor so the
        asyncio loop keeps serving other flows while this one suspends.
        """
        # The hold endpoint lives at /v1/intercept/hold (its own namespace, not
        # under /v1/traffic/). Derive it from the webhook's scheme+host origin.
        webhook_url = ctx.options.node_webhook
        parsed = urlparse(webhook_url)
        origin = f"{parsed.scheme}://{parsed.netloc}"
        url = origin + "/v1/intercept/hold"
        try:
            payload = json.dumps(data).encode("utf-8")
            req = urllib.request.Request(
                url,
                data=payload,
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            # Generous ceiling; Node resolves sooner via its own shorter timeout.
            resp = urllib.request.urlopen(req, timeout=300)
            result = json.loads(resp.read().decode("utf-8"))
            if isinstance(result, dict) and result.get("action") in ("forward", "drop"):
                return result
            return {"action": "forward"}
        except Exception as e:
            ctx.log.error(f"[DarkRide] Hold POST failed (failing open to forward): {e}")
            return {"action": "forward"}

    def _apply_hold_request(self, flow, resolution: dict):
        """Apply a held-request verdict to the flow (request phase)."""
        action = resolution.get("action", "forward")
        if action == "drop":
            # Per project memory flow.kill() is unreliable in WireGuard mode.
            flow.response = http.Response.make(444, b"Dropped by DarkRide intercept")
            return
        modified = resolution.get("modified")
        if not modified:
            return
        if "method" in modified and modified["method"]:
            flow.request.method = modified["method"]
        if "url" in modified and modified["url"]:
            flow.request.url = modified["url"]
        if "headers" in modified and isinstance(modified["headers"], dict):
            flow.request.headers.clear()
            for k, v in modified["headers"].items():
                flow.request.headers[k] = v
        if "body" in modified:
            body = modified["body"]
            if body is not None:
                flow.request.set_text(body)
            else:
                flow.request.content = b""

    def _apply_hold_response(self, flow, resolution: dict):
        """Apply a held-response verdict to the flow (response phase)."""
        action = resolution.get("action", "forward")
        if action == "drop":
            flow.response = http.Response.make(444, b"Dropped by DarkRide intercept")
            return
        modified = resolution.get("modified")
        if not modified or flow.response is None:
            return
        if "statusCode" in modified and modified["statusCode"] is not None:
            flow.response.status_code = int(modified["statusCode"])
        if "headers" in modified and isinstance(modified["headers"], dict):
            flow.response.headers.clear()
            for k, v in modified["headers"].items():
                flow.response.headers[k] = v
        if "body" in modified:
            body = modified["body"]
            if body is not None:
                flow.response.set_text(body)
            else:
                flow.response.content = b""

    async def _run_hold(self, flow, phase: str):
        """Suspend just this flow's coroutine on a blocking hold round-trip.

        Uses run_in_executor so the mitmproxy asyncio loop keeps serving every
        other flow while this one waits for a manual verdict.
        """
        try:
            device_id, session_id = self._get_context()
            if phase == "request":
                try:
                    body = flow.request.get_text()
                except Exception:
                    body = None
                headers = dict(flow.request.headers)
                status_code = None
            else:
                try:
                    body = flow.response.get_text() if flow.response else None
                except Exception:
                    body = None
                headers = dict(flow.response.headers) if flow.response else {}
                status_code = flow.response.status_code if flow.response else None
            data = {
                "flowId": flow.id,
                "phase": phase,
                "deviceId": device_id or None,
                "sessionId": session_id,
                "method": flow.request.method,
                "url": flow.request.pretty_url,
                "headers": headers,
                "body": body,
                "statusCode": status_code,
            }
            loop = asyncio.get_running_loop()
            resolution = await loop.run_in_executor(None, self._post_to_hold, data)
            if phase == "request":
                self._apply_hold_request(flow, resolution)
            else:
                self._apply_hold_response(flow, resolution)
        except Exception as e:
            ctx.log.error(f"[DarkRide] _run_hold error (forwarding unmodified): {e}")

    def _match_rules(self, flow, phase: str) -> list:
        """Return rules matching this flow/phase (preserving config order = priority order)."""
        matched = []
        for rule in self._intercept_rules:
            if rule.get("phase") != phase:
                continue
            # Hostname matching — check host (may be IP in WireGuard mode) then pretty_host
            pattern = rule.get("matchHostname", "")
            if pattern:
                host = getattr(flow.request, "host", "") or ""
                pretty = getattr(flow.request, "pretty_host", "") or ""
                if not (fnmatch.fnmatch(host, pattern) or fnmatch.fnmatch(pretty, pattern)):
                    continue
            # Path matching (strip query string)
            match_path = rule.get("matchPath", "")
            if match_path:
                raw_path = getattr(flow.request, "path", "") or ""
                path_no_qs = raw_path.split("?")[0]
                if not fnmatch.fnmatch(path_no_qs, match_path):
                    continue
            # Method matching
            match_method = rule.get("matchMethod", "")
            if match_method:
                req_method = getattr(flow.request, "method", "") or ""
                if req_method.upper() != match_method.upper():
                    continue
            # Status code matching (response phase only)
            match_status = rule.get("matchStatusCode", "")
            if match_status and phase == "response":
                try:
                    expected = int(match_status)
                    if flow.response.status_code != expected:
                        continue
                except (ValueError, AttributeError):
                    continue
            # Header matching — check if a header name:value pattern exists in request/response
            match_header = rule.get("matchHeader", "")
            if match_header:
                headers = flow.response.headers if phase == "response" else flow.request.headers
                # Format: "Header-Name: value" or just "Header-Name" (existence check)
                if ":" in match_header:
                    h_name, h_value = match_header.split(":", 1)
                    h_name = h_name.strip()
                    h_value = h_value.strip()
                    actual = headers.get(h_name, "")
                    if not fnmatch.fnmatch(actual, h_value):
                        continue
                else:
                    if match_header.strip() not in headers:
                        continue
            # Body content matching — check if body contains a substring or matches a pattern
            match_body = rule.get("matchBody", "")
            if match_body:
                body = flow.response.content if phase == "response" else flow.request.content
                if body:
                    try:
                        body_str = body.decode("utf-8", errors="replace")
                    except Exception:
                        body_str = ""
                    if match_body not in body_str:
                        continue
                else:
                    continue
            # Device filter
            device_filter = rule.get("deviceFilter", "")
            if device_filter:
                try:
                    current_device = ctx.options.device_id
                except Exception:
                    current_device = ""
                if current_device != device_filter:
                    continue
            matched.append(rule)
        return matched

    def _apply_actions(self, flow, rule: dict, phase: str) -> dict:
        """Apply all actions for a rule to the flow. Returns attribution dict."""
        actions_applied = []
        for action in rule.get("actions", []):
            action_type = action.get("type", "")
            if action_type == "json-patch":
                body = flow.response.content if phase == "response" else flow.request.content
                if body:
                    try:
                        data = json.loads(body)
                        from jsonpath_ng import parse as jp_parse
                        expr = jp_parse(action["path"])
                        matches = expr.find(data)
                        if matches:
                            for match in matches:
                                match.full_path.update(data, action["value"])
                            new_body = json.dumps(data, separators=(",", ":"))
                            if phase == "response":
                                flow.response.content = new_body.encode()
                            else:
                                flow.request.content = new_body.encode()
                            actions_applied.append(f"json-patch: {action['path']}")
                    except (json.JSONDecodeError, Exception):
                        pass  # skip if not valid JSON or path error
            elif action_type == "header-set":
                headers = flow.response.headers if phase == "response" else flow.request.headers
                headers[action["name"]] = action["value"]
                actions_applied.append(f"header-set: {action['name']}")
            elif action_type == "header-remove":
                headers = flow.response.headers if phase == "response" else flow.request.headers
                if action["name"] in headers:
                    del headers[action["name"]]
                    actions_applied.append(f"header-remove: {action['name']}")
            elif action_type == "status-code" and phase == "response":
                flow.response.status_code = int(action["value"])
                actions_applied.append(f"status-code: {action['value']}")
            elif action_type == "replace-body":
                new_body = action.get("body", "")
                if phase == "response":
                    flow.response.content = new_body.encode("utf-8") if isinstance(new_body, str) else new_body
                else:
                    flow.request.content = new_body.encode("utf-8") if isinstance(new_body, str) else new_body
                actions_applied.append("replace-body")
            elif action_type == "rewrite-url" and phase == "request":
                new_url = action.get("url", "")
                if new_url:
                    flow.request.url = new_url
                    actions_applied.append(f"rewrite-url: {new_url}")
            elif action_type == "delay":
                import time
                time.sleep(action["ms"] / 1000.0)
                actions_applied.append(f"delay: {action['ms']}ms")
        return {
            "id": rule.get("id"),
            "name": rule.get("name"),
            "phase": phase,
            "actionsApplied": actions_applied,
        }

    def _is_hidden_by_url(self, url: str) -> bool:
        """Fallback: check if any hidden domain appears as host in the URL."""
        if not self._hiddenlist or not url:
            return False
        url_lower = url.lower()
        for domain in self._hiddenlist:
            idx = url_lower.find(domain)
            if idx > 0 and url_lower[idx - 1] in (".", "/"):
                return True
        return False

    def _is_blocked_by_url(self, url: str) -> bool:
        """Fallback: check if any blocked domain appears as host in the URL."""
        if not self._blocklist or not url:
            return False
        url_lower = url.lower()
        for domain in self._blocklist:
            # Match domain as a hostname boundary: must be preceded by // or .
            # and followed by / or : or end-of-string
            idx = url_lower.find(domain)
            if idx > 0 and url_lower[idx - 1] in (".", "/"):
                return True
        return False

    def _post_to_intercept(self, data: dict) -> dict:
        """Post data to the Node.js intercept endpoint. Returns result or pass on error."""
        webhook_url = ctx.options.node_webhook
        if webhook_url.endswith("/ingest"):
            base_url = webhook_url[: -len("/ingest")]
        else:
            base_url = webhook_url.rstrip("/")
        url = base_url + "/intercept"
        try:
            payload = json.dumps(data).encode("utf-8")
            req = urllib.request.Request(
                url,
                data=payload,
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            resp = urllib.request.urlopen(req, timeout=10)
            return json.loads(resp.read().decode("utf-8"))
        except Exception as e:
            ctx.log.error(f"[DarkRide] Intercept POST failed: {e}")
            return {"action": "pass"}

    def _apply_request_modifications(self, flow: http.HTTPFlow, result: dict):
        """Apply intercept result to a request flow. Returns True if blocked."""
        action = result.get("action", "pass")
        if action == "block":
            flow.response = http.Response.make(403, b"Blocked by DarkRide hook")
            return True
        if action == "modify":
            if "method" in result:
                flow.request.method = result["method"]
            if "url" in result:
                flow.request.url = result["url"]
            if "headers" in result:
                flow.request.headers.clear()
                for k, v in result["headers"].items():
                    flow.request.headers[k] = v
            if "body" in result:
                body = result["body"]
                if body is not None:
                    flow.request.set_text(body)
                else:
                    flow.request.content = b""
        return False

    def _apply_response_modifications(self, flow: http.HTTPFlow, result: dict) -> bool:
        """Apply intercept result to a response flow. Returns True if blocked."""
        action = result.get("action", "pass")
        if action == "block":
            flow.response = http.Response.make(403, b"Blocked by DarkRide hook")
            return True
        if action == "modify":
            if "status" in result:
                flow.response.status_code = result["status"]
            if "responseHeaders" in result:
                flow.response.headers.clear()
                for k, v in result["responseHeaders"].items():
                    flow.response.headers[k] = v
            if "responseBody" in result:
                body = result["responseBody"]
                if body is not None:
                    flow.response.set_text(body)
                else:
                    flow.response.content = b""
        return False

    def _notify_request_started(self, flow: http.HTTPFlow):
        """Fire-and-forget POST to notify backend that a request has started."""
        try:
            device_id, session_id = self._get_context()
            host = flow.request.host
            url = flow.request.pretty_url
            # Skip hidden domains
            if self._is_hidden(host) or self._is_hidden_by_url(url):
                return
            data = {
                "flowId": flow.id,
                "deviceId": device_id or None,
                "sessionId": session_id,
                "method": flow.request.method,
                "url": url,
                "headers": dict(flow.request.headers),
            }
            self._post_to_ws_webhook("/request-started", data)
        except Exception as e:
            ctx.log.error(f"[DarkRide] _notify_request_started error: {e}")

    async def request(self, flow: http.HTTPFlow):
        """Block requests to domains in the blocklist, then run intercept hooks."""
        try:
            self._reload_blocklist()
            self._reload_hiddenlist()
            self._reload_intercept_config()
            self._reload_hold_config()
            host = flow.request.host
            url = flow.request.pretty_url
            blocked = self._is_blocked(host) or self._is_blocked_by_url(url)
            if blocked:
                flow.response = http.Response.make(403, b"Blocked by DarkRide blocklist")
                return

            # Notify backend that request has started (fire-and-forget)
            self._notify_request_started(flow)

            # Apply intercept rules
            matched = self._match_rules(flow, "request")
            matched_rules_data = []
            for rule in matched:
                attribution = self._apply_actions(flow, rule, "request")
                if attribution["actionsApplied"]:
                    matched_rules_data.append(attribution)
            if matched_rules_data:
                flow.metadata["matched_rules"] = matched_rules_data

            # Intercept hooks
            if ctx.options.intercept_hooks:
                try:
                    parsed = urlparse(url)
                except Exception:
                    parsed = None
                device_id, session_id = self._get_context()
                try:
                    request_body = flow.request.get_text()
                except Exception:
                    request_body = None
                intercept_data = {
                    "deviceId": device_id or "",
                    "phase": "request",
                    "guid": flow.id,
                    "method": flow.request.method,
                    "url": url,
                    "hostname": host or (parsed.hostname if parsed else ""),
                    "path": parsed.path if parsed else "",
                    "headers": dict(flow.request.headers),
                    "body": request_body,
                }
                result = self._post_to_intercept(intercept_data)
                if self._apply_request_modifications(flow, result):
                    return  # blocked

            # Interactive intercept ("breakpoints") — pause this flow in-flight
            # for a manual verdict. Only suspends this coroutine; other flows
            # keep flowing. Skipped for hidden domains.
            if (
                flow.response is None
                and not self._is_hidden(host)
                and not self._is_hidden_by_url(url)
                and self._hold_matches(flow, "request")
            ):
                await self._run_hold(flow, "request")
        except Exception as e:
            ctx.log.error(f"[DarkRide] request hook error: {e}")

    def running(self):
        ctx.log.info(f"[DarkRide] Addon running, webhook: {ctx.options.node_webhook}")
        ctx.log.info(f"[DarkRide] READY")
        self._reload_blocklist()
        if self._blocklist:
            ctx.log.info(f"[DarkRide] Blocklist: {len(self._blocklist)} domains")
        self._reload_hiddenlist()
        if self._hiddenlist:
            ctx.log.info(f"[DarkRide] Hiddenlist: {len(self._hiddenlist)} domains")
        self._reload_intercept_config()
        if ctx.options.upstream_proxy_url:
            _activate_proxy(ctx.options.upstream_proxy_url)
            ctx.log.info(f"[DarkRide] Upstream proxy active (socket-level): {ctx.options.upstream_proxy_url}")

    def _find_client_cert(self, hostname: str) -> dict | None:
        """Return the first client cert entry whose hostnames list contains hostname, or None."""
        if not hostname or not self._client_certs:
            return None
        for cert_entry in self._client_certs:
            if hostname in cert_entry.get("hostnames", []):
                return cert_entry
        return None

    def tls_start_server(self, data: TlsData):
        """Replace upstream TLS context with a spoofed fingerprint profile."""
        global _ssl_ctx_cache
        try:
            profile = ctx.options.tls_profile
            server_address = data.conn.address[0] if data.conn.address else None

            # Reload intercept config to pick up any cert changes
            self._reload_intercept_config()
            client_cert_entry = self._find_client_cert(server_address) if server_address else None

            if profile == "default" and client_cert_entry is None:
                return  # No spoofing and no client cert — let mitmproxy use its default TLS context

            if profile != "default":
                # Build (or reuse cached) context for the requested TLS profile.
                # If a client cert is needed we must NOT mutate the shared cached context,
                # so we build a fresh one instead.
                if client_cert_entry is not None:
                    ssl_ctx = _build_ssl_context(profile)
                else:
                    if profile not in _ssl_ctx_cache:
                        _ssl_ctx_cache[profile] = _build_ssl_context(profile)
                    ssl_ctx = _ssl_ctx_cache[profile]
            else:
                # profile == "default" but we have a client cert — build a minimal context
                ssl_ctx = SSL.Context(SSL.TLS_CLIENT_METHOD)
                ssl_ctx.set_verify(SSL.VERIFY_NONE, lambda *_: True)

            # Inject client certificate if matched
            if client_cert_entry is not None:
                try:
                    cert = openssl_crypto.load_certificate(
                        openssl_crypto.FILETYPE_PEM,
                        client_cert_entry["certPem"].encode(),
                    )
                    key = openssl_crypto.load_privatekey(
                        openssl_crypto.FILETYPE_PEM,
                        client_cert_entry["keyPem"].encode(),
                    )
                    ssl_ctx.use_certificate(cert)
                    ssl_ctx.use_privatekey(key)
                    ctx.log.info(f"[DarkRide] Using client cert '{client_cert_entry['name']}' for {server_address}")
                except Exception as e:
                    ctx.log.error(f"[DarkRide] Failed to load client cert for {server_address}: {e}")

            conn = SSL.Connection(ssl_ctx, None)
            conn.set_connect_state()

            # Set SNI (Server Name Indication)
            if server_address and not server_address.replace(".", "").isdigit():
                conn.set_tlsext_host_name(server_address.encode("idna"))

            data.ssl_conn = conn
        except Exception as e:
            ctx.log.error(f"[DarkRide] tls_start_server error (falling back to default): {e}")
            # On error, don't set data.ssl_conn — mitmproxy uses its default

    def _get_context(self):
        """Return device_id and session_id from mitmproxy options."""
        device_id = ctx.options.device_id
        session_id = ctx.options.session_id
        parsed_session = None
        if session_id:
            try:
                parsed_session = int(session_id)
            except (ValueError, TypeError):
                parsed_session = session_id
        return device_id, parsed_session

    def _post_to_webhook(self, data: dict):
        """Post data to the Node.js webhook endpoint."""
        webhook_url = ctx.options.node_webhook
        try:
            payload = json.dumps(data).encode("utf-8")
            req = urllib.request.Request(
                webhook_url,
                data=payload,
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            urllib.request.urlopen(req, timeout=5)
        except Exception as e:
            ctx.log.error(f"[DarkRide] Webhook POST failed: {e}")

    def _post_to_ws_webhook(self, path: str, data: dict):
        """Post data to a WebSocket-specific webhook endpoint.

        Derives the URL from the configured node_webhook by replacing the
        trailing /ingest segment with the given path.
        E.g. http://localhost:3000/v1/traffic/ingest + /ws-start
           → http://localhost:3000/v1/traffic/ws-start
        """
        webhook_url = ctx.options.node_webhook
        if webhook_url.endswith("/ingest"):
            base_url = webhook_url[: -len("/ingest")]
        else:
            base_url = webhook_url.rstrip("/")
        url = base_url + path
        try:
            payload = json.dumps(data).encode("utf-8")
            req = urllib.request.Request(
                url,
                data=payload,
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            urllib.request.urlopen(req, timeout=5)
        except Exception as e:
            ctx.log.error(f"[DarkRide] WS webhook POST to {path} failed: {e}")

    def dns_request(self, flow: dns.DNSFlow):
        """Kill DNS queries for blocked domains before they resolve."""
        self._reload_blocklist()
        if flow.request.questions:
            query_name = flow.request.questions[0].name.rstrip(".")
            if self._is_blocked(query_name):
                flow.kill()

    def dns_response(self, flow: dns.DNSFlow):
        """Log DNS queries to the traffic ingest."""
        if flow.response is None:
            return

        self._reload_blocklist()
        self._reload_hiddenlist()
        query_name = flow.request.questions[0].name if flow.request.questions else "?"
        raw_type = flow.request.questions[0].type if flow.request.questions else "?"
        query_type = raw_type.name if hasattr(raw_type, 'name') else str(raw_type)
        if self._is_blocked(query_name.rstrip(".")):
            return
        # Hidden domains: DNS passes through but don't capture
        if self._is_hidden(query_name.rstrip(".")):
            return

        device_id, session_id = self._get_context()

        # Collect resolved addresses
        answers = []
        for answer in flow.response.answers:
            answers.append(str(answer))

        data = {
            "id": flow.id,
            "request": {
                "method": "DNS",
                "url": f"dns://{query_name}?type={query_type}",
                "headers": {},
                "body": None,
            },
            "response": {
                "status": 0,
                "body": json.dumps(answers),
            },
        }

        if device_id:
            data["deviceId"] = device_id
        if session_id is not None:
            data["sessionId"] = session_id

        self._post_to_webhook(data)

    def tls_failed_client(self, data: TlsData):
        """Log TLS client handshake failures (e.g. certificate pinning rejections).

        Fires when the client refuses the proxy's certificate — typically because
        the app pins to a specific cert and mitmproxy's CA-signed cert doesn't match.
        """
        self._reload_blocklist()
        self._reload_hiddenlist()
        sni = data.context.server.address[0] if data.context.server and data.context.server.address else "unknown"
        if self._is_blocked(sni):
            return
        if self._is_hidden(sni):
            return

        device_id, session_id = self._get_context()
        port = data.context.server.address[1] if data.context.server and data.context.server.address else 443

        # Extract error details from the SSL connection if available
        error_detail = "client does not trust proxy certificate"
        if data.conn and hasattr(data.conn, 'error'):
            error_detail = str(data.conn.error) or error_detail

        entry = {
            "id": f"tls-fail-{sni}-{port}",
            "request": {
                "method": "CONNECT",
                "url": f"https://{sni}:{port}/",
                "headers": {},
                "body": None,
            },
            "response": {
                "status": 0,
                "body": f"TLS handshake failed: {error_detail}",
            },
        }

        if device_id:
            entry["deviceId"] = device_id
        if session_id is not None:
            entry["sessionId"] = session_id

        self._post_to_webhook(entry)

    def tls_failed_server(self, data: TlsData):
        """Log TLS server handshake failures (e.g. server rejected our connection)."""
        sni = data.context.server.address[0] if data.context.server and data.context.server.address else "unknown"
        if self._is_blocked(sni) or self._is_hidden(sni):
            return

        device_id, session_id = self._get_context()
        port = data.context.server.address[1] if data.context.server and data.context.server.address else 443

        error_detail = "server TLS handshake failed"
        if data.conn and hasattr(data.conn, 'error'):
            error_detail = str(data.conn.error) or error_detail

        entry = {
            "id": f"tls-fail-srv-{sni}-{port}",
            "request": {
                "method": "CONNECT",
                "url": f"https://{sni}:{port}/",
                "headers": {},
                "body": None,
            },
            "response": {
                "status": 0,
                "body": f"TLS handshake failed (server): {error_detail}",
            },
        }

        if device_id:
            entry["deviceId"] = device_id
        if session_id is not None:
            entry["sessionId"] = session_id

        self._post_to_webhook(entry)

    def _register_ws_flow(self, flow: http.HTTPFlow):
        """Create a WebSocket traffic entry from a 101 upgrade or first WS message."""
        if flow.id in self._registered_ws_flows:
            return
        try:
            self._reload_blocklist()
            self._reload_hiddenlist()
            host = flow.request.host
            url = flow.request.pretty_url
            if self._is_blocked(host) or self._is_blocked_by_url(url):
                return
            if self._is_hidden(host) or self._is_hidden_by_url(url):
                self._hidden_ws_flows.add(flow.id)
                return

            device_id, session_id = self._get_context()

            ws_url = url
            if ws_url.startswith("https://"):
                ws_url = "wss://" + ws_url[len("https://"):]
            elif ws_url.startswith("http://"):
                ws_url = "ws://" + ws_url[len("http://"):]

            data = {
                "flowId": flow.id,
                "url": ws_url,
                "headers": dict(flow.request.headers),
            }
            if device_id:
                data["deviceId"] = device_id
            if session_id is not None:
                data["sessionId"] = session_id

            self._post_to_ws_webhook("/ws-start", data)
            self._registered_ws_flows.add(flow.id)
            ctx.log.info(f"[DarkRide] WebSocket registered: {ws_url}")
        except Exception as e:
            ctx.log.error(f"[DarkRide] WebSocket registration error: {e}")

    async def response(self, flow: http.HTTPFlow):
        """Called when a response is received from the server."""
        if flow.response is None:
            return

        # WebSocket upgrade — register the flow for frame capture
        if flow.response.status_code == 101:
            self._register_ws_flow(flow)
            return

        # Safety net: reload and check blocklist here too, in case request() failed
        self._reload_blocklist()
        self._reload_hiddenlist()
        self._reload_hold_config()
        host = flow.request.host
        url = flow.request.pretty_url
        if self._is_blocked(host) or self._is_blocked_by_url(url):
            return
        # Hidden domains: traffic passes through but don't capture
        if self._is_hidden(host) or self._is_hidden_by_url(url):
            return

        # Intercept hooks — before body extraction/capture
        if ctx.options.intercept_hooks:
            try:
                try:
                    resp_body_raw = flow.response.get_text()
                except Exception:
                    resp_body_raw = None
                try:
                    parsed = urlparse(url)
                except Exception:
                    parsed = None
                device_id_hook, _ = self._get_context()
                intercept_data = {
                    "deviceId": device_id_hook or "",
                    "phase": "response",
                    "guid": flow.id,
                    "method": flow.request.method,
                    "url": url,
                    "hostname": host or (parsed.hostname if parsed else ""),
                    "path": parsed.path if parsed else "",
                    "headers": dict(flow.request.headers),
                    "body": None,
                    "status": flow.response.status_code,
                    "responseHeaders": dict(flow.response.headers),
                    "responseBody": resp_body_raw,
                }
                result = self._post_to_intercept(intercept_data)
                if self._apply_response_modifications(flow, result):
                    return  # blocked — skip capture
            except Exception as e:
                ctx.log.error(f"[DarkRide] response intercept hook error: {e}")

        # Interactive intercept ("breakpoints") — pause the response in-flight
        # for a manual verdict before it is captured/forwarded.
        if self._hold_matches(flow, "response"):
            await self._run_hold(flow, "response")

        # Apply intercept rules
        matched = self._match_rules(flow, "response")
        matched_rules_data = list(flow.metadata.get("matched_rules", []))
        for rule in matched:
            attribution = self._apply_actions(flow, rule, "response")
            if attribution["actionsApplied"]:
                matched_rules_data.append(attribution)
        if matched_rules_data:
            flow.metadata["matched_rules"] = matched_rules_data

        try:
            request_body = flow.request.get_text()
        except Exception:
            request_body = None

        try:
            response_body = flow.response.get_text()
        except Exception:
            response_body = None

        # Determine content type for truncation decisions
        resp_content_type = flow.response.headers.get("content-type", None)
        req_content_type = flow.request.headers.get("content-type", None)

        # Capture image binary data before truncation replaces it
        response_body_base64 = None
        if resp_content_type:
            ct_lower = resp_content_type.lower().split(";")[0].strip()
            for prefix in IMAGE_CONTENT_PREFIXES:
                if ct_lower.startswith(prefix):
                    raw_bytes = flow.response.get_content()
                    if raw_bytes and len(raw_bytes) <= MAX_IMAGE_BYTES:
                        response_body_base64 = base64.b64encode(raw_bytes).decode("ascii")
                    break

        request_body = _truncate_body(request_body, req_content_type)
        response_body = _truncate_body(response_body, resp_content_type)

        device_id, session_id = self._get_context()

        data = {
            "id": flow.id,
            "request": {
                "method": flow.request.method,
                "url": flow.request.pretty_url,
                "headers": dict(flow.request.headers),
                "body": request_body,
            },
            "response": {
                "status": flow.response.status_code,
                "headers": dict(flow.response.headers),
                "body": response_body,
                "bodyBase64": response_body_base64,
                "contentType": resp_content_type,
            },
        }

        # Per-request timing — forward the mitmproxy flow timestamps so the
        # backend can persist a real Duration + timing waterfall. Fully
        # best-effort: never breaks ingest if timestamps are missing.
        duration_ms, timings = _extract_timings(flow)
        data["durationMs"] = duration_ms
        if timings is not None:
            data["timings"] = timings

        if device_id:
            data["deviceId"] = device_id
        if session_id is not None:
            data["sessionId"] = session_id

        matched_rules_final = flow.metadata.get("matched_rules")
        if matched_rules_final:
            data["matchedRules"] = matched_rules_final

        self._post_to_webhook(data)

    def websocket_message(self, flow: http.HTTPFlow):
        """Called when a WebSocket message is received or sent."""
        try:
            if flow.id in self._hidden_ws_flows:
                return

            # Lazy init: if response() didn't register this flow yet, do it now
            if flow.id not in self._registered_ws_flows:
                self._register_ws_flow(flow)
                if flow.id in self._hidden_ws_flows:
                    return

            msg = flow.websocket.messages[-1]
            direction = "send" if msg.from_client else "receive"
            is_binary = not msg.is_text

            if is_binary:
                truncated = msg.content[:MAX_WS_PAYLOAD_BYTES]
                payload = base64.b64encode(truncated).decode("ascii")
            else:
                truncated = msg.content[:MAX_WS_PAYLOAD_BYTES]
                payload = truncated.decode("utf-8", errors="replace")

            device_id, session_id = self._get_context()

            data = {
                "flowId": flow.id,
                "direction": direction,
                "opcode": "binary" if is_binary else "text",
                "payload": payload,
                "isBinary": is_binary,
                "payloadSize": len(msg.content),
            }

            if device_id:
                data["deviceId"] = device_id
            if session_id is not None:
                data["sessionId"] = session_id

            self._post_to_ws_webhook("/ws-message", data)
        except Exception as e:
            ctx.log.error(f"[DarkRide] websocket_message hook error: {e}")

    def websocket_end(self, flow: http.HTTPFlow):
        """Called when a WebSocket connection is closed."""
        try:
            if flow.id in self._hidden_ws_flows:
                self._hidden_ws_flows.discard(flow.id)
                self._registered_ws_flows.discard(flow.id)
                return

            # Lazy init: ensure flow is registered even if no messages were exchanged
            if flow.id not in self._registered_ws_flows:
                self._register_ws_flow(flow)

            close_code = getattr(flow.websocket, "close_code", None)
            close_reason = getattr(flow.websocket, "close_reason", None)

            device_id, session_id = self._get_context()

            data = {
                "flowId": flow.id,
                "closeCode": close_code,
                "closeReason": close_reason,
                "messageCount": len(flow.websocket.messages),
            }

            if device_id:
                data["deviceId"] = device_id
            if session_id is not None:
                data["sessionId"] = session_id

            self._post_to_ws_webhook("/ws-end", data)
            self._registered_ws_flows.discard(flow.id)
            ctx.log.info(f"[DarkRide] WebSocket closed: {flow.request.pretty_url}")
        except Exception as e:
            ctx.log.error(f"[DarkRide] websocket_end hook error: {e}")


def load(loader):
    """Register custom options for mitmproxy."""
    loader.add_option(
        name="node_webhook",
        typespec=str,
        default="http://localhost:3000/v1/traffic/ingest",
        help="URL of the Node.js webhook endpoint for traffic capture",
    )
    loader.add_option(
        name="device_id",
        typespec=str,
        default="",
        help="DarkRide device ID to include in webhook payloads",
    )
    loader.add_option(
        name="session_id",
        typespec=str,
        default="",
        help="DarkRide automation session ID to include in webhook payloads",
    )
    loader.add_option(
        name="blocklist_file",
        typespec=str,
        default="",
        help="Path to JSON file containing blocked domain list",
    )
    loader.add_option(
        name="hiddenlist_file",
        typespec=str,
        default="",
        help="Path to JSON file containing hidden domain list",
    )
    loader.add_option(
        name="upstream_proxy_url",
        typespec=str,
        default="",
        help="HTTP CONNECT proxy URL (http://host:port) to route all outgoing connections through",
    )
    loader.add_option(
        name="tls_profile",
        typespec=str,
        default="default",
        help="TLS fingerprint profile: chrome, okhttp, or default (no spoofing)",
    )
    loader.add_option(
        name="intercept_hooks",
        typespec=bool,
        default=False,
        help="Enable real-time traffic interception hooks for automation scripts",
    )
    loader.add_option(
        name="intercept_config_file",
        typespec=str,
        default="",
        help="Path to intercept config JSON file containing rules and client certs",
    )
    loader.add_option(
        name="intercept_hold_config_file",
        typespec=str,
        default="",
        help="Path to interactive-intercept ('breakpoints') armed config JSON file",
    )


addons = [DarkRideAddon()]
