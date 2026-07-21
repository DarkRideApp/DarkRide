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
# 1. Boot an emulator and connect it to DarkRide (docker-android or a local AVD).
# 2. Install the Playground target (published from DarkRideApp/playground CI):
demo/fetch-playground.sh
adb install demo/assets/playground.apk
# 3. Start DarkRide (backend + frontend), then record + convert:
node demo/record.mjs \
  --scenario demo/scenarios/hero-playground.mjs \
  --base-url http://localhost:5173 --name hero
demo/to-gif.sh demo/out/hero.webm 15 960
```

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
