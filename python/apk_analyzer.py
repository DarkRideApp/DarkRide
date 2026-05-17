#!/usr/bin/env python3
"""
APK Analyzer — Long-running worker that extracts metadata from APK files using androguard.

Protocol: JSON-over-stdin/stdout, one message per line.

Inbound:
  {"id": "job-123", "command": "analyze", "apkPath": "...", "outputDir": "..."}
  {"command": "shutdown"}

Outbound:
  {"id": "job-123", "status": "completed", "result": {...}}
  {"id": "job-123", "status": "failed", "error": "..."}
"""

import hashlib
import json
import math
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import traceback
import xml.etree.ElementTree as ET
import zipfile
import zlib
import zstandard as zstd


def decompress_content(data: bytes) -> bytes:
    """Decompress file content — tries zstd first, falls back to zlib for older DBs."""
    try:
        return zstd.decompress(data)
    except Exception:
        return zlib.decompress(data)


HERMES_MAGIC = b'\xc6\x1f\xbc\x03'
HERMES_BUNDLE_PATHS = [
    'assets/index.android.bundle',
    'assets/hermes/index.android.bundle',
]


def detect_react_native(files: dict[str, bytes]) -> dict | None:
    """Detect React Native framework usage from APK file entries.

    Args:
        files: dict of filename -> raw bytes (first ~64 bytes for bundle files,
               empty bytes for native libs where only presence matters).

    Returns:
        {'reactNative': True, 'hermesEngine': bool, 'hermesBundlePath': str|None,
         'jsBundlePath': str|None}
        or None if React Native is not detected.
    """
    # Check for Hermes or JSC native libraries
    has_hermes_lib = any('libhermes.so' in name for name in files)
    has_jsc_lib = any('libjsc.so' in name for name in files)

    # Check for Hermes bytecode bundles and plain JS bundles
    hermes_bundle_path = None
    js_bundle_path = None
    for name, data in files.items():
        # Only look at bundle files in assets/
        if not (name.endswith('.bundle') or name.endswith('.jsbundle')):
            continue
        if not name.startswith('assets/'):
            continue
        if len(data) >= 4 and data[:4] == HERMES_MAGIC:
            if hermes_bundle_path is None:
                hermes_bundle_path = name
        elif len(data) >= 4 and (data[:4] == b'var ' or b'__BUNDLE_START_TIME__' in data[:64]):
            if js_bundle_path is None:
                js_bundle_path = name

    # Resource heuristic: Metro bundler flattens node_modules paths into resource names
    # Normalize both sides (remove dashes/underscores) so node_modules_react-native → nodemodulesreactnative
    has_rn_resources = any('nodemodulesreactnative' in name.lower().replace('-', '').replace('_', '')
                           for name in files)

    # Determine if this is a React Native app
    is_react_native = (has_hermes_lib or has_jsc_lib or
                       hermes_bundle_path is not None or
                       js_bundle_path is not None or
                       has_rn_resources)

    if not is_react_native:
        return None

    hermes_engine = has_hermes_lib or hermes_bundle_path is not None

    return {
        'reactNative': True,
        'hermesEngine': hermes_engine,
        'hermesBundlePath': hermes_bundle_path,
        'jsBundlePath': js_bundle_path,
    }


# Framework detection signatures: (name, check_function)

def _detect_flutter(files: dict) -> dict | None:
    """Detect Flutter and capture arch/libapp/assets details."""
    if not any('libflutter.so' in n for n in files):
        return None
    arch = None
    if 'lib/arm64-v8a/libapp.so' in files:
        arch = 'arm64-v8a'
    elif 'lib/armeabi-v7a/libapp.so' in files:
        arch = 'armeabi-v7a'
    return {
        'hasLibApp': any('libapp.so' in n for n in files),
        'hasFlutterAssets': any(
            'flutter_assets/' in n or n.startswith('assets/flutter_assets')
            for n in files
        ),
        'arch': arch,
    }


FRAMEWORK_SIGNATURES = [
    ('Flutter', _detect_flutter),
    ('Xamarin', lambda files: {} if any('libmonodroid.so' in n or 'libmonosgen-2.0.so' in n for n in files) else None),
    ('Unity', lambda files: {} if any('libunity.so' in n for n in files) else None),
    ('Cordova', lambda files: {} if any(n == 'assets/www/cordova.js' or n == 'assets/www/cordova_plugins.js' for n in files) else None),
    ('Ionic', lambda files: {} if any(n == 'assets/native-bridge.js' for n in files) else None),
    ('Qt', lambda files: {} if any('libQt5Core.so' in n or 'libQt6Core.so' in n for n in files) else None),
    ('Godot', lambda files: {} if any('libgodot_android.so' in n for n in files) else None),
    ('Unreal Engine', lambda files: {} if any('libUE4.so' in n for n in files) else None),
    ('Cocos2d-x', lambda files: {} if any('libcocos2dcpp.so' in n for n in files) else None),
    ('Expo', lambda files: {} if any(n in ('assets/shell-app.bundle', 'assets/expo-manifest.json') for n in files) else None),
    ('NativeScript', lambda files: {} if (any(n == 'assets/app/bundle.js' for n in files) and any(n.startswith('assets/internal/') for n in files)) else None),
]


def detect_frameworks(files: dict[str, bytes]) -> list[dict]:
    """Detect cross-platform frameworks from APK file entries.

    Args:
        files: dict of filename -> raw bytes (first ~64 bytes for bundle files,
               empty bytes for native libs where only presence matters).

    Returns:
        List of {'name': str, 'details': dict} for each detected framework.
        React Native entry includes backward-compat keys: hermesEngine, hermesBundlePath, jsBundlePath.
    """
    detected = []

    # React Native — use existing detailed detection
    rn = detect_react_native(files)
    if rn:
        detected.append({
            'name': 'React Native',
            'details': {
                'hermesEngine': rn['hermesEngine'],
                'hermesBundlePath': rn.get('hermesBundlePath'),
                'jsBundlePath': rn.get('jsBundlePath'),
            },
        })

    # All other frameworks
    for name, check_fn in FRAMEWORK_SIGNATURES:
        details = check_fn(files)
        if details is not None:
            detected.append({'name': name, 'details': details})

    return detected


LIBRARY_SIGNATURES = {
    'Firebase': ['com/google/firebase/'],
    'Google Play Services': ['com/google/android/gms/'],
    'Google Ads (AdMob)': ['com/google/android/gms/ads/'],
    'OkHttp': ['okhttp3/'],
    'Retrofit': ['retrofit2/'],
    'Glide': ['com/bumptech/glide/'],
    'Picasso': ['com/squareup/picasso/'],
    'Gson': ['com/google/gson/'],
    'Moshi': ['com/squareup/moshi/'],
    'RxJava': ['io/reactivex/'],
    'Dagger': ['dagger/'],
    'Room': ['androidx/room/'],
    'WorkManager': ['androidx/work/'],
    'Kotlin Coroutines': ['kotlinx/coroutines/'],
    'Jetpack Compose': ['androidx/compose/'],
    'Lottie': ['com/airbnb/lottie/'],
    'Sentry': ['io/sentry/'],
    'Facebook SDK': ['com/facebook/'],
    'Stripe': ['com/stripe/android/'],
    'AppsFlyer': ['com/appsflyer/'],
    'Adjust': ['com/adjust/sdk/'],
    'Branch': ['io/branch/referral/'],
    'Timber': ['timber/log/'],
    'Coil': ['coil/'],
    'ExoPlayer': ['com/google/android/exoplayer2/', 'androidx/media3/exoplayer/'],
    'Koin': ['org/koin/'],
    'Hilt': ['dagger/hilt/'],
    'Navigation Component': ['androidx/navigation/'],
    'CameraX': ['androidx/camera/'],
    'Paging': ['androidx/paging/'],
    'DataStore': ['androidx/datastore/'],
    'Ktor': ['io/ktor/'],
    'Apollo GraphQL': ['com/apollographql/'],
    'Braze': ['com/braze/', 'com/appboy/'],
    'OneSignal': ['com/onesignal/'],
}


def detect_libraries(class_names: list[str]) -> list[dict]:
    """Detect Java/Kotlin libraries from DEX class descriptors."""
    normalized = set()
    for cls in class_names:
        name = cls
        if name.startswith('L'):
            name = name[1:]
        if name.endswith(';'):
            name = name[:-1]
        normalized.add(name)

    detected = []
    for lib_name, prefixes in LIBRARY_SIGNATURES.items():
        for prefix in prefixes:
            if any(n.startswith(prefix) for n in normalized):
                detected.append({'name': lib_name, 'packages': prefixes})
                break

    return detected


def detect_build_info(apk_path: str) -> dict:
    """Run APKiD to detect compiler, packer, obfuscator, and anti-analysis tools."""
    empty = {'compiler': [], 'packer': [], 'obfuscator': [], 'anti_analysis': []}
    try:
        from apkid.apkid import Options, Scanner
        from apkid.rules import RulesManager
    except ImportError:
        return empty

    try:
        rules = RulesManager().load()
        options = Options(timeout=30, json=True, output_dir=None, typing='magic',
                          entry_max_scan_size=100 * 1024 * 1024,
                          scan_depth=2, recursive=False)
        scanner = Scanner(rules, options)
        res = scanner.scan_file(apk_path)
    except Exception:
        return empty

    result = {'compiler': [], 'packer': [], 'obfuscator': [], 'anti_analysis': []}
    CATEGORY_MAP = {
        'compiler': 'compiler',
        'packer': 'packer',
        'obfuscator': 'obfuscator',
        'anti_vm': 'anti_analysis',
        'anti_disassembly': 'anti_analysis',
        'anti_debug': 'anti_analysis',
        'dropper': 'packer',
        'manipulator': 'obfuscator',
    }

    try:
        for _filename, matches in res.items():
            if not isinstance(matches, list):
                continue
            for match in matches:
                tags = getattr(match, 'tags', [])
                desc = ''
                meta = getattr(match, 'meta', {})
                if isinstance(meta, dict):
                    desc = meta.get('description', str(match))
                else:
                    desc = str(match)
                for tag in tags:
                    category = CATEGORY_MAP.get(tag)
                    if category and desc and desc not in result[category]:
                        result[category].append(desc)
    except Exception:
        pass

    return result


