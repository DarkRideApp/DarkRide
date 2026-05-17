#!/usr/bin/env python3
"""
iOS Bridge - pymobiledevice3 JSON-RPC service for DarkRide.

Provides a Flask-based JSON-RPC 2.0 server for iOS device discovery,
info retrieval, and pairing via pymobiledevice3.

pymobiledevice3 v9.x uses an async API — all device calls go through
asyncio.run() since Flask handlers are synchronous.
"""

import argparse
import asyncio
import base64
import json
import logging
import os
import subprocess
import sys
import threading
import time
import traceback
import urllib.request
import xml.etree.ElementTree as ET
from collections import deque

from flask import Flask, request, jsonify

# Suppress Werkzeug per-request access logs
logging.getLogger('werkzeug').setLevel(logging.ERROR)

logger = logging.getLogger('ios_bridge')
logging.basicConfig(level=logging.INFO, format='[iOS Bridge] %(message)s')

app = Flask(__name__)


# Apple product type → marketing name lookup
# See https://gist.github.com/adamawolf/3048717
PRODUCT_TYPE_NAMES = {
    # iPhone
    "iPhone1,1": "iPhone",
    "iPhone1,2": "iPhone 3G",
    "iPhone2,1": "iPhone 3GS",
    "iPhone3,1": "iPhone 4", "iPhone3,2": "iPhone 4", "iPhone3,3": "iPhone 4",
    "iPhone4,1": "iPhone 4S",
    "iPhone5,1": "iPhone 5", "iPhone5,2": "iPhone 5",
    "iPhone5,3": "iPhone 5c", "iPhone5,4": "iPhone 5c",
    "iPhone6,1": "iPhone 5s", "iPhone6,2": "iPhone 5s",
    "iPhone7,1": "iPhone 6 Plus", "iPhone7,2": "iPhone 6",
    "iPhone8,1": "iPhone 6s", "iPhone8,2": "iPhone 6s Plus", "iPhone8,4": "iPhone SE",
    "iPhone9,1": "iPhone 7", "iPhone9,2": "iPhone 7 Plus",
    "iPhone9,3": "iPhone 7", "iPhone9,4": "iPhone 7 Plus",
    "iPhone10,1": "iPhone 8", "iPhone10,2": "iPhone 8 Plus", "iPhone10,3": "iPhone X",
    "iPhone10,4": "iPhone 8", "iPhone10,5": "iPhone 8 Plus", "iPhone10,6": "iPhone X",
    "iPhone11,2": "iPhone XS", "iPhone11,4": "iPhone XS Max", "iPhone11,6": "iPhone XS Max",
    "iPhone11,8": "iPhone XR",
    "iPhone12,1": "iPhone 11", "iPhone12,3": "iPhone 11 Pro", "iPhone12,5": "iPhone 11 Pro Max",
    "iPhone12,8": "iPhone SE (2nd gen)",
    "iPhone13,1": "iPhone 12 mini", "iPhone13,2": "iPhone 12",
    "iPhone13,3": "iPhone 12 Pro", "iPhone13,4": "iPhone 12 Pro Max",
    "iPhone14,2": "iPhone 13 Pro", "iPhone14,3": "iPhone 13 Pro Max",
    "iPhone14,4": "iPhone 13 mini", "iPhone14,5": "iPhone 13",
    "iPhone14,6": "iPhone SE (3rd gen)",
    "iPhone14,7": "iPhone 14", "iPhone14,8": "iPhone 14 Plus",
    "iPhone15,2": "iPhone 14 Pro", "iPhone15,3": "iPhone 14 Pro Max",
    "iPhone15,4": "iPhone 15", "iPhone15,5": "iPhone 15 Plus",
    "iPhone16,1": "iPhone 15 Pro", "iPhone16,2": "iPhone 15 Pro Max",
    "iPhone17,1": "iPhone 16 Pro", "iPhone17,2": "iPhone 16 Pro Max",
    "iPhone17,3": "iPhone 16", "iPhone17,4": "iPhone 16 Plus",
    "iPhone17,5": "iPhone 16e",
    # iPad
    "iPad1,1": "iPad",
    "iPad2,1": "iPad 2", "iPad2,2": "iPad 2", "iPad2,3": "iPad 2", "iPad2,4": "iPad 2",
    "iPad2,5": "iPad mini", "iPad2,6": "iPad mini", "iPad2,7": "iPad mini",
    "iPad3,1": "iPad (3rd gen)", "iPad3,2": "iPad (3rd gen)", "iPad3,3": "iPad (3rd gen)",
    "iPad3,4": "iPad (4th gen)", "iPad3,5": "iPad (4th gen)", "iPad3,6": "iPad (4th gen)",
    "iPad4,1": "iPad Air", "iPad4,2": "iPad Air", "iPad4,3": "iPad Air",
    "iPad4,4": "iPad mini 2", "iPad4,5": "iPad mini 2", "iPad4,6": "iPad mini 2",
    "iPad4,7": "iPad mini 3", "iPad4,8": "iPad mini 3", "iPad4,9": "iPad mini 3",
    "iPad5,1": "iPad mini 4", "iPad5,2": "iPad mini 4",
    "iPad5,3": "iPad Air 2", "iPad5,4": "iPad Air 2",
    "iPad6,3": "iPad Pro 9.7\"", "iPad6,4": "iPad Pro 9.7\"",
    "iPad6,7": "iPad Pro 12.9\"", "iPad6,8": "iPad Pro 12.9\"",
    "iPad6,11": "iPad (5th gen)", "iPad6,12": "iPad (5th gen)",
    "iPad7,1": "iPad Pro 12.9\" (2nd gen)", "iPad7,2": "iPad Pro 12.9\" (2nd gen)",
    "iPad7,3": "iPad Pro 10.5\"", "iPad7,4": "iPad Pro 10.5\"",
    "iPad7,5": "iPad (6th gen)", "iPad7,6": "iPad (6th gen)",
    "iPad7,11": "iPad (7th gen)", "iPad7,12": "iPad (7th gen)",
    "iPad8,1": "iPad Pro 11\"", "iPad8,2": "iPad Pro 11\"",
    "iPad8,3": "iPad Pro 11\"", "iPad8,4": "iPad Pro 11\"",
    "iPad8,5": "iPad Pro 12.9\" (3rd gen)", "iPad8,6": "iPad Pro 12.9\" (3rd gen)",
    "iPad8,7": "iPad Pro 12.9\" (3rd gen)", "iPad8,8": "iPad Pro 12.9\" (3rd gen)",
    "iPad11,1": "iPad mini (5th gen)", "iPad11,2": "iPad mini (5th gen)",
    "iPad11,3": "iPad Air (3rd gen)", "iPad11,4": "iPad Air (3rd gen)",
    "iPad11,6": "iPad (8th gen)", "iPad11,7": "iPad (8th gen)",
    "iPad12,1": "iPad (9th gen)", "iPad12,2": "iPad (9th gen)",
    "iPad13,1": "iPad Air (4th gen)", "iPad13,2": "iPad Air (4th gen)",
    "iPad13,4": "iPad Pro 11\" (3rd gen)", "iPad13,5": "iPad Pro 11\" (3rd gen)",
    "iPad13,6": "iPad Pro 11\" (3rd gen)", "iPad13,7": "iPad Pro 11\" (3rd gen)",
    "iPad13,8": "iPad Pro 12.9\" (5th gen)", "iPad13,9": "iPad Pro 12.9\" (5th gen)",
    "iPad13,10": "iPad Pro 12.9\" (5th gen)", "iPad13,11": "iPad Pro 12.9\" (5th gen)",
    "iPad13,16": "iPad Air (5th gen)", "iPad13,17": "iPad Air (5th gen)",
    "iPad13,18": "iPad (10th gen)", "iPad13,19": "iPad (10th gen)",
    "iPad14,1": "iPad mini (6th gen)", "iPad14,2": "iPad mini (6th gen)",
    "iPad14,3": "iPad Pro 11\" (4th gen)", "iPad14,4": "iPad Pro 11\" (4th gen)",
    "iPad14,5": "iPad Pro 12.9\" (6th gen)", "iPad14,6": "iPad Pro 12.9\" (6th gen)",
    "iPad14,8": "iPad Air 11\" (M2)", "iPad14,9": "iPad Air 11\" (M2)",
    "iPad14,10": "iPad Air 13\" (M2)", "iPad14,11": "iPad Air 13\" (M2)",
    "iPad16,1": "iPad mini (A17 Pro)", "iPad16,2": "iPad mini (A17 Pro)",
    "iPad16,3": "iPad Pro 11\" (M4)", "iPad16,4": "iPad Pro 11\" (M4)",
    "iPad16,5": "iPad Pro 13\" (M4)", "iPad16,6": "iPad Pro 13\" (M4)",
    # iPod touch
    "iPod1,1": "iPod touch",
    "iPod2,1": "iPod touch (2nd gen)",
    "iPod3,1": "iPod touch (3rd gen)",
    "iPod4,1": "iPod touch (4th gen)",
    "iPod5,1": "iPod touch (5th gen)",
    "iPod7,1": "iPod touch (6th gen)",
    "iPod9,1": "iPod touch (7th gen)",
}


