import pytest
import sys
import os
import threading

# Ensure the python directory is in the path
sys.path.insert(0, os.path.join(os.path.dirname(__file__)))


class TestFridaErrorCodes:
    def test_error_codes_defined(self):
        from bridge import ErrorCode
        assert ErrorCode.FRIDA_NOT_AVAILABLE == -32010
        assert ErrorCode.FRIDA_SERVER_NOT_RUNNING == -32011
        assert ErrorCode.FRIDA_SPAWN_FAILED == -32012
        assert ErrorCode.FRIDA_ATTACH_FAILED == -32013
        assert ErrorCode.FRIDA_SCRIPT_ERROR == -32014


class TestFridaGetMessages:
    def setup_method(self):
        import bridge
        bridge._frida_message_lock = threading.Lock()
        bridge._frida_messages.clear()

    def test_returns_empty_when_no_messages(self):
        from bridge import handle_frida_get_messages
        result = handle_frida_get_messages({'since': 0})
        assert result['messages'] == []
        assert result['next_index'] == 0

    def test_returns_messages_since_index(self):
        import bridge
        from bridge import handle_frida_get_messages
        bridge._frida_messages.extend([
            {'type': 'log', 'payload': 'msg1', 'timestamp': '2026-01-01T00:00:00'},
            {'type': 'send', 'payload': {'data': 1}, 'timestamp': '2026-01-01T00:00:01'},
            {'type': 'error', 'payload': 'bad', 'timestamp': '2026-01-01T00:00:02'},
        ])
        result = handle_frida_get_messages({'since': 1})
        assert len(result['messages']) == 2
        assert result['next_index'] == 3

    def test_defaults_since_to_zero(self):
        import bridge
        from bridge import handle_frida_get_messages
        bridge._frida_messages.append({'type': 'log', 'payload': 'test', 'timestamp': 'now'})
        result = handle_frida_get_messages({})
        assert len(result['messages']) == 1


class TestFridaRunParamValidation:
    """Test parameter validation for handle_frida_run (CLI-based)."""

    def setup_method(self):
        import bridge
        bridge._frida_message_lock = threading.Lock()

    def test_spawn_mode_requires_bundle_id(self):
        from bridge import handle_frida_run, BridgeError, ErrorCode
        with pytest.raises(BridgeError) as exc:
            handle_frida_run({'mode': 'spawn'})
        assert exc.value.code == ErrorCode.INVALID_PARAMS

    def test_spawn_mode_default_requires_bundle_id(self):
        from bridge import handle_frida_run, BridgeError, ErrorCode
        with pytest.raises(BridgeError) as exc:
            handle_frida_run({})
        assert exc.value.code == ErrorCode.INVALID_PARAMS

    def test_attach_mode_requires_pid_or_app_name(self):
        from bridge import handle_frida_run, BridgeError, ErrorCode
        with pytest.raises(BridgeError) as exc:
            handle_frida_run({'mode': 'attach'})
        assert exc.value.code == ErrorCode.INVALID_PARAMS


class TestFridaSpawnControlledParamValidation:
    """Test parameter validation for handle_frida_spawn_controlled (Python API)."""

    def test_requires_bundle_id(self):
        from bridge import handle_frida_spawn_controlled, BridgeError, ErrorCode
        with pytest.raises(BridgeError) as exc:
            handle_frida_spawn_controlled({})
        assert exc.value.code == ErrorCode.INVALID_PARAMS


class TestFridaStopServer:
    def setup_method(self):
        import bridge
        bridge._frida_device = None
        bridge._frida_process = None
        bridge._frida_session = None
        bridge._frida_script = None
        bridge._frida_message_lock = threading.Lock()

    def test_stop_clears_state(self):
        import bridge
        # Mock the ADB call to not actually run
        original = bridge._adb_run
        bridge._adb_run = lambda *a, **kw: ''
        try:
            result = bridge.handle_frida_stop_server({})
            assert result == {'status': 'stopped'}
            assert bridge._frida_device is None
        finally:
            bridge._adb_run = original