def extract_proto_schemas(apk, all_files: list, output_dir: str) -> dict:
    """Extract .proto schema files and detect protobuf usage in an APK.

    Searches for:
    - Bundled .proto files in assets or raw resources
    - Protobuf descriptor files (.desc, .pb, .protobin)
    - Class names indicating protobuf/gRPC usage
    """
    proto_files = []
    descriptor_files = []
    has_protobuf = False
    has_grpc = False

    proto_dir = os.path.join(output_dir, 'proto_schemas')

    for fname in all_files:
        fname_lower = fname.lower()

        # Look for .proto source files
        if fname_lower.endswith('.proto'):
            try:
                data = apk.get_file(fname)
                if data and len(data) > 0:
                    # Save the proto file
                    os.makedirs(proto_dir, exist_ok=True)
                    safe_name = fname.replace('/', '_').replace('\\', '_')
                    out_path = os.path.join(proto_dir, safe_name)
                    with open(out_path, 'wb') as f:
                        f.write(data)
                    proto_files.append({
                        'path': fname,
                        'size': len(data),
                        'savedAs': safe_name,
                    })
            except Exception:
                pass

        # Look for protobuf descriptor/compiled schema files
        if fname_lower.endswith(('.desc', '.pb', '.protobin', '.descriptor')):
            try:
                data = apk.get_file(fname)
                if data and len(data) > 10:
                    os.makedirs(proto_dir, exist_ok=True)
                    safe_name = fname.replace('/', '_').replace('\\', '_')
                    out_path = os.path.join(proto_dir, safe_name)
                    with open(out_path, 'wb') as f:
                        f.write(data)
                    descriptor_files.append({
                        'path': fname,
                        'size': len(data),
                        'savedAs': safe_name,
                    })
            except Exception:
                pass

        # Detect protobuf shared libraries
        if 'libprotobuf' in fname_lower or 'libprotoc' in fname_lower:
            has_protobuf = True
        if 'libgrpc' in fname_lower:
            has_grpc = True

    # Check class names for protobuf/gRPC usage
    try:
        dex_names = list(apk.get_dex_names())
        for dex_name in dex_names:
            try:
                dex_data = apk.get_file(dex_name)
                if dex_data:
                    from androguard.core.dex import DEX
                    d = DEX(dex_data)
                    for cls in d.get_classes_names():
                        cls_str = str(cls)
                        if 'com/google/protobuf/' in cls_str or 'com.google.protobuf' in cls_str:
                            has_protobuf = True
                        if 'io/grpc/' in cls_str or 'io.grpc' in cls_str:
                            has_grpc = True
                        if has_protobuf and has_grpc:
                            break
                if has_protobuf and has_grpc:
                    break
            except Exception:
                pass
    except Exception:
        pass

    return {
        'detected': has_protobuf,
        'grpcDetected': has_grpc,
        'protoFiles': proto_files,
        'descriptorFiles': descriptor_files,
        'schemaCount': len(proto_files) + len(descriptor_files),
    }


def analyze_apk(apk_path: str, output_dir: str) -> dict:
    """Analyze an APK file and write outputs to output_dir.

    Returns a dict with: appName, packageName, icon (bool), minSdk, targetSdk, permissions.
    """
    from androguard.core.apk import APK

    a = APK(apk_path)

    package_name = a.get_package()
    app_name = a.get_app_name()
    min_sdk = a.get_min_sdk_version()
    target_sdk = a.get_target_sdk_version()
    permissions = a.get_permissions()

    # Try to parse SDK values as integers
    try:
        min_sdk = int(min_sdk) if min_sdk else None
    except (ValueError, TypeError):
        min_sdk = None
    try:
        target_sdk = int(target_sdk) if target_sdk else None
    except (ValueError, TypeError):
        target_sdk = None

    # Ensure output directory exists
    os.makedirs(output_dir, exist_ok=True)

    # Extract icon — get the default one first
    icon_saved = False
    icon_filename = a.get_app_icon()
    if icon_filename:
        icon_data = a.get_file(icon_filename)
        if icon_data and len(icon_data) > 100:
            icon_path = os.path.join(output_dir, "icon.png")
            with open(icon_path, "wb") as f:
                f.write(icon_data)
            icon_saved = True

    # If the default icon was not found or too small, try other densities
    if not icon_saved:
        for res_name in a.get_files():
            if "ic_launcher" in res_name and (res_name.endswith(".png") or res_name.endswith(".webp")):
                data = a.get_file(res_name)
                if data and len(data) > 100:
                    ext = "png" if res_name.endswith(".png") else "webp"
                    icon_path = os.path.join(output_dir, f"icon.{ext}")
                    with open(icon_path, "wb") as f:
                        f.write(data)
                    icon_saved = True
                    break

    # Write metadata.json
    metadata = {
        "appName": app_name,
        "packageName": package_name,
        "icon": icon_saved,
        "minSdk": min_sdk,
        "targetSdk": target_sdk,
        "permissions": list(permissions) if permissions else [],
    }
    # Detect frameworks and libraries
    all_files = a.get_files()

    # Build files dict for framework detection (file names → first 64 bytes for bundles)
    fw_files = {}
    for fname in all_files:
        if fname.startswith('assets/') and (fname.endswith('.bundle') or fname.endswith('.jsbundle')):
            try:
                data = a.get_file(fname)
                fw_files[fname] = data[:64] if data else b''
            except Exception:
                pass
        elif fname.startswith('assets/') or fname.startswith('assemblies/'):
            fw_files[fname] = b''
        elif fname.startswith('lib/') and fname.endswith('.so'):
            fw_files[fname] = b''
        elif 'nodemodulesreactnative' in fname.lower().replace('-', '').replace('_', ''):
            fw_files[fname] = b''

    frameworks_detected = detect_frameworks(fw_files)

    # DEX class scanning for library detection
    libraries_detected = []
    try:
        dex_names = list(a.get_dex_names())
        all_classes = []
        for dex_name in dex_names:
            try:
                dex_data = a.get_file(dex_name)
                if dex_data:
                    from androguard.core.dex import DEX
                    d = DEX(dex_data)
                    all_classes.extend(d.get_classes_names())
            except Exception:
                pass
        libraries_detected = detect_libraries(all_classes)
    except Exception:
        pass

    # Protobuf schema extraction
    proto_schemas = extract_proto_schemas(a, all_files, output_dir)

    # APKiD build info detection
    build_info = detect_build_info(apk_path)

    # Assemble frameworks metadata
    rn_entry = next((f for f in frameworks_detected if f['name'] == 'React Native'), None)

    frameworks_meta = {
        'detected': frameworks_detected,
        'libraries': libraries_detected,
        'buildInfo': build_info,
    }

    # Backward compat: copy RN-specific fields to top level for pipeline access
    if rn_entry:
        frameworks_meta['reactNative'] = True
        frameworks_meta['hermesEngine'] = rn_entry['details'].get('hermesEngine', False)
        frameworks_meta['hermesBundlePath'] = rn_entry['details'].get('hermesBundlePath')
        frameworks_meta['jsBundlePath'] = rn_entry['details'].get('jsBundlePath')

    metadata['frameworks'] = frameworks_meta
    metadata['protobuf'] = proto_schemas

    metadata_path = os.path.join(output_dir, "metadata.json")
    with open(metadata_path, "w") as f:
        json.dump(metadata, f, indent=2)

    return metadata


def decompile_apk(apk_path: str, tools: dict, output_dir: str, job_id: str = None) -> dict:
    """Run jadx and apktool against APK. Returns per-tool results.

    Each tool runs independently — if one fails, the other still proceeds.
    Tools with null/missing paths are skipped entirely (not reported as failures).
    """
    os.makedirs(output_dir, exist_ok=True)
    results = {}

    # Count available tools for progress
    tool_list = []
    if tools.get('jadx'):
        tool_list.append('jadx')
    if tools.get('apktool') and tools.get('java'):
        tool_list.append('apktool')
    total_tools = len(tool_list)
    completed_tools = 0

    # jadx → Java source
    if tools.get('jadx'):
        try:
            jadx_dir = os.path.join(output_dir, 'jadx')
            proc = subprocess.run(
                [tools['jadx'], '--no-res', '--output-dir', jadx_dir, apk_path],
                capture_output=True, text=True, timeout=600,
            )
            # jadx exits 1 on non-fatal decompilation errors (normal for complex APKs)
            # Treat as success if output directory was created with files
            if proc.returncode != 0 and os.path.isdir(jadx_dir) and os.listdir(jadx_dir):
                results['jadx'] = {'success': True, 'outputDir': jadx_dir}
            elif proc.returncode != 0:
                output = (proc.stderr or proc.stdout or '').strip()
                err_msg = f"exit code {proc.returncode}"
                if output:
                    err_msg += f": {output[-500:]}"
                results['jadx'] = {'success': False, 'error': err_msg}
            else:
                results['jadx'] = {'success': True, 'outputDir': jadx_dir}
        except Exception as e:
            results['jadx'] = {'success': False, 'error': str(e)}
        completed_tools += 1
        if job_id and total_tools > 0:
            send({"id": job_id, "status": "progress", "progress": round(completed_tools / total_tools * 100)})

    # apktool → Smali + decoded resources (requires java)
    if tools.get('apktool') and tools.get('java'):
        try:
            apktool_dir = os.path.join(output_dir, 'apktool')
            proc = subprocess.run(
                [tools['java'], '-jar', tools['apktool'], 'd', '--force',
                 '--output', apktool_dir, apk_path],
                capture_output=True, text=True, timeout=600,
            )
            proc.check_returncode()
            results['apktool'] = {'success': True, 'outputDir': apktool_dir}
        except subprocess.CalledProcessError as e:
            output = (e.stderr or e.stdout or '').strip()
            err_msg = f"exit code {e.returncode}"
            if output:
                err_msg += f": {output[-500:]}"
            results['apktool'] = {'success': False, 'error': err_msg}
        except Exception as e:
            results['apktool'] = {'success': False, 'error': str(e)}
        completed_tools += 1
        if job_id and total_tools > 0:
            send({"id": job_id, "status": "progress", "progress": round(completed_tools / total_tools * 100)})

    return results


