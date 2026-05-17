#!/usr/bin/env python3
"""
APK Analysis Test Harness — standalone CLI for running apk_analyzer stages
without the Node.js orchestrator, DB, or WebSocket infrastructure.

Usage:
    .venv/bin/python scripts/apk-analyze.py <command> <APK_PATH> [options]

Accepts a single .apk, a .zip of split APKs, or a directory of split APKs.
Split APKs are automatically detected and merged for framework detection.

Commands:
    analyze     Extract metadata (package, permissions, frameworks, icon)
    decompile   Decompile with jadx/apktool
    flutter     Decompile Flutter libapp.so via blutter
    hermes      Decompile Hermes bytecode bundle
    beautify    Beautify plain JS bundle
    store       Compress decompiled source into SQLite DB
    scan        Scan source DB for secrets
    pipeline    Run full pipeline (auto-selects stages based on metadata)
    tools       Show discovered tool paths (no APK needed)
"""

import argparse
import glob as glob_mod
import json
import os
import shutil
import sys
import tempfile
import time
import traceback
import zipfile

# Add project root to path so we can import apk_analyzer
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(PROJECT_ROOT, 'python'))

import apk_analyzer


# ---------------------------------------------------------------------------
# Split APK resolution
# ---------------------------------------------------------------------------

class ApkInput:
    """Resolved APK input — handles single APK, ZIP of splits, or directory of splits."""

    def __init__(self, base_apk: str, all_apks: list[str], temp_dir: str | None = None):
        self.base_apk = base_apk
        self.all_apks = all_apks
        self.is_split = len(all_apks) > 1
        self._temp_dir = temp_dir

    def cleanup(self):
        if self._temp_dir:
            shutil.rmtree(self._temp_dir, ignore_errors=True)

    def find_apk_with_file(self, inner_path: str) -> str | None:
        """Find which APK contains a specific file path."""
        for apk_path in self.all_apks:
            try:
                with zipfile.ZipFile(apk_path, 'r') as zf:
                    if inner_path in zf.namelist():
                        return apk_path
            except zipfile.BadZipFile:
                continue
        return None

    def find_apk_with_pattern(self, pattern: str) -> tuple[str, str] | None:
        """Find APK + matching entry name for a glob-like pattern (simple substring match)."""
        for apk_path in self.all_apks:
            try:
                with zipfile.ZipFile(apk_path, 'r') as zf:
                    for name in zf.namelist():
                        if pattern in name:
                            return apk_path, name
            except zipfile.BadZipFile:
                continue
        return None

    def collect_framework_files(self) -> dict[str, bytes]:
        """Build merged fw_files dict from all APKs for framework detection."""
        fw_files = {}
        for apk_path in self.all_apks:
            try:
                with zipfile.ZipFile(apk_path, 'r') as zf:
                    for fname in zf.namelist():
                        if fname.startswith('assets/') and (fname.endswith('.bundle') or fname.endswith('.jsbundle')):
                            try:
                                data = zf.read(fname)
                                fw_files[fname] = data[:64] if data else b''
                            except Exception:
                                pass
                        elif fname.startswith('assets/') or fname.startswith('assemblies/'):
                            fw_files[fname] = b''
                        elif fname.startswith('lib/') and fname.endswith('.so'):
                            fw_files[fname] = b''
                        elif 'nodemodulesreactnative' in fname.lower().replace('-', '').replace('_', ''):
                            fw_files[fname] = b''
            except zipfile.BadZipFile:
                continue
        return fw_files


def resolve_apk_input(path_arg: str) -> ApkInput:
    """Resolve an APK path argument into an ApkInput.

    Handles:
    - Single .apk file
    - .zip file containing split APKs (extracts to temp dir)
    - Directory containing split APKs
    """
    if os.path.isdir(path_arg):
        apks = sorted(
            os.path.join(path_arg, f)
            for f in os.listdir(path_arg)
            if f.endswith('.apk')
        )
        if not apks:
            print(f'No .apk files found in directory: {path_arg}', file=sys.stderr)
            sys.exit(2)
        base = next((a for a in apks if os.path.basename(a) == 'base.apk'), apks[0])
        return ApkInput(base, apks)

    if path_arg.endswith('.zip') and zipfile.is_zipfile(path_arg):
        temp_dir = tempfile.mkdtemp(prefix='apk-analyze-')
        with zipfile.ZipFile(path_arg, 'r') as zf:
            members = [m for m in zf.namelist() if m.endswith('.apk')]
            if not members:
                shutil.rmtree(temp_dir, ignore_errors=True)
                print(f'No .apk files found in ZIP: {path_arg}', file=sys.stderr)
                sys.exit(2)
            zf.extractall(temp_dir, members)

        apks = sorted(os.path.join(temp_dir, m) for m in members)
        base = next((a for a in apks if os.path.basename(a) == 'base.apk'), apks[0])
        if len(apks) > 1:
            print(f'Split APKs detected: {", ".join(os.path.basename(a) for a in apks)}',
                  file=sys.stderr)
        return ApkInput(base, apks, temp_dir)

    # Single APK file
    return ApkInput(path_arg, [path_arg])


