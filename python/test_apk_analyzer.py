"""Tests for apk_analyzer.py — protocol and basic functionality."""

import importlib.util
import json
import sqlite3
import subprocess
import os
import sys
import stat
import tempfile
import zstandard as zstd

import pytest

# Allow direct import of the analyzer module for unit tests
sys.path.insert(0, os.path.dirname(__file__))
from apk_analyzer import _is_likely_base64_secret, detect_react_native, detect_frameworks, detect_libraries, detect_build_info, HERMES_MAGIC, HERMES_BUNDLE_PATHS, _tile_to_lat_lng, detect_map_tiles, extract_map_tiles, TILE_PATH_RE, SECRET_PATTERNS, IGNORED_DEEPLINK_SCHEMES

ANALYZER_PATH = os.path.join(os.path.dirname(__file__), "apk_analyzer.py")
PYTHON = os.path.join(os.path.dirname(__file__), "..", ".venv", "bin", "python")


def start_worker():
    """Start the analyzer worker as a subprocess."""
    proc = subprocess.Popen(
        [PYTHON, ANALYZER_PATH],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    ready_line = proc.stdout.readline().strip()
    ready = json.loads(ready_line)
    assert ready["status"] == "ready"
    return proc


def send_recv(proc, msg: dict) -> dict:
    """Send a JSON message and read the final JSON response (skipping progress messages)."""
    proc.stdin.write(json.dumps(msg) + "\n")
    proc.stdin.flush()
    while True:
        line = proc.stdout.readline().strip()
        resp = json.loads(line)
        if resp.get("status") != "progress":
            return resp


class TestProtocol:
    def test_ready_message(self):
        proc = start_worker()
        resp = send_recv(proc, {"command": "shutdown"})
        assert resp["status"] == "shutdown"
        proc.wait(timeout=5)

    def test_unknown_command(self):
        proc = start_worker()
        resp = send_recv(proc, {"command": "bogus"})
        assert resp["status"] == "error"
        assert "Unknown command" in resp["error"]
        send_recv(proc, {"command": "shutdown"})
        proc.wait(timeout=5)

    def test_analyze_missing_file(self):
        proc = start_worker()
        resp = send_recv(proc, {
            "id": "test-1",
            "command": "analyze",
            "apkPath": "/nonexistent/fake.apk",
            "outputDir": "/tmp/test-analysis",
        })
        assert resp["id"] == "test-1"
        assert resp["status"] == "failed"
        assert "not found" in resp["error"]
        send_recv(proc, {"command": "shutdown"})
        proc.wait(timeout=5)

    def test_analyze_missing_params(self):
        proc = start_worker()
        resp = send_recv(proc, {"id": "test-2", "command": "analyze"})
        assert resp["id"] == "test-2"
        assert resp["status"] == "failed"
        assert "Missing" in resp["error"]
        send_recv(proc, {"command": "shutdown"})
        proc.wait(timeout=5)

    def test_invalid_json(self):
        proc = start_worker()
        proc.stdin.write("not valid json\n")
        proc.stdin.flush()
        line = proc.stdout.readline().strip()
        resp = json.loads(line)
        assert resp["status"] == "error"
        assert "Invalid JSON" in resp["error"]
        send_recv(proc, {"command": "shutdown"})
        proc.wait(timeout=5)


def _make_script(path: str, content: str):
    """Write a shell script and make it executable."""
    with open(path, "w") as f:
        f.write(content)
    os.chmod(path, os.stat(path).st_mode | stat.S_IEXEC)


class TestDecompile:
    def test_decompile_sends_result(self, tmp_path):
        """Decompile command with mocked tools should return results per tool."""
        # Create a fake APK file
        apk_file = tmp_path / "test.apk"
        apk_file.write_text("fake apk content")

        # Create mock jadx binary that succeeds (creates output dir)
        jadx_bin = str(tmp_path / "mock_jadx")
        _make_script(jadx_bin, '#!/bin/sh\nmkdir -p "$3"\nexit 0\n')

        # Create mock java binary that succeeds
        java_bin = str(tmp_path / "mock_java")
        _make_script(java_bin, '#!/bin/sh\n'
                     '# For apktool: java -jar apktool.jar d --no-res --force --output DIR APK\n'
                     'exit 0\n')

        apktool_jar = str(tmp_path / "apktool.jar")
        with open(apktool_jar, "w") as f:
            f.write("fake jar")

        output_dir = str(tmp_path / "decompile-output")

        proc = start_worker()
        resp = send_recv(proc, {
            "id": "dec-1",
            "command": "decompile",
            "apkPath": str(apk_file),
            "tools": {
                "jadx": jadx_bin,
                "apktool": apktool_jar,
                "java": java_bin,
            },
            "outputDir": output_dir,
        })

        assert resp["id"] == "dec-1"
        assert resp["status"] == "completed"
        result = resp["result"]

        # Both tools should have been run
        assert "jadx" in result
        assert "apktool" in result

        # jadx should have succeeded
        assert result["jadx"]["success"] is True
        assert "outputDir" in result["jadx"]

        # apktool should have succeeded
        assert result["apktool"]["success"] is True
        assert "outputDir" in result["apktool"]

        send_recv(proc, {"command": "shutdown"})
        proc.wait(timeout=5)

    def test_decompile_missing_apk(self, tmp_path):
        """Decompile command with nonexistent APK returns error."""
        proc = start_worker()
        resp = send_recv(proc, {
            "id": "dec-2",
            "command": "decompile",
            "apkPath": "/nonexistent/fake.apk",
            "tools": {"jadx": "/usr/bin/jadx"},
            "outputDir": str(tmp_path / "output"),
        })
        assert resp["id"] == "dec-2"
        assert resp["status"] == "failed"
        assert "not found" in resp["error"]
        send_recv(proc, {"command": "shutdown"})
        proc.wait(timeout=5)

    def test_decompile_partial_failure(self, tmp_path):
        """If one tool fails, others still succeed, result shows which failed."""
        apk_file = tmp_path / "test.apk"
        apk_file.write_text("fake apk content")

        # jadx succeeds
        jadx_bin = str(tmp_path / "mock_jadx")
        _make_script(jadx_bin, '#!/bin/sh\nmkdir -p "$3"\nexit 0\n')

        # java fails (apktool will fail)
        java_bin = str(tmp_path / "mock_java")
        _make_script(java_bin, '#!/bin/sh\nexit 1\n')

        apktool_jar = str(tmp_path / "apktool.jar")
        with open(apktool_jar, "w") as f:
            f.write("fake jar")

        output_dir = str(tmp_path / "decompile-output")

        proc = start_worker()
        resp = send_recv(proc, {
            "id": "dec-3",
            "command": "decompile",
            "apkPath": str(apk_file),
            "tools": {
                "jadx": jadx_bin,
                "apktool": apktool_jar,
                "java": java_bin,
            },
            "outputDir": output_dir,
        })

        assert resp["id"] == "dec-3"
        assert resp["status"] == "completed"
        result = resp["result"]

        # jadx succeeded
        assert result["jadx"]["success"] is True

        # apktool failed (java exits 1)
        assert result["apktool"]["success"] is False
        assert "error" in result["apktool"]

        send_recv(proc, {"command": "shutdown"})
        proc.wait(timeout=5)

    def test_decompile_missing_tool_paths(self, tmp_path):
        """Tools with null paths are skipped, not failed."""
        apk_file = tmp_path / "test.apk"
        apk_file.write_text("fake apk content")

        output_dir = str(tmp_path / "decompile-output")

        proc = start_worker()
        resp = send_recv(proc, {
            "id": "dec-4",
            "command": "decompile",
            "apkPath": str(apk_file),
            "tools": {
                "jadx": None,
                "apktool": None,
                "java": None,
            },
            "outputDir": output_dir,
        })

        assert resp["id"] == "dec-4"
        assert resp["status"] == "completed"
        result = resp["result"]

        # No tools should be present in results — they were skipped
        assert "jadx" not in result
        assert "apktool" not in result
        send_recv(proc, {"command": "shutdown"})
        proc.wait(timeout=5)

    def test_decompile_missing_params(self):
        """Decompile command with missing parameters returns error."""
        proc = start_worker()
        resp = send_recv(proc, {
            "id": "dec-5",
            "command": "decompile",
        })
        assert resp["id"] == "dec-5"
        assert resp["status"] == "failed"
        assert "Missing" in resp["error"]
        send_recv(proc, {"command": "shutdown"})
        proc.wait(timeout=5)


def _create_decompile_tree(base_dir):
    """Helper: create a fake decompile output tree with source files."""
    # jadx sources
    jadx_dir = os.path.join(base_dir, 'jadx', 'com', 'example')
    os.makedirs(jadx_dir)
    with open(os.path.join(jadx_dir, 'MainActivity.java'), 'w') as f:
        f.write('package com.example;\npublic class MainActivity {}')
    with open(os.path.join(jadx_dir, 'Utils.kt'), 'w') as f:
        f.write('package com.example\nfun helper() {}')

    # apktool smali + manifest
    apktool_dir = os.path.join(base_dir, 'apktool', 'smali', 'com', 'example')
    os.makedirs(apktool_dir)
    with open(os.path.join(apktool_dir, 'MainActivity.smali'), 'w') as f:
        f.write('.class public Lcom/example/MainActivity;\n.super Ljava/lang/Object;')

    # AndroidManifest.xml in apktool root
    manifest_xml = '''\
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    package="com.example.testapp">
    <uses-sdk android:minSdkVersion="21" android:targetSdkVersion="33" />
    <uses-permission android:name="android.permission.INTERNET" />
    <uses-permission android:name="android.permission.CAMERA" />
    <application>
        <activity android:name=".MainActivity" />
        <activity android:name=".SettingsActivity" />
        <service android:name=".SyncService" />
        <receiver android:name=".BootReceiver" />
        <provider android:name=".DataProvider" />
    </application>
</manifest>'''
    with open(os.path.join(base_dir, 'apktool', 'AndroidManifest.xml'), 'w') as f:
        f.write(manifest_xml)

    # Add some config files in jadx
    jadx_res = os.path.join(base_dir, 'jadx', 'res')
    os.makedirs(jadx_res)
    with open(os.path.join(jadx_res, 'strings.xml'), 'w') as f:
        f.write('<resources><string name="app_name">Test</string></resources>')
    with open(os.path.join(jadx_res, 'config.json'), 'w') as f:
        f.write('{"key": "value"}')
    with open(os.path.join(jadx_res, 'build.properties'), 'w') as f:
        f.write('version=1.0')
    with open(os.path.join(jadx_res, 'notes.txt'), 'w') as f:
        f.write('some notes')
    with open(os.path.join(jadx_res, 'ci.yml'), 'w') as f:
        f.write('name: CI')


class TestStoreSource:
    def test_store_source_creates_db(self, tmp_path):
        """store_source creates SQLite DB with files, findings, and manifest tables."""
        decompile_dir = str(tmp_path / 'decompiled')
        _create_decompile_tree(decompile_dir)
        db_path = str(tmp_path / 'db' / 'source.db')

        proc = start_worker()
        resp = send_recv(proc, {
            "id": "store-1",
            "command": "store_source",
            "decompileDir": decompile_dir,
            "dbPath": db_path,
        })

        assert resp["id"] == "store-1"
        assert resp["status"] == "completed"
        result = resp["result"]
        assert result["fileCount"] > 0
        assert result["totalSize"] > 0
        assert result["dbPath"] == db_path

        # Verify DB file was created and has the right tables
        assert os.path.isfile(db_path)
        conn = sqlite3.connect(db_path)
        tables = [r[0] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
        ).fetchall()]
        assert 'files' in tables
        assert 'findings' in tables
        assert 'manifest' in tables
        conn.close()

        send_recv(proc, {"command": "shutdown"})
        proc.wait(timeout=5)

    def test_store_source_compresses_files(self, tmp_path):
        """Files are zlib-compressed in the DB, can be decompressed back to original."""
        decompile_dir = str(tmp_path / 'decompiled')
        _create_decompile_tree(decompile_dir)
        db_path = str(tmp_path / 'db' / 'source.db')

        proc = start_worker()
        resp = send_recv(proc, {
            "id": "store-2",
            "command": "store_source",
            "decompileDir": decompile_dir,
            "dbPath": db_path,
        })
        assert resp["status"] == "completed"

        conn = sqlite3.connect(db_path)
        row = conn.execute(
            "SELECT path, size, content FROM files WHERE path LIKE '%MainActivity.java' AND source='jadx' LIMIT 1"
        ).fetchone()
        assert row is not None
        path, size, compressed_blob = row

        # Decompress and verify content matches original
        decompressed = zstd.decompress(compressed_blob)
        assert len(decompressed) == size
        original = 'package com.example;\npublic class MainActivity {}'
        assert decompressed.decode('utf-8') == original

        # Compressed blob should be smaller or equal to original (for small strings it may not be smaller)
        # but it should definitely be valid zstd
        assert isinstance(compressed_blob, bytes)
        conn.close()

        send_recv(proc, {"command": "shutdown"})
        proc.wait(timeout=5)

    def test_store_source_detects_languages(self, tmp_path):
        """Java, smali, xml, json, kotlin, properties, text, yaml files get correct language tags."""
        decompile_dir = str(tmp_path / 'decompiled')
        _create_decompile_tree(decompile_dir)
        db_path = str(tmp_path / 'db' / 'source.db')

        proc = start_worker()
        resp = send_recv(proc, {
            "id": "store-3",
            "command": "store_source",
            "decompileDir": decompile_dir,
            "dbPath": db_path,
        })
        assert resp["status"] == "completed"

        conn = sqlite3.connect(db_path)
        rows = conn.execute("SELECT path, language FROM files").fetchall()
        lang_by_ext = {}
        for path, lang in rows:
            ext = os.path.splitext(path)[1]
            lang_by_ext[ext] = lang

        assert lang_by_ext.get('.java') == 'java'
        # smali is skipped when jadx output exists (redundant)
        assert '.smali' not in lang_by_ext
        assert lang_by_ext.get('.xml') == 'xml'
        assert lang_by_ext.get('.json') == 'json'
        assert lang_by_ext.get('.kt') == 'kotlin'
        assert lang_by_ext.get('.properties') == 'properties'
        assert lang_by_ext.get('.txt') == 'text'
        assert lang_by_ext.get('.yml') == 'yaml'
        conn.close()

        send_recv(proc, {"command": "shutdown"})
        proc.wait(timeout=5)

    def test_store_source_multiple_sources(self, tmp_path):
        """Files from jadx and apktool get correct source tags."""
        decompile_dir = str(tmp_path / 'decompiled')
        _create_decompile_tree(decompile_dir)
        db_path = str(tmp_path / 'db' / 'source.db')

        proc = start_worker()
        resp = send_recv(proc, {
            "id": "store-4",
            "command": "store_source",
            "decompileDir": decompile_dir,
            "dbPath": db_path,
        })
        assert resp["status"] == "completed"

        conn = sqlite3.connect(db_path)
        sources = set(r[0] for r in conn.execute("SELECT DISTINCT source FROM files").fetchall())
        assert 'jadx' in sources
        assert 'apktool' in sources

        # Check jadx has the java and kotlin files
        jadx_files = conn.execute("SELECT path FROM files WHERE source='jadx'").fetchall()
        jadx_paths = [r[0] for r in jadx_files]
        assert any('MainActivity.java' in p for p in jadx_paths)
        assert any('Utils.kt' in p for p in jadx_paths)

        # Check apktool has XML/resources (smali is skipped when jadx exists)
        apktool_files = conn.execute("SELECT path FROM files WHERE source='apktool'").fetchall()
        apktool_paths = [r[0] for r in apktool_files]
        assert any('AndroidManifest.xml' in p for p in apktool_paths)
        assert not any('.smali' in p for p in apktool_paths)

        conn.close()

        send_recv(proc, {"command": "shutdown"})
        proc.wait(timeout=5)

    def test_store_source_parses_manifest(self, tmp_path):
        """AndroidManifest.xml is parsed into manifest table entries."""
        decompile_dir = str(tmp_path / 'decompiled')
        _create_decompile_tree(decompile_dir)
        db_path = str(tmp_path / 'db' / 'source.db')

        proc = start_worker()
        resp = send_recv(proc, {
            "id": "store-5",
            "command": "store_source",
            "decompileDir": decompile_dir,
            "dbPath": db_path,
        })
        assert resp["status"] == "completed"

        conn = sqlite3.connect(db_path)
        manifest = dict(conn.execute("SELECT key, value FROM manifest").fetchall())

        # Package
        assert json.loads(manifest['package']) == 'com.example.testapp'

        # SDK versions
        assert json.loads(manifest['min_sdk']) == '21'
        assert json.loads(manifest['target_sdk']) == '33'

        # Permissions
        perms = json.loads(manifest['permissions'])
        assert 'android.permission.INTERNET' in perms
        assert 'android.permission.CAMERA' in perms
        assert len(perms) == 2

        # Activities
        activities = json.loads(manifest['activities'])
        assert '.MainActivity' in activities
        assert '.SettingsActivity' in activities
        assert len(activities) == 2

        # Services
        services = json.loads(manifest['services'])
        assert '.SyncService' in services
        assert len(services) == 1

        # Receivers
        receivers = json.loads(manifest['receivers'])
        assert '.BootReceiver' in receivers
        assert len(receivers) == 1

        # Providers
        providers = json.loads(manifest['providers'])
        assert '.DataProvider' in providers
        assert len(providers) == 1

        conn.close()

        send_recv(proc, {"command": "shutdown"})
        proc.wait(timeout=5)

    def test_store_source_saves_frameworks_metadata(self, tmp_path):
        """store_source saves frameworks metadata from analyze_apk into manifest table."""
        decompile_dir = str(tmp_path / 'decompiled')
        _create_decompile_tree(decompile_dir)
        db_path = str(tmp_path / 'db' / 'source.db')

        metadata = {
            'packageName': 'com.example.rn',
            'frameworks': {
                'reactNative': True,
                'hermesEngine': True,
                'hermesBundlePath': 'assets/index.android.bundle',
            },
        }

        proc = start_worker()
        resp = send_recv(proc, {
            "id": "store-fw-1",
            "command": "store_source",
            "decompileDir": decompile_dir,
            "dbPath": db_path,
            "metadata": metadata,
        })

        assert resp["status"] == "completed"

        conn = sqlite3.connect(db_path)
        manifest = dict(conn.execute("SELECT key, value FROM manifest").fetchall())
        assert 'frameworks' in manifest
        frameworks = json.loads(manifest['frameworks'])
        assert frameworks['reactNative'] is True
        assert frameworks['hermesEngine'] is True
        assert frameworks['hermesBundlePath'] == 'assets/index.android.bundle'
        conn.close()

        send_recv(proc, {"command": "shutdown"})
        proc.wait(timeout=5)

    def test_store_source_missing_params(self):
        """store_source with missing params returns error."""
        proc = start_worker()
        resp = send_recv(proc, {
            "id": "store-6",
            "command": "store_source",
        })
        assert resp["id"] == "store-6"
        assert resp["status"] == "failed"
        assert "Missing" in resp["error"]
        send_recv(proc, {"command": "shutdown"})
        proc.wait(timeout=5)

    def test_store_source_nonexistent_dir(self, tmp_path):
        """store_source with nonexistent decompile dir returns error."""
        proc = start_worker()
        resp = send_recv(proc, {
            "id": "store-7",
            "command": "store_source",
            "decompileDir": "/nonexistent/dir",
            "dbPath": str(tmp_path / "db" / "source.db"),
        })
        assert resp["id"] == "store-7"
        assert resp["status"] == "failed"
        assert "not found" in resp["error"]
        send_recv(proc, {"command": "shutdown"})
        proc.wait(timeout=5)

    def test_store_source_includes_hermes_dec(self, tmp_path):
        """store_source walks hermes-dec/ alongside jadx/ and apktool/."""
        decompile_dir = str(tmp_path / 'decompiled')
        _create_decompile_tree(decompile_dir)

        # Create hermes-dec/ output with decompiled JS and disassembly
        hermes_dir = os.path.join(decompile_dir, 'hermes-dec')
        os.makedirs(hermes_dir)
        with open(os.path.join(hermes_dir, 'decompiled.js'), 'w') as f:
            f.write('function hello() { return "world"; }')
        with open(os.path.join(hermes_dir, 'disassembly.hasm'), 'w') as f:
            f.write('Function<hello>0(1 params, 1 registers):\n  LoadConstString r0, "world"\n  Ret r0')

        db_path = str(tmp_path / 'db' / 'source.db')

        proc = start_worker()
        resp = send_recv(proc, {
            "id": "store-hermes-1",
            "command": "store_source",
            "decompileDir": decompile_dir,
            "dbPath": db_path,
        })

        assert resp["id"] == "store-hermes-1"
        assert resp["status"] == "completed"

        conn = sqlite3.connect(db_path)

        # hermes-dec should appear as a source
        sources = set(r[0] for r in conn.execute("SELECT DISTINCT source FROM files").fetchall())
        assert 'hermes-dec' in sources

        # Both files should be stored under hermes-dec source
        hermes_files = conn.execute(
            "SELECT path, language FROM files WHERE source='hermes-dec'"
        ).fetchall()
        hermes_paths = [r[0] for r in hermes_files]
        hermes_langs = {r[0]: r[1] for r in hermes_files}

        assert 'decompiled.js' in hermes_paths
        assert 'disassembly.hasm' in hermes_paths

        # Verify correct language tags
        assert hermes_langs['decompiled.js'] == 'javascript'
        assert hermes_langs['disassembly.hasm'] == 'hermes-asm'

        conn.close()

        send_recv(proc, {"command": "shutdown"})
        proc.wait(timeout=5)

    def test_store_source_large_hermes_file_stored(self, tmp_path):
        """Large JS bundles in hermes-dec/ are stored (higher size limit), but large jadx files are skipped."""
        decompile_dir = str(tmp_path / 'decompiled')
        os.makedirs(os.path.join(decompile_dir, 'jadx'))
        os.makedirs(os.path.join(decompile_dir, 'hermes-dec'))

        # 3MB file in jadx — should be skipped (over 2MB limit)
        with open(os.path.join(decompile_dir, 'jadx', 'BigClass.java'), 'w') as f:
            f.write('x' * (3 * 1024 * 1024))

        # 12MB file in hermes-dec — should be stored (under 50MB limit)
        with open(os.path.join(decompile_dir, 'hermes-dec', 'beautified.js'), 'w') as f:
            f.write('y' * (12 * 1024 * 1024))

        db_path = str(tmp_path / 'db' / 'source.db')

        proc = start_worker()
        resp = send_recv(proc, {
            "id": "store-large-1",
            "command": "store_source",
            "decompileDir": decompile_dir,
            "dbPath": db_path,
        })
        assert resp["status"] == "completed"

        conn = sqlite3.connect(db_path)
        files = conn.execute("SELECT source, path FROM files").fetchall()
        conn.close()

        sources_paths = [(r[0], r[1]) for r in files]
        # Large jadx file should be skipped
        assert ('jadx', 'BigClass.java') not in sources_paths
        # Large hermes-dec file should be stored
        assert ('hermes-dec', 'beautified.js') in sources_paths

        send_recv(proc, {"command": "shutdown"})
        proc.wait(timeout=5)

    def test_store_source_empty_dir(self, tmp_path):
        """store_source with empty decompile dir produces zero files."""
        decompile_dir = str(tmp_path / 'empty_decompiled')
        os.makedirs(decompile_dir)
        db_path = str(tmp_path / 'db' / 'source.db')

        proc = start_worker()
        resp = send_recv(proc, {
            "id": "store-8",
            "command": "store_source",
            "decompileDir": decompile_dir,
            "dbPath": db_path,
        })
        assert resp["status"] == "completed"
        assert resp["result"]["fileCount"] == 0
        assert resp["result"]["totalSize"] == 0

        send_recv(proc, {"command": "shutdown"})
        proc.wait(timeout=5)


