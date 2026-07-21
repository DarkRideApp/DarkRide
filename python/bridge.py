#!/usr/bin/env python3
"""
Python Bridge - uiautomator2 JSON-RPC service for DarkRide.

Provides a Flask-based JSON-RPC 2.0 server that interfaces with Android devices
via the uiautomator2 library.
"""

import argparse
import base64
import io
import json
import logging
import socket
import subprocess
import sys
import time
import traceback

from flask import Flask, request, jsonify

# Suppress Werkzeug per-request access logs
logging.getLogger('werkzeug').setLevel(logging.ERROR)

try:
    import uiautomator2 as u2
except ImportError:
    u2 = None

try:
    import frida
except ImportError:
    frida = None

app = Flask(__name__)
device = None
device_serial = None
atx_free = False
_cached_window_size = None  # (width, height)

# Frida state
_frida_device = None          # frida.core.Device (for list_apps only)
_frida_process = None         # subprocess.Popen — the `frida` CLI process
_frida_messages = []          # list of message dicts
_frida_message_lock = None    # threading.Lock, initialized in main()


# Error codes matching BridgeErrorCode enum in TypeScript
class ErrorCode:
    ELEMENT_NOT_FOUND = -32001
    TIMEOUT = -32002
    DEVICE_DISCONNECTED = -32003
    APP_NOT_INSTALLED = -32004
    PERMISSION_DENIED = -32005
    INVALID_REQUEST = -32600
    METHOD_NOT_FOUND = -32601
    INVALID_PARAMS = -32602
    FRIDA_NOT_AVAILABLE = -32010
    FRIDA_SERVER_NOT_RUNNING = -32011
    FRIDA_SPAWN_FAILED = -32012
    FRIDA_ATTACH_FAILED = -32013
    FRIDA_SCRIPT_ERROR = -32014


class BridgeError(Exception):
    def __init__(self, code, message, data=None):
        super().__init__(message)
        self.code = code
        self.data = data


_KEY_MAP = {
    'home': '3', 'back': '4', 'power': '26', 'menu': '82',
    'enter': '66', 'delete': '67', 'tab': '61', 'space': '62',
    'volume_up': '24', 'volume_down': '25', 'recent': '187',
}


def _adb_run(args, timeout=10):
    """Run an ADB shell command. Returns stdout string."""
    try:
        result = subprocess.run(
            ['adb', '-s', device_serial, 'shell'] + args,
            capture_output=True, text=True, timeout=timeout,
        )
        if result.returncode != 0:
            raise BridgeError(
                ErrorCode.DEVICE_DISCONNECTED,
                f"ADB command failed: {' '.join(args)}: {result.stderr.strip()}",
            )
        return result.stdout
    except subprocess.TimeoutExpired:
        raise BridgeError(ErrorCode.TIMEOUT, f"ADB command timed out: {' '.join(args)}")


def _adb_tap(x, y):
    _adb_run(['input', 'tap', str(int(x)), str(int(y))])


def _adb_long_press(x, y, duration_ms=1000):
    # input swipe from same point to same point = long press
    _adb_run(['input', 'swipe', str(int(x)), str(int(y)), str(int(x)), str(int(y)), str(int(duration_ms))])


def _adb_swipe(x1, y1, x2, y2, duration_ms=200):
    _adb_run(['input', 'swipe', str(int(x1)), str(int(y1)), str(int(x2)), str(int(y2)), str(int(duration_ms))])


def _adb_keyevent(key):
    code = _KEY_MAP.get(key)
    if code:
        _adb_run(['input', 'keyevent', code])
    else:
        # Try raw keycode or key name
        _adb_run(['input', 'keyevent', str(key)])


def _adb_text(text):
    """Input text via ADB. Escapes shell metacharacters."""
    # Replace spaces with %s (ADB input text convention)
    escaped = text.replace(' ', '%s')
    # Escape shell metacharacters
    for ch in ('\\', '"', "'", '`', '$', '&', '|', ';', '(', ')', '<', '>', '{', '}', '!', '~', '*', '?', '#'):
        escaped = escaped.replace(ch, '\\' + ch)
    _adb_run(['input', 'text', escaped])


def _get_window_size():
    """Get device window size, with caching."""
    global _cached_window_size
    if _cached_window_size:
        return _cached_window_size
    output = _adb_run(['wm', 'size'])
    # Parse "Physical size: 1080x1920"
    for line in output.strip().splitlines():
        if 'size:' in line.lower():
            parts = line.split(':')[-1].strip()
            w, h = parts.split('x')
            _cached_window_size = (int(w), int(h))
            return _cached_window_size
    raise BridgeError(ErrorCode.DEVICE_DISCONNECTED, f"Could not parse window size: {output}")


def build_selector(selector_dict):
    """Convert TypeScript Selector object to uiautomator2 kwargs."""
    mapping = {
        'text': 'text',
        'textContains': 'textContains',
        'textStartsWith': 'textStartsWith',
        'textMatches': 'textMatches',
        'resourceId': 'resourceId',
        'resourceIdMatches': 'resourceIdMatches',
        'className': 'className',
        'classNameMatches': 'classNameMatches',
        'description': 'description',
        'descriptionMatches': 'descriptionMatches',
        'clickable': 'clickable',
        'enabled': 'enabled',
        'index': 'index',
        'instance': 'instance',
    }

    kwargs = {}
    for ts_key, u2_key in mapping.items():
        if ts_key in selector_dict and selector_dict[ts_key] is not None:
            kwargs[u2_key] = selector_dict[ts_key]

    return kwargs


def get_element(selector_dict, timeout_ms=5000):
    """Find a UI element using selector, raising BridgeError if not found."""
    kwargs = build_selector(selector_dict)
    timeout_sec = timeout_ms / 1000

    element = device(**kwargs)
    if not element.wait(timeout=timeout_sec):
        raise BridgeError(
            ErrorCode.ELEMENT_NOT_FOUND,
            "Element not found",
            {"selector": selector_dict, "timeout": timeout_ms}
        )
    return element


def dom_node_to_dict(node):
    """Convert a uiautomator2 XML node to our DOMNode dict format."""
    if node is None:
        return None

    attrib = node.attrib if hasattr(node, 'attrib') else {}
    bounds_str = attrib.get('bounds', '[0,0][0,0]')

    # Parse bounds string like [0,0][100,200]
    bounds = [0, 0, 0, 0]
    try:
        parts = bounds_str.replace('][', ',').replace('[', '').replace(']', '')
        coords = parts.split(',')
        if len(coords) == 4:
            bounds = [int(c) for c in coords]
    except (ValueError, IndexError):
        pass

    children = []
    for child in node:
        child_dict = dom_node_to_dict(child)
        if child_dict:
            children.append(child_dict)

    return {
        'className': attrib.get('class', ''),
        'text': attrib.get('text', ''),
        'resourceId': attrib.get('resource-id', ''),
        'description': attrib.get('content-desc', ''),
        'bounds': bounds,
        'clickable': attrib.get('clickable', 'false') == 'true',
        'enabled': attrib.get('enabled', 'true') == 'true',
        'children': children,
    }


# ---- RPC Handlers ----

def handle_click(params):
    if atx_free:
        raise BridgeError(ErrorCode.ELEMENT_NOT_FOUND, "ATX-free mode: use DOM fallback")
    selector = params.get('selector', {})
    timeout = params.get('timeout', 5000)
    element = get_element(selector, timeout)
    element.click()
    return {"success": True}


def handle_long_click(params):
    if atx_free:
        raise BridgeError(ErrorCode.ELEMENT_NOT_FOUND, "ATX-free mode: use DOM fallback")
    selector = params.get('selector', {})
    duration = params.get('duration', 1000)
    timeout = params.get('timeout', 5000)
    element = get_element(selector, timeout)
    element.long_click(duration=duration / 1000)
    return {"success": True}


