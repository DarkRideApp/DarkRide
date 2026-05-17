"""Tests for ios_bridge.py with mocked pymobiledevice3."""

import json
import sys
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

# Mock pymobiledevice3 before importing ios_bridge
sys.modules['pymobiledevice3'] = MagicMock()
sys.modules['pymobiledevice3.usbmux'] = MagicMock()
sys.modules['pymobiledevice3.lockdown'] = MagicMock()
sys.modules['pymobiledevice3.services'] = MagicMock()
sys.modules['pymobiledevice3.services.diagnostics'] = MagicMock()

from python.ios_bridge import app, list_devices, device_info, pair, check_paired, BridgeError


@pytest.fixture
def client():
    app.config['TESTING'] = True
    with app.test_client() as client:
        yield client


class TestHealthEndpoint:
    def test_health_returns_ok(self, client):
        resp = client.get('/health')
        data = json.loads(resp.data)
        assert resp.status_code == 200
        assert data['status'] == 'ok'
        assert data['service'] == 'ios_bridge'


class TestRpcEndpoint:
    def test_rpc_unknown_method(self, client):
        resp = client.post('/rpc', data=json.dumps({
            'jsonrpc': '2.0', 'id': 1, 'method': 'unknown_method'
        }), content_type='application/json')
        data = json.loads(resp.data)
        assert data['error']['code'] == -32601

    def test_rpc_missing_method(self, client):
        resp = client.post('/rpc', data=json.dumps({
            'jsonrpc': '2.0', 'id': 1
        }), content_type='application/json')
        data = json.loads(resp.data)
        assert data['error']['code'] == -32600


class TestListDevices:
    @patch('python.ios_bridge._get_usbmux_devices', new_callable=AsyncMock)
    def test_list_devices_empty(self, mock_list):
        mock_list.return_value = []
        result = list_devices()
        assert result == []

    @patch('python.ios_bridge._get_lockdown_client', new_callable=AsyncMock)
    @patch('python.ios_bridge._get_usbmux_devices', new_callable=AsyncMock)
    def test_list_devices_paired(self, mock_list, mock_lockdown):
        mock_dev = MagicMock()
        mock_dev.serial = 'UDID-123'
        mock_list.return_value = [mock_dev]

        mock_client = MagicMock()
        mock_client.all_values = {
            'DeviceName': 'Test iPhone',
            'ProductType': 'iPhone14,5',
            'ModelNumber': 'MQ3H3',
            'ProductVersion': '17.4',
            'BuildVersion': '21E219',
        }
        mock_lockdown.return_value = mock_client

        result = list_devices()
        assert len(result) == 1
        assert result[0]['udid'] == 'UDID-123'
        assert result[0]['device_name'] == 'Test iPhone'
        assert result[0]['ios_version'] == '17.4'
        assert result[0]['paired'] is True

    @patch('python.ios_bridge._get_lockdown_client', new_callable=AsyncMock)
    @patch('python.ios_bridge._get_usbmux_devices', new_callable=AsyncMock)
    def test_list_devices_unpaired(self, mock_list, mock_lockdown):
        mock_dev = MagicMock()
        mock_dev.serial = 'UDID-456'
        mock_list.return_value = [mock_dev]
        mock_lockdown.side_effect = Exception('Not paired')

        result = list_devices()
        assert len(result) == 1
        assert result[0]['udid'] == 'UDID-456'
        assert result[0]['paired'] is False


class TestDeviceInfo:
    @patch('python.ios_bridge._get_lockdown_client', new_callable=AsyncMock)
    def test_device_info_success(self, mock_lockdown):
        mock_client = MagicMock()
        mock_client.all_values = {
            'DeviceName': 'Test iPhone',
            'ProductType': 'iPhone14,5',
            'ModelNumber': 'MQ3H3',
            'HardwareModel': 'D54pAP',
            'ProductVersion': '17.4',
            'BuildVersion': '21E219',
            'SerialNumber': 'FVFJ1234ABCD',
            'CPUArchitecture': 'arm64e',
            'TotalDiskCapacity': 256 * 1024 ** 3,
            'TotalDataAvailable': 100 * 1024 ** 3,
        }
        mock_lockdown.return_value = mock_client

        result = device_info('UDID-123')
        assert result['udid'] == 'UDID-123'
        assert result['device_name'] == 'Test iPhone'
        assert result['ios_version'] == '17.4'
        assert result['serial_number'] == 'FVFJ1234ABCD'
        assert result['cpu_architecture'] == 'arm64e'
        assert result['paired'] is True
        assert result['storage']['total_gb'] == 256.0

    @patch('python.ios_bridge._get_lockdown_client', new_callable=AsyncMock)
    def test_device_info_not_found(self, mock_lockdown):
        mock_lockdown.side_effect = Exception('Device not found')
        with pytest.raises(BridgeError):
            device_info('NONEXISTENT')


class TestPair:
    @patch('python.ios_bridge._get_lockdown_client', new_callable=AsyncMock)
    def test_pair_success(self, mock_lockdown):
        mock_client = MagicMock()
        mock_lockdown.return_value = mock_client

        result = pair('UDID-123')
        assert result['success'] is True
        mock_client.pair.assert_called_once()

    @patch('python.ios_bridge._get_lockdown_client', new_callable=AsyncMock)
    def test_pair_failure(self, mock_lockdown):
        mock_client = MagicMock()
        mock_client.pair.side_effect = Exception('User denied trust')
        mock_lockdown.return_value = mock_client

        with pytest.raises(BridgeError):
            pair('UDID-123')


class TestCheckPaired:
    @patch('python.ios_bridge._get_lockdown_client', new_callable=AsyncMock)
    def test_check_paired_true(self, mock_lockdown):
        mock_client = MagicMock()
        mock_client.all_values = {'DeviceName': 'Test'}
        mock_lockdown.return_value = mock_client

        result = check_paired('UDID-123')
        assert result['paired'] is True

    @patch('python.ios_bridge._get_lockdown_client', new_callable=AsyncMock)
    def test_check_paired_false(self, mock_lockdown):
        mock_lockdown.side_effect = Exception('Not paired')

        result = check_paired('UDID-123')
        assert result['paired'] is False
