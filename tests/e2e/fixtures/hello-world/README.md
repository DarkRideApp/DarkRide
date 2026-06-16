# DarkRide E2E fixture — Hello World

Minimal Android app used by the E2E emulator-capture test
(`tests/e2e/emulator-capture.test.ts`).

## What it does

On launch, fires a single HTTPS GET to `https://example.com/?darkride-e2e=ping`.
The DarkRide E2E test asserts the captured request appears in mitmproxy's
traffic store with the expected hostname + path.

## Why a real APK (not adb shell curl, not the built-in browser)

The "install an APK, capture its traffic" path is the user-facing story —
real plugin authors will install real APKs. Using `adb shell curl` would
prove capture works but skip the install pathway entirely; using the
built-in browser would test Chrome's traffic (which has its own quirks
like QUIC fallback) rather than a typical app's `HttpURLConnection`.

## How it's built in CI

The `.github/workflows/ci-e2e-emulator.yml` workflow sets up Android SDK
+ Gradle, then runs `./gradlew assembleDebug` to produce
`app/build/outputs/apk/debug/app-debug.apk`. The E2E test installs that
artefact.

Not pre-built in this repo — the source IS the source of truth. Run
`./gradlew assembleDebug` locally if you need the APK for manual testing.