# ---------------------------------------------------------------------------
# Tool discovery (mirrors backend/services/tool-manager.ts)
# ---------------------------------------------------------------------------

def discover_tools(overrides: dict | None = None) -> dict:
    """Discover tool paths using CLI overrides > project-local > PATH fallback."""
    overrides = overrides or {}
    tools = {}

    # jadx: glob data/tools/jadx/*/bin/jadx
    if overrides.get('jadx'):
        tools['jadx'] = overrides['jadx']
    else:
        matches = sorted(glob_mod.glob(os.path.join(PROJECT_ROOT, 'data/tools/jadx/*/bin/jadx')))
        tools['jadx'] = matches[-1] if matches else shutil.which('jadx')

    # apktool: glob data/tools/apktool/*/apktool.jar
    if overrides.get('apktool'):
        tools['apktool'] = overrides['apktool']
    else:
        matches = sorted(glob_mod.glob(os.path.join(PROJECT_ROOT, 'data/tools/apktool/*/apktool.jar')))
        tools['apktool'] = matches[-1] if matches else None

    # java
    if overrides.get('java'):
        tools['java'] = overrides['java']
    else:
        tools['java'] = shutil.which('java')

    # pip tools in .venv/bin/
    venv_bin = os.path.join(PROJECT_ROOT, '.venv', 'bin')

    for name, binary in [
        ('mobsfscan', 'mobsfscan'),
        ('hbc_decompiler', 'hbc-decompiler'),
        ('hbc_disassembler', 'hbc-disassembler'),
    ]:
        if overrides.get(name):
            tools[name] = overrides[name]
        else:
            local = os.path.join(venv_bin, binary)
            tools[name] = local if os.path.exists(local) else shutil.which(binary)

    # blutter: project-local data/tools/blutter/blutter.py > PATH
    if overrides.get('blutter'):
        tools['blutter'] = overrides['blutter']
    else:
        local_blutter = os.path.join(PROJECT_ROOT, 'data', 'tools', 'blutter', 'blutter.py')
        if os.path.exists(local_blutter):
            tools['blutter'] = local_blutter
        else:
            tools['blutter'] = shutil.which('blutter')

    return tools


# ---------------------------------------------------------------------------
# Verbose mode: redirect apk_analyzer.send() to stderr
# ---------------------------------------------------------------------------

_original_send = apk_analyzer.send


def _verbose_send(msg: dict):
    """Redirect progress messages to stderr for visibility."""
    sys.stderr.write(json.dumps(msg) + '\n')
    sys.stderr.flush()


# ---------------------------------------------------------------------------
# Stage runners — each wraps the corresponding apk_analyzer function
# ---------------------------------------------------------------------------

def run_stage(fn, *args, **kwargs) -> tuple:
    """Run a stage function, return (result, error_string)."""
    try:
        result = fn(*args, **kwargs)
        return result, None
    except Exception as e:
        return None, f'{type(e).__name__}: {e}'


def fmt_time(seconds: float) -> str:
    if seconds < 60:
        return f'{seconds:.1f}s'
    return f'{int(seconds // 60)}m {seconds % 60:.1f}s'