def hermes_decompile_bundle(apk_path: str, output_dir: str, bundle_path: str,
                            tools: dict, job_id: str = None) -> dict:
    """Extract Hermes bytecode bundle from APK and run decompiler + disassembler.

    Each tool runs independently — if one fails, the other still proceeds.

    Args:
        apk_path: Path to the APK file.
        output_dir: Base output directory (hermes-dec/ subdirectory will be created).
        bundle_path: Path within the APK to the Hermes bundle (e.g. 'assets/index.android.bundle').
        tools: Dict with 'hbc_decompiler' and/or 'hbc_disassembler' paths.
        job_id: Optional job ID for progress reporting.

    Returns:
        {'decompiler': {'success': bool, ...}, 'disassembler': {'success': bool, ...}}

    Raises:
        FileNotFoundError: If the bundle_path is not found inside the APK.
        ValueError: If the APK is not a valid ZIP file.
    """
    hermes_dir = os.path.join(output_dir, 'hermes-dec')
    os.makedirs(hermes_dir, exist_ok=True)

    # Extract bundle from APK
    try:
        zf = zipfile.ZipFile(apk_path, 'r')
    except zipfile.BadZipFile as e:
        raise ValueError(f"Invalid ZIP/APK file: {e}")

    try:
        if bundle_path not in zf.namelist():
            raise FileNotFoundError(f"Bundle not found in APK: {bundle_path}")
        bundle_data = zf.read(bundle_path)
    finally:
        zf.close()

    # Write bundle to temp file
    bundle_tmp = os.path.join(hermes_dir, 'index.android.bundle')
    with open(bundle_tmp, 'wb') as f:
        f.write(bundle_data)

    results = {}

    # Count available tools for progress
    tool_list = []
    if tools.get('hbc_decompiler'):
        tool_list.append('decompiler')
    if tools.get('hbc_disassembler'):
        tool_list.append('disassembler')
    total_tools = len(tool_list)
    completed_tools = 0

    # hbc_decompiler → decompiled JS
    if tools.get('hbc_decompiler'):
        decompiled_out = os.path.join(hermes_dir, 'decompiled.js')
        try:
            proc = subprocess.run(
                [tools['hbc_decompiler'], bundle_tmp, decompiled_out],
                capture_output=True, text=True, timeout=600,
            )
            if proc.returncode != 0:
                output = (proc.stderr or proc.stdout or '').strip()
                err_msg = f"exit code {proc.returncode}"
                if output:
                    err_msg += f": {output[-500:]}"
                results['decompiler'] = {'success': False, 'error': err_msg}
            else:
                results['decompiler'] = {'success': True, 'outputFile': decompiled_out}
        except Exception as e:
            results['decompiler'] = {'success': False, 'error': str(e)}
        completed_tools += 1
        if job_id and total_tools > 0:
            send({"id": job_id, "status": "progress", "progress": round(completed_tools / total_tools * 100)})

    # hbc_disassembler → disassembly
    if tools.get('hbc_disassembler'):
        disasm_out = os.path.join(hermes_dir, 'disassembly.hasm')
        try:
            proc = subprocess.run(
                [tools['hbc_disassembler'], bundle_tmp, disasm_out],
                capture_output=True, text=True, timeout=600,
            )
            if proc.returncode != 0:
                output = (proc.stderr or proc.stdout or '').strip()
                err_msg = f"exit code {proc.returncode}"
                if output:
                    err_msg += f": {output[-500:]}"
                results['disassembler'] = {'success': False, 'error': err_msg}
            else:
                results['disassembler'] = {'success': True, 'outputFile': disasm_out}
        except Exception as e:
            results['disassembler'] = {'success': False, 'error': str(e)}
        completed_tools += 1
        if job_id and total_tools > 0:
            send({"id": job_id, "status": "progress", "progress": round(completed_tools / total_tools * 100)})

    # Clean up temp bundle file
    try:
        os.remove(bundle_tmp)
    except OSError:
        pass

    return results


def beautify_js_bundle(apk_path: str, output_dir: str, bundle_path: str,
                        job_id: str = None) -> dict:
    """Extract plain JS bundle from APK, beautify it, write to hermes-dec/ directory.

    Args:
        apk_path: Path to the APK file.
        output_dir: Base output directory (hermes-dec/ subdirectory will be created).
        bundle_path: Path within the APK to the JS bundle (e.g. 'assets/index.android.bundle').
        job_id: Optional job ID for progress reporting.

    Returns:
        {'success': True, 'outputFile': path}

    Raises:
        FileNotFoundError: If the bundle_path is not found inside the APK.
        ValueError: If the APK is not a valid ZIP file.
    """
    import jsbeautifier

    hermes_dir = os.path.join(output_dir, 'hermes-dec')
    os.makedirs(hermes_dir, exist_ok=True)

    # Extract bundle from APK
    try:
        zf = zipfile.ZipFile(apk_path, 'r')
    except zipfile.BadZipFile as e:
        raise ValueError(f"Invalid ZIP/APK file: {e}")

    try:
        if bundle_path not in zf.namelist():
            raise FileNotFoundError(f"Bundle not found in APK: {bundle_path}")
        bundle_data = zf.read(bundle_path)
    finally:
        zf.close()

    content = bundle_data.decode('utf-8', errors='replace')

    # Beautify (skip for very large bundles >10MB)
    MAX_BEAUTIFY_SIZE = 10 * 1024 * 1024
    output_path = os.path.join(hermes_dir, 'beautified.js')

    if len(bundle_data) > MAX_BEAUTIFY_SIZE:
        with open(output_path, 'w', encoding='utf-8') as f:
            f.write('// Bundle too large to beautify (>10MB), showing raw source\n')
            f.write(content)
    else:
        if job_id:
            send({"id": job_id, "status": "progress", "progress": 50})
        opts = jsbeautifier.default_options()
        opts.indent_size = 2
        beautified = jsbeautifier.beautify(content, opts)
        with open(output_path, 'w', encoding='utf-8') as f:
            f.write(beautified)

    return {'success': True, 'outputFile': output_path}


def flutter_decompile(apk_path: str, output_dir: str, tools: dict, job_id: str = None) -> dict:
    """Extract libapp.so from APK and analyze with blutter.

    Writes dump.dart to output_dir/flutter-dump/ if successful.
    Falls back to string extraction if blutter fails.

    Args:
        apk_path: Path to the APK file.
        output_dir: Decompile directory (flutter-dump/ created inside).
        tools: Dict with optional 'blutter' path.
        job_id: Optional job ID for progress reporting.

    Returns:
        {
            'arch': 'arm64-v8a' | 'armeabi-v7a' | None,
            'libappSize': int | None,
            'blutter': {'success': bool, 'error': str | None} | None,
            'dumpGenerated': bool,
        }
    """
    flutter_dir = os.path.join(output_dir, 'flutter-dump')
    os.makedirs(flutter_dir, exist_ok=True)

    result = {
        'arch': None,
        'libappSize': None,
        'blutter': None,
        'dumpGenerated': False,
    }

    # Step 1: Extract libapp.so (and libflutter.so for blutter) from APK
    if job_id:
        send({"id": job_id, "status": "progress", "progress": 5})

    try:
        with zipfile.ZipFile(apk_path, 'r') as zf:
            names = zf.namelist()
            libapp_data = None
            libflutter_data = None
            for candidate_arch in ['arm64-v8a', 'armeabi-v7a']:
                app_path = f'lib/{candidate_arch}/libapp.so'
                flutter_path = f'lib/{candidate_arch}/libflutter.so'
                if app_path in names:
                    libapp_data = zf.read(app_path)
                    result['arch'] = candidate_arch
                    if flutter_path in names:
                        libflutter_data = zf.read(flutter_path)
                    break
    except zipfile.BadZipFile as e:
        raise ValueError(f"Invalid ZIP/APK file: {e}")

    if libapp_data is None:
        raise FileNotFoundError("libapp.so not found in APK")

    result['libappSize'] = len(libapp_data)

    # Write extracted .so files to flutter-dump/ for tool consumption
    libapp_path = os.path.join(flutter_dir, 'libapp.so')
    with open(libapp_path, 'wb') as f:
        f.write(libapp_data)

    if libflutter_data:
        libflutter_path = os.path.join(flutter_dir, 'libflutter.so')
        with open(libflutter_path, 'wb') as f:
            f.write(libflutter_data)

    if job_id:
        send({"id": job_id, "status": "progress", "progress": 10})

    # Step 2: Try blutter (static analysis — preferred)
    # blutter.py expects a directory containing libapp.so + libflutter.so
    blutter_path = tools.get('blutter') or shutil.which('blutter')
    if blutter_path and libflutter_data:
        blutter_out = os.path.join(flutter_dir, 'blutter-out')
        os.makedirs(blutter_out, exist_ok=True)
        try:
            # blutter can be either a standalone binary or a blutter.py script
            cmd = [blutter_path, flutter_dir, blutter_out]
            if blutter_path.endswith('.py'):
                cmd = [sys.executable, blutter_path, flutter_dir, blutter_out]
            proc = subprocess.run(
                cmd, capture_output=True, text=True, timeout=600,
            )
            if job_id:
                send({"id": job_id, "status": "progress", "progress": 60})

            # blutter outputs asm/ directory with per-library .dart files
            asm_dir = os.path.join(blutter_out, 'asm')
            dump_src = os.path.join(blutter_out, 'dump.dart')
            if os.path.exists(asm_dir) and os.listdir(asm_dir):
                result['blutter'] = {'success': True, 'error': None}
                result['dumpGenerated'] = True
            elif os.path.exists(dump_src):
                result['blutter'] = {'success': True, 'error': None}
                result['dumpGenerated'] = True
            else:
                err = (proc.stderr or proc.stdout or '').strip()[-500:]
                result['blutter'] = {'success': False, 'error': err or 'No output produced'}
        except subprocess.TimeoutExpired:
            result['blutter'] = {'success': False, 'error': 'Timed out after 600s'}
        except Exception as e:
            result['blutter'] = {'success': False, 'error': str(e)}
    elif blutter_path and not libflutter_data:
        result['blutter'] = {'success': False, 'error': 'libflutter.so not found in APK (needed by blutter)'}

    # Step 3: If blutter didn't produce a dump, extract Dart strings as fallback
    if not result['dumpGenerated']:
        try:
            strings_result = _extract_dart_strings(libapp_path, flutter_dir)
            if strings_result:
                result['dumpGenerated'] = True
                result['stringsFallback'] = True
        except Exception:
            pass

    if job_id:
        send({"id": job_id, "status": "progress", "progress": 100})

    return result