def _create_source_db(db_path: str, files: list):
    """Helper: create a source DB with files for scan_secrets testing.

    files is a list of (path, source, language, content) tuples.
    """
    conn = sqlite3.connect(db_path)
    conn.executescript('''
        CREATE TABLE IF NOT EXISTS files (
            id INTEGER PRIMARY KEY,
            path TEXT NOT NULL,
            source TEXT NOT NULL,
            size INTEGER NOT NULL,
            content BLOB NOT NULL,
            language TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS findings (
            id INTEGER PRIMARY KEY,
            file_id INTEGER REFERENCES files(id),
            rule_id TEXT NOT NULL,
            severity TEXT NOT NULL,
            title TEXT NOT NULL,
            description TEXT NOT NULL,
            line_number INTEGER,
            matched_text TEXT,
            category TEXT NOT NULL
        );
    ''')
    for path, source, language, content in files:
        raw = content.encode('utf-8')
        compressed = zstd.compress(raw)
        conn.execute(
            'INSERT INTO files (path, source, size, content, language) VALUES (?,?,?,?,?)',
            (path, source, len(raw), compressed, language),
        )
    conn.commit()
    conn.close()


class TestScanSecrets:
    def test_scan_finds_hardcoded_api_key(self, tmp_path):
        """Regex scan detects API key patterns like 'AIza...'."""
        db_path = str(tmp_path / 'source.db')
        _create_source_db(db_path, [
            ('Config.java', 'jadx', 'java',
             'public class Config {\n'
             '    static final String API_KEY = "AIzaSyA1234567890abcdefghijklmnopqrstuv";\n'
             '}'),
        ])

        proc = start_worker()
        resp = send_recv(proc, {
            "id": "scan-1",
            "command": "scan_secrets",
            "dbPath": db_path,
        })

        assert resp["id"] == "scan-1"
        assert resp["status"] == "completed"
        assert resp["result"]["findingCount"] > 0

        # Verify finding in DB
        conn = sqlite3.connect(db_path)
        findings = conn.execute(
            "SELECT rule_id, matched_text, line_number FROM findings WHERE rule_id = 'google-api-key'"
        ).fetchall()
        assert len(findings) >= 1
        assert 'AIzaSyA1234567890abcdefghijklmnopqrstuv' in findings[0][1]
        assert findings[0][2] == 2  # line 2
        conn.close()

        send_recv(proc, {"command": "shutdown"})
        proc.wait(timeout=5)

    def test_scan_finds_hardcoded_url(self, tmp_path):
        """Regex scan finds http:// URLs (cleartext)."""
        db_path = str(tmp_path / 'source.db')
        _create_source_db(db_path, [
            ('Network.java', 'jadx', 'java',
             'public class Network {\n'
             '    String url = "http://api.example.com/v1/data";\n'
             '}'),
        ])

        proc = start_worker()
        resp = send_recv(proc, {
            "id": "scan-2",
            "command": "scan_secrets",
            "dbPath": db_path,
        })

        assert resp["status"] == "completed"
        assert resp["result"]["findingCount"] > 0

        conn = sqlite3.connect(db_path)
        findings = conn.execute(
            "SELECT rule_id, matched_text FROM findings WHERE rule_id = 'cleartext-http'"
        ).fetchall()
        assert len(findings) >= 1
        assert 'http://api.example.com' in findings[0][1]
        conn.close()

        send_recv(proc, {"command": "shutdown"})
        proc.wait(timeout=5)

    def test_scan_finds_aws_key(self, tmp_path):
        """Regex scan detects AWS access key patterns."""
        db_path = str(tmp_path / 'source.db')
        _create_source_db(db_path, [
            ('AwsConfig.java', 'jadx', 'java',
             'public class AwsConfig {\n'
             '    String accessKey = "AKIAIOSFODNN7EXAMPLE";\n'
             '}'),
        ])

        proc = start_worker()
        resp = send_recv(proc, {
            "id": "scan-3",
            "command": "scan_secrets",
            "dbPath": db_path,
        })

        assert resp["status"] == "completed"
        assert resp["result"]["findingCount"] > 0

        conn = sqlite3.connect(db_path)
        findings = conn.execute(
            "SELECT rule_id, matched_text, severity FROM findings WHERE rule_id = 'aws-access-key'"
        ).fetchall()
        assert len(findings) >= 1
        assert 'AKIAIOSFODNN7EXAMPLE' in findings[0][1]
        assert findings[0][2] == 'critical'
        conn.close()

        send_recv(proc, {"command": "shutdown"})
        proc.wait(timeout=5)

    def test_scan_inserts_findings_to_db(self, tmp_path):
        """Findings are inserted into the findings table with correct fields."""
        db_path = str(tmp_path / 'source.db')
        _create_source_db(db_path, [
            ('Secrets.java', 'jadx', 'java',
             'public class Secrets {\n'
             '    String key = "AIzaSyB9876543210zyxwvutsrqponmlkjihgfe";\n'
             '    String firebase = "https://myapp-12345.firebaseio.com";\n'
             '    String token = "xoxb-1234567890-abcdefghijklmnop";\n'
             '}'),
        ])

        proc = start_worker()
        resp = send_recv(proc, {
            "id": "scan-4",
            "command": "scan_secrets",
            "dbPath": db_path,
        })

        assert resp["status"] == "completed"
        result = resp["result"]
        assert result["findingCount"] >= 3

        conn = sqlite3.connect(db_path)
        # Check all expected fields are populated
        row = conn.execute(
            '''SELECT file_id, rule_id, severity, title, description, line_number,
                      matched_text, category
               FROM findings LIMIT 1'''
        ).fetchone()
        assert row is not None
        file_id, rule_id, severity, title, description, line_number, matched_text, category = row
        assert file_id is not None
        assert rule_id != ''
        assert severity in ('info', 'low', 'medium', 'high', 'critical')
        assert title != ''
        assert description != ''
        assert line_number > 0
        assert matched_text != ''
        assert category != ''

        # Verify multiple finding types
        rule_ids = set(r[0] for r in conn.execute("SELECT DISTINCT rule_id FROM findings").fetchall())
        assert 'google-api-key' in rule_ids
        assert 'firebase-url' in rule_ids
        assert 'slack-token' in rule_ids
        conn.close()

        send_recv(proc, {"command": "shutdown"})
        proc.wait(timeout=5)

    def test_scan_mobsfscan_integration(self, tmp_path):
        """If mobsfscan available, runs and merges results."""
        db_path = str(tmp_path / 'source.db')
        _create_source_db(db_path, [
            ('App.java', 'jadx', 'java',
             'public class App {\n'
             '    String s = "nothing secret here";\n'
             '}'),
        ])

        # Create a mock mobsfscan that outputs valid JSON results
        mobsfscan_bin = str(tmp_path / 'mock_mobsfscan')
        # mobsfscan JSON format: results is a dict of rule_id -> list of findings
        mobsfscan_output = json.dumps({
            "results": {
                "android_insecure_random": [
                    {
                        "metadata": {
                            "description": "Insecure random number generator",
                            "severity": "WARNING",
                            "cwe": "CWE-330",
                        },
                        "files": [
                            {
                                "file_path": "App.java",
                                "match_string": "new Random()",
                                "match_lines": [2, 2],
                                "match_position": [10, 22],
                            }
                        ],
                    }
                ]
            },
            "errors": [],
        })
        _make_script(mobsfscan_bin, f'#!/bin/sh\necho \'{mobsfscan_output}\'\nexit 0\n')

        proc = start_worker()
        resp = send_recv(proc, {
            "id": "scan-5",
            "command": "scan_secrets",
            "dbPath": db_path,
            "mobsfscanPath": mobsfscan_bin,
        })

        assert resp["status"] == "completed"
        result = resp["result"]
        assert result["mobsfscanFindings"] >= 1

        # Verify mobsfscan finding was inserted
        conn = sqlite3.connect(db_path)
        mobsfscan_rows = conn.execute(
            "SELECT rule_id, title, line_number FROM findings WHERE rule_id LIKE 'mobsfscan:%'"
        ).fetchall()
        assert len(mobsfscan_rows) >= 1
        assert mobsfscan_rows[0][2] == 2  # line number from mobsfscan result
        conn.close()

        send_recv(proc, {"command": "shutdown"})
        proc.wait(timeout=5)

    def test_scan_mobsfscan_unavailable(self, tmp_path):
        """If mobsfscan not available, regex scan still runs."""
        db_path = str(tmp_path / 'source.db')
        _create_source_db(db_path, [
            ('Config.java', 'jadx', 'java',
             'public class Config {\n'
             '    String key = "AIzaSyC1111111111111111111111111111111111";\n'
             '}'),
        ])

        proc = start_worker()
        resp = send_recv(proc, {
            "id": "scan-6",
            "command": "scan_secrets",
            "dbPath": db_path,
            "mobsfscanPath": None,
        })

        assert resp["status"] == "completed"
        result = resp["result"]
        assert result["findingCount"] > 0
        assert result["mobsfscanFindings"] == 0

        # Verify regex findings still inserted
        conn = sqlite3.connect(db_path)
        count = conn.execute("SELECT COUNT(*) FROM findings").fetchone()[0]
        assert count > 0
        conn.close()

        send_recv(proc, {"command": "shutdown"})
        proc.wait(timeout=5)

    def test_scan_secrets_missing_db(self):
        """scan_secrets with missing dbPath returns error."""
        proc = start_worker()
        resp = send_recv(proc, {
            "id": "scan-7",
            "command": "scan_secrets",
        })
        assert resp["id"] == "scan-7"
        assert resp["status"] == "failed"
        assert "Missing" in resp["error"]
        send_recv(proc, {"command": "shutdown"})
        proc.wait(timeout=5)

    def test_scan_finds_secrets_in_javascript(self, tmp_path):
        """Regex scan detects secrets in JavaScript files from hermes-dec source."""
        db_path = str(tmp_path / 'source.db')
        _create_source_db(db_path, [
            ('decompiled.js', 'hermes-dec', 'javascript',
             'var config = {\n'
             '  apiKey: "AIzaSyD99999999999999999999999999999999",\n'
             '};\n'),
        ])

        proc = start_worker()
        resp = send_recv(proc, {
            "id": "scan-js-1",
            "command": "scan_secrets",
            "dbPath": db_path,
        })

        assert resp["id"] == "scan-js-1"
        assert resp["status"] == "completed"
        assert resp["result"]["findingCount"] > 0

        # Verify google-api-key rule matched
        conn = sqlite3.connect(db_path)
        findings = conn.execute(
            "SELECT rule_id, matched_text FROM findings WHERE rule_id = 'google-api-key'"
        ).fetchall()
        assert len(findings) >= 1
        assert 'AIzaSyD99999999999999999999999999999999' in findings[0][1]
        conn.close()

        send_recv(proc, {"command": "shutdown"})
        proc.wait(timeout=5)

    def test_scan_skips_binary_languages(self, tmp_path):
        """Files with unsupported language tags are skipped."""
        db_path = str(tmp_path / 'source.db')
        _create_source_db(db_path, [
            ('image.png', 'jadx', 'binary',
             'AIzaSyA1234567890abcdefghijklmnopqrstuv'),
        ])

        proc = start_worker()
        resp = send_recv(proc, {
            "id": "scan-8",
            "command": "scan_secrets",
            "dbPath": db_path,
        })

        assert resp["status"] == "completed"
        assert resp["result"]["findingCount"] == 0

        send_recv(proc, {"command": "shutdown"})
        proc.wait(timeout=5)

    def test_scan_truncates_long_matches(self, tmp_path):
        """Matched text is truncated to 200 characters max."""
        db_path = str(tmp_path / 'source.db')
        # Create a line with a very long base64 string (>200 chars)
        long_b64 = 'A' * 300
        _create_source_db(db_path, [
            ('Config.java', 'jadx', 'java',
             f'String secret = "{long_b64}";\n'),
        ])

        proc = start_worker()
        resp = send_recv(proc, {
            "id": "scan-9",
            "command": "scan_secrets",
            "dbPath": db_path,
        })

        assert resp["status"] == "completed"

        conn = sqlite3.connect(db_path)
        rows = conn.execute("SELECT matched_text FROM findings").fetchall()
        for row in rows:
            assert len(row[0]) <= 200
        conn.close()

        send_recv(proc, {"command": "shutdown"})
        proc.wait(timeout=5)

    def test_scan_skips_base64_with_english_words(self, tmp_path):
        """Base64 rule should not flag strings that contain English words."""
        db_path = str(tmp_path / 'source.db')
        # This looks base64-charset but is clearly English text
        english_text = 'ThisIsALongStringContainingMultipleEnglishWordsNotASecret'
        _create_source_db(db_path, [
            ('Config.java', 'jadx', 'java',
             f'String desc = "{english_text}";\n'),
        ])

        proc = start_worker()
        resp = send_recv(proc, {
            "id": "scan-b64-fp",
            "command": "scan_secrets",
            "dbPath": db_path,
        })

        assert resp["status"] == "completed"

        conn = sqlite3.connect(db_path)
        findings = conn.execute(
            "SELECT rule_id FROM findings WHERE rule_id = 'base64-secret'"
        ).fetchall()
        assert len(findings) == 0, f"English text should not be flagged as base64 secret: {english_text}"
        conn.close()

        send_recv(proc, {"command": "shutdown"})
        proc.wait(timeout=5)

    def test_scan_keeps_real_base64_secrets(self, tmp_path):
        """Base64 rule should still flag actual base64-encoded data."""
        db_path = str(tmp_path / 'source.db')
        # Random-looking base64 with no English words
        real_b64 = 'dGhpcyBpcyBhIHRlc3Qgc2VjcmV0IGtleSB2YWx1ZSBmb3IgdGVzdGluZw=='
        _create_source_db(db_path, [
            ('Config.java', 'jadx', 'java',
             f'String key = "{real_b64}";\n'),
        ])

        proc = start_worker()
        resp = send_recv(proc, {
            "id": "scan-b64-real",
            "command": "scan_secrets",
            "dbPath": db_path,
        })

        assert resp["status"] == "completed"

        conn = sqlite3.connect(db_path)
        findings = conn.execute(
            "SELECT rule_id FROM findings WHERE rule_id = 'base64-secret'"
        ).fetchall()
        assert len(findings) >= 1, f"Real base64 should still be flagged: {real_b64}"
        conn.close()

        send_recv(proc, {"command": "shutdown"})
        proc.wait(timeout=5)