def _get_model_name(product_type):
    """Convert Apple product type (e.g. 'iPhone14,4') to marketing name (e.g. 'iPhone 13 mini')."""
    if not product_type:
        return None
    return PRODUCT_TYPE_NAMES.get(product_type)


class ErrorCode:
    DEVICE_NOT_FOUND = -32001
    PAIRING_FAILED = -32002
    DEVICE_DISCONNECTED = -32003
    WDA_NOT_INSTALLED = -32004
    WDA_NOT_RUNNING = -32005
    WDA_REQUEST_FAILED = -32006
    INVALID_REQUEST = -32600
    METHOD_NOT_FOUND = -32601
    INVALID_PARAMS = -32602
    PYMOBILEDEVICE_NOT_AVAILABLE = -32010
    TUNNEL_NOT_AVAILABLE = -32011


class BridgeError(Exception):
    def __init__(self, message, code=-32000, data=None):
        super().__init__(message)
        self.code = code
        self.data = data


def _make_response(result=None, error=None, req_id=None):
    resp = {"jsonrpc": "2.0", "id": req_id}
    if error:
        resp["error"] = error
    else:
        resp["result"] = result
    return jsonify(resp)


async def _get_usbmux_devices():
    """List connected iOS devices via usbmux, deduplicated by UDID (prefer USB over network)."""
    try:
        from pymobiledevice3.usbmux import list_devices
        all_devices = await list_devices()
        # Deduplicate: same device can appear via USB and WiFi
        seen = {}
        for dev in all_devices:
            udid = dev.serial
            if udid not in seen or dev.is_usb:
                seen[udid] = dev
        return list(seen.values())
    except Exception as e:
        msg = str(e) or type(e).__name__
        if 'FileNotFoundError' in type(e).__name__ or 'No such file' in msg or 'connection refused' in msg.lower():
            logger.error(
                "usbmuxd service not running. "
                "Linux: sudo apt install usbmuxd && sudo systemctl start usbmuxd | "
                "Windows: install 'Apple Devices' from Microsoft Store | "
                "macOS: built-in"
            )
        else:
            logger.error(f"Failed to list usbmux devices: {msg}")
        return []


async def _get_lockdown_client(udid):
    """Create a lockdown client for a specific device."""
    from pymobiledevice3.lockdown import create_using_usbmux
    return await create_using_usbmux(serial=udid)


# ---- CoreDevice tunnel helpers ----

TUNNELD_URL = os.environ.get("TUNNELD_URL", "http://127.0.0.1:49151")

# Cache for tunneld liveness checks (avoid hammering every request)
_tunneld_cache = {"available": False, "checked_at": 0.0}
_TUNNELD_CACHE_TTL = 10.0  # seconds

# Cache iOS major version per device (doesn't change while connected)
_device_ios_major = {}


def _tunneld_is_available():
    """Check if the tunneld daemon is reachable (cached for 10s)."""
    now = time.time()
    if now - _tunneld_cache["checked_at"] < _TUNNELD_CACHE_TTL:
        return _tunneld_cache["available"]
    try:
        urllib.request.urlopen(f"{TUNNELD_URL}/", timeout=2)
        _tunneld_cache.update(available=True, checked_at=now)
    except Exception:
        _tunneld_cache.update(available=False, checked_at=now)
    return _tunneld_cache["available"]


def _get_tunnel_info(udid):
    """Query tunneld for an active tunnel to the given device.

    Returns {"host": str, "port": int} or None.
    """
    try:
        resp = urllib.request.urlopen(f"{TUNNELD_URL}/", timeout=3)
        data = json.loads(resp.read().decode())
    except Exception:
        return None
    # tunneld returns {udid: [{tunnel-address, tunnel-port, interface}]}
    for device_udid, tunnel_list in data.items():
        if udid in device_udid or device_udid in udid:
            if tunnel_list:
                t = tunnel_list[0]
                return {
                    "host": t.get("tunnel-address"),
                    "port": int(t.get("tunnel-port", 0)),
                }
    return None


async def _get_ios_major(udid):
    """Get the major iOS version for a device (cached).

    Returns an int (e.g. 17, 18, 26) or None if unknown.
    """
    if udid in _device_ios_major:
        return _device_ios_major[udid]
    try:
        client = await _get_lockdown_client(udid)
        version_str = client.all_values.get("ProductVersion", "")
        major = int(version_str.split(".")[0]) if version_str else None
        if major is not None:
            _device_ios_major[udid] = major
        return major
    except Exception:
        return None


# ---- JSON-RPC methods (all async) ----

async def _list_devices():
    """Discover connected iOS devices via USB."""
    mux_devices = await _get_usbmux_devices()
    results = []
    for dev in mux_devices:
        udid = dev.serial
        connection_type = "USB" if dev.is_usb else "WiFi"
        info = {"udid": udid, "connection_type": connection_type}
        # Try to get basic info via lockdown
        try:
            client = await _get_lockdown_client(udid)
            all_values = client.all_values
            product_type = all_values.get("ProductType", None)
            info["device_name"] = all_values.get("DeviceName", None)
            info["product_type"] = product_type
            info["model_name"] = _get_model_name(product_type)
            info["model_number"] = all_values.get("ModelNumber", None)
            info["ios_version"] = all_values.get("ProductVersion", None)
            info["build_version"] = all_values.get("BuildVersion", None)
            info["paired"] = True
        except Exception:
            # Device may not be paired yet
            info["paired"] = False
        results.append(info)
    return results