def _extract_dart_strings(libapp_path: str, flutter_dir: str) -> bool:
    """Extract Dart class/function names from libapp.so using string analysis.

    Works on any Dart version — parses printable strings matching Dart patterns.
    Writes a structured dump.dart file with extracted info.
    """
    with open(libapp_path, 'rb') as f:
        raw = f.read()

    # Extract all printable strings >= 4 chars
    strings = []
    current = []
    for b in raw:
        if 32 <= b < 127:
            current.append(chr(b))
        else:
            if len(current) >= 4:
                strings.append(''.join(current))
            current = []
    if len(current) >= 4:
        strings.append(''.join(current))

    # Categorize Dart-relevant strings
    package_uris = set()   # package:foo/bar.dart
    class_names = set()    # _ClassName, ClassName
    urls = set()           # http(s) URLs
    dart_libs = set()      # dart:core, dart:ui
    api_strings = set()    # API paths, endpoints
    error_msgs = set()     # Error messages
    json_keys = set()      # JSON-like keys

    for s in strings:
        if s.startswith('package:'):
            package_uris.add(s)
        elif s.startswith('dart:'):
            dart_libs.add(s)
        elif s.startswith('http://') or s.startswith('https://'):
            if len(s) < 300:
                urls.add(s)
        elif s.startswith('/api/') or s.startswith('/v1/') or s.startswith('/v2/') or s.startswith('/graphql'):
            api_strings.add(s)
        elif re.match(r'^_?[A-Z][a-zA-Z0-9]{3,}(?:\.[a-zA-Z_][a-zA-Z0-9_]*)?$', s):
            class_names.add(s)
        elif len(s) >= 10 and any(kw in s.lower() for kw in
                ('error', 'exception', 'failed', 'invalid', 'unauthorized',
                 'forbidden', 'timeout', 'not found', 'null')):
            if len(s) < 200:
                error_msgs.add(s)
        elif re.match(r'^[a-z][a-zA-Z0-9]*(?:_[a-zA-Z0-9]+)+$', s) and len(s) >= 8:
            json_keys.add(s)

    total_found = (len(package_uris) + len(class_names) + len(urls) +
                   len(dart_libs) + len(api_strings) + len(error_msgs))
    if total_found == 0:
        return False

    # Write structured output
    dump_path = os.path.join(flutter_dir, 'dump.dart')
    with open(dump_path, 'w') as f:
        f.write('// Flutter libapp.so string extraction (fallback mode)\n')
        f.write(f'// Extracted: {len(package_uris)} package URIs, '
                f'{len(class_names)} class names, '
                f'{len(dart_libs)} dart libraries, '
                f'{len(urls)} URLs, '
                f'{len(api_strings)} API paths, '
                f'{len(error_msgs)} error messages\n\n')

        if dart_libs:
            f.write('// === Dart Libraries ===\n')
            for lib in sorted(dart_libs):
                f.write(f'// {lib}\n')
            f.write('\n')

        if package_uris:
            f.write('// === Package URIs (Dart source files) ===\n')
            packages = {}
            for uri in sorted(package_uris):
                parts = uri.split('/')
                pkg = parts[0] if parts else uri
                packages.setdefault(pkg, []).append(uri)
            for pkg in sorted(packages):
                f.write(f'\n// {pkg}\n')
                for uri in sorted(packages[pkg]):
                    f.write(f'//   {uri}\n')
            f.write('\n')

        if class_names:
            f.write('// === Class Names ===\n')
            for name in sorted(class_names):
                f.write(f'class {name} {{}}\n')
            f.write('\n')

        if urls:
            f.write('// === URLs ===\n')
            for url in sorted(urls):
                f.write(f'// {url}\n')
            f.write('\n')

        if api_strings:
            f.write('// === API Paths ===\n')
            for path in sorted(api_strings):
                f.write(f'// {path}\n')
            f.write('\n')

        if json_keys:
            f.write('// === Configuration Keys ===\n')
            for key in sorted(json_keys):
                f.write(f'// {key}\n')
            f.write('\n')

        if error_msgs:
            f.write('// === Error Messages ===\n')
            for msg in sorted(error_msgs):
                f.write(f'// {msg}\n')

    return True


LANG_MAP = {
    '.java': 'java', '.smali': 'smali', '.xml': 'xml',
    '.json': 'json', '.kt': 'kotlin', '.properties': 'properties',
    '.txt': 'text', '.yml': 'yaml', '.yaml': 'yaml',
    '.js': 'javascript', '.ts': 'typescript', '.html': 'html',
    '.css': 'css', '.md': 'markdown', '.cfg': 'text', '.ini': 'ini',
    '.gradle': 'groovy', '.pro': 'text', '.mf': 'text',
    '.hasm': 'hermes-asm', '.dart': 'dart',
}

# Binary extensions to skip entirely during storage
BINARY_EXTENSIONS = frozenset({
    '.arsc', '.dex', '.so', '.class', '.jar', '.zip', '.gz', '.tar',
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.svg',
    '.ttf', '.otf', '.woff', '.woff2', '.eot',
    '.mp3', '.mp4', '.ogg', '.wav', '.flac', '.aac',
    '.apk', '.aab', '.aar', '.bin', '.dat', '.db', '.sqlite',
    '.keystore', '.jks', '.p12', '.pfx', '.pem', '.der', '.cer',
})

ANDROID_NS = 'http://schemas.android.com/apk/res/android'


def parse_manifest(decompile_dir: str, conn: sqlite3.Connection):
    """Parse AndroidManifest.xml and insert key/value rows into manifest table.

    Keys: permissions, activities, services, receivers, providers, package, min_sdk, target_sdk.
    Values are JSON-encoded.
    """
    # Try to find AndroidManifest.xml — apktool preserves it at root level
    manifest_path = None
    for source_name in ['apktool', 'jadx']:
        candidate = os.path.join(decompile_dir, source_name, 'AndroidManifest.xml')
        if os.path.isfile(candidate):
            manifest_path = candidate
            break

    if manifest_path is None:
        return

    try:
        tree = ET.parse(manifest_path)
    except ET.ParseError:
        return

    root = tree.getroot()

    # Package name
    package = root.get('package', '')
    if package:
        conn.execute('INSERT OR REPLACE INTO manifest (key, value) VALUES (?, ?)',
                     ('package', json.dumps(package)))

    # SDK versions from <uses-sdk>
    uses_sdk = root.find('uses-sdk')
    if uses_sdk is not None:
        min_sdk = uses_sdk.get(f'{{{ANDROID_NS}}}minSdkVersion', '')
        target_sdk = uses_sdk.get(f'{{{ANDROID_NS}}}targetSdkVersion', '')
        if min_sdk:
            conn.execute('INSERT OR REPLACE INTO manifest (key, value) VALUES (?, ?)',
                         ('min_sdk', json.dumps(min_sdk)))
        if target_sdk:
            conn.execute('INSERT OR REPLACE INTO manifest (key, value) VALUES (?, ?)',
                         ('target_sdk', json.dumps(target_sdk)))

    # Permissions
    permissions = []
    for perm in root.findall('uses-permission'):
        name = perm.get(f'{{{ANDROID_NS}}}name', '')
        if name:
            permissions.append(name)
    conn.execute('INSERT OR REPLACE INTO manifest (key, value) VALUES (?, ?)',
                 ('permissions', json.dumps(permissions)))

    # Application components
    app = root.find('application')
    if app is None:
        return

    activities = []
    for act in app.findall('activity'):
        name = act.get(f'{{{ANDROID_NS}}}name', '')
        if name:
            activities.append(name)
    conn.execute('INSERT OR REPLACE INTO manifest (key, value) VALUES (?, ?)',
                 ('activities', json.dumps(activities)))

    services = []
    for svc in app.findall('service'):
        name = svc.get(f'{{{ANDROID_NS}}}name', '')
        if name:
            services.append(name)
    conn.execute('INSERT OR REPLACE INTO manifest (key, value) VALUES (?, ?)',
                 ('services', json.dumps(services)))

    receivers = []
    for rcv in app.findall('receiver'):
        name = rcv.get(f'{{{ANDROID_NS}}}name', '')
        if name:
            receivers.append(name)
    conn.execute('INSERT OR REPLACE INTO manifest (key, value) VALUES (?, ?)',
                 ('receivers', json.dumps(receivers)))

    providers = []
    for prv in app.findall('provider'):
        name = prv.get(f'{{{ANDROID_NS}}}name', '')
        if name:
            providers.append(name)
    conn.execute('INSERT OR REPLACE INTO manifest (key, value) VALUES (?, ?)',
                 ('providers', json.dumps(providers)))


