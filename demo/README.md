# DarkRide demo recorder

Automatic hero-video pipeline: drive DarkRide in a browser with Playwright,
record it, and produce a web-ready **MP4 + optimized GIF** with ffmpeg.

## What's here

| File | Purpose |
|------|---------|
| `record.mjs` | Generic recorder — runs a scenario module against a DarkRide URL, saves a `webm`. |
| `to-gif.sh` | `webm` → `mp4` (H.264) + palette-optimized `gif`. |
| `scenarios/smoke.mjs` | Self-contained animation that proves the record→convert mechanics with no backend/emulator. |
| `scenarios/hero-playground.mjs` | **The hero** — DarkRide vs the purpose-built [DarkRide Playground](https://github.com/DarkRideApp/playground) target (capture + pin-bypass + APK analysis + WS decode). |
| `scenarios/hero-allsafe.mjs` | Fallback storyboard vs the Allsafe target (Frida / APK-analysis only, no real traffic). |
| `fetch-playground.sh` | Downloads the Playground APK from its Releases (via `gh`; kept out of git). |
| `fetch-allsafe.sh` | Downloads the Allsafe APK (kept out of git). |

## Prove the pipeline (works anywhere)

```bash
node demo/record.mjs --scenario demo/scenarios/smoke.mjs --name smoke
demo/to-gif.sh demo/out/smoke.webm 15 720
# -> demo/out/smoke.mp4  +  demo/out/smoke.gif
```

## Record the real hero (needs an emulator)

Not runnable in a disk-constrained CI sandbox — an Android emulator needs KVM +
a system image (multi-GB). Run on a machine/CI with the room:

```bash
# 1. Connect a device (physical or emulator) to DarkRide.
# 2. Install the Playground target (published from DarkRideApp/playground CI):
demo/fetch-playground.sh
adb install demo/assets/playground.apk
# 3. Start DarkRide, then record + convert. The recorder logs into DarkRide
#    first (else you just film the login screen) — creds via env vars:
export DARKRIDE_USER=you DARKRIDE_PASS=yourpassword
node demo/record.mjs \
  --scenario demo/scenarios/hero-playground.mjs \
  --base-url http://localhost:5173 --name hero
# trim the ~3s login intro off the front (4th arg = start seconds):
demo/to-gif.sh demo/out/hero.webm 15 960 3
```

`DARKRIDE_USER`/`DARKRIDE_PASS` (or `--user`/`--pass`) auth the recorder's browser
(default: the seeded `hero` admin — see Hero mode). Login mirrors `tests/e2e/helpers/auth.ts`.

## Hero mode — clean data + a known login

Recording against your real DarkRide films your local test captures. `hero-env.sh` boots a **fresh,
throwaway DarkRide** (separate DB + a `hero` admin), seeds it with curated on-brand Playground
traffic, and leaves your real instance/DB untouched:

```bash
demo/hero-env.sh
# → fresh DarkRide on http://localhost:5399, login hero / hero-demo-pass,
#   pre-seeded with clean Playground traffic. Connect your device to it.
```

In another terminal, record against it — creds default to `hero`, so nothing to pass:

```bash
node demo/record.mjs --scenario demo/scenarios/hero-playground.mjs \
  --base-url http://localhost:5399 --name hero
demo/to-gif.sh demo/out/hero.webm 15 960 3
```

`hero-seed.mjs` (curated rows) and the ports/DB are overridable via env — see the scripts.

## White chunks / blank areas in the capture

- The recorder now forces **dark theme** (a light-theme flash is a common cause).
- The **live device screen** is decoded with WebCodecs, which often renders **blank in headless**
  Chromium. Record **`--headed`** on a machine with a display so that region captures:
  `node demo/record.mjs … --headed`.

Use the resulting `hero.mp4` in a looping muted `<video>` on the site hero, with
`hero.gif` as the fallback / social-embed asset.

## Notes

- The **DarkRide Playground** is the intended hero target: purpose-built so each
  beat (login capture, cert-pin bypass, hardcoded-key APK analysis, WS decode)
  has a clean, branded, repeatable payoff. `hero-allsafe.mjs` stays as a fallback
  (Allsafe has no real traffic, so it's Frida/APK-analysis only).
- Scenario selectors are best-effort from the app's data-testids — verify them on
  the first real run.
- Recorded media (`demo/out/`) and the APK (`demo/assets/`) are git-ignored.
