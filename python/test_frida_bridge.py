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


class TestFridaErrorPreservation:
    """Bug #5: known frida errors must propagate with their original message
    instead of being swallowed into a generic 'Internal error'."""

    def setup_method(self):
        import bridge
        bridge._frida_device = None
        bridge._frida_session = None
        bridge._frida_script = None
        bridge._frida_message_lock = threading.Lock()

    def test_spawn_controlled_preserves_frida_error_message(self):
        """When device.spawn raises (e.g. frida.NotSupportedError 'need Gadget
        to attach on jailed Android'), the original message must reach the
        caller as a BridgeError — not be hidden by the dispatcher's generic
        'Internal error — see server logs' fallback."""
        import bridge
        from bridge import handle_frida_spawn_controlled, BridgeError
        from unittest.mock import MagicMock

        original_start = bridge.handle_frida_start_server
        original_get_dev = bridge._get_frida_device
        bridge.handle_frida_start_server = lambda *a, **kw: {'status': 'running'}

        # Real frida exception subclasses Exception; the bridge fix should
        # propagate by class name, not require a frida-package import. Use
        # `type(...)` so the created class's `__name__` is exactly
        # 'NotSupportedError' to match what _map_frida_exception_code reads.
        boom = type('NotSupportedError', (Exception,), {})('need Gadget to attach on jailed Android')
        fake_device = MagicMock()
        fake_device.spawn.side_effect = boom
        bridge._get_frida_device = lambda: fake_device

        try:
            with pytest.raises(BridgeError) as exc:
                handle_frida_spawn_controlled({'bundle_id': 'com.x', 'code': ''})
            assert 'need Gadget to attach on jailed Android' in str(exc.value), \
                f"original frida error message lost; got: {exc.value}"
        finally:
            bridge.handle_frida_start_server = original_start
            bridge._get_frida_device = original_get_dev


class TestFridaProcessCleanup:
    """Bug #6: re.frida.helper / re.frida.agent / re.frida.server children
    survive after pkill, holding IPC state that blocks the next frida-server
    launch. The cleanup helper must use explicit `killall <name>` against the
    known process names AND loop until pgrep shows nothing left (or timeout)."""

    def setup_method(self):
        import bridge
        bridge._frida_device = None
        bridge._frida_message_lock = threading.Lock()

    def test_cleanup_uses_killall_with_explicit_names(self):
        import bridge
        calls = []
        def fake_adb(args, timeout=10):
            calls.append(args[0] if args else '')
            return ''  # pgrep returns empty → cleanup terminates after one round
        original = bridge._adb_run
        bridge._adb_run = fake_adb
        try:
            bridge._kill_all_frida_processes(timeout_s=2)
        finally:
            bridge._adb_run = original

        joined = ' ; '.join(calls)
        # Must explicitly killall each known frida process name (Linux comm
        # name limit + reparenting to PID 1 makes pkill -f unreliable on
        # some Android builds).
        for name in ['frida-server', 're.frida.server.32', 're.frida.server.64',
                     're.frida.helper.32', 're.frida.helper.64']:
            assert name in joined, f"cleanup should explicitly killall {name}; calls: {calls}"

    def test_cleanup_loops_until_pgrep_empty(self):
        import bridge
        import time as _t

        # First pgrep call returns processes; second returns empty.
        pgrep_responses = iter([
            're.frida.helper.64\n12345\n',  # first probe: still running
            '',                              # second probe: clean
        ])
        kill_count = [0]
        def fake_adb(args, timeout=10):
            cmd = args[0] if args else ''
            if 'pgrep' in cmd:
                try:
                    return next(pgrep_responses)
                except StopIteration:
                    return ''
            if 'killall' in cmd or 'pkill' in cmd:
                kill_count[0] += 1
            return ''
        original = bridge._adb_run
        bridge._adb_run = fake_adb
        try:
            bridge._kill_all_frida_processes(timeout_s=2)
        finally:
            bridge._adb_run = original

        # Should have issued kill commands at least twice (once per loop iter
        # while pgrep was non-empty, plus a final pass).
        assert kill_count[0] >= 2, \
            f"cleanup should loop while pgrep shows processes; kill_count={kill_count[0]}"

    def test_cleanup_terminates_on_timeout(self):
        """If processes never go away, the cleanup must give up (best-effort)
        rather than hanging the bridge forever."""
        import bridge
        def fake_adb(args, timeout=10):
            cmd = args[0] if args else ''
            if 'pgrep' in cmd:
                return 'frida-server\n9999\n'  # always non-empty
            return ''
        original = bridge._adb_run
        bridge._adb_run = fake_adb
        try:
            t0 = __import__('time').monotonic()
            bridge._kill_all_frida_processes(timeout_s=0.5)
            elapsed = __import__('time').monotonic() - t0
        finally:
            bridge._adb_run = original
        assert elapsed < 2.0, f"cleanup should time out promptly; took {elapsed:.2f}s"