def store_source(decompile_dir: str, db_path: str, job_id: str = None,
                  metadata: dict = None) -> dict:
    """Walk decompiled source trees, compress & store in per-APK SQLite DB.

    Creates tables: files, findings, manifest.
    Walks jadx/ and apktool/ subdirectories of decompile_dir.
    If metadata dict is provided (from analyze_apk), populates manifest table
    with package/SDK/permissions as fallback when AndroidManifest.xml parsing fails.
    Returns dict with fileCount, totalSize, dbPath.
    """
    os.makedirs(os.path.dirname(db_path), exist_ok=True)

    conn = sqlite3.connect(db_path)
    conn.execute('PRAGMA journal_mode=WAL')

    # Drop and recreate tables to ensure clean state on re-analysis
    conn.executescript('''
        DROP TABLE IF EXISTS findings;
        DROP TABLE IF EXISTS files;
        DROP TABLE IF EXISTS manifest;

        CREATE TABLE files (
            id INTEGER PRIMARY KEY,
            path TEXT NOT NULL,
            source TEXT NOT NULL,
            size INTEGER NOT NULL,
            content BLOB NOT NULL,
            language TEXT NOT NULL,
            content_hash TEXT
        );
        CREATE INDEX idx_files_path ON files(path);
        CREATE INDEX idx_files_source ON files(source);
        CREATE INDEX idx_files_content_hash ON files(content_hash);

        CREATE TABLE findings (
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
        CREATE INDEX idx_findings_severity ON findings(severity);

        CREATE TABLE manifest (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
    ''')

    MAX_FILE_SIZE = 2 * 1024 * 1024  # Skip files over 2MB
    MAX_FILE_SIZE_HERMES = 50 * 1024 * 1024  # Higher limit for hermes-dec (large JS bundles)
    BATCH_SIZE = 500
    PROGRESS_INTERVAL = 100
    COMMIT_INTERVAL = 2000  # Commit every N files to limit memory
    ZSTD_LEVEL = 1  # Level 1 is ~2x faster than default 3 with minimal size increase
    import hashlib

    # If jadx succeeded, skip apktool smali (redundant — Java source is more useful).
    # Still store apktool resources/XML since jadx uses --no-res.
    jadx_dir = os.path.join(decompile_dir, 'jadx')
    has_jadx = os.path.isdir(jadx_dir) and os.listdir(jadx_dir)

    # Pre-filter: collect only processable files (skip binaries upfront)
    storable_files: list[tuple[str, str, str]] = []  # (source_name, source_dir, fpath)
    for source_name in ['jadx', 'apktool', 'hermes-dec', 'flutter-dump']:
        source_dir = os.path.join(decompile_dir, source_name)
        if not os.path.isdir(source_dir):
            continue
        for root, dirs, files in os.walk(source_dir):
            for fname in files:
                ext = os.path.splitext(fname)[1].lower()
                if ext in BINARY_EXTENSIONS:
                    continue

                # Skip apktool smali when jadx Java source is available
                if has_jadx and source_name == 'apktool' and ext == '.smali':
                    continue

                fpath = os.path.join(root, fname)

                try:
                    fsize = os.path.getsize(fpath)
                except OSError:
                    continue
                size_limit = MAX_FILE_SIZE_HERMES if source_name in ('hermes-dec', 'flutter-dump') else MAX_FILE_SIZE
                if fsize > size_limit:
                    continue

                storable_files.append((source_name, source_dir, fpath))

    total_files = len(storable_files)
    file_count = 0
    total_size = 0
    batch = []
    since_commit = 0
    zctx = zstd.ZstdCompressor(level=ZSTD_LEVEL)

    for processed, (source_name, source_dir, fpath) in enumerate(storable_files, 1):
        # Emit progress periodically
        if job_id and processed % PROGRESS_INTERVAL == 0:
            send({"id": job_id, "status": "progress",
                  "progress": round(processed / total_files * 100)})

        try:
            with open(fpath, 'rb') as f:
                raw_bytes = f.read()
        except Exception:
            continue

        # Detect binary content: check for null bytes in first 8KB
        if b'\x00' in raw_bytes[:8192]:
            continue

        # Validate text encoding — try UTF-8, fall back to latin-1
        try:
            raw_bytes.decode('utf-8')
        except UnicodeDecodeError:
            try:
                # Re-encode latin-1 content as UTF-8 for consistent storage
                raw_bytes = raw_bytes.decode('latin-1').encode('utf-8')
            except Exception:
                continue

        ext = os.path.splitext(fpath)[1].lower()
        rel_path = os.path.relpath(fpath, source_dir).replace('\\', '/')
        language = LANG_MAP.get(ext, 'text')

        size = len(raw_bytes)
        content_hash = hashlib.md5(raw_bytes).hexdigest()
        compressed = zctx.compress(raw_bytes)

        batch.append((rel_path, source_name, size, compressed, language, content_hash))
        file_count += 1
        total_size += size

        if len(batch) >= BATCH_SIZE:
            conn.executemany(
                'INSERT INTO files (path, source, size, content, language, content_hash) VALUES (?,?,?,?,?,?)',
                batch,
            )
            since_commit += len(batch)
            batch.clear()
            if since_commit >= COMMIT_INTERVAL:
                conn.commit()
                since_commit = 0

    # Flush remaining batch
    if batch:
        conn.executemany(
            'INSERT INTO files (path, source, size, content, language, content_hash) VALUES (?,?,?,?,?,?)',
            batch,
        )

    # Final 100% progress
    if job_id and total_files > 0:
        send({"id": job_id, "status": "progress", "progress": 100})

    # Parse manifest from decompiled AndroidManifest.xml
    parse_manifest(decompile_dir, conn)

    # Fill in any missing manifest fields from androguard metadata
    if metadata:
        existing = {r[0] for r in conn.execute('SELECT key FROM manifest').fetchall()}
        fallbacks = [
            ('package', metadata.get('packageName')),
            ('min_sdk', metadata.get('minSdk')),
            ('target_sdk', metadata.get('targetSdk')),
            ('permissions', metadata.get('permissions')),
            ('frameworks', metadata.get('frameworks')),
        ]
        for key, value in fallbacks:
            if key not in existing and value is not None:
                conn.execute('INSERT INTO manifest (key, value) VALUES (?, ?)',
                             (key, json.dumps(value)))

    conn.commit()
    conn.close()

    return {'fileCount': file_count, 'totalSize': total_size, 'dbPath': db_path}


# Regex rules: (rule_id, title, description, category, severity, pattern)
SECRET_PATTERNS = [
    ('google-api-key', 'Google API Key', 'Hardcoded Google API key', 'secret', 'high',
     r'AIza[0-9A-Za-z_-]{35}'),
    ('aws-access-key', 'AWS Access Key', 'Hardcoded AWS access key ID', 'secret', 'critical',
     r'AKIA[0-9A-Z]{16}'),
    ('aws-secret-key', 'AWS Secret Key', 'Hardcoded AWS secret access key', 'secret', 'critical',
     r'(?i)aws[_-]?secret[_-]?access[_-]?key\s*[=:]\s*["\']?([A-Za-z0-9/+=]{40})'),
    ('generic-api-key', 'Generic API Key', 'Possible hardcoded API key', 'secret', 'medium',
     r'(?i)(api[_-]?key|apikey|api_secret)\s*[=:]\s*["\']([A-Za-z0-9_\-]{16,})'),
    ('generic-password', 'Hardcoded Password', 'Possible hardcoded password', 'secret', 'high',
     r'(?i)(password|passwd|pwd)\s*[=:]\s*["\']([^"\']{6,})'),
    ('private-key', 'Private Key', 'Embedded private key', 'certificate', 'critical',
     r'-----BEGIN (RSA |EC |DSA )?PRIVATE KEY-----'),
    ('firebase-url', 'Firebase URL', 'Firebase database URL', 'url', 'medium',
     r'https://[a-z0-9-]+\.firebaseio\.com'),
    ('cleartext-http', 'Cleartext HTTP URL', 'Non-HTTPS URL', 'network', 'low',
     r'http://[a-zA-Z0-9][a-zA-Z0-9.-]+\.[a-zA-Z]{2,}'),
    ('https-url', 'HTTPS URL', 'HTTPS endpoint URL', 'url', 'info',
     r'https://[a-zA-Z0-9][a-zA-Z0-9.-]+\.[a-zA-Z]{2,}[^\s"\'<>)*,]*'),
    ('ip-address', 'Hardcoded IP Address', 'IP address in source', 'network', 'info',
     r'(?<![0-9.])\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b(?![0-9.])'),
    ('jwt-token', 'JWT Token', 'Hardcoded JWT token', 'secret', 'high',
     r'eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+'),
    ('gcp-service-account', 'GCP Service Account', 'Google Cloud service account key', 'secret', 'critical',
     r'"type"\s*:\s*"service_account"'),
    ('slack-token', 'Slack Token', 'Hardcoded Slack token', 'secret', 'high',
     r'xox[baprs]-[0-9a-zA-Z]{10,}'),
    ('generic-token', 'Generic Token', 'Possible hardcoded token', 'secret', 'medium',
     r'(?i)(token|bearer|auth)\s*[=:]\s*["\']([A-Za-z0-9_\-.]{20,})'),
    ('base64-secret', 'Base64 Encoded Secret', 'Long base64 string (possible secret)', 'secret', 'low',
     r'["\'][A-Za-z0-9+/]{40,}={0,2}["\']'),
    # JS / React Native specific patterns (primarily hit hermes-dec decompiled output)
    ('api-path', 'API Path', 'REST or GraphQL endpoint path', 'endpoint', 'info',
     r'(?:"/api/v[0-9]+/[a-zA-Z0-9/_-]*"|"/graphql\b)'),
    ('api-base-url', 'API Base URL', 'Base URL with API path suffix', 'endpoint', 'info',
     r'https?://[a-zA-Z0-9][a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/(?:api|v[1-9])/[^\s"\'<>)*,]*'),
    ('deeplink-scheme', 'Deep Link Scheme', 'Custom URI scheme for deep linking', 'endpoint', 'info',
     r'(?!https?://)[a-z][a-z0-9+.-]{2,20}://[^\s"\'<>)]*'),
    ('feature-flag-key', 'Feature Flag Key', 'Possible feature flag identifier', 'config', 'info',
     r'(?i)["\'](?:feature_|ff_|experiment_|toggle_)[a-zA-Z0-9_]{3,}["\']'),
    ('react-navigation-route', 'React Navigation Route', 'Screen or route name in navigator', 'config', 'info',
     r'(?:Screen|screen|name)\s*[:=]\s*["\']([A-Z][a-zA-Z0-9]{2,}(?:Screen|Tab|Modal|Page|View)?)["\']'),
    ('graphql-operation', 'GraphQL Operation', 'GraphQL query, mutation, or subscription', 'endpoint', 'info',
     r'(?:query|mutation|subscription)\s+[A-Z][a-zA-Z0-9_]*\s*[\({]'),
    ('websocket-url', 'WebSocket URL', 'WebSocket endpoint', 'endpoint', 'info',
     r'wss?://[a-zA-Z0-9][a-zA-Z0-9.-]+\.[a-zA-Z]{2,}[^\s"\'<>)*,]*'),
]

SCANNABLE_LANGUAGES = {'java', 'smali', 'xml', 'json', 'kotlin', 'properties', 'yaml', 'text', 'javascript', 'dart'}