class TestIsLikelyBase64Secret:
    """Unit tests for the _is_likely_base64_secret heuristic."""

    def test_random_base64_is_secret(self):
        assert _is_likely_base64_secret('"dGVzdCBzZWNyZXQga2V5IHZhbHVl"') is True

    def test_alphabet_sequence_not_secret(self):
        # Sequential alphabet runs are charsets/lookup tables, not secrets
        assert _is_likely_base64_secret('"ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDEF"') is False

    def test_all_uppercase_random_is_secret(self):
        # Random uppercase without sequential runs is still a secret
        assert _is_likely_base64_secret('"XKJQWMPZLVNHRTGYSCBDAFOEUI1234567890XKJQ"') is True

    def test_camelcase_english_words_not_secret(self):
        assert _is_likely_base64_secret('"thisIsALongStringContainingMultipleEnglishWords"') is False

    def test_sentence_with_spaces_not_secret(self):
        assert _is_likely_base64_secret('"This is a normal English sentence with spaces"') is False

    def test_comma_separated_not_secret(self):
        assert _is_likely_base64_secret('"hello,world,these,are,words"') is False

    def test_sequential_uppercase_with_other_chars_not_secret(self):
        # Contains ABCDEFGHIJKLMNOPQR (18-char sequential run) — rejected
        assert _is_likely_base64_secret('"ABCDEFGHIJKLMNOPQRtest1234567890ABCDEF"') is False

    def test_short_sequential_run_still_secret(self):
        # Only 8-char sequential run (below threshold of 10) — still a secret
        assert _is_likely_base64_secret('"XABCDEFGHtest1234567890XKJQWMPZLVNHRTGY"') is True

    def test_mixed_case_identifier_not_secret(self):
        assert _is_likely_base64_secret('"getApplicationContext/initializeComponent"') is False

    def test_lowercase_alphabet_sequence_not_secret(self):
        assert _is_likely_base64_secret('"abcdefghijklmnopqrstuvwxyz0123456789abcdef"') is False

    def test_padding_equals_is_secret(self):
        assert _is_likely_base64_secret('"c2VjcmV0S2V5VmFsdWVGb3JUZXN0aW5nUHVycG9zZXM="') is True


