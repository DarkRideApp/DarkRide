# DarkRide Playground — deliberately-vulnerable demo target — Design

Date: 2026-07-20
Status: **Scoping/design for review.** No code. Decisions 1-4 below were made autonomously (Cube away) and are flagged.

## Why

DarkRide needs a demo/onboarding target it *controls*. Existing vulnerable apps (Allsafe,
InjuredAndroid, DIVA) are training CTFs with third-party/dead backends and little network traffic —
so they can't drive a clean, branded, repeatable **capture → intercept → analyse → bypass → AI**
story. The Playground is a small deliberately-vulnerable Android app + a bundled demo API, curated so
each DarkRide hero beat has a target and a visible payoff. It triples as:

1. **Hero-demo target** — the repeatable scenario the recording harness (`demo/`) films.
2. **Onboarding artifact** — "install this APK, point DarkRide at it, try every feature in 5 minutes."
3. **Deterministic E2E fixture** — DarkRide's emulator/capture/Frida flows get a stable app to test against.

## Decisions (autonomous, pending Cube review)

1. **Home:** new repo **`DarkRideApp/playground`** (self-contained, independently published APK + API).
2. **Demo API:** **bundled local server** (Node/TS) with a **self-signed cert the app pins** — makes
   capture + cert-pinning demos fully offline, deterministic, CI-friendly. Designed to be trivially
   hostable later (single container) if a public `play-api.darkride.app` is ever wanted.
3. **App stack:** **native Kotlin** (most common RE target, cleanest jadx/Frida story). Flutter/RN
   variant deferred.
4. **Scope:** **curated to the hero beats** — ~7 features, each a CTF-style flag — not broad MASVS.

## The seven features → DarkRide beat → payoff

| # | Playground feature | DarkRide beat | Visible payoff |
|---|--------------------|---------------|----------------|
| 1 | Login `POST` → bearer token; authed JSON calls | **HTTPS capture** | Token + authed request/response appear live in Traffic |
| 2 | Hardcoded API key / secret string in the APK | **APK analysis** | Findings tab surfaces the secret; AI summarises the risk |
| 3 | Certificate pinning on the authed calls | **Frida** | Pinning hides traffic → cert-pinning-bypass script → traffic appears |
| 4 | Root / emulator / anti-Frida gate (block screen) | **Frida** | App refuses on an emulator → detection-bypass script → app proceeds |
| 5 | Token/secret written to SharedPrefs + SQLite in cleartext | **APK analysis / data-extraction** | DarkRide pulls the insecure storage; a data-extraction Frida script dumps it |
| 6 | Deterministic login form (stable ids) + navigable screens | **TypeScript automation** | The automation engine drives login + navigation hands-free |
| 7 | WebSocket "telemetry" feed (JSON frames) | **Protocol decoders** | Live WS frames render in the frames panel |
| — | (whole flow driven end-to-end) | **AI / MCP** | The agent chains capture → find token → replay via MCP |

Each feature exposes a **flag** (a short string) so a run can assert "DarkRide solved beat N" — good
for the narrative *and* for the E2E fixture.

## Architecture

```
playground/                      # new repo: DarkRideApp/playground
  app/                           # Android app (Kotlin, single module)
    - screens: Login, Home (feed + profile), Settings, "InsecureDevice" gate
    - net: OkHttp client with CertificatePinner pinned to the demo API's cert
    - storage: SharedPrefs + Room/SQLite writing the token in cleartext
    - security: root/emulator/frida checks gating the Home screen
    - a hardcoded API key + a couple of "flags" in resources/BuildConfig
  api/                           # bundled demo API (Node + TS, Fastify/Express)
    - POST /login  -> { token }        (weak/guessable creds; token is a JWT-ish blob)
    - GET  /profile (Bearer)           -> user JSON  (the authed call that's pinned)
    - GET  /feed    (Bearer)           -> list JSON
    - WS   /telemetry                  -> periodic JSON frames
    - TLS via a bundled self-signed cert (the app pins its SPKI)
  certs/                         # self-signed cert + key (checked in; it's a demo)
  docker-compose.yml             # `docker compose up` -> API on https://localhost:8443
  README.md                      # install APK, run API, map each beat to a DarkRide screen
```

- **App ↔ API contract** is the only boundary: the app talks to `https://<api-host>:8443` (default
  `10.0.2.2` on the Android emulator = host loopback), pinning the bundled cert's SPKI. Config via
  `BuildConfig` so a hosted URL can be swapped at build time.
- **Isolation:** the API is stateless demo data (no DB); the app is one module. Each is understandable
  and runnable on its own.

## Data flow (the hero scenario it enables)

1. Emulator boots with the Playground app; DarkRide capture is armed.
2. App login `POST` → token; **traffic capture** shows it (beat 1).
3. Authed `/profile` is **cert-pinned** → nothing in Traffic → run the **Frida cert-pinning bypass**
   → the request appears (beat 3).
4. DarkRide analyses the APK → **hardcoded secret + insecure storage** findings, **AI** summarises
   (beats 2, 5).
5. The **root/emulator gate** is bypassed with a Frida detection script (beat 4).
6. The **automation engine** replays the login hands-free (beat 6); the **WS telemetry** decodes in
   the frames panel (beat 7); the **AI agent** narrates it over MCP.

## Testing

- **API:** unit tests (endpoints return the expected shapes; WS emits frames) — Vitest.
- **App:** minimal instrumented/Robolectric tests for the login flow + that the gate triggers on an
  emulator and the pinner is wired. Kept light; the app's *point* is to be exercised by DarkRide.
- **Integration (later, in DarkRide):** the Playground becomes the target for DarkRide's emulator +
  capture + Frida E2E, and for the `demo/` recording harness — replacing the Allsafe placeholder.
- **No eval lane** — deterministic app + API.

## Build & publish

- App: Gradle → `playground-release.apk`, published on the repo's GitHub Releases (like Allsafe), with
  a `fetch-playground.sh` in DarkRide's `demo/` mirroring `fetch-allsafe.sh`.
- API: a small Docker image + `docker compose up`; also `npm start` for the bare server.
- License: deliberately-vulnerable, clearly labelled "for authorised testing / demos only."

## Non-goals / deferred

- Broad OWASP MASVS coverage (this is a demo target, not a full training range).
- Flutter/RN variants (later, to demo those analysis paths).
- iOS target (DarkRide's iOS support is capture-only today).
- A public hosted API (bundled-local first; hosting is a trivial follow-on).
- Raw-TCP/MQTT protocol demo (WS-only for v1, matching today's decoder support).

## Review flags (decide differently any time)

1. New repo vs monorepo. 2. Bundled-local API vs hosted. 3. Kotlin vs Flutter/RN. 4. Curated vs broad.
