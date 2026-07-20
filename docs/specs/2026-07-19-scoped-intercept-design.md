# Scoped Interactive Intercept (match rules) — Design

Date: 2026-07-19
Branch: `feat/scoped-intercept`
Decisions (Cube): **multiple match rules**; prefill via **detail-panel "Intercept this host" + a scope/rules popover** (tree-host action deferred until #40 lands).

## Problem

Interactive intercept ("breakpoints") pauses **every** flow — unusable in practice. The backend
already matches a *single* `matchHostname`/`matchPath`/`matchMethod` glob, but the UI never sets it.
We want to intercept only specific requests, defined by a **list** of match rules.

## Model

A rule matches a flow when all of its set fields match; the armed config holds a **list** of rules
and a flow is held when it matches **any** rule (OR). An empty rule list means "match all" (today's
behavior), so arming with no rules is still a firehose — but the UI always arms with ≥1 rule.

```ts
interface InterceptMatchRule { hostname?: string|null; path?: string|null; method?: string|null } // globs for host/path
interface InterceptArmedConfig {
  enabled: boolean;
  phases: ('request'|'response')[];   // global, applies to all rules
  rules?: InterceptMatchRule[];       // NEW. match ANY. empty/absent => match all
  // legacy single-match fields kept for back-compat; used only when `rules` is absent
  matchHostname?: string|null; matchPath?: string|null; matchMethod?: string|null;
}
```

Phases stay global (a rule is a match filter, not a phase selector).

## Matching (three places, kept in lockstep)

1. **Python addon** `_hold_matches` (`mitmproxy_bridge.py`) — hot path, `fnmatch` globs. Factor
   `_rule_matches(flow, rule)`; `_hold_matches` = enabled + phase-in-phases + (rules: any rule
   matches; else legacy single-match; else True).
2. **JS mirror** `holdMatches` (`intercept-hold-store.ts`) — defensive server-side check, same logic
   with `globToRegExp`.
3. `setArmed` normalizes: drop rules with no fields; store `rules`.

## Backend

- `shared/types/websocket.ts`: add `InterceptMatchRule`, `rules?` on `InterceptArmedConfig`.
- `intercept-hold-store.ts`: `setArmed` accepts/normalizes `rules`; `holdMatches` rule-list logic;
  defaults/reset include `rules: []`.
- `intercept-live.ts`: POST destructures `rules`, passes to `setArmed`.
- The config-writer already serializes the whole config to JSON — `rules` rides along.

## Frontend

- `interceptArm.ts` (rules model): `armIntercept(ws, {rules, phases})`, `disarmIntercept(ws)`,
  `describeRule(rule)`, `describeArmed(config)` (summary line), `armedChipLabel(config)`
  (host for 1 rule, "N rules" for many, null when disarmed).
- `InterceptScopeEditor` popover: a list of rule rows (host glob / path glob / method select +
  remove), "Add rule", global Request/Response phase toggles, a plain-English summary, and
  Arm / Update / Disarm. Opened from a caret on the arm button.
- `InterceptArmControl`: stores the full config (from GET + `intercept-armed-changed`), renders a
  **scope chip** (`Intercept: *.stripe.com` / `Intercept: 3 rules`), and the caret to open the editor.
- **Detail panel**: an "Intercept host" action that appends a `{hostname}` rule to the current armed
  config (or arms fresh with it) — point-and-intercept from a request you just saw.

## Tests

- Python `test_mitmproxy_bridge.py`: `_hold_matches` with a rules list (any-match), empty rules
  (match all), legacy single-match still works, phase gating.
- `intercept-hold-store.test.ts`: `setArmed` normalizes rules; `holdMatches` any-rule / empty / legacy.
- `interceptArm.test.ts`: describe/label + `armIntercept` posts `rules`.
- `InterceptScopeEditor.test.tsx`: add/remove rule, summary text, Arm posts the rule list.
- Detail panel: "Intercept host" appends a host rule + arms.
- E2E: arm a host-scoped rule via the editor; confirm the armed chip shows the scope.

## Out of scope (flagged)
- Tree "Intercept this host" action (needs #40; small follow-up).
- Per-rule phases; response-status matching; saved rule presets.