class TestDetectReactNative:
    """Unit tests for detect_react_native()."""

    def test_hermes_bundle_detected(self):
        """Hermes bytecode bundle at standard path is detected."""
        files = {
            'assets/index.android.bundle': HERMES_MAGIC + b'\x00\x00\x00\x00',
            'lib/arm64-v8a/libhermes.so': b'',
        }
        result = detect_react_native(files)
        assert result is not None
        assert result['reactNative'] is True
        assert result['hermesEngine'] is True
        assert result['hermesBundlePath'] == 'assets/index.android.bundle'

    def test_hermes_alternative_bundle_path(self):
        """Hermes bytecode bundle at alternative hermes/ path is detected."""
        files = {
            'assets/hermes/index.android.bundle': HERMES_MAGIC + b'\x00\x00\x00\x00',
            'lib/arm64-v8a/libhermes.so': b'',
        }
        result = detect_react_native(files)
        assert result is not None
        assert result['reactNative'] is True
        assert result['hermesEngine'] is True
        assert result['hermesBundlePath'] == 'assets/hermes/index.android.bundle'

    def test_hermes_lib_only_no_bundle(self):
        """libhermes.so without a valid Hermes bundle still detects RN with Hermes engine."""
        files = {
            'lib/arm64-v8a/libhermes.so': b'',
        }
        result = detect_react_native(files)
        assert result is not None
        assert result['reactNative'] is True
        assert result['hermesEngine'] is True
        assert result['hermesBundlePath'] is None

    def test_jsc_engine_detected(self):
        """libjsc.so (JavaScriptCore) indicates RN without Hermes."""
        files = {
            'lib/arm64-v8a/libjsc.so': b'',
        }
        result = detect_react_native(files)
        assert result is not None
        assert result['reactNative'] is True
        assert result['hermesEngine'] is False
        assert result['hermesBundlePath'] is None

    def test_jsc_with_plain_bundle(self):
        """JSC engine with a JS bundle (non-Hermes magic) is RN without Hermes."""
        files = {
            'assets/index.android.bundle': b'var __DEX',  # plain JS, not Hermes bytecode
            'lib/arm64-v8a/libjsc.so': b'',
        }
        result = detect_react_native(files)
        assert result is not None
        assert result['reactNative'] is True
        assert result['hermesEngine'] is False
        assert result['hermesBundlePath'] is None

    def test_no_react_native(self):
        """APK without RN indicators returns None."""
        files = {
            'lib/arm64-v8a/libnative-lib.so': b'',
            'classes.dex': b'',
            'res/layout/main.xml': b'',
        }
        result = detect_react_native(files)
        assert result is None

    def test_empty_files_dict(self):
        """Empty files dict returns None."""
        result = detect_react_native({})
        assert result is None

    def test_bundle_without_hermes_magic(self):
        """Bundle file present but without Hermes magic bytes is not Hermes."""
        files = {
            'assets/index.android.bundle': b'\x00\x00\x00\x00\x00\x00\x00\x00',
        }
        result = detect_react_native(files)
        assert result is None

    def test_bundle_too_short(self):
        """Bundle file with fewer than 4 bytes does not match Hermes magic."""
        files = {
            'assets/index.android.bundle': b'\xc6\x1f',  # only 2 bytes
        }
        result = detect_react_native(files)
        assert result is None

    def test_hermes_bundle_with_both_libs(self):
        """Both libhermes.so and libjsc.so present with Hermes bundle."""
        files = {
            'assets/index.android.bundle': HERMES_MAGIC + b'\x00\x00\x00\x00',
            'lib/arm64-v8a/libhermes.so': b'',
            'lib/arm64-v8a/libjsc.so': b'',
        }
        result = detect_react_native(files)
        assert result is not None
        assert result['reactNative'] is True
        assert result['hermesEngine'] is True
        assert result['hermesBundlePath'] == 'assets/index.android.bundle'

    def test_hermes_magic_constant(self):
        """HERMES_MAGIC constant matches expected bytes."""
        assert HERMES_MAGIC == b'\xc6\x1f\xbc\x03'

    def test_bundle_paths_constant(self):
        """HERMES_BUNDLE_PATHS contains expected paths."""
        assert 'assets/index.android.bundle' in HERMES_BUNDLE_PATHS
        assert 'assets/hermes/index.android.bundle' in HERMES_BUNDLE_PATHS

    def test_prefers_standard_bundle_path(self):
        """When both bundle paths have Hermes magic, the standard path is preferred."""
        files = {
            'assets/index.android.bundle': HERMES_MAGIC + b'\x00\x00\x00\x00',
            'assets/hermes/index.android.bundle': HERMES_MAGIC + b'\x00\x00\x00\x00',
            'lib/arm64-v8a/libhermes.so': b'',
        }
        result = detect_react_native(files)
        assert result is not None
        # Standard path comes first in HERMES_BUNDLE_PATHS
        assert result['hermesBundlePath'] == 'assets/index.android.bundle'

    def test_lib_name_in_subdirectory(self):
        """libhermes.so nested in arch subdirectory is detected."""
        files = {
            'lib/x86/libhermes.so': b'',
            'lib/armeabi-v7a/libhermes.so': b'',
        }
        result = detect_react_native(files)
        assert result is not None
        assert result['reactNative'] is True
        assert result['hermesEngine'] is True

    def test_plain_js_bundle_detected(self):
        """Plain JS bundle starting with 'var ' is detected as RN without Hermes."""
        files = {
            'assets/index.android.bundle': b'var __BUNDLE_START_TIME__=this.nativePerformanceNow?nativePerformanceNow():Date.now()',
        }
        result = detect_react_native(files)
        assert result is not None
        assert result['reactNative'] is True
        assert result['hermesEngine'] is False
        assert result['hermesBundlePath'] is None
        assert result['jsBundlePath'] == 'assets/index.android.bundle'

    def test_plain_js_bundle_bundle_start_time(self):
        """Plain JS bundle with __BUNDLE_START_TIME__ in first 64 bytes is detected."""
        # Bundle doesn't start with 'var ' but has the marker within first 64 bytes
        data = b'!function(){var __BUNDLE_START_TIME__=Date.now()' + b'\x00' * 20
        files = {
            'assets/index.android.bundle': data[:64],
        }
        result = detect_react_native(files)
        assert result is not None
        assert result['reactNative'] is True
        assert result['jsBundlePath'] == 'assets/index.android.bundle'

    def test_resource_heuristic_detects_rn(self):
        """Files with node_modules_reactnative in path indicate RN."""
        files = {
            'res/raw/node_modules_reactnativeratings_src_images_star.png': b'',
        }
        result = detect_react_native(files)
        assert result is not None
        assert result['reactNative'] is True
        assert result['hermesEngine'] is False
        assert result['hermesBundlePath'] is None
        assert result['jsBundlePath'] is None

    def test_split_apk_no_native_libs(self):
        """Split APK: no native libs, only bundle + resources → detected as RN."""
        files = {
            'assets/index.android.bundle': b'var __BUNDLE_START_TIME__=Date.now()',
            'res/raw/node_modules_reactnative_package.json': b'',
        }
        result = detect_react_native(files)
        assert result is not None
        assert result['reactNative'] is True
        assert result['hermesEngine'] is False
        assert result['jsBundlePath'] == 'assets/index.android.bundle'

    def test_js_bundle_path_not_set_for_hermes(self):
        """Hermes bytecode bundle sets hermesBundlePath, not jsBundlePath."""
        files = {
            'assets/index.android.bundle': HERMES_MAGIC + b'\x00\x00\x00\x00',
        }
        result = detect_react_native(files)
        assert result is not None
        assert result['hermesBundlePath'] == 'assets/index.android.bundle'
        assert result['jsBundlePath'] is None

    def test_jsbundle_extension_detected(self):
        """Files with .jsbundle extension are also scanned."""
        files = {
            'assets/main.jsbundle': b'var React=require("react")',
        }
        result = detect_react_native(files)
        assert result is not None
        assert result['reactNative'] is True
        assert result['jsBundlePath'] == 'assets/main.jsbundle'

    def test_non_assets_bundle_ignored(self):
        """Bundle files not under assets/ are not considered."""
        files = {
            'other/index.android.bundle': b'var __BUNDLE_START_TIME__=Date.now()',
        }
        result = detect_react_native(files)
        assert result is None


def _create_hermes_apk(apk_path: str, bundle_path: str = 'assets/index.android.bundle'):
    """Helper: create a fake APK (ZIP) containing a Hermes bytecode bundle."""
    import zipfile
    with zipfile.ZipFile(apk_path, 'w') as zf:
        # Write a Hermes bytecode bundle (magic bytes + some filler)
        zf.writestr(bundle_path, HERMES_MAGIC + b'\x00' * 100)