def _is_likely_base64_secret(s: str) -> bool:
    """Return True if the string looks like an actual base64-encoded secret rather
    than natural text, a sentence, or a readable identifier that happens to be
    base64-charset.

    Heuristics:
    - Strip surrounding quotes, then check the inner value.
    - If 2+ word-like segments of 4+ lowercase letters exist, it's probably
      English / natural language, not a secret.
    - If it contains spaces, commas, or common sentence punctuation it's text.
    - Reject alphabet sequences (ABCDEF..., abcdef..., 0123...) which are
      charsets, lookup tables, or test data, not secrets.
    """
    inner = s.strip('\'"')
    # Spaces / punctuation → natural language, not base64
    if ' ' in inner or ',' in inner or ';' in inner:
        return False
    # Count word-like segments: runs of 4+ lowercase letters
    words = re.findall(r'[a-z]{4,}', inner)
    if len(words) >= 2:
        return False
    # Reject strings with long runs of sequential characters (alphabet/digit sequences)
    if _has_long_sequential_run(inner, 10):
        return False
    return True


def _has_long_sequential_run(s: str, min_run: int) -> bool:
    """Return True if s contains a run of min_run+ characters where each is
    the next codepoint after the previous (e.g. ABCDEFGHIJ, abcdefghij, 0123456789)."""
    run = 1
    for i in range(1, len(s)):
        if ord(s[i]) == ord(s[i - 1]) + 1:
            run += 1
            if run >= min_run:
                return True
        else:
            run = 1
    return False


# IPs that are uninteresting in findings
IGNORED_IPS = frozenset({
    '0.0.0.0', '127.0.0.1', '255.255.255.255', '10.0.0.1',
    '192.168.0.1', '192.168.1.1', '224.0.0.1',
})

# Common URI schemes that are not app deep links
IGNORED_DEEPLINK_SCHEMES = frozenset({
    'file', 'data', 'content', 'mailto', 'tel', 'sms', 'geo',
    'javascript', 'about', 'blob', 'ftp', 'ssh', 'market',
    'android-app', 'intent', 'jar', 'resource',
})

# URLs that are XML namespace/schema declarations, not real network endpoints
IGNORED_URL_PREFIXES = (
    'http://schemas.android.com',
    'http://www.w3.org',
    'http://www.w3c.org',
    'http://purl.org',
    'http://ns.adobe.com',
    'http://www.openapis.org',
    'http://xml.org',
    'http://xmlpull.org',
    'http://java.sun.com',
    'http://javax.xml',
    'http://apache.org',
    'http://www.apache.org',
    'http://xmlns.jcp.org',
    'http://schema.org',
    'https://schemas.android.com',
    'https://www.w3.org',
    'https://www.w3c.org',
    'https://purl.org',
    'https://ns.adobe.com',
    'https://www.openapis.org',
    'https://xml.org',
    'https://xmlpull.org',
    'https://xmlns.jcp.org',
    'https://schema.org',
    'https://developer.android.com/reference',
    'https://docs.oracle.com',
)


def run_mobsfscan(db_path: str, mobsfscan_path: str, conn: sqlite3.Connection) -> int:
    """Extract source to temp dir, run mobsfscan, parse results, insert findings.

    mobsfscan is purpose-built for Android/iOS security scanning with rules for
    hardcoded keys, insecure crypto, WebView issues, etc. Runs fully offline.

    Returns the number of mobsfscan findings inserted.
    """
    rows = conn.execute('SELECT id, path, source, content, language FROM files').fetchall()

    # Extract scannable files to a temp directory
    with tempfile.TemporaryDirectory() as tmp_dir:
        path_to_file_id = {}
        for file_id, file_path, source, content_blob, language in rows:
            if language not in ('java', 'kotlin', 'xml', 'smali'):
                continue
            try:
                content = decompress_content(content_blob).decode('utf-8')
            except Exception:
                continue

            out_path = os.path.join(tmp_dir, file_path)
            os.makedirs(os.path.dirname(out_path), exist_ok=True)
            with open(out_path, 'w', encoding='utf-8') as f:
                f.write(content)
            path_to_file_id[file_path] = file_id

        if not path_to_file_id:
            return 0

        # Run mobsfscan with JSON output
        try:
            result = subprocess.run(
                [mobsfscan_path, '--json', '-o', '/dev/stdout', tmp_dir],
                capture_output=True, text=True, timeout=600,
            )
            output = json.loads(result.stdout)
        except Exception:
            return 0

        findings_count = 0
        results = output.get('results', {})

        for rule_id, rule_findings in results.items():
            if not isinstance(rule_findings, list):
                continue
            for finding in rule_findings:
                metadata = finding.get('metadata', {})
                description = metadata.get('description', rule_id)
                severity_raw = metadata.get('severity', 'WARNING').upper()
                cwe = metadata.get('cwe', '')

                # Map mobsfscan severity to our levels
                severity_map = {
                    'ERROR': 'high',
                    'WARNING': 'medium',
                    'INFO': 'low',
                }
                severity = severity_map.get(severity_raw, 'medium')

                title = rule_id.replace('_', ' ').title()

                for file_entry in finding.get('files', []):
                    abs_path = file_entry.get('file_path', '')
                    rel_path = os.path.relpath(abs_path, tmp_dir).replace('\\', '/') if abs_path.startswith(tmp_dir) else abs_path.replace('\\', '/')
                    match_lines = file_entry.get('match_lines', [0, 0])
                    line_num = match_lines[0] if match_lines else 0
                    matched_text = str(file_entry.get('match_string', ''))[:200]

                    file_id = path_to_file_id.get(rel_path)

                    desc_full = description
                    if cwe:
                        desc_full = f"{description} ({cwe})"

                    conn.execute(
                        '''INSERT INTO findings
                           (file_id, rule_id, severity, title, description, line_number, matched_text, category)
                           VALUES (?,?,?,?,?,?,?,?)''',
                        (file_id, f'mobsfscan:{rule_id}', severity, title,
                         desc_full, line_num, matched_text, 'mobsfscan')
                    )
                    findings_count += 1

        return findings_count


def scan_secrets(db_path: str, mobsfscan_path: str = None, job_id: str = None) -> dict:
    """Scan all source files for secrets, URLs, and security issues."""
    conn = sqlite3.connect(db_path)

    # Load all files (decompress content)
    files = conn.execute('SELECT id, path, source, content, language FROM files').fetchall()
    total_files = len(files)

    finding_count = 0
    PROGRESS_INTERVAL = 100

    for idx, (file_id, file_path, source, content_blob, language) in enumerate(files):
        # Emit progress periodically
        if job_id and total_files > 0 and (idx + 1) % PROGRESS_INTERVAL == 0:
            send({"id": job_id, "status": "progress",
                  "progress": round((idx + 1) / total_files * 100)})

        # Skip binary-looking files
        if language not in SCANNABLE_LANGUAGES:
            continue

        try:
            content = decompress_content(content_blob).decode('utf-8')
        except Exception:
            continue

        lines = content.split('\n')
        for line_num, line in enumerate(lines, 1):
            for rule_id, title, desc, category, severity, pattern in SECRET_PATTERNS:
                for match in re.finditer(pattern, line):
                    matched = match.group(0)[:200]
                    # Skip well-known XML namespace/schema URLs
                    if rule_id in ('cleartext-http', 'firebase-url', 'https-url') and \
                       any(matched.startswith(p) for p in IGNORED_URL_PREFIXES):
                        continue
                    # Skip uninteresting IP addresses
                    if rule_id == 'ip-address' and matched in IGNORED_IPS:
                        continue
                    # Skip base64 matches that look like natural text
                    if rule_id == 'base64-secret' and not _is_likely_base64_secret(matched):
                        continue
                    # Skip common URI schemes for deeplink rule
                    if rule_id == 'deeplink-scheme' and matched.split('://')[0] in IGNORED_DEEPLINK_SCHEMES:
                        continue
                    # Skip well-known URLs for api-base-url rule
                    if rule_id == 'api-base-url' and \
                       any(matched.startswith(p) for p in IGNORED_URL_PREFIXES):
                        continue
                    conn.execute(
                        '''INSERT INTO findings
                           (file_id, rule_id, severity, title, description, line_number, matched_text, category)
                           VALUES (?,?,?,?,?,?,?,?)''',
                        (file_id, rule_id, severity, title, desc, line_num, matched, category)
                    )
                    finding_count += 1

    # Run mobsfscan if available
    mobsfscan_findings = 0
    if mobsfscan_path and os.path.exists(mobsfscan_path):
        mobsfscan_findings = run_mobsfscan(db_path, mobsfscan_path, conn)

    conn.commit()
    conn.close()

    return {'findingCount': finding_count, 'mobsfscanFindings': mobsfscan_findings}


TILE_EXTENSIONS = frozenset({'jpg', 'jpeg', 'png', 'webp'})
TILE_PATH_RE = re.compile(r'^(.+?)/(\d+)/(\d+)/(\d+)\.(jpg|jpeg|png|webp)$')


def _tile_to_lat_lng(x: int, y: int, z: int) -> tuple[float, float]:
    """Convert tile coordinates to lat/lng (NW corner of tile).

    Standard Web Mercator / Slippy Map formula (same as Google Maps, OSM).
    """
    n = 2 ** z
    lng = x / n * 360.0 - 180.0
    lat_rad = math.atan(math.sinh(math.pi * (1 - 2 * y / n)))
    lat = lat_rad * 180.0 / math.pi
    return (lat, lng)