async def _device_info(udid):
    """Get detailed device info."""
    try:
        client = await _get_lockdown_client(udid)
    except Exception as e:
        raise BridgeError(f"Cannot connect to device {udid}: {e}", ErrorCode.DEVICE_NOT_FOUND)

    all_values = client.all_values
    product_type = all_values.get("ProductType", None)

    # Battery info
    battery = {}
    try:
        from pymobiledevice3.services.diagnostics import DiagnosticsService
        async with DiagnosticsService(client) as diag:
            battery_info = await diag.get_battery()
            battery = {
                "level": battery_info.get("BatteryCurrentCapacity", None),
                "charging": battery_info.get("BatteryIsCharging", False),
            }
    except Exception:
        pass

    # Storage info
    storage = {}
    try:
        disk = all_values.get("TotalDiskCapacity", 0)
        available = all_values.get("TotalDataAvailable", 0)
        if disk:
            storage = {
                "total_gb": round(disk / (1024 ** 3), 1),
                "available_gb": round(available / (1024 ** 3), 1),
            }
    except Exception:
        pass

    # WiFi SSID via DiagnosticsService (best-effort)
    wifi_ssid = ''
    try:
        from pymobiledevice3.services.diagnostics import DiagnosticsService
        async with DiagnosticsService(client) as diag:
            wifi_info = await diag.get_wifi()
            wifi_ssid = wifi_info.get('CurrentSSID', '') if isinstance(wifi_info, dict) else ''
    except Exception:
        pass

    return {
        "udid": udid,
        "device_name": all_values.get("DeviceName", None),
        "product_type": product_type,
        "model_name": _get_model_name(product_type),
        "model_number": all_values.get("ModelNumber", None),
        "hardware_model": all_values.get("HardwareModel", None),
        "ios_version": all_values.get("ProductVersion", None),
        "build_version": all_values.get("BuildVersion", None),
        "serial_number": all_values.get("SerialNumber", None),
        "wifi_address": all_values.get("WiFiAddress", None),
        "wifi_ssid": wifi_ssid,
        "bluetooth_address": all_values.get("BluetoothAddress", None),
        "phone_number": all_values.get("PhoneNumber", None),
        "cpu_architecture": all_values.get("CPUArchitecture", None),
        "battery": battery,
        "storage": storage,
        "paired": True,
    }


async def _pair(udid):
    """Initiate pairing with an iOS device. User must tap 'Trust' on device."""
    try:
        client = await _get_lockdown_client(udid)
        client.pair()
        return {"success": True, "udid": udid}
    except Exception as e:
        raise BridgeError(f"Pairing failed for {udid}: {e}", ErrorCode.PAIRING_FAILED)


async def _check_paired(udid):
    """Check if a device is paired."""
    try:
        client = await _get_lockdown_client(udid)
        _ = client.all_values  # This will fail if not paired
        return {"paired": True, "udid": udid}
    except Exception:
        return {"paired": False, "udid": udid}


# ---- WDA (WebDriverAgent) management ----

# Track WDA state per device: { udid: { "port": int, "process": subprocess.Popen | None, "tunnel": subprocess.Popen | None } }
_wda_state = {}

WDA_BUNDLE_ID = "com.facebook.WebDriverAgentRunner.xctrunner"
WDA_IPA_PATH = os.path.join(os.path.dirname(__file__), '..', 'data', 'ios', 'WDA.ipa')
WDA_DEFAULT_PORT = 8100  # WDA's default listening port on-device
WDA_LOCAL_PORT_START = 9210  # Local port range for WDA tunnels (one per device)

_next_wda_local_port = WDA_LOCAL_PORT_START


def _allocate_wda_port():
    """Allocate a local port for WDA tunnel."""
    global _next_wda_local_port
    port = _next_wda_local_port
    _next_wda_local_port += 1
    if _next_wda_local_port > 9299:
        _next_wda_local_port = WDA_LOCAL_PORT_START
    return port


async def _install_wda(udid):
    """Install WDA IPA onto the device via pymobiledevice3."""
    ipa_path = os.path.abspath(WDA_IPA_PATH)
    if not os.path.exists(ipa_path):
        raise BridgeError(
            f"WDA.ipa not found at {ipa_path}. Compile WDA on macOS first.",
            ErrorCode.WDA_NOT_INSTALLED,
        )

    try:
        from pymobiledevice3.lockdown import create_using_usbmux
        from pymobiledevice3.services.installation_proxy import InstallationProxyService

        client = await create_using_usbmux(serial=udid)
        async with InstallationProxyService(lockdown=client) as install_service:
            await install_service.install_from_local(ipa_path)
        logger.info(f"WDA installed on {udid}")
        return {"success": True, "udid": udid}
    except ImportError:
        # Fallback: use pymobiledevice3 CLI
        result = subprocess.run(
            ['pymobiledevice3', 'apps', 'install', '--udid', udid, ipa_path],
            capture_output=True, text=True, timeout=120,
        )
        if result.returncode != 0:
            raise BridgeError(f"WDA install failed: {result.stderr}", ErrorCode.WDA_NOT_INSTALLED)
        logger.info(f"WDA installed on {udid} (via CLI)")
        return {"success": True, "udid": udid}
    except Exception as e:
        raise BridgeError(f"Failed to install WDA on {udid}: {e}", ErrorCode.WDA_NOT_INSTALLED)