class TestHermesDecompile:
    def test_hermes_decompile_runs_tools(self, tmp_path):
        """Both decompiler and disassembler run and produce output files."""
        apk_file = str(tmp_path / 'test.apk')
        _create_hermes_apk(apk_file)

        # Create mock hbc_decompiler: writes output to $2
        decompiler_bin = str(tmp_path / 'mock_hbc_decompiler')
        _make_script(decompiler_bin, '#!/bin/sh\necho "decompiled JS output" > "$2"\n')

        # Create mock hbc_disassembler: writes output to $2
        disassembler_bin = str(tmp_path / 'mock_hbc_disassembler')
        _make_script(disassembler_bin, '#!/bin/sh\necho "disassembly output" > "$2"\n')

        output_dir = str(tmp_path / 'decompile-output')

        proc = start_worker()
        resp = send_recv(proc, {
            "id": "hermes-1",
            "command": "hermes_decompile",
            "apkPath": apk_file,
            "outputDir": output_dir,
            "bundlePath": "assets/index.android.bundle",
            "tools": {
                "hbc_decompiler": decompiler_bin,
                "hbc_disassembler": disassembler_bin,
            },
        })

        assert resp["id"] == "hermes-1"
        assert resp["status"] == "completed"
        result = resp["result"]

        # Both tools should have succeeded
        assert result["decompiler"]["success"] is True
        assert result["disassembler"]["success"] is True

        # Output files should exist
        hermes_dir = os.path.join(output_dir, 'hermes-dec')
        assert os.path.isfile(os.path.join(hermes_dir, 'decompiled.js'))
        assert os.path.isfile(os.path.join(hermes_dir, 'disassembly.hasm'))

        # Temp bundle file should be cleaned up
        assert not os.path.exists(os.path.join(hermes_dir, 'index.android.bundle'))

        send_recv(proc, {"command": "shutdown"})
        proc.wait(timeout=5)

    def test_hermes_decompile_missing_bundle(self, tmp_path):
        """APK without the expected bundle path returns error."""
        apk_file = str(tmp_path / 'test.apk')
        # Create APK with bundle at a different path
        _create_hermes_apk(apk_file, bundle_path='assets/other.bundle')

        output_dir = str(tmp_path / 'decompile-output')

        proc = start_worker()
        resp = send_recv(proc, {
            "id": "hermes-2",
            "command": "hermes_decompile",
            "apkPath": apk_file,
            "outputDir": output_dir,
            "bundlePath": "assets/index.android.bundle",
            "tools": {
                "hbc_decompiler": "/usr/bin/true",
                "hbc_disassembler": "/usr/bin/true",
            },
        })

        assert resp["id"] == "hermes-2"
        assert resp["status"] == "failed"
        assert "not found" in resp["error"].lower() or "Bundle not found" in resp["error"]

        send_recv(proc, {"command": "shutdown"})
        proc.wait(timeout=5)

    def test_hermes_decompile_partial_failure(self, tmp_path):
        """If one tool fails, the other still runs and succeeds."""
        apk_file = str(tmp_path / 'test.apk')
        _create_hermes_apk(apk_file)

        # Decompiler fails
        decompiler_bin = str(tmp_path / 'mock_hbc_decompiler')
        _make_script(decompiler_bin, '#!/bin/sh\necho "error occurred" >&2\nexit 1\n')

        # Disassembler succeeds
        disassembler_bin = str(tmp_path / 'mock_hbc_disassembler')
        _make_script(disassembler_bin, '#!/bin/sh\necho "disassembly output" > "$2"\n')

        output_dir = str(tmp_path / 'decompile-output')

        proc = start_worker()
        resp = send_recv(proc, {
            "id": "hermes-3",
            "command": "hermes_decompile",
            "apkPath": apk_file,
            "outputDir": output_dir,
            "bundlePath": "assets/index.android.bundle",
            "tools": {
                "hbc_decompiler": decompiler_bin,
                "hbc_disassembler": disassembler_bin,
            },
        })

        assert resp["id"] == "hermes-3"
        assert resp["status"] == "completed"
        result = resp["result"]

        # Decompiler failed
        assert result["decompiler"]["success"] is False
        assert "error" in result["decompiler"]

        # Disassembler succeeded
        assert result["disassembler"]["success"] is True

        send_recv(proc, {"command": "shutdown"})
        proc.wait(timeout=5)

    def test_hermes_decompile_missing_params(self):
        """Missing required params returns error."""
        proc = start_worker()
        resp = send_recv(proc, {
            "id": "hermes-4",
            "command": "hermes_decompile",
        })
        assert resp["id"] == "hermes-4"
        assert resp["status"] == "failed"
        assert "Missing" in resp["error"]
        send_recv(proc, {"command": "shutdown"})
        proc.wait(timeout=5)


def _create_js_apk(apk_path: str, bundle_content: str = 'var x=1;function hello(){return"world"}',
                    bundle_path: str = 'assets/index.android.bundle'):
    """Helper: create a fake APK (ZIP) containing a plain JS bundle."""
    import zipfile
    with zipfile.ZipFile(apk_path, 'w') as zf:
        zf.writestr(bundle_path, bundle_content)


class TestBeautifyJsBundle:
    def test_beautify_extracts_and_beautifies(self, tmp_path):
        """beautify_js_bundle extracts JS from APK and produces beautified output."""
        apk_file = str(tmp_path / 'test.apk')
        _create_js_apk(apk_file)

        output_dir = str(tmp_path / 'decompile-output')

        proc = start_worker()
        resp = send_recv(proc, {
            "id": "beautify-1",
            "command": "beautify_js_bundle",
            "apkPath": apk_file,
            "outputDir": output_dir,
            "bundlePath": "assets/index.android.bundle",
        })

        assert resp["id"] == "beautify-1"
        assert resp["status"] == "completed"
        result = resp["result"]
        assert result["success"] is True

        # Output file should exist in hermes-dec/ subdirectory
        output_path = os.path.join(output_dir, 'hermes-dec', 'beautified.js')
        assert os.path.isfile(output_path)

        # Content should be beautified (indented)
        with open(output_path) as f:
            content = f.read()
        assert 'function hello' in content
        # Beautified output should have newlines/indentation
        assert '\n' in content

        send_recv(proc, {"command": "shutdown"})
        proc.wait(timeout=5)

    def test_beautify_missing_bundle(self, tmp_path):
        """APK without the expected bundle path returns error."""
        apk_file = str(tmp_path / 'test.apk')
        _create_js_apk(apk_file, bundle_path='assets/other.bundle')

        output_dir = str(tmp_path / 'decompile-output')

        proc = start_worker()
        resp = send_recv(proc, {
            "id": "beautify-2",
            "command": "beautify_js_bundle",
            "apkPath": apk_file,
            "outputDir": output_dir,
            "bundlePath": "assets/index.android.bundle",
        })

        assert resp["id"] == "beautify-2"
        assert resp["status"] == "failed"
        assert "not found" in resp["error"].lower() or "Bundle not found" in resp["error"]

        send_recv(proc, {"command": "shutdown"})
        proc.wait(timeout=5)

    def test_beautify_invalid_zip(self, tmp_path):
        """Invalid APK file returns error."""
        apk_file = str(tmp_path / 'not_a_zip.apk')
        with open(apk_file, 'w') as f:
            f.write('not a zip file')

        output_dir = str(tmp_path / 'decompile-output')

        proc = start_worker()
        resp = send_recv(proc, {
            "id": "beautify-3",
            "command": "beautify_js_bundle",
            "apkPath": apk_file,
            "outputDir": output_dir,
            "bundlePath": "assets/index.android.bundle",
        })

        assert resp["id"] == "beautify-3"
        assert resp["status"] == "failed"
        assert "Invalid ZIP" in resp["error"] or "ValueError" in resp["error"]

        send_recv(proc, {"command": "shutdown"})
        proc.wait(timeout=5)

    def test_beautify_missing_params(self):
        """Missing required params returns error."""
        proc = start_worker()
        resp = send_recv(proc, {
            "id": "beautify-4",
            "command": "beautify_js_bundle",
        })
        assert resp["id"] == "beautify-4"
        assert resp["status"] == "failed"
        assert "Missing" in resp["error"]
        send_recv(proc, {"command": "shutdown"})
        proc.wait(timeout=5)


class TestDetectFrameworks:
    """Unit tests for detect_frameworks()."""

    def test_flutter_detected(self):
        files = {'lib/arm64-v8a/libflutter.so': b'', 'lib/arm64-v8a/libapp.so': b''}
        result = detect_frameworks(files)
        names = [f['name'] for f in result]
        assert 'Flutter' in names

    def test_react_native_hermes_detected(self):
        files = {'assets/index.android.bundle': HERMES_MAGIC + b'\x00' * 60, 'lib/arm64-v8a/libhermes.so': b''}
        result = detect_frameworks(files)
        names = [f['name'] for f in result]
        assert 'React Native' in names
        rn = next(f for f in result if f['name'] == 'React Native')
        assert rn['details']['hermesEngine'] is True
        assert rn['details']['hermesBundlePath'] == 'assets/index.android.bundle'

    def test_react_native_plain_js(self):
        files = {'assets/index.android.bundle': b'var __BUNDLE_START_TIME__=Date.now()', 'lib/arm64-v8a/libjsc.so': b''}
        result = detect_frameworks(files)
        rn = next(f for f in result if f['name'] == 'React Native')
        assert rn['details']['hermesEngine'] is False
        assert rn['details']['jsBundlePath'] == 'assets/index.android.bundle'

    def test_xamarin_detected(self):
        files = {'lib/arm64-v8a/libmonodroid.so': b'', 'assemblies/Mono.Android.dll': b''}
        result = detect_frameworks(files)
        assert 'Xamarin' in [f['name'] for f in result]

    def test_unity_detected(self):
        files = {'lib/arm64-v8a/libunity.so': b''}
        result = detect_frameworks(files)
        assert 'Unity' in [f['name'] for f in result]

    def test_cordova_detected(self):
        files = {'assets/www/cordova.js': b'', 'assets/www/cordova_plugins.js': b'', 'assets/www/index.html': b''}
        result = detect_frameworks(files)
        assert 'Cordova' in [f['name'] for f in result]

    def test_qt_detected(self):
        files = {'lib/arm64-v8a/libQt6Core.so': b''}
        result = detect_frameworks(files)
        assert 'Qt' in [f['name'] for f in result]

    def test_godot_detected(self):
        files = {'lib/arm64-v8a/libgodot_android.so': b''}
        result = detect_frameworks(files)
        assert 'Godot' in [f['name'] for f in result]

    def test_unreal_detected(self):
        files = {'lib/arm64-v8a/libUE4.so': b''}
        result = detect_frameworks(files)
        assert 'Unreal Engine' in [f['name'] for f in result]

    def test_cocos2dx_detected(self):
        files = {'lib/arm64-v8a/libcocos2dcpp.so': b''}
        result = detect_frameworks(files)
        assert 'Cocos2d-x' in [f['name'] for f in result]

    def test_no_frameworks_returns_empty(self):
        files = {'lib/arm64-v8a/libnative-lib.so': b'', 'classes.dex': b''}
        result = detect_frameworks(files)
        assert result == []

    def test_multiple_frameworks(self):
        files = {'lib/arm64-v8a/libflutter.so': b'', 'lib/arm64-v8a/libunity.so': b''}
        result = detect_frameworks(files)
        names = [f['name'] for f in result]
        assert 'Flutter' in names
        assert 'Unity' in names

    def test_expo_detected(self):
        files = {'assets/shell-app.bundle': b'var x=1', 'lib/arm64-v8a/libhermes.so': b''}
        result = detect_frameworks(files)
        names = [f['name'] for f in result]
        assert 'Expo' in names
        assert 'React Native' in names

    def test_nativescript_detected(self):
        files = {'assets/app/bundle.js': b'', 'assets/internal/livesync.js': b''}
        result = detect_frameworks(files)
        assert 'NativeScript' in [f['name'] for f in result]

    def test_ionic_detected_with_native_bridge(self):
        files = {'assets/www/index.html': b'', 'assets/native-bridge.js': b''}
        result = detect_frameworks(files)
        assert 'Ionic' in [f['name'] for f in result]