def analyze_with_splits(apk_input: ApkInput, output_dir: str) -> tuple[dict | None, str | None]:
    """Run analyze_apk on base APK, then supplement framework detection from all splits."""
    result, err = run_stage(apk_analyzer.analyze_apk, apk_input.base_apk, output_dir)
    if err or not result:
        return result, err

    if not apk_input.is_split:
        return result, None

    # Supplement framework detection with files from all splits
    fw_files = apk_input.collect_framework_files()
    if fw_files:
        frameworks_detected = apk_analyzer.detect_frameworks(fw_files)
        if frameworks_detected:
            existing_names = {f['name'] for f in result.get('frameworks', {}).get('detected', [])}
            merged = list(result.get('frameworks', {}).get('detected', []))
            for fw in frameworks_detected:
                if fw['name'] not in existing_names:
                    merged.append(fw)
            result['frameworks']['detected'] = merged

            # Update backward-compat RN fields
            rn_entry = next((f for f in merged if f['name'] == 'React Native'), None)
            if rn_entry:
                result['frameworks']['reactNative'] = True
                result['frameworks']['hermesEngine'] = rn_entry['details'].get('hermesEngine', False)
                result['frameworks']['hermesBundlePath'] = rn_entry['details'].get('hermesBundlePath')
                result['frameworks']['jsBundlePath'] = rn_entry['details'].get('jsBundlePath')

    return result, None


# ---------------------------------------------------------------------------
# Pretty printers
# ---------------------------------------------------------------------------

def print_metadata(result: dict):
    print(f"  App:         {result.get('appName', '?')}")
    print(f"  Package:     {result.get('packageName', '?')}")
    print(f"  Min SDK:     {result.get('minSdk', '?')}")
    print(f"  Target SDK:  {result.get('targetSdk', '?')}")
    print(f"  Icon:        {'yes' if result.get('icon') else 'no'}")
    perms = result.get('permissions', [])
    print(f"  Permissions: {len(perms)}")
    for p in perms[:10]:
        print(f"    - {p.split('.')[-1]}")
    if len(perms) > 10:
        print(f"    ... and {len(perms) - 10} more")
    fw = result.get('frameworks', {})
    detected = fw.get('detected', [])
    if detected:
        print(f"  Frameworks:  {', '.join(f['name'] for f in detected)}")
        for f in detected:
            details = f.get('details', {})
            if details:
                detail_str = ', '.join(f'{k}={v}' for k, v in details.items() if v is not None)
                if detail_str:
                    print(f"    {f['name']}: {detail_str}")
    libs = fw.get('libraries', [])
    if libs:
        print(f"  Libraries:   {', '.join(l['name'] for l in libs[:10])}")
        if len(libs) > 10:
            print(f"               ... and {len(libs) - 10} more")
    bi = fw.get('buildInfo', {})
    for cat in ('compiler', 'packer', 'obfuscator', 'anti_analysis'):
        items = bi.get(cat, [])
        if items:
            print(f"  {cat.title()}: {', '.join(items)}")


def print_decompile(result: dict):
    for tool, r in result.items():
        status = 'OK' if r.get('success') else f"FAILED: {r.get('error', '?')}"
        print(f"  {tool}: {status}")
        if r.get('outputDir'):
            print(f"    -> {r['outputDir']}")


def print_flutter(result: dict):
    print(f"  Arch:        {result.get('arch', '?')}")
    size = result.get('libappSize')
    if size:
        print(f"  libapp.so:   {size / 1024 / 1024:.1f} MB")
    print(f"  Dump:        {'yes' if result.get('dumpGenerated') else 'no'}")
    r = result.get('blutter')
    if r:
        status = 'OK' if r.get('success') else f"FAILED: {r.get('error', '?')}"
        print(f"  blutter: {status}")


def print_hermes(result: dict):
    for tool, r in result.items():
        status = 'OK' if r.get('success') else f"FAILED: {r.get('error', '?')}"
        print(f"  {tool}: {status}")
        if r.get('outputFile'):
            print(f"    -> {r['outputFile']}")


def print_store(result: dict):
    print(f"  Files:  {result.get('fileCount', 0)}")
    size = result.get('totalSize', 0)
    print(f"  Size:   {size / 1024 / 1024:.1f} MB")
    print(f"  DB:     {result.get('dbPath', '?')}")


def print_scan(result: dict):
    print(f"  Regex findings:    {result.get('findingCount', 0)}")
    print(f"  mobsfscan findings: {result.get('mobsfscanFindings', 0)}")


def print_tools(tools: dict):
    for name, path in sorted(tools.items()):
        status = path if path else '(not found)'
        print(f"  {name:20s} {status}")


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

