# Contributing to DarkRide

Thank you for your interest in contributing. This guide covers development setup, coding guidelines, and the PR process. By participating you agree to the project's [Code of Conduct](CODE_OF_CONDUCT.md).

## Development Setup

### Prerequisites

- Node.js 22+ (24 recommended)
- Python 3.12+ (3.13 recommended — required for mitmproxy 12.x)
- ADB (for Android device testing)

#### Platform Notes

**Linux (recommended):** All features work out of the box. Install `adb` via your package manager (`apt install adb` / `pacman -S android-tools`).

**macOS:** Install ADB via Homebrew (`brew install android-platform-tools`). WireGuard kernel module is not available — traffic capture uses userspace WireGuard which works but is slower. Native `node-pty` and `better-sqlite3` compile with Xcode command-line tools (`xcode-select --install`).

**Windows:** Install ADB via [Android SDK Platform Tools](https://developer.android.com/tools/releases/platform-tools). Use PowerShell or Git Bash. Native modules (`node-pty`, `better-sqlite3`) require Visual Studio Build Tools with the "Desktop development with C++" workload. Python venv: use `python -m venv .venv` and `.venv\Scripts\pip` instead of `.venv/bin/pip`.

### Getting Started

```bash
git clone https://github.com/DarkRideApp/DarkRide.git
cd DarkRide
npm install
npm run dev
```

The dev server creates the Python virtualenv at `.venv/` and installs `python/requirements.txt` automatically on first start — see `backend/services/python-bridge.ts` if you want to do it by hand. Python 3.12+ required.

### Running Tests

```bash
# Backend tests
npx vitest run

# Frontend tests
npx vitest run --config vitest.config.frontend.ts

# Plugin tests
npx vitest run plugins/

# Python tests
.venv/bin/python -m pytest python/ -v

# End-to-end tests (Playwright — spawns browser + real server)
npx playwright test

# TypeScript type checking
npx tsc --noEmit
```

## Code Style

- **TypeScript** throughout (backend, frontend, shared types)
- **React** with function components and hooks
- **Drizzle ORM** for database access (better-sqlite3)
- **Vitest** for testing (backend and frontend)
- Follow existing patterns in the codebase — consistency matters more than personal preference
- No unnecessary abstractions. Three similar lines of code is better than a premature abstraction
- Only add comments where the logic isn't self-evident

## Test-Driven Development

**Bug fixes must start with a failing test.** The process:

1. Write a test that reproduces the exact bug
2. Run it — confirm it **fails**
3. Implement the fix
4. Run it — confirm it **passes**
5. Commit test + fix together

**New features must have tests** covering the happy path, error cases, and edge cases.

**Test mocks must match reality.** If the API returns `{ data: { plugins: [...], darkrideVersion } }`, your test mock must use that exact shape — not a simplified `{ data: [...] }`. Mismatched mocks hide real bugs.

## Pull Request Process

1. **Branch** from `main` with a descriptive name (`feat/my-feature`, `fix/the-bug`)
2. **Write tests first** — bug fixes need a failing test, features need coverage
3. **Run the full test suite** before submitting — `npx vitest run && npx vitest run --config vitest.config.frontend.ts`
4. **Keep PRs focused** — one feature or fix per PR. Don't bundle unrelated changes
5. **Write a clear PR description** — what changed, why, and how to test it

### Commit Messages

Use conventional commits:

```
feat: add new feature
fix: correct the bug
refactor: restructure without behavior change
test: add or update tests
chore: maintenance tasks
docs: documentation updates
```

## Plugin Development

DarkRide has a plugin system for extending functionality. If your contribution adds a new feature area, consider building it as a plugin rather than modifying core.

See the [Plugin Authoring Guide](docs/plugins/README.md) for details.

## Contributor License Agreement

DarkRide ships dual-licensed (AGPL-3.0 + commercial), so every Pull Request needs a signed CLA before it can be merged. The first time you open a PR, a status check from [cla-assistant.io](https://cla-assistant.io/DarkRideApp/DarkRide) will prompt you to sign — one click, one time, covers all your future contributions.

- **Most contributors** sign the [Individual CLA](ICLA.md) via the bot.
- **Contributors whose employer owns their work** should arrange a [Corporate CLA](CCLA.md) (email **hello@darkride.app**) instead of / in addition to the individual one — the CCLA covers everyone on your company's Schedule A.
- **Edge cases** (tiny PRs, no CCLA process at your employer, etc.): email us and we'll find a way to take the contribution.

See [CLA.md](CLA.md) for the full landing-page explanation.

## Reporting Issues

- Search existing issues before opening a new one
- Include steps to reproduce, expected behavior, and actual behavior
- Include your Node.js version, OS, and device type if relevant
- Logs and screenshots are helpful

## Code of Conduct

Be respectful and constructive. We're building tools for security research — treat fellow contributors the way you'd want to be treated in a code review. Harassment, personal attacks, and unconstructive criticism are not tolerated.