class TestDetectLibraries:
    """Unit tests for detect_libraries()."""

    def test_detects_firebase(self):
        classes = ['Lcom/google/firebase/FirebaseApp;', 'Lcom/example/App;']
        result = detect_libraries(classes)
        assert 'Firebase' in [lib['name'] for lib in result]

    def test_detects_okhttp(self):
        classes = ['Lokhttp3/OkHttpClient;', 'Lokhttp3/Request;']
        result = detect_libraries(classes)
        assert 'OkHttp' in [lib['name'] for lib in result]

    def test_detects_multiple_libraries(self):
        classes = ['Lretrofit2/Retrofit;', 'Lcom/bumptech/glide/Glide;', 'Lcom/google/gson/Gson;']
        result = detect_libraries(classes)
        names = [lib['name'] for lib in result]
        assert 'Retrofit' in names
        assert 'Glide' in names
        assert 'Gson' in names

    def test_no_matches_returns_empty(self):
        classes = ['Lcom/example/custom/MyApp;']
        assert detect_libraries(classes) == []

    def test_detects_jetpack_compose(self):
        classes = ['Landroidx/compose/runtime/Composable;']
        assert 'Jetpack Compose' in [lib['name'] for lib in detect_libraries(classes)]

    def test_detects_kotlin_coroutines(self):
        classes = ['Lkotlinx/coroutines/CoroutineScope;']
        assert 'Kotlin Coroutines' in [lib['name'] for lib in detect_libraries(classes)]

    def test_empty_classes_returns_empty(self):
        assert detect_libraries([]) == []

    def test_does_not_duplicate_matches(self):
        classes = ['Lokhttp3/OkHttpClient;', 'Lokhttp3/Request;', 'Lokhttp3/Response;']
        result = detect_libraries(classes)
        assert len([lib for lib in result if lib['name'] == 'OkHttp']) == 1


class TestDetectBuildInfo:
    """Unit tests for detect_build_info()."""

    def test_returns_dict_structure(self, tmp_path):
        fake_apk = str(tmp_path / 'fake.apk')
        with open(fake_apk, 'wb') as f:
            f.write(b'PK\x03\x04' + b'\x00' * 100)
        result = detect_build_info(fake_apk)
        assert isinstance(result, dict)
        assert 'compiler' in result
        assert 'packer' in result
        assert 'obfuscator' in result
        assert 'anti_analysis' in result
        assert isinstance(result['compiler'], list)

    def test_returns_empty_on_error(self, tmp_path):
        fake_file = str(tmp_path / 'not_apk.txt')
        with open(fake_file, 'w') as f:
            f.write('not an apk')
        result = detect_build_info(fake_file)
        assert isinstance(result, dict)
        assert result['compiler'] == []

    @pytest.mark.skipif(not importlib.util.find_spec('apkid'), reason='apkid not installed (optional GPL dependency)')
    def test_parses_apkid_match_objects(self, tmp_path):
        """Test parsing APKiD's actual Match object format (list of matches with tags/meta)."""
        from unittest.mock import patch, MagicMock

        class FakeMatch:
            def __init__(self, tags, description):
                self.tags = tags
                self.meta = {'description': description}
            def __repr__(self):
                return self.meta['description']

        fake_result = {
            'test.apk!classes.dex': [
                FakeMatch(['file_type'], 'DEX'),
                FakeMatch(['compiler'], 'r8'),
                FakeMatch(['anti_vm'], 'Build.FINGERPRINT check'),
                FakeMatch(['anti_vm'], 'possible VM check'),
            ],
            'test.apk': [
                FakeMatch(['file_type'], 'APK'),
                FakeMatch(['packer'], 'Bangcle'),
            ],
        }

        fake_apk = str(tmp_path / 'test.apk')
        with open(fake_apk, 'wb') as f:
            f.write(b'PK\x03\x04' + b'\x00' * 100)

        with patch('apkid.apkid.Scanner') as mock_scanner_cls, \
             patch('apkid.rules.RulesManager') as mock_rules_cls, \
             patch('apkid.apkid.Options') as mock_options_cls:
            mock_scanner = MagicMock()
            mock_scanner.scan_file.return_value = fake_result
            mock_scanner_cls.return_value = mock_scanner
            mock_rules_cls.return_value.load.return_value = MagicMock()

            result = detect_build_info(fake_apk)

        assert 'r8' in result['compiler']
        assert 'DEX' not in result['compiler']  # file_type tags should be ignored
        assert 'Bangcle' in result['packer']
        assert 'Build.FINGERPRINT check' in result['anti_analysis']
        assert 'possible VM check' in result['anti_analysis']


# ---------------------------------------------------------------------------
# Map tile detection tests
# ---------------------------------------------------------------------------

class TestTileToLatLng:
    """Unit tests for _tile_to_lat_lng Web Mercator conversion."""

    def test_origin_tile(self):
        """Tile (0, 0, 0) should be NW corner of world: (85.05°, -180°)."""
        lat, lng = _tile_to_lat_lng(0, 0, 0)
        assert abs(lat - 85.0511) < 0.01
        assert abs(lng - (-180.0)) < 0.01

    def test_se_corner_of_world(self):
        """Tile (1, 1, 0) at z=0 should give SE corner."""
        lat, lng = _tile_to_lat_lng(1, 1, 0)
        assert abs(lat - (-85.0511)) < 0.01
        assert abs(lng - 180.0) < 0.01

    def test_known_tile_paris(self):
        """Tile at zoom 13 near Paris — verify reasonable lat/lng."""
        # z=13 tile (4156, 2816) should be roughly NW of DLP area
        lat, lng = _tile_to_lat_lng(4156, 2816, 13)
        assert 48.0 < lat < 50.0  # latitude in northern France range
        assert 2.0 < lng < 3.5    # longitude near Paris

    def test_zoom_0_full_world(self):
        """At zoom 0, (0,0) → (0,1) and (1,0) → (1,1) cover the full world."""
        nw_lat, nw_lng = _tile_to_lat_lng(0, 0, 0)
        se_lat, se_lng = _tile_to_lat_lng(1, 1, 0)
        assert nw_lng == -180.0
        assert se_lng == 180.0
        assert nw_lat > 0  # Northern hemisphere
        assert se_lat < 0  # Southern hemisphere

    def test_symmetry(self):
        """Tiles symmetric about the equator should have equal but opposite latitudes."""
        n = 2 ** 4  # z=4
        mid = n // 2
        lat_north, _ = _tile_to_lat_lng(0, mid - 1, 4)
        lat_south, _ = _tile_to_lat_lng(0, mid + 1, 4)
        # Not perfectly symmetric due to Mercator, but both should be on correct sides
        assert lat_north > 0
        assert lat_south < 0


class TestTilePathRegex:
    """Tests for the TILE_PATH_RE regex pattern."""

    def test_matches_standard_tile_path(self):
        m = TILE_PATH_RE.match('assets/map/13/4156/2816.jpg')
        assert m is not None
        assert m.group(1) == 'assets/map'
        assert m.group(2) == '13'
        assert m.group(3) == '4156'
        assert m.group(4) == '2816'
        assert m.group(5) == 'jpg'

    def test_matches_png(self):
        m = TILE_PATH_RE.match('tiles/0/0/0.png')
        assert m is not None
        assert m.group(5) == 'png'

    def test_matches_webp(self):
        m = TILE_PATH_RE.match('res/tiles/5/10/20.webp')
        assert m is not None
        assert m.group(5) == 'webp'

    def test_matches_jpeg(self):
        m = TILE_PATH_RE.match('assets/map/1/2/3.jpeg')
        assert m is not None
        assert m.group(5) == 'jpeg'

    def test_no_match_non_image(self):
        assert TILE_PATH_RE.match('assets/map/1/2/3.txt') is None

    def test_no_match_too_few_levels(self):
        assert TILE_PATH_RE.match('1/2.jpg') is None

    def test_no_match_non_numeric(self):
        assert TILE_PATH_RE.match('assets/map/abc/1/2.jpg') is None

    def test_deep_prefix(self):
        m = TILE_PATH_RE.match('a/b/c/d/1/2/3.png')
        assert m is not None
        assert m.group(1) == 'a/b/c/d'  # captures full prefix before z/x/y