def cmd_tools(args):
    tools = discover_tools(build_overrides(args))
    if args.json:
        print(json.dumps(tools, indent=2))
    else:
        print('Discovered tools:')
        print_tools(tools)
    return 0


def cmd_analyze(args):
    apk = resolve_apk_input(args.apk_path)
    try:
        output_dir = os.path.join(args.output, 'metadata')
        t0 = time.monotonic()
        result, err = analyze_with_splits(apk, output_dir)
        elapsed = time.monotonic() - t0

        if args.json:
            print(json.dumps({'result': result, 'error': err, 'elapsed': round(elapsed, 2)}, indent=2))
        elif err:
            print(f'FAILED ({fmt_time(elapsed)}): {err}')
            if args.verbose:
                traceback.print_exc()
        else:
            print(f'Metadata ({fmt_time(elapsed)}):')
            print_metadata(result)
        return 1 if err else 0
    finally:
        apk.cleanup()


def cmd_decompile(args):
    apk = resolve_apk_input(args.apk_path)
    try:
        tools = discover_tools(build_overrides(args))
        output_dir = os.path.join(args.output, 'decompiled')
        t0 = time.monotonic()
        result, err = run_stage(apk_analyzer.decompile_apk, apk.base_apk, tools, output_dir)
        elapsed = time.monotonic() - t0

        if args.json:
            print(json.dumps({'result': result, 'error': err, 'elapsed': round(elapsed, 2)}, indent=2))
        elif err:
            print(f'FAILED ({fmt_time(elapsed)}): {err}')
        else:
            print(f'Decompile ({fmt_time(elapsed)}):')
            print_decompile(result)
        return 1 if err else 0
    finally:
        apk.cleanup()


def cmd_flutter(args):
    apk = resolve_apk_input(args.apk_path)
    try:
        tools = discover_tools(build_overrides(args))
        output_dir = os.path.join(args.output, 'decompiled')

        # Find which APK has libapp.so
        flutter_apk = apk.base_apk
        for candidate in ('lib/arm64-v8a/libapp.so', 'lib/armeabi-v7a/libapp.so'):
            found = apk.find_apk_with_file(candidate)
            if found:
                flutter_apk = found
                if apk.is_split:
                    print(f'Found libapp.so in {os.path.basename(flutter_apk)}', file=sys.stderr)
                break

        t0 = time.monotonic()
        result, err = run_stage(apk_analyzer.flutter_decompile, flutter_apk, output_dir, tools)
        elapsed = time.monotonic() - t0

        if args.json:
            print(json.dumps({'result': result, 'error': err, 'elapsed': round(elapsed, 2)}, indent=2))
        elif err:
            print(f'FAILED ({fmt_time(elapsed)}): {err}')
        else:
            print(f'Flutter decompile ({fmt_time(elapsed)}):')
            print_flutter(result)
        return 1 if err else 0
    finally:
        apk.cleanup()


def cmd_hermes(args):
    apk = resolve_apk_input(args.apk_path)
    try:
        tools = discover_tools(build_overrides(args))
        bundle_path = args.bundle_path
        hermes_apk = apk.base_apk

        if not bundle_path:
            # Auto-detect from metadata
            metadata_dir = os.path.join(args.output, 'metadata')
            result, err = analyze_with_splits(apk, metadata_dir)
            if err:
                print(f'Cannot auto-detect bundle path (metadata failed): {err}', file=sys.stderr)
                return 2
            fw = result.get('frameworks', {})
            bundle_path = fw.get('hermesBundlePath')
            if not bundle_path:
                print('No Hermes bundle detected in APK. Use --bundle-path to specify.', file=sys.stderr)
                return 2

        # Find which APK has the bundle
        found = apk.find_apk_with_file(bundle_path)
        if found:
            hermes_apk = found

        output_dir = os.path.join(args.output, 'decompiled')
        t0 = time.monotonic()
        result, err = run_stage(apk_analyzer.hermes_decompile_bundle,
                                hermes_apk, output_dir, bundle_path, tools)
        elapsed = time.monotonic() - t0

        if args.json:
            print(json.dumps({'result': result, 'error': err, 'elapsed': round(elapsed, 2)}, indent=2))
        elif err:
            print(f'FAILED ({fmt_time(elapsed)}): {err}')
        else:
            print(f'Hermes decompile ({fmt_time(elapsed)}):')
            print_hermes(result)
        return 1 if err else 0
    finally:
        apk.cleanup()


