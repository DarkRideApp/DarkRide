# DarkRide demo recorder

Automatic hero-video pipeline: drive DarkRide in a browser with Playwright,
record it, and produce a web-ready **MP4 + optimized GIF** with ffmpeg.

## What's here

| File | Purpose |
|------|---------|
| `record.mjs` | Generic recorder — runs a scenario module against a DarkRide URL, saves a `webm`. |
| `to-gif.sh` | `webm` → `mp4` (H.264) + palette-optimized `gif`. |
| `scenarios/smoke.mjs` | Self-contained animation that proves the record→convert mechanics with no backend/emulator. |
| `scenarios/hero-allsafe.mjs` | The hero storyboard: DarkRide vs the Allsafe target (APK analysis + Frida cert-pinning bypass). Needs the full live stack. |
| `fetch-allsafe.sh` | Downloads the Allsafe demo-target APK (kept out of git). |

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
# 2. Install the target app:
demo/fetch-allsafe.sh
adb install demo/assets/allsafe.apk
# 3. Start DarkRide (backend + frontend), then record + convert:
node demo/record.mjs \
  --scenario demo/scenarios/hero-allsafe.mjs \
  --base-url http://localhost:5173 --name hero
demo/to-gif.sh demo/out/hero.webm 15 960
```

Use the resulting `hero.mp4` in a looping muted `<video>` on the site hero, with
`hero.gif` as the fallback / social-embed asset.

## Notes

- **Allsafe is a Frida / cert-pinning / APK-analysis target, not a traffic
  generator** — its network activity is minimal. This hero leans on APK
  analysis + a Frida cert-pinning bypass. For a capture-heavy hero, build a
  purpose-made "DarkRide Playground" target (small vulnerable app + a demo API
  you host) so the traffic is clean, branded, and repeatable.
- Selectors in `hero-allsafe.mjs` are best-effort from the app's data-testids —
  verify them on the first real run.
- Recorded media (`demo/out/`) and the APK (`demo/assets/`) are git-ignored.