class TestDetectMapTilesMocked:
    """Unit tests for detect_map_tiles using mocked zipfile objects."""

    def _make_mock_zipfile(self, file_list, file_sizes=None, file_data=None):
        """Create a mock ZipFile with given file list and optional sizes/data."""
        from unittest.mock import MagicMock
        import zipfile as _zf

        mock_zf = MagicMock()
        infos = []
        for fname in file_list:
            info = MagicMock(spec=_zf.ZipInfo)
            info.filename = fname
            info.file_size = file_sizes.get(fname, 100) if file_sizes else 100
            infos.append(info)
        mock_zf.infolist.return_value = infos

        def read_file(fname):
            if file_data and fname in file_data:
                return file_data[fname]
            return b'\xff' * 100

        mock_zf.read.side_effect = read_file
        return mock_zf

    def _generate_tile_paths(self, prefix, zoom_ranges):
        """Generate tile paths for given zoom ranges.
        zoom_ranges: {z: (minX, maxX, minY, maxY)}
        """
        paths = []
        for z, (min_x, max_x, min_y, max_y) in zoom_ranges.items():
            for x in range(min_x, max_x + 1):
                for y in range(min_y, max_y + 1):
                    paths.append(f'{prefix}/{z}/{x}/{y}.jpg')
        return paths

    def test_detects_simple_tile_set(self):
        """Basic tile detection with 2 zoom levels."""
        paths = self._generate_tile_paths('assets/map', {
            1: (0, 1, 0, 1),   # z=1: 4 tiles
            2: (0, 3, 0, 3),   # z=2: 16 tiles
        })
        # 20 tiles total, 2 zoom levels → should detect

        from unittest.mock import patch
        mock_zf = self._make_mock_zipfile(paths)
        with patch('zipfile.ZipFile', return_value=mock_zf):
            result = detect_map_tiles('/fake.apk')

        assert len(result['tileSets']) == 1
        ts = result['tileSets'][0]
        assert ts['basePath'] == 'assets/map'
        assert ts['name'] == 'map'
        assert ts['format'] == 'jpg'
        assert ts['zoomLevels'] == [1, 2]
        assert ts['minZoom'] == 1
        assert ts['maxZoom'] == 2
        assert ts['tileCount'] == 20
        assert 'contentHash' in ts
        assert ts['contentHash'].startswith('sha256:')
        assert 'bounds' in ts
        assert 'zoomRanges' in ts

    def test_rejects_too_few_zoom_levels(self):
        """Single zoom level should be rejected (need ≥2)."""
        paths = [f'tiles/{5}/{x}/{y}.png' for x in range(5) for y in range(5)]
        # 25 tiles but only 1 zoom → should NOT detect

        from unittest.mock import patch
        mock_zf = self._make_mock_zipfile(paths)
        with patch('zipfile.ZipFile', return_value=mock_zf):
            result = detect_map_tiles('/fake.apk')

        assert len(result['tileSets']) == 0

    def test_rejects_too_few_tiles(self):
        """Fewer than 10 tiles should be rejected."""
        paths = [
            'tiles/1/0/0.jpg',
            'tiles/1/0/1.jpg',
            'tiles/2/0/0.jpg',
            'tiles/2/0/1.jpg',
        ]
        # 4 tiles with 2 zoom levels → too few

        from unittest.mock import patch
        mock_zf = self._make_mock_zipfile(paths)
        with patch('zipfile.ZipFile', return_value=mock_zf):
            result = detect_map_tiles('/fake.apk')

        assert len(result['tileSets']) == 0

    def test_detects_multiple_tile_sets(self):
        """Two different tile prefixes should be detected as separate sets."""
        paths_a = self._generate_tile_paths('assets/map', {
            1: (0, 1, 0, 1),
            2: (0, 3, 0, 3),
        })
        paths_b = self._generate_tile_paths('assets/winter', {
            3: (0, 1, 0, 1),
            4: (0, 3, 0, 3),
        })

        from unittest.mock import patch
        mock_zf = self._make_mock_zipfile(paths_a + paths_b)
        with patch('zipfile.ZipFile', return_value=mock_zf):
            result = detect_map_tiles('/fake.apk')

        assert len(result['tileSets']) == 2
        names = sorted(ts['name'] for ts in result['tileSets'])
        assert names == ['map', 'winter']

    def test_bounds_computation(self):
        """Bounds should be computed from the highest zoom level (tightest)."""
        paths = self._generate_tile_paths('tiles', {
            1: (0, 1, 0, 1),   # z=1: full world
            2: (0, 3, 0, 3),   # z=2: full world
        })

        from unittest.mock import patch
        mock_zf = self._make_mock_zipfile(paths)
        with patch('zipfile.ZipFile', return_value=mock_zf):
            result = detect_map_tiles('/fake.apk')

        ts = result['tileSets'][0]
        bounds = ts['bounds']
        # At z=2, tiles (0,0)→(4,4) also covers entire world
        assert bounds['minLat'] < -80
        assert bounds['maxLat'] > 80
        assert bounds['minLng'] == -180.0
        assert bounds['maxLng'] == 180.0

    def test_bounds_from_highest_zoom_is_tighter(self):
        """Highest zoom should give tighter bounds than lowest zoom."""
        # z=3: covers a wide area (few tiles)
        # z=5: covers a smaller area (specific tiles)
        paths = self._generate_tile_paths('tiles', {
            3: (4, 5, 4, 5),     # z=3: 4 tiles, wide area
            5: (16, 17, 16, 17), # z=5: 4 tiles within the z=3 area but tighter
        })
        # Pad to get >=10 tiles
        paths += self._generate_tile_paths('tiles', {
            4: (8, 11, 8, 11),   # z=4: 16 tiles
        })

        from unittest.mock import patch
        mock_zf = self._make_mock_zipfile(paths)
        with patch('zipfile.ZipFile', return_value=mock_zf):
            result = detect_map_tiles('/fake.apk')

        ts = result['tileSets'][0]
        bounds = ts['bounds']

        # z=5 tiles (16,16)→(18,18): these map to a specific quadrant
        # Verify the bounds use z=5 (highest) not z=3 (lowest)
        from apk_analyzer import _tile_to_lat_lng
        nw_lat_z5, nw_lng_z5 = _tile_to_lat_lng(16, 16, 5)
        se_lat_z5, se_lng_z5 = _tile_to_lat_lng(18, 18, 5)
        nw_lat_z3, nw_lng_z3 = _tile_to_lat_lng(4, 4, 3)
        se_lat_z3, se_lng_z3 = _tile_to_lat_lng(6, 6, 3)

        # z=5 bounds should be tighter (smaller range) than z=3
        z5_lat_range = nw_lat_z5 - se_lat_z5
        z3_lat_range = nw_lat_z3 - se_lat_z3
        assert z5_lat_range < z3_lat_range

        # Verify the detected bounds match z=5
        assert abs(bounds['maxLat'] - round(nw_lat_z5, 6)) < 0.001
        assert abs(bounds['minLng'] - round(nw_lng_z5, 6)) < 0.001

    def test_content_hash_deterministic(self):
        """Same tile set should produce the same content hash."""
        paths = self._generate_tile_paths('assets/map', {
            1: (0, 1, 0, 1),
            2: (0, 3, 0, 3),
        })

        from unittest.mock import patch

        mock_zf1 = self._make_mock_zipfile(paths)
        with patch('zipfile.ZipFile', return_value=mock_zf1):
            result1 = detect_map_tiles('/fake.apk')

        mock_zf2 = self._make_mock_zipfile(paths)
        with patch('zipfile.ZipFile', return_value=mock_zf2):
            result2 = detect_map_tiles('/fake.apk')

        assert result1['tileSets'][0]['contentHash'] == result2['tileSets'][0]['contentHash']

    def test_content_hash_changes_with_file_size(self):
        """Different file sizes should produce different content hashes."""
        paths = self._generate_tile_paths('assets/map', {
            1: (0, 1, 0, 1),
            2: (0, 3, 0, 3),
        })

        from unittest.mock import patch

        sizes_a = {p: 100 for p in paths}
        sizes_b = {p: 200 for p in paths}

        mock_zf1 = self._make_mock_zipfile(paths, file_sizes=sizes_a)
        with patch('zipfile.ZipFile', return_value=mock_zf1):
            result1 = detect_map_tiles('/fake.apk')

        mock_zf2 = self._make_mock_zipfile(paths, file_sizes=sizes_b)
        with patch('zipfile.ZipFile', return_value=mock_zf2):
            result2 = detect_map_tiles('/fake.apk')

        assert result1['tileSets'][0]['contentHash'] != result2['tileSets'][0]['contentHash']

    def test_zoom_ranges_correct(self):
        """Per-zoom coordinate ranges should be computed correctly."""
        paths = self._generate_tile_paths('tiles', {
            5: (10, 15, 20, 25),
            6: (20, 31, 40, 51),
        })

        from unittest.mock import patch
        mock_zf = self._make_mock_zipfile(paths)
        with patch('zipfile.ZipFile', return_value=mock_zf):
            result = detect_map_tiles('/fake.apk')

        ts = result['tileSets'][0]
        assert ts['zoomRanges']['5'] == {'minX': 10, 'maxX': 15, 'minY': 20, 'maxY': 25}
        assert ts['zoomRanges']['6'] == {'minX': 20, 'maxX': 31, 'minY': 40, 'maxY': 51}

    def test_jpeg_normalized_to_jpg(self):
        """'jpeg' extension should be normalized to 'jpg' in format field."""
        paths = self._generate_tile_paths('tiles', {
            1: (0, 1, 0, 1),
            2: (0, 3, 0, 3),
        })
        # Replace .jpg with .jpeg
        paths = [p.replace('.jpg', '.jpeg') for p in paths]

        from unittest.mock import patch
        mock_zf = self._make_mock_zipfile(paths)
        with patch('zipfile.ZipFile', return_value=mock_zf):
            result = detect_map_tiles('/fake.apk')

        assert result['tileSets'][0]['format'] == 'jpg'

    def test_name_from_nested_prefix(self):
        """Name should be derived from last path segment."""
        paths = self._generate_tile_paths('res/raw/map_data', {
            1: (0, 1, 0, 1),
            2: (0, 3, 0, 3),
        })

        from unittest.mock import patch
        mock_zf = self._make_mock_zipfile(paths)
        with patch('zipfile.ZipFile', return_value=mock_zf):
            result = detect_map_tiles('/fake.apk')

        assert result['tileSets'][0]['name'] == 'map_data'
        assert result['tileSets'][0]['basePath'] == 'res/raw/map_data'

    def test_tile_size_defaults_to_256(self):
        """When PIL fails or is unavailable, tile size defaults to 256."""
        paths = self._generate_tile_paths('tiles', {
            1: (0, 1, 0, 1),
            2: (0, 3, 0, 3),
        })

        from unittest.mock import patch
        mock_zf = self._make_mock_zipfile(paths)
        # Return invalid image data so PIL.Image.open fails
        mock_zf.read.side_effect = lambda f: b'not-an-image'
        with patch('zipfile.ZipFile', return_value=mock_zf):
            result = detect_map_tiles('/fake.apk')

        assert result['tileSets'][0]['tileSize'] == 256

    def test_non_tile_files_ignored(self):
        """Non-tile files mixed in should be ignored."""
        tile_paths = self._generate_tile_paths('assets/map', {
            1: (0, 1, 0, 1),
            2: (0, 3, 0, 3),
        })
        other_paths = [
            'classes.dex',
            'AndroidManifest.xml',
            'res/layout/main.xml',
            'assets/map/readme.txt',
            'assets/map/config.json',
        ]

        from unittest.mock import patch
        mock_zf = self._make_mock_zipfile(tile_paths + other_paths)
        with patch('zipfile.ZipFile', return_value=mock_zf):
            result = detect_map_tiles('/fake.apk')

        assert len(result['tileSets']) == 1
        assert result['tileSets'][0]['tileCount'] == 20

    def test_empty_apk(self):
        """APK with no files returns empty tileSets."""
        from unittest.mock import patch
        mock_zf = self._make_mock_zipfile([])
        with patch('zipfile.ZipFile', return_value=mock_zf):
            result = detect_map_tiles('/fake.apk')

        assert result == {'tileSets': []}


class TestExtractMapTilesMocked:
    """Unit tests for extract_map_tiles."""

    def _make_mock_zipfile(self, file_list, file_data=None):
        """Create a mock ZipFile for extract tests."""
        from unittest.mock import MagicMock
        import zipfile as _zf

        mock_zf = MagicMock()
        infos = []
        for fname in file_list:
            info = MagicMock(spec=_zf.ZipInfo)
            info.filename = fname
            info.file_size = len(file_data.get(fname, b'')) if file_data else 100
            infos.append(info)
        mock_zf.infolist.return_value = infos

        def read_file(fname):
            if file_data and fname in file_data:
                return file_data[fname]
            return b'\xff' * 100

        mock_zf.read.side_effect = read_file
        return mock_zf

    def test_extracts_tiles_to_disk(self, tmp_path):
        """Tiles should be written to output_dir/{z}/{x}/{y}.{ext}."""
        from unittest.mock import patch

        tile_data = {
            'assets/map/1/0/0.jpg': b'\xff\xd8\xff' + b'\x00' * 50,
            'assets/map/1/0/1.jpg': b'\xff\xd8\xff' + b'\x00' * 60,
            'assets/map/2/0/0.jpg': b'\xff\xd8\xff' + b'\x00' * 70,
        }

        mock_zf = self._make_mock_zipfile(
            list(tile_data.keys()) + ['AndroidManifest.xml'],
            file_data=tile_data,
        )

        output = str(tmp_path / 'output')

        with patch('zipfile.ZipFile', return_value=mock_zf):
            result = extract_map_tiles('/fake.apk', 'assets/map', output)

        assert result['extractedCount'] == 3
        assert result['totalBytes'] == 50 + 3 + 60 + 3 + 70 + 3  # each has 3-byte header + padding
        assert (tmp_path / 'output' / '1' / '0' / '0.jpg').exists()
        assert (tmp_path / 'output' / '1' / '0' / '1.jpg').exists()
        assert (tmp_path / 'output' / '2' / '0' / '0.jpg').exists()

    def test_skips_non_matching_files(self, tmp_path):
        """Only files matching basePath prefix should be extracted."""
        from unittest.mock import patch

        tile_data = {
            'assets/map/1/0/0.jpg': b'\xff' * 10,
            'assets/other/1/0/0.jpg': b'\xff' * 10,
        }

        mock_zf = self._make_mock_zipfile(list(tile_data.keys()), file_data=tile_data)

        output = str(tmp_path / 'output')

        with patch('zipfile.ZipFile', return_value=mock_zf):
            result = extract_map_tiles('/fake.apk', 'assets/map', output)

        assert result['extractedCount'] == 1
        assert not (tmp_path / 'output' / 'assets').exists()  # Should be flat z/x/y


class TestDetectMapTilesWorkerProtocol:
    """Tests for the detect_map_tiles command handler via worker protocol."""

    def test_missing_apk_path(self):
        proc = start_worker()
        resp = send_recv(proc, {"id": "t1", "command": "detect_map_tiles"})
        assert resp["status"] == "failed"
        assert "Missing" in resp["error"]
        send_recv(proc, {"command": "shutdown"})
        proc.wait(timeout=5)

    def test_nonexistent_apk(self):
        proc = start_worker()
        resp = send_recv(proc, {
            "id": "t2",
            "command": "detect_map_tiles",
            "apkPath": "/no/such/file.apk",
        })
        assert resp["status"] == "failed"
        assert "not found" in resp["error"]
        send_recv(proc, {"command": "shutdown"})
        proc.wait(timeout=5)


class TestExtractMapTilesWorkerProtocol:
    """Tests for the extract_map_tiles command handler via worker protocol."""

    def test_missing_params(self):
        proc = start_worker()
        resp = send_recv(proc, {"id": "t3", "command": "extract_map_tiles"})
        assert resp["status"] == "failed"
        assert "Missing" in resp["error"]
        send_recv(proc, {"command": "shutdown"})
        proc.wait(timeout=5)

    def test_nonexistent_apk(self):
        proc = start_worker()
        resp = send_recv(proc, {
            "id": "t4",
            "command": "extract_map_tiles",
            "apkPath": "/no/such/file.apk",
            "basePath": "assets/map",
            "outputDir": "/tmp/test-output",
        })
        assert resp["status"] == "failed"
        assert "not found" in resp["error"]
        send_recv(proc, {"command": "shutdown"})
        proc.wait(timeout=5)


# ---------------------------------------------------------------------------
# DLP APK integration test — runs against real APK, slow, marked with marker
# ---------------------------------------------------------------------------