def handle_set_text(params):
    if atx_free:
        raise BridgeError(ErrorCode.ELEMENT_NOT_FOUND, "ATX-free mode: use DOM fallback")
    selector = params.get('selector', {})
    text = params.get('text', '')
    timeout = params.get('timeout', 5000)
    element = get_element(selector, timeout)
    element.set_text(text)
    return {"success": True}


def handle_get_text(params):
    if atx_free:
        raise BridgeError(ErrorCode.ELEMENT_NOT_FOUND, "ATX-free mode: use DOM fallback")
    selector = params.get('selector', {})
    timeout = params.get('timeout', 5000)
    element = get_element(selector, timeout)
    return {"text": element.get_text()}


def handle_exists(params):
    selector = params.get('selector', {})
    timeout = params.get('timeout', 0)
    kwargs = build_selector(selector)
    element = device(**kwargs)
    exists = element.wait(timeout=timeout / 1000) if timeout > 0 else element.exists()
    return {"exists": bool(exists)}


def handle_wait_for(params):
    selector = params.get('selector', {})
    timeout = params.get('timeout', 10000)
    kwargs = build_selector(selector)
    element = device(**kwargs)
    if not element.wait(timeout=timeout / 1000):
        raise BridgeError(
            ErrorCode.TIMEOUT,
            "Timed out waiting for element",
            {"selector": selector, "timeout": timeout}
        )
    return {"success": True}