def cmd_beautify(args):
    apk = resolve_apk_input(args.apk_path)
    try:
        bundle_path = args.bundle_path
        beautify_apk = apk.base_apk

        if not bundle_path:
            metadata_dir = os.path.join(args.output, 'metadata')
            result, err = analyze_with_splits(apk, metadata_dir)
            if err:
                print(f'Cannot auto-detect bundle path (metadata failed): {err}', file=sys.stderr)
                return 2
            fw = result.get('frameworks', {})
            bundle_path = fw.get('jsBundlePath')
            if not bundle_path:
                print('No plain JS bundle detected in APK. Use --bundle-path to specify.', file=sys.stderr)
                return 2

        found = apk.find_apk_with_file(bundle_path)
        if found:
            beautify_apk = found

        output_dir = os.path.join(args.output, 'decompiled')
        t0 = time.monotonic()
        result, err = run_stage(apk_analyzer.beautify_js_bundle,
                                beautify_apk, output_dir, bundle_path)
        elapsed = time.monotonic() - t0

        if args.json:
            print(json.dumps({'result': result, 'error': err, 'elapsed': round(elapsed, 2)}, indent=2))
        elif err:
            print(f'FAILED ({fmt_time(elapsed)}): {err}')
        else:
            print(f'Beautify ({fmt_time(elapsed)}):')
            if result.get('outputFile'):
                print(f'  -> {result["outputFile"]}')
        return 1 if err else 0
    finally:
        apk.cleanup()


def cmd_store(args):
    decompile_dir = args.decompile_dir or os.path.join(args.output, 'decompiled')
    db_path = args.db_path or os.path.join(args.output, 'source.db')

    if not os.path.isdir(decompile_dir):
        print(f'Decompile directory not found: {decompile_dir}', file=sys.stderr)
        return 2

    t0 = time.monotonic()
    result, err = run_stage(apk_analyzer.store_source, decompile_dir, db_path)
    elapsed = time.monotonic() - t0

    if args.json:
        print(json.dumps({'result': result, 'error': err, 'elapsed': round(elapsed, 2)}, indent=2))
    elif err:
        print(f'FAILED ({fmt_time(elapsed)}): {err}')
    else:
        print(f'Store ({fmt_time(elapsed)}):')
        print_store(result)
    return 1 if err else 0


def cmd_scan(args):
    tools = discover_tools(build_overrides(args))
    db_path = args.db_path or os.path.join(args.output, 'source.db')

    if not os.path.isfile(db_path):
        print(f'Source DB not found: {db_path}', file=sys.stderr)
        return 2

    t0 = time.monotonic()
    result, err = run_stage(apk_analyzer.scan_secrets, db_path, tools.get('mobsfscan'))
    elapsed = time.monotonic() - t0

    if args.json:
        print(json.dumps({'result': result, 'error': err, 'elapsed': round(elapsed, 2)}, indent=2))
    elif err:
        print(f'FAILED ({fmt_time(elapsed)}): {err}')
    else:
        print(f'Scan ({fmt_time(elapsed)}):')
        print_scan(result)
    return 1 if err else 0