DLP_BASE_APK = "/tmp/dlp_test/base.apk"

@pytest.mark.skipif(
    not os.path.exists(DLP_BASE_APK),
    reason=f"DLP APK not found at {DLP_BASE_APK}"
)
class TestDetectMapTilesDLP:
    """Integration tests running detect_map_tiles against the real DLP APK."""

    def test_detect_via_worker(self):
        """Run detect_map_tiles via the worker subprocess on the DLP base.apk."""
        proc = start_worker()
        resp = send_recv(proc, {
            "id": "dlp-detect",
            "command": "detect_map_tiles",
            "apkPath": DLP_BASE_APK,
        })
        send_recv(proc, {"command": "shutdown"})
        proc.wait(timeout=10)

        assert resp["status"] == "completed", f"Failed: {resp.get('error')}"
        result = resp["result"]

        assert len(result["tileSets"]) >= 1

        # Find the main map tile set
        map_set = None
        for ts in result["tileSets"]:
            if ts["basePath"] == "assets/map" or ts["name"] == "map":
                map_set = ts
                break

        assert map_set is not None, f"Expected 'assets/map' tile set, got: {[ts['basePath'] for ts in result['tileSets']]}"

        # Verify known DLP tile set properties
        assert map_set["format"] == "jpg"
        assert map_set["tileCount"] > 10000      # Should be ~10,455
        assert map_set["tileCount"] < 15000       # Sanity upper bound
        assert 13 in map_set["zoomLevels"]
        assert 19 in map_set["zoomLevels"]
        assert map_set["minZoom"] == 13
        assert map_set["maxZoom"] == 19
        assert len(map_set["zoomLevels"]) == 7    # 13,14,15,16,17,18,19

        # Bounds should be near DLP (Marne-la-Vallée, ~48.87°N, 2.78°E)
        bounds = map_set["bounds"]
        assert 48.5 < bounds["maxLat"] < 49.5     # Northern bound (wider range)
        assert 48.5 < bounds["minLat"] < 49.0     # Southern bound
        assert 2.0 < bounds["minLng"] < 3.0       # Western bound
        assert 2.5 < bounds["maxLng"] < 3.5       # Eastern bound

        # Content hash should be present and deterministic
        assert map_set["contentHash"].startswith("sha256:")
        assert len(map_set["contentHash"]) == 7 + 64  # "sha256:" + 64 hex chars

        # Tile size — DLP uses 512px tiles
        assert map_set["tileSize"] in (256, 512)

        # Zoom ranges should have entries for each zoom
        assert set(map_set["zoomRanges"].keys()) == {'13', '14', '15', '16', '17', '18', '19'}

        # Total bytes should be substantial (>40MB)
        assert map_set["totalBytes"] > 40_000_000

    def test_detect_direct_function(self):
        """Call detect_map_tiles directly (no subprocess) for faster validation."""
        result = detect_map_tiles(DLP_BASE_APK)

        assert len(result["tileSets"]) >= 1

        map_set = next(
            (ts for ts in result["tileSets"] if "map" in ts["basePath"].lower()),
            None,
        )
        assert map_set is not None

        # Quick sanity checks (detailed checks in test_detect_via_worker)
        assert map_set["tileCount"] > 10000
        assert map_set["minZoom"] <= 14
        assert map_set["maxZoom"] >= 18
        assert map_set["contentHash"].startswith("sha256:")

    def test_extract_tiles(self, tmp_path):
        """Extract a small subset of tiles and verify files on disk."""
        # First detect to get the basePath
        result = detect_map_tiles(DLP_BASE_APK)
        map_set = next(
            (ts for ts in result["tileSets"] if "map" in ts["basePath"].lower()),
            None,
        )
        assert map_set is not None

        output = str(tmp_path / "extracted")
        extract_result = extract_map_tiles(DLP_BASE_APK, map_set["basePath"], output)

        assert extract_result["extractedCount"] == map_set["tileCount"]
        assert extract_result["totalBytes"] > 0

        # Verify some tiles exist on disk
        import glob
        jpgs = glob.glob(os.path.join(output, "**", "*.jpg"), recursive=True)
        assert len(jpgs) == extract_result["extractedCount"]

        # Verify directory structure: z/x/y.jpg
        sample = jpgs[0]
        parts = os.path.relpath(sample, output).split(os.sep)
        assert len(parts) == 3  # z/x/y.jpg
        assert parts[0].isdigit()
        assert parts[1].isdigit()
        assert parts[2].endswith('.jpg')


class TestJsScanningRules:
    """Tests for JS/React Native specific scanning rules."""

    def test_scan_finds_api_path(self, tmp_path):
        db_path = str(tmp_path / 'source.db')
        _create_source_db(db_path, [
            ('bundle.js', 'hermes-dec', 'javascript',
             'var endpoint = "/api/v1/users";\nvar gql = "/graphql";\n'),
        ])
        proc = start_worker()
        resp = send_recv(proc, {"id": "js-1", "command": "scan_secrets", "dbPath": db_path})
        assert resp["status"] == "completed"
        conn = sqlite3.connect(db_path)
        findings = conn.execute(
            "SELECT rule_id, matched_text, category FROM findings WHERE rule_id = 'api-path'"
        ).fetchall()
        assert len(findings) >= 1
        assert any('/api/v1/users' in f[1] for f in findings)
        assert all(f[2] == 'endpoint' for f in findings)
        conn.close()
        send_recv(proc, {"command": "shutdown"})
        proc.wait(timeout=5)

    def test_scan_finds_api_base_url(self, tmp_path):
        db_path = str(tmp_path / 'source.db')
        _create_source_db(db_path, [
            ('config.js', 'hermes-dec', 'javascript',
             'const BASE = "https://api.myapp.com/v1/endpoint";\n'),
        ])
        proc = start_worker()
        resp = send_recv(proc, {"id": "js-2", "command": "scan_secrets", "dbPath": db_path})
        assert resp["status"] == "completed"
        conn = sqlite3.connect(db_path)
        findings = conn.execute(
            "SELECT rule_id, matched_text, category FROM findings WHERE rule_id = 'api-base-url'"
        ).fetchall()
        assert len(findings) >= 1
        assert any('api.myapp.com' in f[1] for f in findings)
        assert findings[0][2] == 'endpoint'
        conn.close()
        send_recv(proc, {"command": "shutdown"})
        proc.wait(timeout=5)

    def test_scan_finds_deeplink_scheme(self, tmp_path):
        db_path = str(tmp_path / 'source.db')
        _create_source_db(db_path, [
            ('links.js', 'hermes-dec', 'javascript',
             'const link = "myapp://profile/settings";\n'),
        ])
        proc = start_worker()
        resp = send_recv(proc, {"id": "js-3", "command": "scan_secrets", "dbPath": db_path})
        assert resp["status"] == "completed"
        conn = sqlite3.connect(db_path)
        findings = conn.execute(
            "SELECT rule_id, matched_text FROM findings WHERE rule_id = 'deeplink-scheme'"
        ).fetchall()
        assert len(findings) >= 1
        assert any('myapp://profile/settings' in f[1] for f in findings)
        conn.close()
        send_recv(proc, {"command": "shutdown"})
        proc.wait(timeout=5)

    def test_scan_skips_common_uri_schemes(self, tmp_path):
        """Should not flag file://, mailto:, content:// etc. as deep links."""
        db_path = str(tmp_path / 'source.db')
        _create_source_db(db_path, [
            ('boring.js', 'hermes-dec', 'javascript',
             'var f = "file:///data/app/test";\n'
             'var m = "mailto://user@example.com";\n'
             'var c = "content://provider/table";\n'),
        ])
        proc = start_worker()
        resp = send_recv(proc, {"id": "js-4", "command": "scan_secrets", "dbPath": db_path})
        assert resp["status"] == "completed"
        conn = sqlite3.connect(db_path)
        findings = conn.execute(
            "SELECT rule_id FROM findings WHERE rule_id = 'deeplink-scheme'"
        ).fetchall()
        assert len(findings) == 0
        conn.close()
        send_recv(proc, {"command": "shutdown"})
        proc.wait(timeout=5)

    def test_scan_finds_feature_flag(self, tmp_path):
        db_path = str(tmp_path / 'source.db')
        _create_source_db(db_path, [
            ('flags.js', 'hermes-dec', 'javascript',
             'const flag = "feature_dark_mode";\n'
             'const exp = "experiment_new_checkout";\n'),
        ])
        proc = start_worker()
        resp = send_recv(proc, {"id": "js-5", "command": "scan_secrets", "dbPath": db_path})
        assert resp["status"] == "completed"
        conn = sqlite3.connect(db_path)
        findings = conn.execute(
            "SELECT rule_id, matched_text, category FROM findings WHERE rule_id = 'feature-flag-key'"
        ).fetchall()
        assert len(findings) >= 2
        assert all(f[2] == 'config' for f in findings)
        conn.close()
        send_recv(proc, {"command": "shutdown"})
        proc.wait(timeout=5)

    def test_scan_finds_graphql_operation(self, tmp_path):
        db_path = str(tmp_path / 'source.db')
        _create_source_db(db_path, [
            ('queries.js', 'hermes-dec', 'javascript',
             'const q = `query GetUser {\n  user { id name }\n}`;\n'
             'const m = `mutation UpdateProfile {\n  updateProfile { ok }\n}`;\n'),
        ])
        proc = start_worker()
        resp = send_recv(proc, {"id": "js-6", "command": "scan_secrets", "dbPath": db_path})
        assert resp["status"] == "completed"
        conn = sqlite3.connect(db_path)
        findings = conn.execute(
            "SELECT rule_id, matched_text, category FROM findings WHERE rule_id = 'graphql-operation'"
        ).fetchall()
        assert len(findings) >= 2
        assert any('GetUser' in f[1] for f in findings)
        assert any('UpdateProfile' in f[1] for f in findings)
        assert all(f[2] == 'endpoint' for f in findings)
        conn.close()
        send_recv(proc, {"command": "shutdown"})
        proc.wait(timeout=5)

    def test_scan_finds_websocket_url(self, tmp_path):
        db_path = str(tmp_path / 'source.db')
        _create_source_db(db_path, [
            ('ws.js', 'hermes-dec', 'javascript',
             'const ws = "wss://realtime.myapp.com/socket";\n'),
        ])
        proc = start_worker()
        resp = send_recv(proc, {"id": "js-7", "command": "scan_secrets", "dbPath": db_path})
        assert resp["status"] == "completed"
        conn = sqlite3.connect(db_path)
        findings = conn.execute(
            "SELECT rule_id, matched_text, category FROM findings WHERE rule_id = 'websocket-url'"
        ).fetchall()
        assert len(findings) >= 1
        assert any('wss://realtime.myapp.com/socket' in f[1] for f in findings)
        assert findings[0][2] == 'endpoint'
        conn.close()
        send_recv(proc, {"command": "shutdown"})
        proc.wait(timeout=5)

    def test_scan_finds_react_navigation_route(self, tmp_path):
        db_path = str(tmp_path / 'source.db')
        _create_source_db(db_path, [
            ('nav.js', 'hermes-dec', 'javascript',
             'Screen: name = "HomeScreen"\n'
             'screen: name = "ProfileView"\n'),
        ])
        proc = start_worker()
        resp = send_recv(proc, {"id": "js-8", "command": "scan_secrets", "dbPath": db_path})
        assert resp["status"] == "completed"
        conn = sqlite3.connect(db_path)
        findings = conn.execute(
            "SELECT rule_id, matched_text, category FROM findings WHERE rule_id = 'react-navigation-route'"
        ).fetchall()
        assert len(findings) >= 1
        assert findings[0][2] == 'config'
        conn.close()
        send_recv(proc, {"command": "shutdown"})
        proc.wait(timeout=5)

    def test_new_categories_in_patterns(self):
        """Verify endpoint and config categories exist in SECRET_PATTERNS."""
        categories = {p[3] for p in SECRET_PATTERNS}
        assert 'endpoint' in categories
        assert 'config' in categories

    def test_ignored_deeplink_schemes(self):
        """Verify common schemes are in the ignore list."""
        assert 'file' in IGNORED_DEEPLINK_SCHEMES
        assert 'content' in IGNORED_DEEPLINK_SCHEMES
        assert 'mailto' in IGNORED_DEEPLINK_SCHEMES
        assert 'javascript' in IGNORED_DEEPLINK_SCHEMES