async def _launch_wda(udid):
    """Launch WDA on the device and set up a USB tunnel to its HTTP server."""
    # Check if already running
    state = _wda_state.get(udid)
    if state and state.get("port"):
        try:
            url = f"http://localhost:{state['port']}/status"
            resp = urllib.request.urlopen(url, timeout=3)
            if resp.status == 200:
                return {"success": True, "udid": udid, "port": state["port"], "already_running": True}
        except Exception:
            # Not actually running, clean up
            _stop_wda(udid)

    local_port = _allocate_wda_port()

    # Start WDA — use tunnel (xcuitest via --rsd) on iOS 17+, dvt launch on older
    tunnel_info = _get_tunnel_info(udid)
    try:
        if tunnel_info:
            # iOS 17+: run XCUITest runner through CoreDevice tunnel
            wda_proc = subprocess.Popen(
                ['pymobiledevice3', 'developer', 'dvt', 'xcuitest', WDA_BUNDLE_ID,
                 '--rsd', tunnel_info["host"], str(tunnel_info["port"])],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            )
        else:
            # Older iOS or no tunnel: try direct dvt launch via usbmux
            wda_proc = subprocess.Popen(
                ['pymobiledevice3', 'developer', 'dvt', 'launch', '--udid', udid, WDA_BUNDLE_ID],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            )
    except Exception as e:
        raise BridgeError(f"Failed to launch WDA on {udid}: {e}", ErrorCode.WDA_NOT_RUNNING)

    # Set up USB tunnel (port forward) from local_port to device WDA_DEFAULT_PORT
    try:
        tunnel_proc = subprocess.Popen(
            ['pymobiledevice3', 'usbmux', 'forward', '--udid', udid,
             str(local_port), str(WDA_DEFAULT_PORT)],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
    except Exception as e:
        wda_proc.kill()
        raise BridgeError(f"Failed to create WDA tunnel for {udid}: {e}", ErrorCode.WDA_NOT_RUNNING)

    _wda_state[udid] = {"port": local_port, "process": wda_proc, "tunnel": tunnel_proc}

    # Wait for WDA to become responsive
    for _ in range(30):  # 15 seconds max
        try:
            url = f"http://localhost:{local_port}/status"
            resp = urllib.request.urlopen(url, timeout=2)
            if resp.status == 200:
                logger.info(f"WDA running on {udid} at localhost:{local_port}")
                return {"success": True, "udid": udid, "port": local_port}
        except Exception:
            pass
        time.sleep(0.5)

    # Timed out
    _stop_wda(udid)
    raise BridgeError(f"WDA on {udid} did not become responsive", ErrorCode.WDA_NOT_RUNNING)


def _stop_wda(udid):
    """Stop WDA and its tunnel for a device."""
    state = _wda_state.pop(udid, None)
    if not state:
        return
    for key in ("process", "tunnel"):
        proc = state.get(key)
        if proc:
            try:
                proc.kill()
            except Exception:
                pass


def _get_wda_url(udid):
    """Get the local WDA URL for a device, or raise if not running."""
    state = _wda_state.get(udid)
    if not state or not state.get("port"):
        raise BridgeError(f"WDA not running on {udid}. Call launch_wda first.", ErrorCode.WDA_NOT_RUNNING)
    return f"http://localhost:{state['port']}"


def _wda_request(udid, method, path, body=None, timeout=10):
    """Make an HTTP request to WDA on a device."""
    base = _get_wda_url(udid)
    url = f"{base}{path}"
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(url, data=data, method=method)
    if data:
        req.add_header('Content-Type', 'application/json')
    try:
        resp = urllib.request.urlopen(req, timeout=timeout)
        return json.loads(resp.read().decode())
    except Exception as e:
        raise BridgeError(f"WDA request failed ({method} {path}): {e}", ErrorCode.WDA_REQUEST_FAILED)


async def _wda_screenshot(udid):
    """Take a screenshot via WDA, return base64-encoded PNG."""
    base = _get_wda_url(udid)
    url = f"{base}/screenshot"
    try:
        resp = urllib.request.urlopen(url, timeout=10)
        data = json.loads(resp.read().decode())
        # WDA returns { "value": "<base64 png>", "sessionId": "...", "status": 0 }
        b64 = data.get("value", "")
        if not b64:
            raise BridgeError("WDA returned empty screenshot", ErrorCode.WDA_REQUEST_FAILED)
        return {"image": b64, "format": "png"}
    except BridgeError:
        raise
    except Exception as e:
        raise BridgeError(f"WDA screenshot failed for {udid}: {e}", ErrorCode.WDA_REQUEST_FAILED)


def _parse_wda_xml_to_domnode(xml_string):
    """Convert WDA XML source to DOMNode JSON matching DarkRide's DOMNode interface.

    WDA XML elements have attributes like:
      type, name, label, value, visible, accessible, enabled,
      x, y, width, height
    We map these to the DOMNode interface:
      className, text, resourceId, description, bounds, clickable, enabled, children
    """
    try:
        root = ET.fromstring(xml_string)
    except ET.ParseError as e:
        raise BridgeError(f"Failed to parse WDA XML: {e}", ErrorCode.WDA_REQUEST_FAILED)

    def _convert_element(el):
        attrs = el.attrib

        # className: WDA 'type' attribute (e.g. XCUIElementTypeButton)
        class_name = attrs.get('type', el.tag)

        # text: prefer 'value', fall back to 'label', then 'name'
        text = attrs.get('value', '') or attrs.get('label', '') or attrs.get('name', '')

        # resourceId: WDA 'name' maps closest to Android resourceId (accessibility identifier)
        resource_id = attrs.get('name', '')

        # description: 'label' is the accessibility label
        description = attrs.get('label', '')

        # bounds: [x1, y1, x2, y2] from x, y, width, height
        try:
            x = int(attrs.get('x', '0'))
            y = int(attrs.get('y', '0'))
            w = int(attrs.get('width', '0'))
            h = int(attrs.get('height', '0'))
            bounds = [x, y, x + w, y + h]
        except (ValueError, TypeError):
            bounds = [0, 0, 0, 0]

        # clickable: WDA doesn't have a direct 'clickable'; use 'accessible' as proxy
        clickable = attrs.get('accessible', 'false').lower() == 'true'

        # enabled
        enabled = attrs.get('enabled', 'true').lower() == 'true'

        children = [_convert_element(child) for child in el]

        return {
            "className": class_name,
            "text": text,
            "resourceId": resource_id,
            "description": description,
            "bounds": bounds,
            "clickable": clickable,
            "enabled": enabled,
            "children": children,
        }

    return _convert_element(root)


async def _wda_dom(udid):
    """Get the UI hierarchy (source) via WDA."""
    result = _wda_request(udid, 'GET', '/source')
    # WDA returns { "value": "<xml source>", ... }
    return {"source": result.get("value", ""), "format": "xml"}


async def _wda_dom_parsed(udid):
    """Get the UI hierarchy via WDA and return as parsed DOMNode JSON."""
    result = _wda_request(udid, 'GET', '/source')
    xml_source = result.get("value", "")
    if not xml_source:
        raise BridgeError("WDA returned empty DOM source", ErrorCode.WDA_REQUEST_FAILED)
    dom_node = _parse_wda_xml_to_domnode(xml_source)
    return dom_node


def _build_nspredicate(selector):
    """Build an NSPredicate string from a cross-platform Selector dict.

    Maps DarkRide Selector fields to WDA NSPredicate expressions:
      text         → label == 'value' OR value == 'value'
      textContains → label CONTAINS 'value' OR value CONTAINS 'value'
      textStartsWith → label BEGINSWITH 'value' OR value BEGINSWITH 'value'
      textMatches  → label MATCHES 'pattern' OR value MATCHES 'pattern'
      resourceId   → name == 'value' (accessibility identifier)
      resourceIdMatches → name MATCHES 'pattern'
      className    → type == 'value'
      classNameMatches → type MATCHES 'pattern'
      description  → label == 'value'
      descriptionContains → label CONTAINS 'value'
      descriptionMatches → label MATCHES 'pattern'
      clickable    → accessible == true/false
      enabled      → enabled == true/false
    """
    clauses = []

    def _escape(val):
        return val.replace("'", "\\'")

    if 'text' in selector:
        v = _escape(selector['text'])
        clauses.append(f"(label == '{v}' OR value == '{v}')")
    if 'textContains' in selector:
        v = _escape(selector['textContains'])
        clauses.append(f"(label CONTAINS '{v}' OR value CONTAINS '{v}')")
    if 'textStartsWith' in selector:
        v = _escape(selector['textStartsWith'])
        clauses.append(f"(label BEGINSWITH '{v}' OR value BEGINSWITH '{v}')")
    if 'textMatches' in selector:
        v = _escape(selector['textMatches'])
        clauses.append(f"(label MATCHES '{v}' OR value MATCHES '{v}')")
    if 'resourceId' in selector:
        v = _escape(selector['resourceId'])
        clauses.append(f"name == '{v}'")
    if 'resourceIdMatches' in selector:
        v = _escape(selector['resourceIdMatches'])
        clauses.append(f"name MATCHES '{v}'")
    if 'className' in selector:
        v = _escape(selector['className'])
        clauses.append(f"type == '{v}'")
    if 'classNameMatches' in selector:
        v = _escape(selector['classNameMatches'])
        clauses.append(f"type MATCHES '{v}'")
    if 'description' in selector:
        v = _escape(selector['description'])
        clauses.append(f"label == '{v}'")
    if 'descriptionContains' in selector:
        v = _escape(selector['descriptionContains'])
        clauses.append(f"label CONTAINS '{v}'")
    if 'descriptionMatches' in selector:
        v = _escape(selector['descriptionMatches'])
        clauses.append(f"label MATCHES '{v}'")
    if 'clickable' in selector:
        clauses.append(f"accessible == {'true' if selector['clickable'] else 'false'}")
    if 'enabled' in selector:
        clauses.append(f"enabled == {'true' if selector['enabled'] else 'false'}")

    if not clauses:
        return None
    return ' AND '.join(clauses)


def _best_ios_selector(selector):
    """Choose the best WDA selector strategy for a given cross-platform Selector.

    Returns (using, value) tuple for WDA POST /element.
    Priority:
      1. Accessibility ID (if only resourceId is specified)
      2. Class chain (if only className is specified)
      3. NSPredicate (general-purpose fallback)
    """
    keys = set(selector.keys())

    # Pure accessibility ID lookup
    if keys == {'resourceId'}:
        return ('accessibility id', selector['resourceId'])

    # Pure class name lookup → class chain
    if keys == {'className'}:
        return ('class chain', f"**/{selector['className']}")

    # General case: NSPredicate
    predicate = _build_nspredicate(selector)
    if predicate:
        return ('-ios predicate string', predicate)

    return None


async def _wda_find_element(udid, selector):
    """Find a single element via WDA using the best iOS selector strategy.

    Args:
        udid: Device UDID
        selector: Cross-platform Selector dict (text, resourceId, className, etc.)

    Returns:
        Dict with element info: { elementId, bounds, text, className, enabled, clickable }
    """
    strategy = _best_ios_selector(selector)
    if not strategy:
        raise BridgeError("Cannot build iOS selector from empty selector", ErrorCode.INVALID_PARAMS)

    using, value = strategy
    session_id = _get_or_create_wda_session(udid)
    result = _wda_request(udid, 'POST', f'/session/{session_id}/element', {
        "using": using,
        "value": value,
    })

    element = result.get("value", {})
    element_id = element.get("ELEMENT", "")

    # Get element attributes for DOMNode-compatible response
    if element_id:
        try:
            rect = _wda_request(udid, 'GET', f'/session/{session_id}/element/{element_id}/rect')
            rect_val = rect.get("value", {})
            x = rect_val.get("x", 0)
            y = rect_val.get("y", 0)
            w = rect_val.get("width", 0)
            h = rect_val.get("height", 0)
            bounds = [x, y, x + w, y + h]
        except Exception:
            bounds = [0, 0, 0, 0]

        try:
            label_resp = _wda_request(udid, 'GET', f'/session/{session_id}/element/{element_id}/attribute/label')
            label = label_resp.get("value", "")
        except Exception:
            label = ""

        try:
            type_resp = _wda_request(udid, 'GET', f'/session/{session_id}/element/{element_id}/attribute/type')
            el_type = type_resp.get("value", "")
        except Exception:
            el_type = ""

        try:
            enabled_resp = _wda_request(udid, 'GET', f'/session/{session_id}/element/{element_id}/enabled')
            el_enabled = enabled_resp.get("value", True)
        except Exception:
            el_enabled = True

        return {
            "elementId": element_id,
            "bounds": bounds,
            "text": label,
            "className": el_type,
            "enabled": el_enabled,
            "clickable": True,
        }

    raise BridgeError("Element not found", ErrorCode.WDA_REQUEST_FAILED)


async def _wda_find_elements(udid, selector):
    """Find multiple elements via WDA using the best iOS selector strategy.

    Returns list of element dicts with { elementId, bounds, text, className }.
    """
    strategy = _best_ios_selector(selector)
    if not strategy:
        raise BridgeError("Cannot build iOS selector from empty selector", ErrorCode.INVALID_PARAMS)

    using, value = strategy
    session_id = _get_or_create_wda_session(udid)
    result = _wda_request(udid, 'POST', f'/session/{session_id}/elements', {
        "using": using,
        "value": value,
    })

    elements = result.get("value", [])
    results = []
    for el in elements:
        element_id = el.get("ELEMENT", "")
        if not element_id:
            continue

        try:
            rect = _wda_request(udid, 'GET', f'/session/{session_id}/element/{element_id}/rect')
            rect_val = rect.get("value", {})
            x = rect_val.get("x", 0)
            y = rect_val.get("y", 0)
            w = rect_val.get("width", 0)
            h = rect_val.get("height", 0)
            bounds = [x, y, x + w, y + h]
        except Exception:
            bounds = [0, 0, 0, 0]

        try:
            label_resp = _wda_request(udid, 'GET', f'/session/{session_id}/element/{element_id}/attribute/label')
            label = label_resp.get("value", "")
        except Exception:
            label = ""

        try:
            type_resp = _wda_request(udid, 'GET', f'/session/{session_id}/element/{element_id}/attribute/type')
            el_type = type_resp.get("value", "")
        except Exception:
            el_type = ""

        results.append({
            "elementId": element_id,
            "bounds": bounds,
            "text": label,
            "className": el_type,
        })

    return results


async def _wda_click_element(udid, element_id):
    """Click an element by its WDA element ID."""
    session_id = _get_or_create_wda_session(udid)
    _wda_request(udid, 'POST', f'/session/{session_id}/element/{element_id}/click', {})
    return {"success": True}


async def _wda_tap(udid, x, y):
    """Tap at coordinates via WDA."""
    # Create or reuse session
    session_id = _get_or_create_wda_session(udid)
    _wda_request(udid, 'POST', f'/session/{session_id}/wda/tap/0', {"x": x, "y": y})
    return {"success": True}


async def _wda_swipe(udid, start_x, start_y, end_x, end_y, duration=0.3):
    """Swipe gesture via WDA."""
    session_id = _get_or_create_wda_session(udid)
    _wda_request(udid, 'POST', f'/session/{session_id}/wda/dragfromtoforduration', {
        "fromX": start_x, "fromY": start_y,
        "toX": end_x, "toY": end_y,
        "duration": duration,
    })
    return {"success": True}


async def _wda_window_size(udid):
    """Get the window size of the device via WDA."""
    session_id = _get_or_create_wda_session(udid)
    result = _wda_request(udid, 'GET', f'/session/{session_id}/window/size')
    value = result.get("value", {})
    return {"width": value.get("width", 0), "height": value.get("height", 0)}


async def _wda_pressbutton(udid, button):
    """Press a hardware button via WDA (home, volumeUp, volumeDown)."""
    session_id = _get_or_create_wda_session(udid)
    _wda_request(udid, 'POST', f'/session/{session_id}/wda/pressButton', {"name": button})
    return {"success": True}


async def _wda_status(udid):
    """Get WDA status for a device."""
    state = _wda_state.get(udid)
    if not state or not state.get("port"):
        return {"running": False, "udid": udid}
    try:
        result = _wda_request(udid, 'GET', '/status')
        return {"running": True, "udid": udid, "port": state["port"], "status": result}
    except Exception:
        return {"running": False, "udid": udid}


def _get_or_create_wda_session(udid):
    """Get or create a WDA session for touch interactions."""
    state = _wda_state.get(udid, {})
    if state.get("session_id"):
        return state["session_id"]

    # Create a new session
    result = _wda_request(udid, 'POST', '/session', {"capabilities": {}})
    session_id = result.get("sessionId") or result.get("value", {}).get("sessionId", "")
    if session_id:
        state["session_id"] = session_id
        _wda_state[udid] = state
    return session_id


# Sync wrappers for dispatch table (used by tests and RPC handler)
def list_devices():
    return asyncio.run(_list_devices())

def device_info(udid):
    return asyncio.run(_device_info(udid))

def pair(udid):
    return asyncio.run(_pair(udid))

def check_paired(udid):
    return asyncio.run(_check_paired(udid))

def install_wda(udid):
    return asyncio.run(_install_wda(udid))

def launch_wda(udid):
    return asyncio.run(_launch_wda(udid))

def stop_wda(udid):
    _stop_wda(udid)
    return {"success": True, "udid": udid}

def wda_status(udid):
    return asyncio.run(_wda_status(udid))

def wda_screenshot(udid):
    return asyncio.run(_wda_screenshot(udid))

def wda_dom(udid):
    return asyncio.run(_wda_dom(udid))

def wda_dom_parsed(udid):
    return asyncio.run(_wda_dom_parsed(udid))

def wda_find_element(udid, selector):
    return asyncio.run(_wda_find_element(udid, selector))

def wda_find_elements(udid, selector):
    return asyncio.run(_wda_find_elements(udid, selector))

def wda_click_element(udid, element_id):
    return asyncio.run(_wda_click_element(udid, element_id))

def wda_tap(udid, x, y):
    return asyncio.run(_wda_tap(udid, x, y))

def wda_swipe(udid, start_x, start_y, end_x, end_y, duration=0.3):
    return asyncio.run(_wda_swipe(udid, start_x, start_y, end_x, end_y, duration))

def wda_window_size(udid):
    return asyncio.run(_wda_window_size(udid))

def wda_pressbutton(udid, button):
    return asyncio.run(_wda_pressbutton(udid, button))


# ---- Syslog streaming (Phase 1.5) ----

class SyslogManager:
    """Manages per-device syslog streaming with a ring buffer.

    Runs OsTraceService.syslog() (an async generator) in a daemon thread
    via asyncio.run() so Flask request handlers remain unblocked.
    """

    def __init__(self):
        self._streams = {}  # udid -> { 'running': bool, 'buffer': deque, 'total': int }
        self._lock = threading.Lock()

    def start(self, udid):
        with self._lock:
            if udid in self._streams and self._streams[udid]['running']:
                return  # already streaming

            buffer = deque(maxlen=1000)
            state = {'running': True, 'buffer': buffer, 'total': 0}
            self._streams[udid] = state

        def _stream_worker():
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            try:
                loop.run_until_complete(self._stream_syslog(udid, state))
            except Exception as e:
                _append_error(state, f'Syslog stream crashed: {e}')
            finally:
                state['running'] = False
                loop.close()

        t = threading.Thread(target=_stream_worker, daemon=True, name=f'syslog-{udid}')
        t.start()

    async def _stream_syslog(self, udid, state):
        try:
            client = await _get_lockdown_client(udid)
        except Exception as e:
            _append_error(state, f'Cannot connect to device: {e}')
            return

        try:
            from pymobiledevice3.services.os_trace import OsTraceService
        except ImportError as e:
            _append_error(state, f'OsTraceService not available: {e}')
            return

        try:
            async with OsTraceService(lockdown=client) as svc:
                async for entry in svc.syslog():
                    if not state['running']:
                        break
                    record = _format_syslog_entry(entry)
                    with self._lock:
                        state['buffer'].append(record)
                        state['total'] += 1
        except Exception as e:
            _append_error(state, f'Syslog stream error: {e}')

    def stop(self, udid):
        with self._lock:
            if udid in self._streams:
                self._streams[udid]['running'] = False
                del self._streams[udid]

    def poll(self, udid, since_index=0):
        """Return new entries since the given absolute index."""
        with self._lock:
            stream = self._streams.get(udid)
            if not stream:
                return {'entries': [], 'running': False, 'nextIndex': since_index}
            buf = list(stream['buffer'])
            total = stream['total']
            running = stream['running']

        # The ring buffer keeps the last 1000 entries.
        # total = absolute count of all entries ever appended.
        # buf[i] corresponds to absolute index (total - len(buf) + i).
        buf_start = total - len(buf)
        if since_index >= total:
            return {'entries': [], 'running': running, 'nextIndex': total}

        # Clamp since_index to the oldest available entry
        clamped = max(since_index, buf_start)
        slice_start = clamped - buf_start
        new_entries = buf[slice_start:]
        return {
            'entries': new_entries,
            'running': running,
            'nextIndex': total,
        }

    def is_streaming(self, udid):
        with self._lock:
            s = self._streams.get(udid)
            return s is not None and s['running']


def _format_syslog_entry(entry):
    """Convert a SyslogEntry to a JSON-serialisable dict."""
    try:
        ts = entry.timestamp.isoformat() if hasattr(entry.timestamp, 'isoformat') else str(entry.timestamp)
    except Exception:
        ts = ''

    try:
        level_val = entry.level
        # SyslogLogLevel is an IntEnum — get its name
        level_str = level_val.name if hasattr(level_val, 'name') else str(level_val)
    except Exception:
        level_str = ''

    subsystem = ''
    category = ''
    if getattr(entry, 'label', None) is not None:
        subsystem = getattr(entry.label, 'subsystem', '') or ''
        category = getattr(entry.label, 'category', '') or ''

    return {
        'timestamp': ts,
        'pid': getattr(entry, 'pid', 0),
        'process': getattr(entry, 'image_name', '') or '',
        'level': level_str,
        'message': getattr(entry, 'message', '') or '',
        'subsystem': subsystem,
        'category': category,
    }


def _append_error(state, message):
    record = {
        'timestamp': '',
        'pid': 0,
        'process': 'ios_bridge',
        'level': 'ERROR',
        'message': message,
        'subsystem': '',
        'category': '',
    }
    state['buffer'].append(record)
    state['total'] += 1


_syslog_manager = SyslogManager()


def syslog_start(udid):
    _syslog_manager.start(udid)
    return {'status': 'started', 'udid': udid}


def syslog_stop(udid):
    _syslog_manager.stop(udid)
    return {'status': 'stopped', 'udid': udid}


def syslog_poll(udid, since_index=0):
    return _syslog_manager.poll(udid, since_index)


# ---- Phase 1.5: Native (no-WDA) methods ----

async def _list_apps(udid):
    """List installed user apps on the iOS device via InstallationProxyService."""
    client = await _get_lockdown_client(udid)
    try:
        from pymobiledevice3.services.installation_proxy import InstallationProxyService
        async with InstallationProxyService(lockdown=client) as svc:
            apps = await svc.get_apps(application_type='User', calculate_sizes=True)
    except Exception as e:
        raise BridgeError(f"Failed to list apps on {udid}: {e}")
    result = []
    for bundle_id, info in apps.items():
        result.append({
            'packageName': bundle_id,
            'name': info.get('CFBundleDisplayName') or info.get('CFBundleName') or bundle_id,
            'versionName': info.get('CFBundleShortVersionString', ''),
            'versionCode': info.get('CFBundleVersion', ''),
            'sizeBytes': info.get('StaticDiskUsage', 0),
        })
    return sorted(result, key=lambda a: a['name'].lower())


# Cache DDI mount failures per-device so we don't retry every poll request.
# Maps udid -> error message string.  Cleared on bridge restart.
_ddi_mount_failed = {}

async def _screenshot_native(udid):
    """Take a screenshot using ScreenshotService (requires Developer Disk Image)."""
    from pymobiledevice3.services.screenshot import ScreenshotService

    # Fast-fail if we already know DDI mount is broken for this device
    if udid in _ddi_mount_failed:
        raise BridgeError(
            f"Native screenshot unavailable for {udid}: {_ddi_mount_failed[udid]}"
        )

    client = await _get_lockdown_client(udid)
    try:
        async with ScreenshotService(lockdown=client) as svc:
            png_bytes = await svc.take_screenshot()
    except Exception as first_err:
        if 'InvalidService' not in str(first_err):
            raise BridgeError(f"Native screenshot failed for {udid}: {first_err}")
        # Developer Disk Image not mounted — try auto-mounting once
        try:
            from pymobiledevice3.services.mobile_image_mounter import auto_mount
            logger.info(f"Auto-mounting Developer Disk Image for {udid}...")
            await auto_mount(client)
        except Exception as mount_err:
            reason = str(mount_err) or "DDI version incompatible with device iOS version"
            _ddi_mount_failed[udid] = reason
            logger.warning(
                f"DDI auto-mount failed for {udid}: {reason}. "
                f"Native screenshots disabled — use WDA instead."
            )
            raise BridgeError(
                f"Native screenshot unavailable for {udid}: screenshotr service requires "
                f"Developer Disk Image but auto-mount failed ({reason}). "
                f"Start WebDriverAgent for screenshots on this device."
            )
        # Retry with a fresh lockdown client after mounting
        client = await _get_lockdown_client(udid)
        try:
            async with ScreenshotService(lockdown=client) as svc:
                png_bytes = await svc.take_screenshot()
        except Exception as retry_err:
            _ddi_mount_failed[udid] = str(retry_err)
            raise BridgeError(f"Native screenshot failed for {udid} after DDI mount: {retry_err}")

    return {
        'image': base64.b64encode(png_bytes).decode('ascii'),
        'format': 'png',
    }


async def _screenshot_tunnel(udid):
    """Take a screenshot via DVT instruments through a CoreDevice tunnel.

    This is the primary screenshot path for iOS 17+.  Requires the
    ``pymobiledevice3 remote tunneld`` daemon to be running externally
    (needs admin privileges).
    """
    tunnel_info = _get_tunnel_info(udid)
    if not tunnel_info:
        if not _tunneld_is_available():
            raise BridgeError(
                "CoreDevice tunnel not available. "
                "Start tunneld in an admin terminal: pymobiledevice3 remote tunneld",
                ErrorCode.TUNNEL_NOT_AVAILABLE,
            )
        raise BridgeError(
            f"No tunnel for device {udid}. "
            "Ensure the device is unlocked and Developer Mode is enabled "
            "(Settings > Privacy & Security > Developer Mode).",
            ErrorCode.TUNNEL_NOT_AVAILABLE,
        )

    host, port = tunnel_info["host"], tunnel_info["port"]

    try:
        from pymobiledevice3.remote.remote_service_discovery import RemoteServiceDiscoveryService
        from pymobiledevice3.services.dvt.instruments.dvt_provider import DvtProvider
        from pymobiledevice3.services.dvt.instruments.screenshot import Screenshot

        rsd = RemoteServiceDiscoveryService((host, port))
        async with rsd:
            async with DvtProvider(rsd) as dvt:
                async with Screenshot(dvt) as ss:
                    png_bytes = await asyncio.wait_for(ss.get_screenshot(), timeout=15)
    except asyncio.TimeoutError:
        raise BridgeError(f"Tunnel screenshot timed out for {udid}")
    except (ConnectionError, OSError) as e:
        raise BridgeError(f"Tunnel connection lost for {udid}: {e}")
    except BridgeError:
        raise
    except Exception as e:
        raise BridgeError(f"Tunnel screenshot failed for {udid}: {e}")

    return {
        'image': base64.b64encode(png_bytes).decode('ascii'),
        'format': 'png',
    }


async def _screenshot_auto(udid):
    """Auto-detect the best screenshot method based on iOS version and services.

    Fallback order:
      iOS 17+:  tunnel DVT  ->  WDA
      iOS < 17: WDA  ->  native (lockdown ScreenshotService)  ->  tunnel DVT
      Unknown:  tunnel DVT  ->  WDA  ->  native
    """
    ios_major = await _get_ios_major(udid)
    errors = []

    if ios_major is not None and ios_major >= 17:
        # iOS 17+: tunnel is the primary path
        for method, name in [(_screenshot_tunnel, "tunnel"), (_wda_screenshot, "WDA")]:
            try:
                return await method(udid)
            except Exception as e:
                errors.append(f"{name}: {e}")
        raise BridgeError(
            f"Screenshot failed for iOS {ios_major} device {udid}. "
            f"Tried: {'; '.join(errors)}. "
            "For iOS 17+, ensure tunneld is running (pymobiledevice3 remote tunneld) "
            "and Developer Mode is enabled on the device.",
        )

    if ios_major is not None and ios_major < 17:
        # Older iOS: WDA and native lockdown work without tunnel
        for method, name in [
            (_wda_screenshot, "WDA"),
            (_screenshot_native, "native"),
            (_screenshot_tunnel, "tunnel"),
        ]:
            try:
                return await method(udid)
            except Exception as e:
                errors.append(f"{name}: {e}")
        raise BridgeError(
            f"Screenshot failed for iOS {ios_major} device {udid}. "
            f"Tried: {'; '.join(errors)}",
        )

    # Unknown iOS version: try everything
    for method, name in [
        (_screenshot_tunnel, "tunnel"),
        (_wda_screenshot, "WDA"),
        (_screenshot_native, "native"),
    ]:
        try:
            return await method(udid)
        except Exception as e:
            errors.append(f"{name}: {e}")
    raise BridgeError(
        f"All screenshot methods failed for {udid}. Tried: {'; '.join(errors)}",
    )


async def _device_restart(udid):
    """Restart the device via DiagnosticsService."""
    client = await _get_lockdown_client(udid)
    try:
        from pymobiledevice3.services.diagnostics import DiagnosticsService
        async with DiagnosticsService(client) as diag:
            await diag.restart()
        return {'status': 'restarting'}
    except Exception as e:
        raise BridgeError(f"Failed to restart device {udid}: {e}")


async def _device_shutdown(udid):
    """Shut down the device via DiagnosticsService."""
    client = await _get_lockdown_client(udid)
    try:
        from pymobiledevice3.services.diagnostics import DiagnosticsService
        async with DiagnosticsService(client) as diag:
            await diag.shutdown()
        return {'status': 'shutting_down'}
    except Exception as e:
        raise BridgeError(f"Failed to shut down device {udid}: {e}")


async def _device_sleep(udid):
    """Put device to sleep via DiagnosticsService."""
    client = await _get_lockdown_client(udid)
    try:
        from pymobiledevice3.services.diagnostics import DiagnosticsService
        async with DiagnosticsService(client) as diag:
            await diag.sleep()
        return {'status': 'sleeping'}
    except Exception as e:
        raise BridgeError(f"Failed to sleep device {udid}: {e}")


async def _list_crash_logs(udid):
    """List crash reports on the device."""
    client = await _get_lockdown_client(udid)
    try:
        from pymobiledevice3.services.crash_reports import CrashReportsManager
        async with CrashReportsManager(lockdown=client) as crash:
            await crash.flush()
            files = await crash.ls('/')
    except Exception as e:
        raise BridgeError(f"Failed to list crash logs on {udid}: {e}")
    results = []
    for f in sorted(files, reverse=True)[:50]:
        results.append({
            'filename': f,
            'path': f,
        })
    return results


async def _get_crash_log(udid, path):
    """Read a specific crash log from the device."""
    client = await _get_lockdown_client(udid)
    try:
        from pymobiledevice3.services.crash_reports import CrashReportsManager
        async with CrashReportsManager(lockdown=client) as crash:
            content = await crash.afc.get_file_contents(path)
        return {'content': content.decode('utf-8', errors='replace')}
    except Exception as e:
        raise BridgeError(f"Failed to read crash log {path} on {udid}: {e}")


async def _list_processes(udid):
    """List running processes using OsTraceService."""
    client = await _get_lockdown_client(udid)
    try:
        from pymobiledevice3.services.os_trace import OsTraceService
        async with OsTraceService(lockdown=client) as svc:
            pids = await svc.get_pid_list()
        return [{'pid': pid, 'name': name} for name, pid in pids.items()]
    except Exception as e:
        raise BridgeError(f"Failed to list processes on {udid}: {e}")


# Sync wrappers for Phase 1.5 methods
def list_apps(udid):
    return asyncio.run(_list_apps(udid))

def screenshot_native(udid):
    return asyncio.run(_screenshot_native(udid))

def screenshot_tunnel(udid):
    return asyncio.run(_screenshot_tunnel(udid))

def screenshot_auto(udid):
    return asyncio.run(_screenshot_auto(udid))

def tunnel_status():
    """Check tunneld availability and list active device tunnels."""
    available = _tunneld_is_available()
    devices = {}
    if available:
        try:
            resp = urllib.request.urlopen(f"{TUNNELD_URL}/", timeout=3)
            data = json.loads(resp.read().decode())
            for device_udid, tunnel_list in data.items():
                if tunnel_list:
                    t = tunnel_list[0]
                    devices[device_udid] = {
                        "host": t.get("tunnel-address"),
                        "port": int(t.get("tunnel-port", 0)),
                    }
        except Exception:
            pass
    return {"available": available, "devices": devices}

def device_restart(udid):
    return asyncio.run(_device_restart(udid))

def device_shutdown(udid):
    return asyncio.run(_device_shutdown(udid))

def device_sleep(udid):
    return asyncio.run(_device_sleep(udid))

def list_crash_logs(udid):
    return asyncio.run(_list_crash_logs(udid))

def get_crash_log(udid, path):
    return asyncio.run(_get_crash_log(udid, path))

def list_processes(udid):
    return asyncio.run(_list_processes(udid))


# Method dispatch table
METHODS = {
    "list_devices": list_devices,
    "device_info": device_info,
    "pair": pair,
    "check_paired": check_paired,
    "install_wda": install_wda,
    "launch_wda": launch_wda,
    "stop_wda": stop_wda,
    "wda_status": wda_status,
    "wda_screenshot": wda_screenshot,
    "wda_dom": wda_dom,
    "wda_dom_parsed": wda_dom_parsed,
    "wda_find_element": wda_find_element,
    "wda_find_elements": wda_find_elements,
    "wda_click_element": wda_click_element,
    "wda_tap": wda_tap,
    "wda_swipe": wda_swipe,
    "wda_window_size": wda_window_size,
    "wda_pressbutton": wda_pressbutton,
    # Phase 1.5 — native (no WDA) methods
    "list_apps": list_apps,
    "screenshot_native": screenshot_native,
    "screenshot_tunnel": screenshot_tunnel,
    "screenshot_auto": screenshot_auto,
    "tunnel_status": tunnel_status,
    "device_restart": device_restart,
    "device_shutdown": device_shutdown,
    "device_sleep": device_sleep,
    "list_crash_logs": list_crash_logs,
    "get_crash_log": get_crash_log,
    "list_processes": list_processes,
    # Phase 1.5 — syslog streaming
    "syslog_start": syslog_start,
    "syslog_stop": syslog_stop,
    "syslog_poll": syslog_poll,
}


@app.route('/health', methods=['GET'])
def health():
    return jsonify({"status": "ok", "service": "ios_bridge"})


@app.route('/rpc', methods=['POST'])
def rpc():
    try:
        body = request.get_json(force=True)
    except Exception:
        return _make_response(error={"code": -32700, "message": "Parse error"})

    req_id = body.get("id")
    method = body.get("method")
    params = body.get("params", {})

    if not method:
        return _make_response(error={"code": ErrorCode.INVALID_REQUEST, "message": "Missing method"}, req_id=req_id)

    fn = METHODS.get(method)
    if not fn:
        return _make_response(error={"code": ErrorCode.METHOD_NOT_FOUND, "message": f"Unknown method: {method}"}, req_id=req_id)

    try:
        if isinstance(params, dict):
            result = fn(**params)
        elif isinstance(params, list):
            result = fn(*params)
        else:
            result = fn()
        return _make_response(result=result, req_id=req_id)
    except BridgeError as e:
        return _make_response(error={"code": e.code, "message": str(e), "data": e.data}, req_id=req_id)
    except Exception as e:
        logger.error(f"RPC error in {method}: {traceback.format_exc()}")
        return _make_response(error={"code": -32000, "message": str(e)}, req_id=req_id)


def main():
    parser = argparse.ArgumentParser(description='iOS Bridge JSON-RPC server')
    parser.add_argument('--port', type=int, default=9200, help='Port to listen on')
    args = parser.parse_args()

    # Verify pymobiledevice3 is available
    try:
        import pymobiledevice3
        from importlib.metadata import version as pkg_version
        ver = pkg_version('pymobiledevice3')
        logger.info(f"pymobiledevice3 version: {ver}")
    except ImportError:
        logger.error("pymobiledevice3 is not installed. Run: pip install pymobiledevice3")
        sys.exit(1)

    logger.info(f"Starting iOS Bridge on port {args.port}")
    app.run(host='127.0.0.1', port=args.port, debug=False, use_reloader=False)


if __name__ == '__main__':
    main()
