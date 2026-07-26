# Server conventions

Express 5, pure ESM (`"type": "module"`). Four-layer structure — keep new code in the right layer:

- `routes/` — `express.Router()` files, path→controller mapping only. No logic.
- `controllers/` — req/res handling. Every handler: `try { … } catch (e) { res.status(500).json({ error: e.message }) }`; validation failures via early `return res.status(400).json({ error: … })`.
- `services/` — business logic. May import models and other services. Never import express or touch req/res.
- `models/` — the ONLY layer that touches `fs` or defines data-file paths (data lives in `../data/` at the repo root).
- `index.js` — bootstrap only: middleware, mount routers, listen, start the autopilot loop.

File naming: `<entity>.routes.js`, `<entity>.controller.js`, `<entity>.service.js`, `<entity>.model.js`. Model exports are entity-qualified (`readSnapshot`, `writeAutopilotState`), never generic (`readState`).

## Style

- Named exports at declaration (`export function` / `export const`); no default exports.
- Relative imports carry explicit `.js` extensions; node builtins & 3rd-party first, then local; alphabetize named-import members.
- Double quotes, semicolons always, 2-space indent, trailing commas in multiline literals; long lines up to ~150 tolerated.
- `camelCase` variables; `SCREAMING_SNAKE` module-level constants (stateful client instances like `parser` stay camelCase); camelCase JSON keys; kebab-case multiword route paths (`/api/autopilot/run-now`).
- async/await only — no `.then()` chains (inline `.catch(() => fallback)` expressions are fine).
- Bare `catch {` when the error binding is unused; unused params prefixed `_` (`_req`).
- Logging with bracketed tags: `console.log("[server] …")`, `console.error("[autopilot] …")`.
- `//` why-comments; no JSDoc.

## Behavior notes

- Data files are per-symbol: `data/snapshots/<SYM>.json`, `data/autopilot/<SYM>.json`, with
  the active symbol in `data/settings.json`. Symbols are validated by `symbol.service.js`
  in controllers and re-asserted in models before ever becoming a path segment.
- `GET /api/snapshot` is a raw-text passthrough of the symbol's snapshot file — do not parse+re-stringify.
- The snapshot reader is dependency-injected into the autopilot service (passed in from callers), not imported by it.
- `strategy.service.js` and `indicators.service.js` are pure/I-O-free — keep them that way.
- Tests use built-in `node:test` (`npm test` → `node --test`, files in `test/*.test.js`). Pure services (blackScholes, greeks, strategy) get unit tests; controllers/routes are verified by smoke-testing the endpoints on port 8787.