def cmd_pipeline(args):
    apk = resolve_apk_input(args.apk_path)
    try:
        tools = discover_tools(build_overrides(args))
        skips = set(args.skip or [])
        output_dir = args.output
        decompile_dir = os.path.join(output_dir, 'decompiled')
        db_path = os.path.join(output_dir, 'source.db')

        stages = {}
        any_failed = False
        pipeline_start = time.monotonic()

        def run(name, fn, *a, **kw):
            nonlocal any_failed
            if name in skips:
                stages[name] = {'skipped': True}
                if not args.json:
                    print(f'  [{name}] skipped')
                return None, 'skipped'
            t0 = time.monotonic()
            result, err = run_stage(fn, *a, **kw)
            elapsed = time.monotonic() - t0
            stages[name] = {'result': result, 'error': err, 'elapsed': round(elapsed, 2)}
            if not args.json:
                status = 'OK' if not err else 'FAILED'
                print(f'  [{name}] {status} ({fmt_time(elapsed)})')
                if err and args.verbose:
                    print(f'    Error: {err}')
            if err:
                any_failed = True
            return result, err

        if not args.json:
            print(f'Pipeline: {args.apk_path}')
            print(f'Output:   {output_dir}')
            if apk.is_split:
                print(f'Splits:   {", ".join(os.path.basename(a) for a in apk.all_apks)}')
            print()

        # 1. analyze (always) — with split APK support
        metadata_dir = os.path.join(output_dir, 'metadata')
        if 'analyze' not in skips:
            t0 = time.monotonic()
            metadata, meta_err = analyze_with_splits(apk, metadata_dir)
            elapsed = time.monotonic() - t0
            stages['analyze'] = {'result': metadata, 'error': meta_err, 'elapsed': round(elapsed, 2)}
            if not args.json:
                status = 'OK' if not meta_err else 'FAILED'
                print(f'  [analyze] {status} ({fmt_time(elapsed)})')
                if meta_err and args.verbose:
                    print(f'    Error: {meta_err}')
            if meta_err:
                any_failed = True
        else:
            metadata = None
            stages['analyze'] = {'skipped': True}
            if not args.json:
                print('  [analyze] skipped')

        fw = (metadata or {}).get('frameworks', {})
        detected_names = [f['name'] for f in fw.get('detected', [])]

        # 2. flutter (if detected)
        decompile_ok = False
        if 'Flutter' in detected_names:
            # Find which APK has libapp.so
            flutter_apk = apk.base_apk
            for candidate in ('lib/arm64-v8a/libapp.so', 'lib/armeabi-v7a/libapp.so'):
                found = apk.find_apk_with_file(candidate)
                if found:
                    flutter_apk = found
                    break
            flutter_result, _ = run('flutter', apk_analyzer.flutter_decompile,
                                    flutter_apk, decompile_dir, tools)
            if flutter_result and flutter_result.get('dumpGenerated'):
                decompile_ok = True

        # 3. decompile with jadx/apktool (if tools available)
        if tools.get('jadx') or (tools.get('apktool') and tools.get('java')):
            dec_result, dec_err = run('decompile', apk_analyzer.decompile_apk,
                                      apk.base_apk, tools, decompile_dir)
            if dec_result and any(r.get('success') for r in dec_result.values()):
                decompile_ok = True

        # 4. hermes or beautify (if React Native)
        if 'React Native' in detected_names:
            if fw.get('hermesEngine') and fw.get('hermesBundlePath'):
                bundle_path = fw['hermesBundlePath']
                bundle_apk = apk.find_apk_with_file(bundle_path) or apk.base_apk
                run('hermes', apk_analyzer.hermes_decompile_bundle,
                    bundle_apk, decompile_dir, bundle_path, tools)
                decompile_ok = True
            elif fw.get('jsBundlePath'):
                bundle_path = fw['jsBundlePath']
                bundle_apk = apk.find_apk_with_file(bundle_path) or apk.base_apk
                run('beautify', apk_analyzer.beautify_js_bundle,
                    bundle_apk, decompile_dir, bundle_path)
                decompile_ok = True

        # 5. store (if any decompile succeeded)
        store_ok = False
        if decompile_ok:
            store_result, store_err = run('store', apk_analyzer.store_source,
                                          decompile_dir, db_path, None, metadata)
            if not store_err:
                store_ok = True

        # 6. scan (if store succeeded)
        if store_ok:
            run('scan', apk_analyzer.scan_secrets, db_path, tools.get('mobsfscan'))

        total_elapsed = time.monotonic() - pipeline_start

        if args.json:
            print(json.dumps({
                'stages': stages,
                'totalElapsed': round(total_elapsed, 2),
            }, indent=2))
        else:
            print()
            completed = sum(1 for s in stages.values() if not s.get('error') and not s.get('skipped'))
            failed = sum(1 for s in stages.values() if s.get('error') and s.get('error') != 'skipped')
            skipped = sum(1 for s in stages.values() if s.get('skipped'))
            print(f'Done in {fmt_time(total_elapsed)}: {completed} OK, {failed} failed, {skipped} skipped')

        return 1 if any_failed else 0
    finally:
        apk.cleanup()


# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

def build_overrides(args) -> dict:
    """Build tool path overrides from CLI arguments."""
    overrides = {}
    for name in ('jadx', 'apktool', 'java', 'mobsfscan', 'blutter'):
        val = getattr(args, name, None)
        if val:
            overrides[name] = val
    return overrides


