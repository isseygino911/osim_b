---
name: refresh-snapshot
description: Fetch a fresh options chain, quotes, greeks, and candles for one ticker from Robinhood via MCP tools and push them to a running osim_b server's POST /api/snapshot. Use when asked to refresh options data, update the snapshot, or when GET /api/snapshot 404s asking to "ask Claude to refresh" data.
---

# Refresh snapshot

Fetches real market/options data from Robinhood (via `mcp__robinhood__*` tools) for one
underlying and pushes it to a running `osim_b` server, matching the shape
`controllers/snapshot.controller.js#postSnapshot` validates.

## Arguments

Parse the invocation arguments as: `TICKER` (default `QQQ`), `SERVER_URL` (default
`http://localhost:8787`). Both are optional and positional, e.g. `/refresh-snapshot SPY
http://localhost:9000`.

## Procedure

1. **Underlying quote** — `mcp__robinhood__get_equity_quotes(symbols=[TICKER])`. Take
   `price` from whichever of `quote.last_trade_price` / `quote.last_non_reg_trade_price` has
   the more recent timestamp; take `priorClose` from `close.price` (fallback
   `quote.previous_close` if `close` is missing).

2. **Chain lookup** — `mcp__robinhood__get_option_chains(underlying_symbol=TICKER)`. Take the
   chain `id` and the full `expiration_dates` list.

3. **Pick expirations** — keep only dates **3–15 calendar days out** from today. This covers
   `services/strategy.service.js`'s `pickExpiration` window (3–10 days) with margin, and keeps
   the fetch bounded — do not pull every expiration on the chain.

4. **Instruments per expiration** — for each kept expiration, call
   `mcp__robinhood__get_option_instruments(chain_id, expiration_dates=[date])`, following the
   `next` cursor to page through all results. Keep only strikes within roughly **±15% of
   spot** (covers the strategy's `targetDelta: 0.4` sweet spot with room either side) — discard
   the rest before the next step so quote-fetching stays cheap.

5. **Quotes** — batch the kept instrument IDs through
   `mcp__robinhood__get_option_quotes(instrument_ids=[...])` in groups of **≤20 IDs per call**.

6. **Candles** — `mcp__robinhood__get_equity_historicals(symbols=[TICKER], interval="day",
   start_time=<~90 days ago, ISO date>)`.

7. **Assemble** the exact JSON shape `postSnapshot` expects:
   ```json
   {
     "schemaVersion": 1,
     "underlying": { "symbol": "QQQ", "price": 684.22, "priorClose": 691.96 },
     "expirations": ["2026-07-31", "2026-08-03", "..."],
     "chains": {
       "2026-07-31": {
         "strikes": [
           {
             "strike": 680,
             "call": { "bid": 12.1, "ask": 12.4, "mark": 12.25, "iv": 0.31, "delta": 0.55, "gamma": 0.02, "theta": -0.18, "vega": 0.35, "rho": 0.09, "openInterest": 420, "volume": 88 },
             "put":  { "bid": 8.0,  "ask": 8.3,  "mark": 8.15,  "iv": 0.29, "delta": -0.45, "gamma": 0.02, "theta": -0.16, "vega": 0.34, "rho": -0.07, "openInterest": 310, "volume": 55 }
           }
         ]
       }
     },
     "candles": [
       { "t": "2026-04-27", "open": 640.1, "high": 645.2, "low": 638.0, "close": 643.5, "volume": 32000000 }
     ],
     "riskFreeRate": 0.04,
     "dividendYield": 0.006
   }
   ```
   Field mapping from `get_option_quotes` results: `bid_price → bid`, `ask_price → ask`,
   `mark_price → mark`, `implied_volatility → iv`, `open_interest → openInterest`;
   `delta`/`gamma`/`theta`/`vega`/`rho`/`volume` pass through as-is (all are strings in the API
   response — convert to numbers). `dividendYield: 0.006` is QQQ's trailing yield
   (`DEFAULT_DIVIDEND_YIELD` in `services/greeks.service.js`) — use a ticker-appropriate value
   for other underlyings, or omit the field and let the backend fall back to its default.

8. **Push** — `POST ${SERVER_URL}/api/snapshot` with that JSON body (`Content-Type:
   application/json`). If a `SNAPSHOT_TOKEN` is configured for this caller, include header
   `X-Snapshot-Token: <token>`. Confirm the response is `{ "ok": true }`; report the ticker and
   number of expirations/strikes pushed.

## Notes

- This is a periodic-refresh model, not streaming — there is no push/subscribe tool for
  Robinhood options data. Don't over-poll: each run costs roughly a dozen tool calls (chain +
  paginated instruments + batched quotes + historicals), so a 5–15 minute cadence is reasonable;
  1–2 minutes burns Robinhood API calls and Claude usage for no real benefit.
- If `GET ${SERVER_URL}/api/snapshot` isn't reachable, the target server likely isn't running —
  report that rather than retrying blindly.

## Automating it locally

The `osim_b` server and its Robinhood-connected Claude CLI must run on the **same machine** —
a cloud-scheduled trigger can't reach your machine's `localhost:8787`. Use an OS-level
scheduler (cron/launchd/Task Scheduler) to run the Claude CLI headlessly during market hours,
e.g. every 5 minutes, 9am–5pm ET, weekdays:

```
*/5 9-17 * * 1-5  claude -p "/refresh-snapshot QQQ" --allowedTools "mcp__robinhood__get_equity_quotes,mcp__robinhood__get_option_chains,mcp__robinhood__get_option_instruments,mcp__robinhood__get_option_quotes,mcp__robinhood__get_equity_historicals,Bash(curl:*)"
```

Headless (`-p`) runs can't interactively approve tool prompts, so the allowlist above (or
equivalent permission config) must be set ahead of time.
