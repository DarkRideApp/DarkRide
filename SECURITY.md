# Security Policy

## Security Model

DarkRide ships with **built-in multi-user authentication**:

- **Passwords** — argon2id hashing
- **Sessions** — opaque session cookies, CSRF-protected mutations
- **Scopes** — 23 area-level permissions, intersected per session (`apiKey.scopes ∩ user.scopes`)
- **API keys** — long-lived, scope-restricted, revocable
- **OAuth providers (optional)** — Google, GitHub, generic OIDC
- **Bootstrap** — first boot prints a one-time claim URL to create the admin account, or set `DARKRIDE_BOOTSTRAP_ADMIN_USERNAME` + `DARKRIDE_BOOTSTRAP_ADMIN_PASSWORD` for unattended setup. After the first admin exists, both env vars are ignored.

By default, DarkRide binds to `127.0.0.1` (localhost only). For local-only use, the auth system is a defense-in-depth layer — your OS user is the primary boundary.

## Binding to a non-localhost interface

If you set `HOST=0.0.0.0`, `HOST=::`, or any LAN-reachable address, complete this checklist first:

- [ ] **First-boot admin claim is complete.** The bootstrap-token UI must have been used (or `DARKRIDE_BOOTSTRAP_ADMIN_*` env vars set) before exposing the server. An unclaimed bootstrap token is a one-step admin grant for anyone who can reach the URL.
- [ ] **Admin password is strong.** Argon2id buys you a lot, but offline-cracking a weak password is still feasible.
- [ ] **No default API keys.** Audit `Settings → API Keys` and revoke anything you don't recognize.
- [ ] **TLS via a reverse proxy.** DarkRide serves plain HTTP. Put nginx, Caddy, or Traefik in front for TLS, rate-limiting, and request-size caps.
- [ ] **You understand the known gaps below.**

## Known gaps (as of 2026-05-17)

These are real and exist today. Treat them as "auth is there, but don't lean on it alone":

- **Plaintext secrets at rest.** `credentials.password` and `ai_providers.api_key` are stored unencrypted in `darkride.db`. Treat the database file as sensitive — encrypted disk + filesystem permissions are your protection. Accepted for launch.
- **No CSP / Helmet security headers.** Plugin pages and Monaco share the same origin as core; XSS in any plugin pivots trivially. Accepted for launch — sandboxing plugin UIs is a post-launch project.
- **No upgrade rollback flow.** Drizzle migrations apply on boot transactionally per migration, but if a botched migration ships you can't `rollback` to the previous schema. The daily cloud backup is your recovery path — if you operate a critical instance, run a manual backup before upgrades. Operational note, not a code fix.

### WebSocket Origin allowlist

The WebSocket endpoint at `/ws` enforces an Origin allowlist to defend against CSWSH (cross-site WebSocket hijacking — the WS analogue of CSRF). Default allowlist covers same-host + the Vite dev port (5173). Extend it via `WEBSOCKET_ALLOWED_ORIGINS=https://my.reverse.proxy,https://other.origin` (comma-separated). Non-browser callers (curl, scripts) work unchanged — they don't send `Origin` and are exempted from the check, which is safe because cookies don't auto-attach in that context.

If you need to expose DarkRide to a non-trusted network, **strongly consider putting a reverse proxy in front anyway** — auth + TLS + rate-limiting + path-level restrictions buy real defense-in-depth on top of the in-app auth.

## Threat Model

DarkRide is a reverse engineering toolkit. It's designed to:

- Control Android and iOS devices you own or have permission to test
- Intercept and modify network traffic on those devices (via user-installed TLS certs)
- Analyze APKs, including decompilation and dynamic instrumentation
- Automate interactions with apps

Running DarkRide does **not** require root on the host machine, but some features (WireGuard tunnel, device shell) need elevated privileges. Consult the docs for specifics.

## Reporting a Vulnerability

If you discover a security issue in DarkRide, please report it privately — **do not open a public GitHub issue**.

**Preferred channel:** GitHub's private vulnerability reporting — open `Security → Advisories → Report a vulnerability` on the repo page, or use the direct link [github.com/DarkRideApp/DarkRide/security/advisories/new](https://github.com/DarkRideApp/DarkRide/security/advisories/new). End-to-end encrypted, tracked in a dashboard, supports back-and-forth and embargoed disclosure timelines. Requires a GitHub account — same one you'd open a normal issue with.

**Fallback channel:** email **hello@darkride.app**. Plaintext SMTP, so don't send proof-of-concept exploit code; if the report itself is sensitive, use the GitHub channel above. We'll respond and pivot to GitHub Security Advisories from there for everything else.

Include in your report:
- A description of the vulnerability
- Steps to reproduce
- The version of DarkRide affected (commit SHA if built from source)
- Your assessment of the impact

We'll acknowledge within a few days, investigate, and coordinate a fix and disclosure timeline with you.

## Reverse Engineering Legality

See [LEGAL.md](LEGAL.md) for the authorized use disclaimer and notes on the legality of traffic interception, TLS bypass, and interoperability reverse engineering.

DarkRide is intended for **authorized** security testing, research, and analysis on devices you own or have explicit permission to test. Using it against systems without authorization may violate computer misuse laws in your jurisdiction.