def main():
    # Parent parser with shared global options — inherited by all subcommands
    parent = argparse.ArgumentParser(add_help=False)
    parent.add_argument('-o', '--output', default='./apk-analyze-output',
                        help='Output directory (default: ./apk-analyze-output/)')
    parent.add_argument('--json', action='store_true', help='Raw JSON output')
    parent.add_argument('--verbose', action='store_true', help='Show subprocess output and tracebacks')
    parent.add_argument('--jadx', help='Override jadx path')
    parent.add_argument('--apktool', help='Override apktool.jar path')
    parent.add_argument('--java', help='Override java path')
    parent.add_argument('--mobsfscan', help='Override mobsfscan path')
    parent.add_argument('--blutter', help='Override blutter path')

    parser = argparse.ArgumentParser(
        description='APK Analysis Test Harness',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    subparsers = parser.add_subparsers(dest='command', required=True)

    # tools
    subparsers.add_parser('tools', parents=[parent], help='Show discovered tool paths')

    # analyze
    p = subparsers.add_parser('analyze', parents=[parent], help='Extract metadata')
    p.add_argument('apk_path', help='Path to APK file, ZIP of splits, or directory')

    # decompile
    p = subparsers.add_parser('decompile', parents=[parent], help='Decompile with jadx/apktool')
    p.add_argument('apk_path', help='Path to APK file, ZIP of splits, or directory')

    # flutter
    p = subparsers.add_parser('flutter', parents=[parent], help='Decompile Flutter libapp.so')
    p.add_argument('apk_path', help='Path to APK file, ZIP of splits, or directory')

    # hermes
    p = subparsers.add_parser('hermes', parents=[parent], help='Decompile Hermes bytecode bundle')
    p.add_argument('apk_path', help='Path to APK file, ZIP of splits, or directory')
    p.add_argument('--bundle-path', help='Path within APK to Hermes bundle (auto-detected if omitted)')

    # beautify
    p = subparsers.add_parser('beautify', parents=[parent], help='Beautify plain JS bundle')
    p.add_argument('apk_path', help='Path to APK file, ZIP of splits, or directory')
    p.add_argument('--bundle-path', help='Path within APK to JS bundle (auto-detected if omitted)')

    # store
    p = subparsers.add_parser('store', parents=[parent], help='Compress decompiled source into SQLite DB')
    p.add_argument('apk_path', nargs='?', help='Path to APK file (unused, for consistency)')
    p.add_argument('--decompile-dir', help='Decompile directory (default: <output>/decompiled)')
    p.add_argument('--db-path', help='Output DB path (default: <output>/source.db)')

    # scan
    p = subparsers.add_parser('scan', parents=[parent], help='Scan source DB for secrets')
    p.add_argument('apk_path', nargs='?', help='Path to APK file (unused, for consistency)')
    p.add_argument('--db-path', help='Source DB path (default: <output>/source.db)')

    # pipeline
    p = subparsers.add_parser('pipeline', parents=[parent], help='Run full pipeline')
    p.add_argument('apk_path', help='Path to APK file, ZIP of splits, or directory')
    p.add_argument('--skip', action='append', help='Skip a stage (repeatable)')

    args = parser.parse_args()

    # Set up verbose mode
    if args.verbose:
        apk_analyzer.send = _verbose_send

    # Validate input path for commands that need it
    if args.command not in ('tools', 'store', 'scan'):
        if not hasattr(args, 'apk_path') or not args.apk_path:
            parser.error(f'{args.command} requires an APK path')
        p = args.apk_path
        if not (os.path.isfile(p) or os.path.isdir(p)):
            print(f'APK file/directory not found: {p}', file=sys.stderr)
            sys.exit(2)

    # Ensure output dir exists
    os.makedirs(args.output, exist_ok=True)

    # Dispatch
    handlers = {
        'tools': cmd_tools,
        'analyze': cmd_analyze,
        'decompile': cmd_decompile,
        'flutter': cmd_flutter,
        'hermes': cmd_hermes,
        'beautify': cmd_beautify,
        'store': cmd_store,
        'scan': cmd_scan,
        'pipeline': cmd_pipeline,
    }

    try:
        sys.exit(handlers[args.command](args))
    except KeyboardInterrupt:
        print('\nInterrupted', file=sys.stderr)
        sys.exit(130)
    except Exception as e:
        if args.verbose:
            traceback.print_exc()
        else:
            print(f'Error: {e}', file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