def detect_map_tiles(apk_path: str) -> dict:
    """Scan an APK for embedded map tile folder structures.

    Detects patterns like: assets/map/{z}/{x}/{y}.jpg
    Returns: {'tileSets': [tileSetInfo, ...]}
    """
    import zipfile

    # Use zipfile for fast metadata read (central directory only, no decompression)
    zf = zipfile.ZipFile(apk_path)
    file_sizes: dict[str, int] = {}
    for info in zf.infolist():
        file_sizes[info.filename] = info.file_size

    # Group files by tile-like pattern
    groups: dict[str, list[tuple[int, int, int, str, int]]] = {}
    for fname in file_sizes:
        m = TILE_PATH_RE.match(fname)
        if not m:
            continue
        prefix = m.group(1)
        z, x, y = int(m.group(2)), int(m.group(3)), int(m.group(4))
        ext = m.group(5)
        fsize = file_sizes[fname]
        groups.setdefault(prefix, []).append((z, x, y, ext, fsize))

    tile_sets = []
    for prefix, tiles in groups.items():
        # Validate: require >=2 zoom levels and >=10 tiles
        zoom_levels = sorted(set(t[0] for t in tiles))
        if len(zoom_levels) < 2 or len(tiles) < 10:
            continue

        # Per-zoom coordinate ranges
        zoom_ranges: dict[str, dict] = {}
        for z in zoom_levels:
            z_tiles = [t for t in tiles if t[0] == z]
            xs = [t[1] for t in z_tiles]
            ys = [t[2] for t in z_tiles]
            zoom_ranges[str(z)] = {
                'minX': min(xs), 'maxX': max(xs),
                'minY': min(ys), 'maxY': max(ys),
            }

        # Detect format (most common extension)
        ext_counts: dict[str, int] = {}
        for t in tiles:
            ext = t[3].lower()
            if ext == 'jpeg':
                ext = 'jpg'
            ext_counts[ext] = ext_counts.get(ext, 0) + 1
        tile_format = max(ext_counts, key=ext_counts.get)

        # Total bytes
        total_bytes = sum(t[4] for t in tiles)

        # Compute bounds from highest zoom level (tightest extent).
        # Lower zoom tiles cover much more ground; the most zoomed-in tiles
        # represent the actual area of interest (e.g. a theme park).
        max_z = zoom_levels[-1]
        zr = zoom_ranges[str(max_z)]
        nw_lat, nw_lng = _tile_to_lat_lng(zr['minX'], zr['minY'], max_z)
        se_lat, se_lng = _tile_to_lat_lng(zr['maxX'] + 1, zr['maxY'] + 1, max_z)

        # Detect tile pixel size from a sample tile
        tile_size = 256
        try:
            from PIL import Image
            import io
            # Sample a tile from the middle zoom level
            sample_z = zoom_levels[len(zoom_levels) // 2]
            sample_tiles = [t for t in tiles if t[0] == sample_z]
            if sample_tiles:
                st = sample_tiles[0]
                sample_path = f"{prefix}/{st[0]}/{st[1]}/{st[2]}.{st[3]}"
                sample_data = zf.read(sample_path)
                if sample_data:
                    img = Image.open(io.BytesIO(sample_data))
                    tile_size = img.width
        except Exception:
            pass

        # Content hash: hash sorted (path, fileSize) tuples for fast change detection
        hash_entries = sorted(
            (f"{prefix}/{t[0]}/{t[1]}/{t[2]}.{t[3]}", t[4])
            for t in tiles
        )
        hash_str = '\n'.join(f"{p}:{s}" for p, s in hash_entries)
        content_hash = 'sha256:' + hashlib.sha256(hash_str.encode()).hexdigest()

        # Derive name from last path segment
        name = prefix.rsplit('/', 1)[-1] if '/' in prefix else prefix

        tile_sets.append({
            'basePath': prefix,
            'name': name,
            'format': tile_format,
            'zoomLevels': zoom_levels,
            'minZoom': zoom_levels[0],
            'maxZoom': zoom_levels[-1],
            'tileCount': len(tiles),
            'totalBytes': total_bytes,
            'tileSize': tile_size,
            'bounds': {
                'minLat': round(se_lat, 6),
                'maxLat': round(nw_lat, 6),
                'minLng': round(nw_lng, 6),
                'maxLng': round(se_lng, 6),
            },
            'zoomRanges': zoom_ranges,
            'contentHash': content_hash,
        })

    # Also detect .mbtiles files embedded in the APK
    import tempfile, sqlite3

    mbtiles_files = [f for f in file_sizes if f.lower().endswith('.mbtiles') and file_sizes[f] > 0]
    for mbtiles_entry in mbtiles_files:
        try:
            # Extract to temp file so we can open it as SQLite
            with tempfile.NamedTemporaryFile(suffix='.mbtiles', delete=False) as tmp:
                tmp.write(zf.read(mbtiles_entry))
                tmp_path = tmp.name

            try:
                conn = sqlite3.connect(tmp_path)
                cur = conn.cursor()

                # Verify tiles table exists
                cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='tiles'")
                if not cur.fetchone():
                    conn.close()
                    continue

                # Zoom levels and tile counts
                cur.execute('SELECT zoom_level, COUNT(*) FROM tiles GROUP BY zoom_level ORDER BY zoom_level')
                zoom_data = cur.fetchall()
                if not zoom_data:
                    conn.close()
                    continue

                zoom_levels = [r[0] for r in zoom_data]
                total_count = sum(r[1] for r in zoom_data)
                if total_count < 1:
                    conn.close()
                    continue

                min_zoom = zoom_levels[0]
                max_zoom = zoom_levels[-1]

                # Read format from metadata table
                tile_format = 'png'
                try:
                    cur.execute("SELECT value FROM metadata WHERE name='format'")
                    fmt_row = cur.fetchone()
                    if fmt_row:
                        fmt = fmt_row[0].lower()
                        if fmt in ('jpg', 'jpeg', 'png', 'webp'):
                            tile_format = 'jpg' if fmt == 'jpeg' else fmt
                except Exception:
                    pass

                # Compute bounds from highest zoom (TMS coords → XYZ)
                cur.execute(
                    'SELECT MIN(tile_column), MAX(tile_column), MIN(tile_row), MAX(tile_row) '
                    'FROM tiles WHERE zoom_level=?',
                    (max_zoom,),
                )
                min_x, max_x, min_y_tms, max_y_tms = cur.fetchone()

                n = 2 ** max_zoom
                min_y_xyz = (n - 1) - max_y_tms
                max_y_xyz = (n - 1) - min_y_tms

                nw_lat, nw_lng = _tile_to_lat_lng(min_x, min_y_xyz, max_zoom)
                se_lat, se_lng = _tile_to_lat_lng(max_x + 1, max_y_xyz + 1, max_zoom)

                # Content hash from (z, x, y, size) tuples
                cur.execute(
                    'SELECT zoom_level, tile_column, tile_row, LENGTH(tile_data) '
                    'FROM tiles ORDER BY zoom_level, tile_column, tile_row',
                )
                hash_str = '\n'.join(f"{z}:{x}:{y}:{s}" for z, x, y, s in cur.fetchall())
                content_hash = 'sha256:' + hashlib.sha256(hash_str.encode()).hexdigest()

                # Total bytes
                cur.execute('SELECT SUM(LENGTH(tile_data)) FROM tiles')
                total_bytes = cur.fetchone()[0] or 0

                # Derive name from mbtiles filename
                name = os.path.splitext(os.path.basename(mbtiles_entry))[0]

                tile_sets.append({
                    'type': 'mbtiles',
                    'mbtilePath': mbtiles_entry,
                    'basePath': mbtiles_entry,
                    'name': name,
                    'format': tile_format,
                    'zoomLevels': zoom_levels,
                    'minZoom': min_zoom,
                    'maxZoom': max_zoom,
                    'tileCount': total_count,
                    'totalBytes': total_bytes,
                    'tileSize': 256,
                    'bounds': {
                        'minLat': round(se_lat, 6),
                        'maxLat': round(nw_lat, 6),
                        'minLng': round(nw_lng, 6),
                        'maxLng': round(se_lng, 6),
                    },
                    'contentHash': content_hash,
                })

                conn.close()
            finally:
                os.unlink(tmp_path)
        except Exception:
            pass

    return {'tileSets': tile_sets}


def extract_map_tiles(apk_path: str, base_path: str, output_dir: str,
                       job_id: str = None) -> dict:
    """Extract map tiles from APK to output directory.

    Reads tiles matching base_path/{z}/{x}/{y}.{ext} from the APK and writes
    them to output_dir/{z}/{x}/{y}.{ext}.

    Returns: {'extractedCount': int, 'totalBytes': int}
    """
    import zipfile

    zf = zipfile.ZipFile(apk_path)
    all_files = [info.filename for info in zf.infolist()]

    os.makedirs(output_dir, exist_ok=True)

    extracted = 0
    total_bytes = 0
    prefix_slash = base_path + '/'

    tile_files = [f for f in all_files if f.startswith(prefix_slash) and TILE_PATH_RE.match(f)]
    total_files = len(tile_files)

    PROGRESS_INTERVAL = 500

    for idx, fname in enumerate(tile_files):
        m = TILE_PATH_RE.match(fname)
        if not m:
            continue

        z, x, y = m.group(2), m.group(3), m.group(4)
        ext = m.group(5)

        try:
            data = zf.read(fname)
            if not data:
                continue
        except Exception:
            continue

        tile_dir = os.path.join(output_dir, z, x)
        os.makedirs(tile_dir, exist_ok=True)

        tile_path = os.path.join(tile_dir, f"{y}.{ext}")
        with open(tile_path, 'wb') as f:
            f.write(data)

        extracted += 1
        total_bytes += len(data)

        if job_id and total_files > 0 and (idx + 1) % PROGRESS_INTERVAL == 0:
            send({"id": job_id, "status": "progress",
                  "progress": round((idx + 1) / total_files * 100)})

    return {'extractedCount': extracted, 'totalBytes': total_bytes}


def extract_mbtiles_tiles(apk_path: str, mbtile_path: str, output_dir: str,
                           job_id: str = None) -> dict:
    """Extract tiles from an MBTiles file embedded in an APK.

    Extracts the .mbtiles entry from the APK zip, opens it as SQLite,
    reads all tiles with TMS → XYZ Y flip, and writes to output_dir/{z}/{x}/{y}.{ext}.

    Returns: {'extractedCount': int, 'totalBytes': int}
    """
    import zipfile, tempfile, sqlite3

    zf = zipfile.ZipFile(apk_path)

    # Extract the .mbtiles file from APK to a temp location
    with tempfile.NamedTemporaryFile(suffix='.mbtiles', delete=False) as tmp:
        tmp.write(zf.read(mbtile_path))
        tmp_path = tmp.name

    try:
        conn = sqlite3.connect(tmp_path)
        cur = conn.cursor()

        # Read format from metadata
        tile_ext = 'png'
        try:
            cur.execute("SELECT value FROM metadata WHERE name='format'")
            fmt_row = cur.fetchone()
            if fmt_row:
                fmt = fmt_row[0].lower()
                if fmt in ('jpg', 'jpeg', 'png', 'webp'):
                    tile_ext = fmt
        except Exception:
            pass

        os.makedirs(output_dir, exist_ok=True)

        cur.execute('SELECT COUNT(*) FROM tiles')
        total = cur.fetchone()[0]

        cur.execute('SELECT zoom_level, tile_column, tile_row, tile_data FROM tiles')

        extracted = 0
        total_bytes = 0
        PROGRESS_INTERVAL = 500

        for row in cur:
            z, x, y_tms, data = row
            # TMS → XYZ Y flip
            y = (2 ** z - 1) - y_tms

            tile_dir = os.path.join(output_dir, str(z), str(x))
            os.makedirs(tile_dir, exist_ok=True)

            tile_path = os.path.join(tile_dir, f"{y}.{tile_ext}")
            with open(tile_path, 'wb') as f:
                f.write(data)

            extracted += 1
            total_bytes += len(data)

            if job_id and total > 0 and extracted % PROGRESS_INTERVAL == 0:
                send({"id": job_id, "status": "progress",
                      "progress": round(extracted / total * 100)})

        conn.close()
        return {'extractedCount': extracted, 'totalBytes': total_bytes}
    finally:
        os.unlink(tmp_path)


def send(msg: dict):
    """Send a JSON message to stdout (one line)."""
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


def main():
    """Main loop — read commands from stdin, process, write results to stdout."""
    send({"status": "ready"})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            msg = json.loads(line)
        except json.JSONDecodeError as e:
            send({"status": "error", "error": f"Invalid JSON: {e}"})
            continue

        command = msg.get("command")

        if command == "shutdown":
            send({"status": "shutdown"})
            break

        if command == "analyze":
            job_id = msg.get("id")
            apk_path = msg.get("apkPath")
            output_dir = msg.get("outputDir")
            split_apk_paths = msg.get("splitApkPaths")

            if not apk_path or not output_dir:
                send({"id": job_id, "status": "failed", "error": "Missing apkPath or outputDir"})
                continue

            if not os.path.exists(apk_path):
                send({"id": job_id, "status": "failed", "error": f"APK file not found: {apk_path}"})
                continue

            try:
                result = analyze_apk(apk_path, output_dir)

                # Supplement framework detection from split APKs
                if split_apk_paths and len(split_apk_paths) > 1:
                    fw_files = {}
                    for split_path in split_apk_paths:
                        try:
                            with zipfile.ZipFile(split_path, 'r') as zf:
                                for fname in zf.namelist():
                                    if fname.startswith('lib/') and fname.endswith('.so'):
                                        fw_files[fname] = b''
                                    elif fname.startswith('assets/'):
                                        if fname.endswith('.bundle') or fname.endswith('.jsbundle'):
                                            try:
                                                data = zf.read(fname)
                                                fw_files[fname] = data[:64] if data else b''
                                            except Exception:
                                                pass
                                        else:
                                            fw_files[fname] = b''
                        except (zipfile.BadZipFile, OSError):
                            continue
                    if fw_files:
                        extra_frameworks = detect_frameworks(fw_files)
                        existing = {f['name'] for f in result.get('frameworks', {}).get('detected', [])}
                        for fw in extra_frameworks:
                            if fw['name'] not in existing:
                                result['frameworks']['detected'].append(fw)

                send({"id": job_id, "status": "completed", "result": result})
            except Exception as e:
                send({
                    "id": job_id,
                    "status": "failed",
                    "error": f"{type(e).__name__}: {e}",
                })

        elif command == "decompile":
            job_id = msg.get("id")
            apk_path = msg.get("apkPath")
            tools = msg.get("tools", {})
            output_dir = msg.get("outputDir")

            if not apk_path or not output_dir:
                send({"id": job_id, "status": "failed", "error": "Missing apkPath or outputDir"})
                continue

            if not os.path.exists(apk_path):
                send({"id": job_id, "status": "failed", "error": f"APK file not found: {apk_path}"})
                continue

            try:
                result = decompile_apk(apk_path, tools, output_dir, job_id=job_id)
                send({"id": job_id, "status": "completed", "result": result})
            except Exception as e:
                send({
                    "id": job_id,
                    "status": "failed",
                    "error": f"{type(e).__name__}: {e}",
                })

        elif command == "store_source":
            job_id = msg.get("id")
            decompile_dir = msg.get("decompileDir")
            db_path = msg.get("dbPath")

            if not decompile_dir or not db_path:
                send({"id": job_id, "status": "failed", "error": "Missing decompileDir or dbPath"})
                continue

            if not os.path.isdir(decompile_dir):
                send({"id": job_id, "status": "failed",
                      "error": f"Decompile directory not found: {decompile_dir}"})
                continue

            try:
                result = store_source(decompile_dir, db_path, job_id=job_id,
                                      metadata=msg.get("metadata"))
                send({"id": job_id, "status": "completed", "result": result})
            except Exception as e:
                send({
                    "id": job_id,
                    "status": "failed",
                    "error": f"{type(e).__name__}: {e}",
                })
        elif command == "scan_secrets":
            job_id = msg.get("id")
            db_path = msg.get("dbPath")
            mobsfscan_path = msg.get("mobsfscanPath")

            if not db_path:
                send({"id": job_id, "status": "failed", "error": "Missing dbPath"})
                continue

            try:
                result = scan_secrets(db_path, mobsfscan_path, job_id=job_id)
                send({"id": job_id, "status": "completed", "result": result})
            except Exception as e:
                send({
                    "id": job_id,
                    "status": "failed",
                    "error": f"{type(e).__name__}: {e}",
                })

        elif command == "hermes_decompile":
            job_id = msg.get("id")
            apk_path = msg.get("apkPath")
            output_dir = msg.get("outputDir")
            bundle_path = msg.get("bundlePath")
            tools = msg.get("tools", {})

            if not apk_path or not output_dir or not bundle_path:
                send({"id": job_id, "status": "failed",
                      "error": "Missing apkPath, outputDir, or bundlePath"})
                continue

            if not os.path.exists(apk_path):
                send({"id": job_id, "status": "failed",
                      "error": f"APK file not found: {apk_path}"})
                continue

            try:
                result = hermes_decompile_bundle(apk_path, output_dir, bundle_path,
                                                 tools, job_id=job_id)
                send({"id": job_id, "status": "completed", "result": result})
            except Exception as e:
                send({
                    "id": job_id,
                    "status": "failed",
                    "error": f"{type(e).__name__}: {e}",
                })

        elif command == "beautify_js_bundle":
            job_id = msg.get("id")
            apk_path = msg.get("apkPath")
            output_dir = msg.get("outputDir")
            bundle_path = msg.get("bundlePath")

            if not apk_path or not output_dir or not bundle_path:
                send({"id": job_id, "status": "failed",
                      "error": "Missing apkPath, outputDir, or bundlePath"})
                continue

            if not os.path.exists(apk_path):
                send({"id": job_id, "status": "failed",
                      "error": f"APK file not found: {apk_path}"})
                continue

            try:
                result = beautify_js_bundle(apk_path, output_dir, bundle_path,
                                            job_id=job_id)
                send({"id": job_id, "status": "completed", "result": result})
            except Exception as e:
                send({
                    "id": job_id,
                    "status": "failed",
                    "error": f"{type(e).__name__}: {e}",
                })

        elif command == "flutter_decompile":
            job_id = msg.get("id")
            apk_path = msg.get("apkPath")
            output_dir = msg.get("outputDir")
            tools = msg.get("tools", {})

            if not apk_path or not output_dir:
                send({"id": job_id, "status": "failed",
                      "error": "Missing apkPath or outputDir"})
                continue

            if not os.path.exists(apk_path):
                send({"id": job_id, "status": "failed",
                      "error": f"APK file not found: {apk_path}"})
                continue

            try:
                result = flutter_decompile(apk_path, output_dir, tools, job_id=job_id)
                send({"id": job_id, "status": "completed", "result": result})
            except Exception as e:
                send({
                    "id": job_id,
                    "status": "failed",
                    "error": f"{type(e).__name__}: {e}",
                })

        elif command == "detect_map_tiles":
            job_id = msg.get("id")
            apk_path = msg.get("apkPath")

            if not apk_path:
                send({"id": job_id, "status": "failed", "error": "Missing apkPath"})
                continue

            if not os.path.exists(apk_path):
                send({"id": job_id, "status": "failed",
                      "error": f"APK file not found: {apk_path}"})
                continue

            try:
                result = detect_map_tiles(apk_path)
                send({"id": job_id, "status": "completed", "result": result})
            except Exception as e:
                send({
                    "id": job_id,
                    "status": "failed",
                    "error": f"{type(e).__name__}: {e}",
                })

        elif command == "extract_map_tiles":
            job_id = msg.get("id")
            apk_path = msg.get("apkPath")
            base_path = msg.get("basePath")
            output_dir = msg.get("outputDir")

            if not apk_path or not base_path or not output_dir:
                send({"id": job_id, "status": "failed",
                      "error": "Missing apkPath, basePath, or outputDir"})
                continue

            if not os.path.exists(apk_path):
                send({"id": job_id, "status": "failed",
                      "error": f"APK file not found: {apk_path}"})
                continue

            try:
                result = extract_map_tiles(apk_path, base_path, output_dir,
                                           job_id=job_id)
                send({"id": job_id, "status": "completed", "result": result})
            except Exception as e:
                send({
                    "id": job_id,
                    "status": "failed",
                    "error": f"{type(e).__name__}: {e}",
                })

        elif command == "extract_mbtiles_tiles":
            job_id = msg.get("id")
            apk_path = msg.get("apkPath")
            mbtile_path = msg.get("mbtilePath")
            output_dir = msg.get("outputDir")

            if not apk_path or not mbtile_path or not output_dir:
                send({"id": job_id, "status": "failed",
                      "error": "Missing apkPath, mbtilePath, or outputDir"})
                continue

            if not os.path.exists(apk_path):
                send({"id": job_id, "status": "failed",
                      "error": f"APK file not found: {apk_path}"})
                continue

            try:
                result = extract_mbtiles_tiles(apk_path, mbtile_path, output_dir,
                                               job_id=job_id)
                send({"id": job_id, "status": "completed", "result": result})
            except Exception as e:
                send({
                    "id": job_id,
                    "status": "failed",
                    "error": f"{type(e).__name__}: {e}",
                })

        else:
            send({"status": "error", "error": f"Unknown command: {command}"})


if __name__ == "__main__":
    main()
