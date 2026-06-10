"""Print core APK identity as JSON: {packageName, versionCode, versionName}.

Usage: python apk_quick_meta.py /path/to/file.apk
Fast path for the upload endpoint — full analysis stays in apk_analyzer.py.
"""
import json
import sys

from androguard.core.apk import APK


def main() -> int:
    if len(sys.argv) != 2:
        print(json.dumps({"error": "usage: apk_quick_meta.py <apk>"}))
        return 1
    try:
        a = APK(sys.argv[1])
        version_code = a.get_androidversion_code()
        print(json.dumps({
            "packageName": a.get_package() or None,
            "versionCode": int(version_code) if version_code else None,
            "versionName": a.get_androidversion_name() or None,
        }))
        return 0
    except Exception as exc:  # androguard raises broadly on malformed files
        print(json.dumps({"error": str(exc)}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