def handle_scroll(params):
    direction = params.get('direction', 'down')
    percent = params.get('percent', 50)

    if atx_free:
        w, h = _get_window_size()
        cx = w // 2
        cy = h // 2
        # Constrain swipe to middle 70% of screen to avoid status/nav bars
        safe_top = int(h * 0.15)
        safe_bottom = int(h * 0.85)
        safe_range = safe_bottom - safe_top
        scroll_dist = int(safe_range * percent / 100)
        # Use 500ms duration for a natural scroll gesture (too fast = fling)
        dur = 500
        if direction == 'down':
            start_y = min(safe_bottom, cy + scroll_dist // 2)
            end_y = max(safe_top, start_y - scroll_dist)
            _adb_swipe(cx, start_y, cx, end_y, dur)
        elif direction == 'up':
            start_y = max(safe_top, cy - scroll_dist // 2)
            end_y = min(safe_bottom, start_y + scroll_dist)
            _adb_swipe(cx, start_y, cx, end_y, dur)
        elif direction == 'left':
            scroll_dist = int(w * percent / 100)
            _adb_swipe(cx + scroll_dist // 2, cy, cx - scroll_dist // 2, cy, dur)
        elif direction == 'right':
            scroll_dist = int(w * percent / 100)
            _adb_swipe(cx - scroll_dist // 2, cy, cx + scroll_dist // 2, cy, dur)
    else:
        if direction == 'down':
            device.swipe_ext("up", scale=percent / 100)
        elif direction == 'up':
            device.swipe_ext("down", scale=percent / 100)
        elif direction == 'left':
            device.swipe_ext("right", scale=percent / 100)
        elif direction == 'right':
            device.swipe_ext("left", scale=percent / 100)

    return {"success": True}


def handle_scroll_to_element(params):
    selector = params.get('selector', {})
    max_scrolls = params.get('maxScrolls', 5)
    kwargs = build_selector(selector)

    for i in range(max_scrolls):
        element = device(**kwargs)
        if element.exists():
            return {"success": True, "scrolls": i}
        device.swipe_ext("up", scale=0.8)

    raise BridgeError(
        ErrorCode.ELEMENT_NOT_FOUND,
        f"Element not found after {max_scrolls} scrolls",
        {"selector": selector, "maxScrolls": max_scrolls}
    )


def _find_app_window(root):
    """Find the app window node, filtering out system UI (com.android.systemui).

    The hierarchy root typically has child <node> elements for each window.
    We return the first non-systemui window, falling back to root if none found.
    """
    SYSTEM_PACKAGES = {'com.android.systemui'}

    children = list(root)
    if not children:
        return root

    # Check if root children are window-level nodes (have package attribute)
    window_nodes = [c for c in children if c.attrib.get('package')]
    if not window_nodes:
        return root

    # Prefer the non-system-UI window
    for node in window_nodes:
        if node.attrib.get('package') not in SYSTEM_PACKAGES:
            return node

    # All windows are system UI — return root as-is
    return root


def _get_webview_dom_js():
    """Return JavaScript that walks the visible DOM and returns a filtered tree."""
    return """
(function() {
    var MAX_DEPTH = 15;
    var MAX_NODES = 500;
    var nodeCount = 0;

    var CLICKABLE_TAGS = {A:1, BUTTON:1, INPUT:1, SELECT:1, TEXTAREA:1};

    function isVisible(el) {
        if (!el.getBoundingClientRect) return false;
        var r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return false;
        var s = window.getComputedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
        return true;
    }

    function isClickable(el) {
        if (CLICKABLE_TAGS[el.tagName]) return true;
        if (el.getAttribute('role') === 'button') return true;
        if (el.getAttribute('onclick')) return true;
        return false;
    }

    function walk(el, depth) {
        if (!el || depth > MAX_DEPTH || nodeCount >= MAX_NODES) return null;
        if (el.nodeType !== 1) return null;
        if (!isVisible(el)) return null;

        nodeCount++;
        var rect = el.getBoundingClientRect();
        var tag = el.tagName.toLowerCase();
        var text = '';
        // Only get direct text content for leaf-ish nodes
        if (el.childElementCount === 0) {
            text = (el.innerText || el.value || '').trim().substring(0, 200);
        }

        var children = [];
        for (var i = 0; i < el.children.length; i++) {
            var c = walk(el.children[i], depth + 1);
            if (c) children.push(c);
        }

        // Skip empty structural nodes (no text, no id, no children with content)
        if (!text && !el.id && children.length === 0 &&
            !CLICKABLE_TAGS[el.tagName] && el.getAttribute('role') !== 'button') {
            return null;
        }

        return {
            className: 'web.' + tag,
            text: text,
            resourceId: el.id || '',
            description: el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') || '',
            bounds: [rect.left, rect.top, rect.right, rect.bottom],
            clickable: isClickable(el),
            enabled: !el.disabled,
            source: 'webview',
            children: children
        };
    }

    var tree = walk(document.body, 0);
    return {
        tree: tree,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight
    };
})()
"""


def _extract_webview_dom(serial, wv_bounds):
    """Extract DOM from a debuggable WebView via Chrome DevTools Protocol.

    Args:
        serial: ADB device serial
        wv_bounds: [x1, y1, x2, y2] of the WebView element on screen

    Returns:
        List of DOMNode dicts to graft as children, or empty list on failure.
    """
    import urllib.request

    try:
        import websocket as ws_mod
    except ImportError:
        print("[CDP] websocket-client not installed, skipping WebView enrichment", flush=True)
        return []

    forwarded = []

    try:
        # Discover devtools sockets — try normal shell first, then root
        unix_output = device.shell("cat /proc/net/unix").output
        socket_names = []
        for line in unix_output.splitlines():
            line = line.strip()
            if 'devtools_remote' in line:
                parts = line.split()
                if parts:
                    name = parts[-1]
                    if name.startswith('@'):
                        name = name[1:]
                    socket_names.append(name)

        # Try with root if no sockets found (some devices hide them from shell user)
        if not socket_names:
            try:
                root_output = device.shell("su -c 'cat /proc/net/unix'").output
                for line in root_output.splitlines():
                    line = line.strip()
                    if 'devtools_remote' in line:
                        parts = line.split()
                        if parts:
                            name = parts[-1]
                            if name.startswith('@'):
                                name = name[1:]
                            socket_names.append(name)
                if socket_names:
                    print(f"[CDP] Found sockets via root that shell user couldn't see", flush=True)
            except Exception:
                pass

        if not socket_names:
            print("[CDP] No devtools_remote sockets found (checked both shell and root)", flush=True)
            return []

        socket_names = list(dict.fromkeys(socket_names))
        print(f"[CDP] Found {len(socket_names)} devtools socket(s): {socket_names}", flush=True)

        for sock_name in socket_names:
            # Find a free local port. Bind to loopback only — the socket
            # exists for the kernel to assign a port and is closed immediately;
            # binding to all interfaces ('') would briefly expose it.
            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            s.bind(('127.0.0.1', 0))
            local_port = s.getsockname()[1]
            s.close()

            try:
                subprocess.run(
                    ['adb', '-s', serial, 'forward',
                     f'tcp:{local_port}', f'localabstract:{sock_name}'],
                    check=True, capture_output=True, timeout=5,
                )
                forwarded.append(local_port)
            except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as e:
                print(f"[CDP] Port forward failed for {sock_name}: {e}", flush=True)
                continue

            # Query CDP /json for pages
            try:
                req = urllib.request.Request(
                    f'http://localhost:{local_port}/json',
                    headers={'Accept': 'application/json'},
                )
                with urllib.request.urlopen(req, timeout=3) as resp:
                    pages = json.loads(resp.read().decode('utf-8'))
            except Exception as e:
                print(f"[CDP] Failed to query /json on port {local_port}: {e}", flush=True)
                continue

            print(f"[CDP] Found {len(pages)} page(s) on socket {sock_name}", flush=True)

            for page in pages:
                debugger_url = page.get('webSocketDebuggerUrl')
                if not debugger_url:
                    continue

                # The debugger URL uses the forwarded port already
                # but may reference a different host — normalize it
                if 'localhost' not in debugger_url and '127.0.0.1' not in debugger_url:
                    from urllib.parse import urlparse, urlunparse
                    parsed = urlparse(debugger_url)
                    debugger_url = urlunparse(parsed._replace(
                        netloc=f'localhost:{local_port}'))

                print(f"[CDP] Connecting to {debugger_url}", flush=True)

                try:
                    ws = ws_mod.create_connection(debugger_url, timeout=5)
                    try:
                        msg = json.dumps({
                            'id': 1,
                            'method': 'Runtime.evaluate',
                            'params': {
                                'expression': _get_webview_dom_js(),
                                'returnByValue': True,
                            }
                        })
                        ws.send(msg)
                        response = json.loads(ws.recv())
                    finally:
                        ws.close()

                    result_obj = response.get('result', {}).get('result', {})
                    if result_obj.get('type') == 'undefined' or 'exceptionDetails' in response.get('result', {}):
                        print(f"[CDP] JS evaluation returned no value or threw", flush=True)
                        continue

                    value = result_obj.get('value')
                    if not value or not value.get('tree'):
                        print(f"[CDP] No tree in evaluation result", flush=True)
                        continue

                    tree = value['tree']
                    vp_width = value.get('viewportWidth', 1)
                    vp_height = value.get('viewportHeight', 1)

                    wv_x1, wv_y1, wv_x2, wv_y2 = wv_bounds
                    wv_w = wv_x2 - wv_x1
                    wv_h = wv_y2 - wv_y1
                    scale_x = wv_w / vp_width if vp_width > 0 else 1
                    scale_y = wv_h / vp_height if vp_height > 0 else 1

                    def translate_bounds(node):
                        """Recursively translate CSS bounds to device screen coordinates."""
                        b = node.get('bounds', [0, 0, 0, 0])
                        node['bounds'] = [
                            int(wv_x1 + b[0] * scale_x),
                            int(wv_y1 + b[1] * scale_y),
                            int(wv_x1 + b[2] * scale_x),
                            int(wv_y1 + b[3] * scale_y),
                        ]
                        for child in node.get('children', []):
                            translate_bounds(child)

                    translate_bounds(tree)

                    child_count = len(tree.get('children', []))
                    print(f"[CDP] Successfully extracted WebView DOM ({child_count} top-level children)", flush=True)

                    children = tree.get('children', [])
                    if not children:
                        return [tree]
                    return children

                except Exception as e:
                    print(f"[CDP] WebSocket/evaluation error: {e}", flush=True)
                    continue

    except Exception as e:
        print(f"[CDP] Unexpected error in _extract_webview_dom: {e}", flush=True)
    finally:
        for port in forwarded:
            try:
                subprocess.run(
                    ['adb', '-s', serial, 'forward', '--remove', f'tcp:{port}'],
                    capture_output=True, timeout=5,
                )
            except Exception:
                pass

    return []


def _has_only_webview_children(node_dict):
    """Check if a WebView node's children are only other WebView nodes or empty.

    uiautomator2 often nests a WebView inside another WebView with just a title
    (e.g. text="ONEID UI MOBILE") but no actual page content. These should still
    be enriched via CDP.
    """
    children = node_dict.get('children', [])
    if not children:
        return True
    for child in children:
        child_class = child.get('className', '')
        if 'WebView' not in child_class:
            return False
    return True


def _enrich_webview_nodes(node_dict):
    """Recursively scan for WebView nodes and enrich them with CDP DOM content."""
    class_name = node_dict.get('className', '')

    if 'WebView' in class_name and _has_only_webview_children(node_dict):
        bounds = node_dict.get('bounds', [0, 0, 0, 0])
        print(f"[CDP] Found WebView node to enrich: bounds={bounds}", flush=True)
        # Only attempt if bounds are non-trivial
        if bounds[2] > bounds[0] and bounds[3] > bounds[1]:
            try:
                webview_children = _extract_webview_dom(device_serial, bounds)
                if webview_children:
                    node_dict['children'] = webview_children
                    return  # Don't recurse into enriched children
                else:
                    print("[CDP] No children returned from CDP extraction", flush=True)
            except Exception as e:
                print(f"[CDP] Enrichment failed: {e}", flush=True)

    for child in node_dict.get('children', []):
        _enrich_webview_nodes(child)


def _dump_hierarchy_via_adb():
    """Dump UI hierarchy using direct ADB subprocess — same method as the Capture DOM button.

    Uses subprocess to call 'adb shell uiautomator dump' directly, bypassing u2's
    ATX agent entirely. The ATX agent holds the uiautomator lock, so we must stop
    it first, run the dump, then restart it.

    In ATX-free mode, ATX is already stopped so we can dump directly without the
    stop/restart cycle — this is the key performance optimization.
    """
    import time

    # Fast path: ATX-free mode — ATX is already stopped, dump directly
    if atx_free:
        # Try /dev/tty first — pipes XML directly to stdout, avoids temp file I/O
        try:
            result = subprocess.run(
                ['adb', '-s', device_serial, 'exec-out', 'uiautomator', 'dump', '/dev/tty'],
                capture_output=True, text=True, timeout=15,
            )
            output = result.stdout
            if output:
                xml_start = output.find('<?xml')
                if xml_start == -1:
                    xml_start = output.find('<hierarchy')
                if xml_start >= 0:
                    # Strip trailing junk after closing </hierarchy> tag
                    xml_end = output.find('</hierarchy>', xml_start)
                    if xml_end >= 0:
                        return output[xml_start:xml_end + len('</hierarchy>')]
                    return output[xml_start:]
        except Exception:
            pass  # Fall through to tmpfile approach

        # Fallback: temp file approach (works on all Android versions)
        tmp_path = f'/data/local/tmp/darkride_dom_{int(time.time() * 1000)}.xml'
        try:
            result = subprocess.run(
                ['adb', '-s', device_serial, 'shell',
                 f'uiautomator dump {tmp_path} && cat {tmp_path} && rm -f {tmp_path}'],
                capture_output=True, text=True, timeout=15,
            )
            output = result.stdout
            if not output:
                return None
            xml_start = output.find('<?xml')
            if xml_start == -1:
                xml_start = output.find('<hierarchy')
            if xml_start == -1:
                return None
            return output[xml_start:]
        except Exception as e:
            print(f"[getDOM] ATX-free ADB dump failed: {e}", flush=True)
            return None

    # Normal path: may need to stop/restart ATX
    tmp_path = f'/sdcard/darkride_dom_{int(time.time() * 1000)}.xml'
    stopped_atx = False
    try:
        # First try without stopping ATX (works when no bridge is connected)
        dump_result = subprocess.run(
            ['adb', '-s', device_serial, 'shell', f'uiautomator dump {tmp_path}'],
            capture_output=True, text=True, timeout=10,
        )

        # If dump failed (ATX holds the lock), stop ATX and retry
        if dump_result.returncode != 0 or 'error' in dump_result.stdout.lower() or 'error' in dump_result.stderr.lower():
            print("[getDOM] ADB dump failed (ATX lock), stopping uiautomator to retry", flush=True)
            try:
                device.stop_uiautomator()
                stopped_atx = True
            except Exception as e:
                print(f"[getDOM] Failed to stop uiautomator: {e}", flush=True)

            dump_result = subprocess.run(
                ['adb', '-s', device_serial, 'shell', f'uiautomator dump {tmp_path}'],
                capture_output=True, text=True, timeout=10,
            )

        result = subprocess.run(
            ['adb', '-s', device_serial, 'shell', f'cat {tmp_path}'],
            capture_output=True, text=True, timeout=10,
        )
        xml_str = result.stdout
        if not xml_str or (not xml_str.strip().startswith('<?xml') and not xml_str.strip().startswith('<')):
            return None
        return xml_str
    except Exception as e:
        print(f"[getDOM] Direct ADB dump failed: {e}", flush=True)
        return None
    finally:
        # Clean up temp file
        try:
            subprocess.run(
                ['adb', '-s', device_serial, 'shell', f'rm -f {tmp_path}'],
                capture_output=True, timeout=5,
            )
        except Exception:
            pass
        # Restart ATX if we stopped it
        if stopped_atx:
            try:
                device.start_uiautomator()
                print("[getDOM] Restarted uiautomator after ADB dump", flush=True)
            except Exception as e:
                print(f"[getDOM] Failed to restart uiautomator: {e}", flush=True)


def handle_get_dom(params):
    try:
        import xml.etree.ElementTree as ET

        # Use direct ADB uiautomator dump — same method as the Capture DOM button
        xml_str = _dump_hierarchy_via_adb()

        # Fall back to u2's dump_hierarchy only if direct ADB fails
        if not xml_str:
            print("[getDOM] Falling back to u2 dump_hierarchy", flush=True)
            xml_str = device.dump_hierarchy(compressed=False)

        root = ET.fromstring(xml_str)
        app_root = _find_app_window(root)
        dom = dom_node_to_dict(app_root)

        # Only enrich WebView nodes when explicitly requested (saves 1-3s per fetch)
        if params.get('enrichWebViews', False):
            _enrich_webview_nodes(dom)

        return dom
    except Exception as e:
        raise BridgeError(ErrorCode.TIMEOUT, f"Failed to get DOM: {str(e)}")


def handle_screenshot(params):
    try:
        if atx_free:
            result = subprocess.run(
                ['adb', '-s', device_serial, 'exec-out', 'screencap', '-p'],
                capture_output=True, timeout=15,
            )
            if result.returncode != 0 or not result.stdout:
                raise BridgeError(ErrorCode.DEVICE_DISCONNECTED, "ADB screencap failed")
            b64 = base64.b64encode(result.stdout).decode('utf-8')
            return {"base64": b64}
        else:
            img = device.screenshot()
            buffer = io.BytesIO()
            img.save(buffer, format='PNG')
            b64 = base64.b64encode(buffer.getvalue()).decode('utf-8')
            return {"base64": b64}
    except BridgeError:
        raise
    except Exception as e:
        raise BridgeError(ErrorCode.DEVICE_DISCONNECTED, f"Screenshot failed: {str(e)}")


def handle_get_app_info(params):
    package_name = params.get('packageName')
    if not package_name:
        raise BridgeError(ErrorCode.INVALID_PARAMS, "packageName is required")

    try:
        info = device.app_info(package_name)
        return {
            "packageName": info.get('packageName', package_name),
            "name": info.get('label', ''),
            "versionCode": info.get('versionCode', 0),
            "versionName": info.get('versionName', ''),
            "apkPath": info.get('mainActivity', ''),
        }
    except Exception as e:
        raise BridgeError(
            ErrorCode.APP_NOT_INSTALLED,
            f"App not found: {package_name}",
            {"packageName": package_name}
        )


def handle_start_app(params):
    package_name = params.get('packageName')
    activity = params.get('activity')
    if not package_name:
        raise BridgeError(ErrorCode.INVALID_PARAMS, "packageName is required")

    try:
        if atx_free:
            if activity:
                _adb_run(['am', 'start', '-n', f'{package_name}/{activity}'])
            else:
                _adb_run(['monkey', '-p', package_name, '-c',
                         'android.intent.category.LAUNCHER', '1'])
        else:
            if activity:
                device.app_start(package_name, activity)
            else:
                device.app_start(package_name)
        return {"success": True}
    except BridgeError:
        raise
    except Exception as e:
        raise BridgeError(ErrorCode.APP_NOT_INSTALLED, f"Failed to start app: {str(e)}")


def handle_stop_app(params):
    package_name = params.get('packageName')
    if not package_name:
        raise BridgeError(ErrorCode.INVALID_PARAMS, "packageName is required")

    if atx_free:
        _adb_run(['am', 'force-stop', package_name])
    else:
        device.app_stop(package_name)
    return {"success": True}


def handle_press_key(params):
    key = params.get('key')
    if not key:
        raise BridgeError(ErrorCode.INVALID_PARAMS, "key is required")

    if atx_free:
        _adb_keyevent(key)
    else:
        device.press(key)
    return {"success": True}


def handle_swipe(params):
    start_x = params.get('startX', 0)
    start_y = params.get('startY', 0)
    end_x = params.get('endX', 0)
    end_y = params.get('endY', 0)
    duration = params.get('duration', 200)

    if atx_free:
        _adb_swipe(start_x, start_y, end_x, end_y, duration)
    else:
        device.swipe(start_x, start_y, end_x, end_y, duration=duration / 1000)
    return {"success": True}


def _is_keyguard_showing():
    """Check if lock screen / keyguard is currently displayed."""
    try:
        window_state = _adb_run(['dumpsys', 'window'], timeout=5)
        return any(marker in window_state for marker in [
            'mDreamingLockscreen=true',
            'mShowingLockscreen=true',
            'mKeyguardShowing=true',
            'isKeyguardShowing=true',
            'statusBarKeyguardShowing=true',
        ])
    except Exception:
        return False


def handle_wake_and_unlock(params):
    """Wake the screen and dismiss the lock screen using multiple strategies."""
    import time
    try:
        # Check if screen is already on and unlocked — skip if so
        power_state = _adb_run(['dumpsys', 'power'], timeout=5)
        screen_on = 'Display Power: state=ON' in power_state

        if screen_on and not _is_keyguard_showing():
            return {"success": True, "skipped": True}

        # Wake screen
        if atx_free:
            _adb_keyevent('224')  # KEYCODE_WAKEUP
        else:
            device.screen_on()
        time.sleep(0.5)

        if not _is_keyguard_showing():
            return {"success": True, "method": "wake_only"}

        # Strategy 1: wm dismiss-keyguard (Android 8+, most reliable)
        try:
            _adb_run(['wm', 'dismiss-keyguard'], timeout=3)
            time.sleep(0.5)
            if not _is_keyguard_showing():
                return {"success": True, "method": "dismiss-keyguard"}
        except Exception:
            pass

        # Strategy 2: KEYCODE_MENU (82) — standard keyguard dismiss
        _adb_keyevent('82')
        time.sleep(0.5)
        if not _is_keyguard_showing():
            return {"success": True, "method": "keycode_menu"}

        # Strategy 3: swipe up (for swipe-to-unlock screens)
        w, h = _get_window_size() if atx_free else (device.window_size()[0], device.window_size()[1])
        if atx_free:
            _adb_swipe(w // 2, int(h * 0.8), w // 2, int(h * 0.2), 300)
        else:
            device.swipe(w // 2, int(h * 0.8), w // 2, int(h * 0.2), duration=0.3)
        time.sleep(0.5)

        # Retry swipe if still locked (may have hit notification shade)
        if _is_keyguard_showing():
            if atx_free:
                _adb_swipe(w // 2, int(h * 0.8), w // 2, int(h * 0.2), 300)
            else:
                device.swipe(w // 2, int(h * 0.8), w // 2, int(h * 0.2), duration=0.3)
            time.sleep(0.5)

        return {"success": True, "method": "swipe"}
    except BridgeError:
        raise
    except Exception as e:
        raise BridgeError(ErrorCode.DEVICE_DISCONNECTED, f"Failed to wake/unlock: {str(e)}")


def handle_get_web_view_info(params):
    """Discover debuggable WebViews via ADB and query CDP /json for page info."""
    import socket
    import subprocess
    import urllib.request

    pages = []
    forwarded = []  # (local_port, socket_name) pairs to clean up

    try:
        # Find devtools sockets from /proc/net/unix
        unix_output = device.shell("cat /proc/net/unix").output
        socket_names = []
        for line in unix_output.splitlines():
            line = line.strip()
            if 'devtools_remote' in line:
                # Last field is the socket path; extract the name after @
                parts = line.split()
                if parts:
                    name = parts[-1]
                    if name.startswith('@'):
                        name = name[1:]
                    socket_names.append(name)

        if not socket_names:
            return {"pages": []}

        # Deduplicate
        socket_names = list(dict.fromkeys(socket_names))

        for sock_name in socket_names:
            # Find a free local port. Bind to loopback only — the socket
            # exists for the kernel to assign a port and is closed immediately;
            # binding to all interfaces ('') would briefly expose it.
            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            s.bind(('127.0.0.1', 0))
            local_port = s.getsockname()[1]
            s.close()

            # Forward local port to the abstract socket on device
            try:
                subprocess.run(
                    ['adb', '-s', device_serial, 'forward',
                     f'tcp:{local_port}', f'localabstract:{sock_name}'],
                    check=True, capture_output=True, timeout=5,
                )
                forwarded.append((local_port, sock_name))
            except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
                continue

            # Query CDP /json endpoint
            try:
                req = urllib.request.Request(
                    f'http://localhost:{local_port}/json',
                    headers={'Accept': 'application/json'},
                )
                with urllib.request.urlopen(req, timeout=3) as resp:
                    data = json.loads(resp.read().decode('utf-8'))
                    for entry in data:
                        pages.append({
                            'url': entry.get('url', ''),
                            'title': entry.get('title', ''),
                            'webSocketDebuggerUrl': entry.get('webSocketDebuggerUrl', None),
                        })
            except Exception:
                # Socket not responding or not a CDP endpoint — skip
                continue

    finally:
        # Clean up all forwarded ports
        for local_port, _ in forwarded:
            try:
                subprocess.run(
                    ['adb', '-s', device_serial, 'forward', '--remove',
                     f'tcp:{local_port}'],
                    capture_output=True, timeout=5,
                )
            except Exception:
                pass

    return {"pages": pages}


def handle_tap_at(params):
    """Tap at specific screen coordinates."""
    x = params.get('x', 0)
    y = params.get('y', 0)
    if atx_free:
        _adb_tap(x, y)
    else:
        device.click(x, y)
    return {"success": True}


def handle_long_click_at(params):
    """Long-press at specific screen coordinates."""
    x = params.get('x', 0)
    y = params.get('y', 0)
    duration = params.get('duration', 1000)
    if atx_free:
        _adb_long_press(x, y, duration)
    else:
        device.long_click(x, y, duration / 1000)
    return {"success": True}


def handle_enable_webview_debug(params):
    """Try to enable WebView debugging on a rooted device.

    Attempts multiple root-based methods to enable Chrome DevTools Protocol
    for WebViews. Returns which methods succeeded.
    """
    results = {}

    # Method 1: Set the chromium command-line flag for all WebViews
    try:
        device.shell("su -c 'echo \"chrome --enable-remote-debugging\" > /data/local/tmp/webview-command-line'")
        device.shell("su -c 'chmod 644 /data/local/tmp/webview-command-line'")
        results['webview_command_line'] = True
        print("[WebView Debug] Set webview-command-line flag", flush=True)
    except Exception as e:
        results['webview_command_line'] = str(e)

    # Method 2: Set the flag file that Chrome/WebView reads
    try:
        device.shell("su -c 'echo \"_ --enable-remote-debugging\" > /data/local/tmp/chrome-command-line'")
        device.shell("su -c 'chmod 644 /data/local/tmp/chrome-command-line'")
        results['chrome_command_line'] = True
        print("[WebView Debug] Set chrome-command-line flag", flush=True)
    except Exception as e:
        results['chrome_command_line'] = str(e)

    # Method 3: Try to set system property
    try:
        device.shell("su -c 'setprop persist.webview.chromium.enable_remote_debugging true'")
        results['system_property'] = True
        print("[WebView Debug] Set system property", flush=True)
    except Exception as e:
        results['system_property'] = str(e)

    # Check if sockets appear now (app may need restart)
    try:
        unix_output = device.shell("su -c 'cat /proc/net/unix'").output
        has_sockets = 'devtools_remote' in unix_output
        results['sockets_found_after'] = has_sockets
        if not has_sockets:
            results['note'] = 'No sockets yet. Try force-stopping and reopening the app.'
    except Exception:
        pass

    return results


def handle_set_atx_free(params):
    """Toggle ATX-free mode: keep ATX stopped for the entire automation run."""
    global atx_free, _cached_window_size
    enabled = params.get('enabled', False)

    if enabled:
        # Cache window size before stopping ATX
        _get_window_size()
        try:
            device.stop_uiautomator()
            print("[ATX-free] Stopped uiautomator, ATX-free mode enabled", flush=True)
        except Exception as e:
            print(f"[ATX-free] Failed to stop uiautomator: {e}", flush=True)
        atx_free = True
    else:
        atx_free = False
        _cached_window_size = None
        try:
            device.start_uiautomator()
            print("[ATX-free] Restarted uiautomator, ATX-free mode disabled", flush=True)
        except Exception as e:
            print(f"[ATX-free] Failed to restart uiautomator: {e}", flush=True)

    return {"success": True, "atxFree": atx_free}


def handle_input_text(params):
    """Direct text input — uses ADB in ATX-free mode, u2 otherwise."""
    text = params.get('text', '')
    if atx_free:
        _adb_text(text)
    else:
        device.send_keys(text)
    return {"success": True}


def handle_get_current_app_id(params):
    try:
        info = device.app_current()
        return info.get('package', '')
    except Exception as e:
        raise BridgeError(ErrorCode.DEVICE_DISCONNECTED, f"Failed to get current app: {str(e)}")


def handle_device_info(params):
    try:
        info = device.info
        wm_size = device.window_size()
        battery = device.shell("dumpsys battery | grep level").output.strip()
        battery_level = 100
        if "level:" in battery:
            try:
                battery_level = int(battery.split("level:")[1].strip())
            except (ValueError, IndexError):
                pass

        return {
            "serial": device_serial,
            "model": info.get('productName', ''),
            "brand": info.get('brand', ''),
            "androidVersion": info.get('version', ''),
            "sdkVersion": info.get('sdkInt', 0),
            "screenSize": {"width": wm_size[0], "height": wm_size[1]},
            "batteryLevel": battery_level,
        }
    except Exception as e:
        raise BridgeError(ErrorCode.DEVICE_DISCONNECTED, f"Failed to get device info: {str(e)}")


# ---- Frida helpers ----

def _ensure_frida():
    if frida is None:
        raise BridgeError(ErrorCode.FRIDA_NOT_AVAILABLE, "frida package not installed")

def _get_frida_device():
    global _frida_device
    _ensure_frida()
    if _frida_device is None:
        try:
            # Try to find the specific device by ADB serial first (handles multi-device setups)
            devices = frida.enumerate_devices()
            for dev in devices:
                if dev.id == device_serial:
                    _frida_device = dev
                    print(f"[DarkRide] Frida device matched by serial: {dev.id} ({dev.name})", file=sys.stderr, flush=True)
                    return _frida_device
            # Fallback: try get_usb_device (single device setups)
            _frida_device = frida.get_usb_device(timeout=5)
            print(f"[DarkRide] Frida USB device: {_frida_device.id} ({_frida_device.name})", file=sys.stderr, flush=True)
        except Exception as e:
            raise BridgeError(ErrorCode.FRIDA_NOT_AVAILABLE, f"No USB device found: {e}")
    return _frida_device

def _frida_cli_path():
    """Return the path to the `frida` CLI tool in the venv."""
    import os
    is_win = sys.platform == 'win32'
    base = os.path.join(os.getcwd(), '.venv', 'Scripts' if is_win else 'bin')
    name = 'frida.exe' if is_win else 'frida'
    p = os.path.join(base, name)
    if not os.path.isfile(p):
        raise BridgeError(ErrorCode.FRIDA_NOT_AVAILABLE, f"frida CLI not found at {p}")
    return p

def _append_frida_message(msg_type, payload):
    import datetime
    with _frida_message_lock:
        _frida_messages.append({
            'timestamp': datetime.datetime.now().isoformat(),
            'type': msg_type,
            'payload': payload,
        })

def _frida_output_reader(proc):
    """Read stdout from the frida CLI process line by line, populating messages."""
    import re
    # Skip Frida banner lines and REPL noise
    _banner_patterns = re.compile(
        r'^\s*(____\s*$|[/|>]\s*[_(]\s*|/_/\s*\|_\||'
        r'\.\s+\.\s+\.\s+\.|Commands:|help\s+->|object\?|exit/quit|More info at|'
        r'Frida \d+\.\d+|Connected to |Spawning |Spawned |Resuming main thread)',
    )
    # Strip REPL prompt like "[DEVICE::APP ]-> "
    _prompt_re = re.compile(r'^\[.*?\]->\s*')
    try:
        for raw_line in proc.stdout:
            line = raw_line.rstrip('\n\r')
            if not line:
                continue
            # Skip banner/noise
            if _banner_patterns.search(line):
                print(f"[DarkRide] frida (filtered): {line[:120]}", file=sys.stderr, flush=True)
                continue
            # Strip REPL prompt prefix
            line = _prompt_re.sub('', line)
            if not line:
                continue
            _append_frida_message('log', line)
            print(f"[DarkRide] frida stdout: {line[:200]}", file=sys.stderr, flush=True)
    except Exception as e:
        print(f"[DarkRide] frida reader error: {e}", file=sys.stderr, flush=True)
    _append_frida_message('log', '[frida process exited]')
    print("[DarkRide] frida output reader finished", file=sys.stderr, flush=True)

def _frida_stderr_reader(proc):
    """Read stderr from the frida CLI process."""
    try:
        for raw_line in proc.stderr:
            line = raw_line.rstrip('\n\r')
            if not line:
                continue
            _append_frida_message('error', line)
            print(f"[DarkRide] frida stderr: {line[:200]}", file=sys.stderr, flush=True)
    except Exception:
        pass


# ---- Frida RPC Handlers ----

def _kill_all_frida_processes(timeout_s=5):
    """Kill frida-server and every re.frida.* helper/agent/server child,
    looping until pgrep shows nothing matching or `timeout_s` elapses.

    Why this is more than `pkill -9 -f "re\\.frida"`:
      - re.frida.helper/agent reparent to PID 1 after frida-server dies and
        continue to hold IPC state that prevents a fresh frida-server from
        starting (it gets SIGKILLed on launch).
      - `pkill -f` matches on the full command line, which has been observed
        to miss these on some Android builds (the matchable command-line is
        truncated or empty for some reparented children). Using `killall`
        with explicit names is reliable because it matches on the kernel
        comm name (set at exec time, ≤15 chars, e.g. "re.frida.helper").
      - We loop and re-probe with pgrep so we don't relaunch frida-server
        while a stale child is still draining.

    Best-effort: gives up after `timeout_s` rather than hanging the bridge.
    The next start_server call will fail loudly if there's still contention.
    """
    deadline = time.monotonic() + timeout_s
    while True:
        try:
            _adb_run([
                "su -c '"
                "killall -9 frida-server 2>/dev/null; "
                "killall -9 re.frida.server.32 2>/dev/null; "
                "killall -9 re.frida.server.64 2>/dev/null; "
                "killall -9 re.frida.helper.32 2>/dev/null; "
                "killall -9 re.frida.helper.64 2>/dev/null; "
                "killall -9 re.frida.agent.32 2>/dev/null; "
                "killall -9 re.frida.agent.64 2>/dev/null; "
                "pkill -9 -f \"re\\.frida\" 2>/dev/null; "
                "true'"
            ], timeout=3)
        except Exception:
            # Best-effort cleanup: kill failures are expected (e.g. su denied
            # on dev images, or no matching processes). We keep looping and
            # re-probe with pgrep below; the loop terminates on clean or
            # timeout, not on a single kill error.
            pass
        try:
            remaining = _adb_run(
                ["su -c 'pgrep -f \"re\\.frida|frida-server\" 2>/dev/null'"],
                timeout=2,
            ).strip()
        except Exception:
            # Can't probe — treat as "clean" so we don't loop forever on a
            # broken adb. start_server will surface the real problem later.
            remaining = ''
        if not remaining:
            return
        if time.monotonic() >= deadline:
            return
        time.sleep(0.3)


def handle_frida_start_server(params):
    global _frida_device
    _frida_device = None  # Clear stale handle immediately before any operation
    # Aggressive cleanup loop — see _kill_all_frida_processes for rationale.
    _kill_all_frida_processes(timeout_s=5)
    subprocess.Popen(
        ['adb', '-s', device_serial, 'shell', "su -c '/data/local/tmp/frida-server -D'"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    for _ in range(20):
        try:
            pid_output = _adb_run(['pidof', 'frida-server'], timeout=3)
            if pid_output.strip():
                break
        except Exception:
            pass
        time.sleep(0.5)
    else:
        raise BridgeError(ErrorCode.FRIDA_SERVER_NOT_RUNNING, "frida-server process not found after start")
    # Verify server is actually responding (not just running)
    _frida_device = None  # Force fresh device handle
    for attempt in range(6):
        try:
            dev = _get_frida_device()
            dev.enumerate_applications()
            time.sleep(1.5)  # Let Frida stabilise before accepting spawn requests
            return {'status': 'running'}
        except Exception:
            _frida_device = None  # Reset for retry
            time.sleep(1)
    raise BridgeError(ErrorCode.FRIDA_SERVER_NOT_RUNNING,
        "frida-server started but not responding — check root access and architecture")

def handle_frida_stop_server(params):
    global _frida_device, _frida_process
    # Kill any running frida CLI process
    if _frida_process and _frida_process.poll() is None:
        try:
            _frida_process.terminate()
            _frida_process.wait(timeout=3)
        except Exception:
            _frida_process.kill()
    _frida_process = None
    _frida_device = None
    # Aggressive cleanup loop — see _kill_all_frida_processes for rationale.
    _kill_all_frida_processes(timeout_s=5)
    return {'status': 'stopped'}

def handle_frida_list_apps(params):
    dev = _get_frida_device()
    try:
        apps = dev.enumerate_applications()
        return [{'name': a.name, 'identifier': a.identifier, 'pid': a.pid if a.pid else None} for a in apps]
    except Exception as e:
        raise BridgeError(ErrorCode.FRIDA_NOT_AVAILABLE, f"Failed to list apps: {e}")

def handle_frida_run(params):
    """Spawn an app with a script using the `frida` CLI tool.

    This replaces the old spawn → load_script → resume flow.
    The frida CLI automatically loads the Java bridge and other platform
    modules that are NOT available via the raw create_script() API.
    """
    import tempfile, os, threading
    global _frida_process

    bundle_id = params.get('bundle_id')
    code = params.get('code', '')
    mode = params.get('mode', 'spawn')  # 'spawn' or 'attach'
    pid = params.get('pid')

    if mode == 'spawn' and not bundle_id:
        raise BridgeError(ErrorCode.INVALID_PARAMS, "bundle_id is required for spawn mode")
    app_name = params.get('app_name')
    if mode == 'attach' and pid is None and not app_name:
        if bundle_id:
            # Callers (run_frida_script) know only the package id. Resolve the
            # running process's PID from it so attach-by-package works.
            out = ''
            try:
                out = _adb_run(['pidof', bundle_id]).strip()
            except Exception:
                out = ''
            if out:
                pid = int(out.split()[0])
            else:
                raise BridgeError(
                    ErrorCode.INVALID_PARAMS,
                    f"No running process found for '{bundle_id}' — start the app on the device before attaching",
                )
        else:
            raise BridgeError(
                ErrorCode.INVALID_PARAMS,
                "pid, app_name, or bundle_id (of a running app) is required for attach mode",
            )

    # Kill previous frida process if still running
    if _frida_process and _frida_process.poll() is None:
        _frida_process.terminate()
        try:
            _frida_process.wait(timeout=3)
        except Exception:
            _frida_process.kill()
        _frida_process = None

    # Clear previous messages
    with _frida_message_lock:
        _frida_messages.clear()

    # Always restart frida-server before a spawn. The "need Gadget to attach
    # on jailed Android" error comes from frida-server itself when its
    # zygote-injection state is corrupted — which happens after one successful
    # spawn on Android 10+. enumerate_applications() still works in that
    # broken state, so a probe can't detect it. Kill + relaunch is the only
    # reliable fix. Cheap on Android (<3s); worth paying unconditionally.
    print(f"[DarkRide] Restarting frida-server before spawn (mitigates stale zygote-injection state)", file=sys.stderr, flush=True)
    handle_frida_start_server({})

    frida_bin = _frida_cli_path()
    # Use the Frida device ID from the Python API — this is the ID that the CLI's
    # -D flag needs. It may differ from the ADB serial in multi-device setups.
    frida_dev = _get_frida_device()
    cmd = [frida_bin, '-D', frida_dev.id]

    if mode == 'spawn':
        cmd += ['-f', bundle_id]
    elif pid is not None:
        cmd += ['-p', str(pid)]
    elif app_name:
        cmd += ['-n', app_name]

    # Write script to temp file if provided
    script_path = None
    if code.strip():
        fd, script_path = tempfile.mkstemp(suffix='.js', prefix='darkride_frida_')
        os.write(fd, code.encode('utf-8'))
        os.close(fd)
        cmd += ['-l', script_path]

    print(f"[DarkRide] Launching frida CLI: {' '.join(cmd)}", file=sys.stderr, flush=True)

    proc = subprocess.Popen(
        cmd,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    _frida_process = proc

    # Start reader threads
    threading.Thread(target=_frida_output_reader, args=(proc,), daemon=True).start()
    threading.Thread(target=_frida_stderr_reader, args=(proc,), daemon=True).start()

    return {'pid': proc.pid, 'status': 'running'}


# Global state for Python API-based frida sessions
_frida_session = None
_frida_script = None
_frida_spawned_pid = None


def _handle_frida_script_message(message, data):
    """Process a 'message' event from a controlled Frida script and push it
    into the shared _frida_messages list.

    Critical: send() payloads are stored AS-IS (not str(payload)) under
    type='send' so TypeScript callers can read structured fields like
    payload.type or payload.methods. The CLI path's _frida_output_reader
    stores stdout lines under type='log'; downstream code distinguishes
    structured send() messages from console.log lines via the 'type' field.

    Exposed at module scope so unit tests can invoke it without spawning a
    real Frida session.
    """
    if message['type'] == 'send':
        payload = message.get('payload', '')
        _append_frida_message('send', payload)
        print(f"[DarkRide] frida-api: {str(payload)[:200]}", file=sys.stderr, flush=True)
    elif message['type'] == 'error':
        desc = message.get('description', '') or message.get('stack', str(message))
        _append_frida_message('error', desc)
        print(f"[DarkRide] frida-api error: {desc[:200]}", file=sys.stderr, flush=True)


def handle_frida_spawn_controlled(params):
    """Spawn with explicit resume control using Frida Python API.

    Unlike frida_run (CLI-based), this method guarantees the script is
    fully loaded before the process is resumed. This is critical for
    hooks that need to intercept early process initialization.
    """
    import threading
    global _frida_process, _frida_session, _frida_script, _frida_spawned_pid

    bundle_id = params.get('bundle_id')
    code = params.get('code', '')
    if not bundle_id:
        raise BridgeError(ErrorCode.INVALID_PARAMS, "bundle_id is required")

    # Clean up previous CLI-based frida process if running
    if _frida_process and _frida_process.poll() is None:
        _frida_process.terminate()
        try:
            _frida_process.wait(timeout=3)
        except Exception:
            _frida_process.kill()
        _frida_process = None

    # Clean up previous Python API session
    if _frida_session:
        try:
            _frida_session.detach()
        except Exception:
            pass
        _frida_session = None
        _frida_script = None

    # Clear messages
    with _frida_message_lock:
        _frida_messages.clear()

    # Always restart frida-server before a controlled spawn — see matching
    # comment in handle_frida_run. Zygote-injection state gets stuck after
    # one spawn on Android 10+, and a probe can't detect the corruption.
    print(f"[DarkRide] Restarting frida-server before controlled spawn (mitigates stale zygote-injection state)", file=sys.stderr, flush=True)
    handle_frida_start_server({})

    device = _get_frida_device()

    def on_detached(reason, crash=None):
        msg = f"Session detached: {reason}"
        if crash:
            msg += f" crash={crash}"
        _append_frida_message('log', msg)
        print(f"[DarkRide] {msg}", file=sys.stderr, flush=True)

    # Wrap the Frida-API calls so domain errors (e.g. frida.NotSupportedError
    # "need Gadget to attach on jailed Android" — see Android 10+ stale
    # zygote-injection state) propagate as a BridgeError whose message reaches
    # the caller, instead of being collapsed into the dispatcher's generic
    # "Internal error — see server logs" fallback.
    try:
        # 1. Spawn suspended
        print(f"[DarkRide] Spawning {bundle_id} (suspended)...", file=sys.stderr, flush=True)
        pid = device.spawn([bundle_id])
        _frida_spawned_pid = pid

        # 2. Attach
        session = device.attach(pid)
        session.on('detached', on_detached)
        _frida_session = session

        # 3. Load script (process is still suspended)
        script = session.create_script(code)
        script.on('message', _handle_frida_script_message)
        script.load()
        _frida_script = script
        _append_frida_message('log', '[DarkRide] Script loaded, process still suspended')
        print(f"[DarkRide] Script loaded for PID {pid}, resuming...", file=sys.stderr, flush=True)

        # 4. Resume — now the hooks are in place
        device.resume(pid)
        _append_frida_message('log', '[DarkRide] Process resumed')
        print(f"[DarkRide] Process {pid} resumed", file=sys.stderr, flush=True)

        return {'pid': pid, 'status': 'running'}
    except BridgeError:
        raise
    except Exception as e:
        raise BridgeError(
            _map_frida_exception_code(e),
            f"frida_spawn_controlled: {type(e).__name__}: {e}",
        ) from e


def _map_frida_exception_code(e):
    """Map a frida.* exception class name to one of the bridge ErrorCodes.
    Defaults to FRIDA_NOT_AVAILABLE; the original message is preserved by the
    caller regardless of which code is chosen."""
    name = type(e).__name__
    if name == 'NotSupportedError':
        return ErrorCode.FRIDA_SPAWN_FAILED
    if name == 'ServerNotRunningError':
        return ErrorCode.FRIDA_SERVER_NOT_RUNNING
    if name == 'ProcessNotFoundError':
        return ErrorCode.APP_NOT_INSTALLED
    if name == 'PermissionDeniedError':
        return ErrorCode.PERMISSION_DENIED
    if name == 'InvalidArgumentError':
        return ErrorCode.INVALID_PARAMS
    if name in ('TransportError', 'ProtocolError'):
        return ErrorCode.FRIDA_NOT_AVAILABLE
    return ErrorCode.FRIDA_NOT_AVAILABLE


def handle_frida_get_messages(params):
    since = params.get('since', 0)
    with _frida_message_lock:
        msgs = _frida_messages[since:]
        return {'messages': msgs, 'next_index': len(_frida_messages)}


def handle_frida_inject_apk(params):
    """Inject Frida Gadget .so into an APK using frida_tools.apk."""
    import zipfile
    import shutil
    import os as _os
    from frida_tools.apk import inject as frida_inject

    apk_path = params.get('apk_path')
    gadget_so_path = params.get('gadget_so_path')
    output_path = params.get('output_path')

    if not apk_path:
        raise BridgeError(ErrorCode.INVALID_PARAMS, "apk_path is required")
    if not gadget_so_path:
        raise BridgeError(ErrorCode.INVALID_PARAMS, "gadget_so_path is required")
    if not output_path:
        raise BridgeError(ErrorCode.INVALID_PARAMS, "output_path is required")

    if not _os.path.exists(apk_path):
        raise BridgeError(ErrorCode.INVALID_PARAMS, f"APK not found: {apk_path}")
    if not _os.path.exists(gadget_so_path):
        raise BridgeError(ErrorCode.INVALID_PARAMS, f"Gadget .so not found: {gadget_so_path}")

    # Determine lib directory from existing APK (arm64-v8a preferred)
    # NOTE: lib_dir needs trailing slash — frida_tools.apk.inject() concatenates
    # lib_dir + filename directly (e.g. lib_dir + "libfridagadget.so")
    lib_dir = "lib/arm64-v8a/"
    try:
        with zipfile.ZipFile(apk_path, 'r') as zf:
            entries = zf.namelist()
            if any(e.startswith('lib/arm64-v8a/') for e in entries):
                lib_dir = "lib/arm64-v8a/"
            elif any(e.startswith('lib/armeabi-v7a/') for e in entries):
                lib_dir = "lib/armeabi-v7a/"
    except Exception:
        pass

    # Gadget config: listen mode, wait on load for script attachment
    config = {
        "interaction": {
            "type": "listen",
            "on_load": "wait",
        }
    }

    # Ensure output directory exists
    out_dir = _os.path.dirname(output_path)
    if out_dir:
        _os.makedirs(out_dir, exist_ok=True)

    # Copy source APK to output, then inject in-place
    shutil.copy2(apk_path, output_path)

    print(f"[DarkRide] Injecting Frida Gadget into {apk_path} -> {output_path}", file=sys.stderr, flush=True)
    frida_inject(gadget_so_path, lib_dir, config, output_path)

    file_size = _os.path.getsize(output_path)
    print(f"[DarkRide] Gadget injection complete ({file_size} bytes)", file=sys.stderr, flush=True)

    return {"output_path": output_path, "size": file_size}


# Dispatch table
HANDLERS = {
    'click': handle_click,
    'longClick': handle_long_click,
    'setText': handle_set_text,
    'getText': handle_get_text,
    'exists': handle_exists,
    'waitFor': handle_wait_for,
    'scroll': handle_scroll,
    'scrollToElement': handle_scroll_to_element,
    'getDOM': handle_get_dom,
    'screenshot': handle_screenshot,
    'getAppInfo': handle_get_app_info,
    'startApp': handle_start_app,
    'stopApp': handle_stop_app,
    'pressKey': handle_press_key,
    'swipe': handle_swipe,
    'tapAt': handle_tap_at,
    'longClickAt': handle_long_click_at,
    'enableWebViewDebug': handle_enable_webview_debug,
    'getCurrentAppId': handle_get_current_app_id,
    'deviceInfo': handle_device_info,
    'getWebViewInfo': handle_get_web_view_info,
    'wakeAndUnlock': handle_wake_and_unlock,
    'setATXFree': handle_set_atx_free,
    'inputText': handle_input_text,
    'frida_start_server': handle_frida_start_server,
    'frida_stop_server': handle_frida_stop_server,
    'frida_list_apps': handle_frida_list_apps,
    'frida_run': handle_frida_run,
    'frida_spawn_controlled': handle_frida_spawn_controlled,
    'frida_get_messages': handle_frida_get_messages,
    'frida_inject_apk': handle_frida_inject_apk,
}


@app.route('/health', methods=['GET'])
def health():
    return jsonify({"status": "ok", "device": device_serial})


@app.route('/rpc', methods=['POST'])
def rpc():
    try:
        req = request.json
    except Exception:
        return jsonify({
            "jsonrpc": "2.0",
            "error": {
                "code": ErrorCode.INVALID_REQUEST,
                "message": "Invalid JSON",
            },
            "id": None,
        })

    method = req.get('method')
    params = req.get('params', {})
    req_id = req.get('id')

    if method not in HANDLERS:
        return jsonify({
            "jsonrpc": "2.0",
            "error": {
                "code": ErrorCode.METHOD_NOT_FOUND,
                "message": f"Method not found: {method}",
            },
            "id": req_id,
        })

    # Lazily connect to device on first RPC call
    if not connect_device():
        return jsonify({
            "jsonrpc": "2.0",
            "error": {
                "code": ErrorCode.DEVICE_DISCONNECTED,
                "message": "uiautomator2 not available or device not connected",
            },
            "id": req_id,
        })

    try:
        result = HANDLERS[method](params)
        return jsonify({
            "jsonrpc": "2.0",
            "result": result,
            "id": req_id,
        })
    except BridgeError as e:
        return jsonify({
            "jsonrpc": "2.0",
            "error": {
                "code": e.code,
                "message": str(e),
                "data": e.data,
            },
            "id": req_id,
        })
    except Exception:
        # Log the full traceback to stderr for the operator to inspect, but
        # don't include str(e) in the response — generic Python exception
        # messages can leak filesystem paths, internal types, or other
        # implementation details to the caller.
        traceback.print_exc()
        return jsonify({
            "jsonrpc": "2.0",
            "error": {
                "code": ErrorCode.DEVICE_DISCONNECTED,
                "message": "Internal error — see server logs",
            },
            "id": req_id,
        })


def connect_device():
    """Lazily connect to device on first RPC call. Returns True if connected."""
    global device
    if device is not None:
        return True
    if u2 is None:
        return False
    try:
        device = u2.connect(device_serial)
        print(f"Connected to device: {device_serial}", flush=True)
        return True
    except Exception as e:
        print(f"Warning: Could not connect to device {device_serial}: {e}", flush=True)
        return False


if __name__ == '__main__':
    import threading
    _frida_message_lock = threading.Lock()

    parser = argparse.ArgumentParser(description='DarkRide Python Bridge')
    parser.add_argument('--device', required=True, help='ADB device serial')
    parser.add_argument('--port', type=int, required=True, help='HTTP port to listen on')
    args = parser.parse_args()

    device_serial = args.device

    print(f"Starting bridge for device {args.device} on port {args.port}", flush=True)
    app.run(host='0.0.0.0', port=args.port, threaded=True)
