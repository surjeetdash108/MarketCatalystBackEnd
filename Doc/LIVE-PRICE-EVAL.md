# Live price: our pipeline vs TradingView widget

An evaluation surface on the **Search** screen (`/menu/stock`) rendering both approaches side by side, so the choice can be made from observed behaviour rather than documentation.

## How to run it

```bash
# 1. backend (holds the Polygon key and the single upstream socket)
cd MarketCatalystBackEnd && npm run start:dev     # :4100

# 2. frontend
cd MarketCatalystUI && npm run dev                # :3000
```

Open **http://localhost:3000/menu/stock**. Both panels track whichever symbol is selected.

Requires the market to be open (09:30–16:00 ET) for ticks to flow. Outside those hours the left panel shows a "no tick for Ns" notice rather than pretending to be live.

## Architecture (side 1)

```
Polygon delayed WS ──► NestJS PolygonLiveService ──► SSE ──► React
  wss://delayed          one socket, ref-counted     /live/stream   useLiveQuote
  .polygon.io/stocks     per ticker                                 recomputes all
  channel A (per-sec)                                               derived values
```

**The browser never contacts Polygon.** The API key stays in the backend; the client opens an `EventSource` against our own origin. A key shipped to the browser is readable by anyone with devtools — there is no way to hide it there.

| File | Role |
|---|---|
| `src/live/polygon-live.service.ts` | Upstream WS, auth, ref-counted subscribe/unsubscribe, reconnect with capped backoff |
| `src/live/live.controller.ts` | `GET /live/stream?ticker=AAPL` → SSE (`snapshot`, `status`, `tick`) |
| `app/iq/hooks/useLiveQuote.ts` | EventSource client + all derived metrics |
| `app/iq/live-compare.tsx` | Both panels |

Derived on every tick: change, % change, session high/low, range position, session VWAP, premium/discount to VWAP, accumulated volume, tick count, tick rate, direction, **feed lag**, time since last tick.

## Verified plan entitlements (2026-07-20, live probes)

| Cluster / channel | Result |
|---|---|
| `wss://socket.polygon.io/stocks` (real-time) | ❌ `"You don't have access real-time data"` |
| `wss://delayed.polygon.io/stocks` — `A` (per-second aggs) | ✅ authorized, streaming |
| `wss://delayed.polygon.io/stocks` — `AM` (per-minute aggs) | ✅ authorized |
| `wss://delayed.polygon.io/stocks` — `T` (trades) | ❌ `"not authorized"` |
| `wss://delayed.polygon.io/stocks` — `Q` (quotes) | ❌ `"not authorized"` |

**Measured feed lag: ~903 s ≈ 15.05 min**, from a captured tick — `at` 1784557060000 vs `receivedAt` 1784557963191. That is the plan's delay, not network latency. The UI shows this figure live.

## What to compare

1. **Price gap.** Left is ~15 min behind; TradingView is at or near real-time. During a quiet tape the two look identical — during a fast move they diverge visibly. That divergence is the whole decision.
2. **Update cadence.** Left updates ~1×/sec while the market is open.
3. **Whether the data is *usable*.** The left panel's numbers are in your app's memory and can drive the screener, RS rating, alerts and Firestore writes. TradingView's numbers cannot be read by your code at all — the widget is a sealed iframe.
4. **Third-party dependency.** If the TradingView script is blocked (ad-blocker, CSP), its panel shows a load-failure notice. The left panel depends only on your own backend.

## Trade-offs

| | Our pipeline | TradingView widget |
|---|---|---|
| Latency | ~15 min delayed | real-time |
| Data reusable in your code | ✅ yes | ❌ no |
| Branding | yours | TradingView's |
| Effort to ship | backend + frontend (built) | drop in a script |
| Cost | current plan | free to embed |
| Infra | needs an always-on process | none |
| Licensing | your Polygon agreement | TradingView ToS; no redistribution |

## Blocker before this ships

**Cloud Run scale-to-zero cannot hold a WebSocket.** Production runs with no warm instance between Cloud Scheduler firings, and Cloud Run caps a connection at 60 minutes. As built this works locally; in production it needs `min-instances=1` plus reconnect-on-cap handling (backoff is already implemented).

If ~15-minute-delayed data is acceptable, **polling the REST snapshot every 15–30 s is materially simpler** and needs no warm instance — the data is equally stale either way. The WebSocket only earns its complexity alongside a real-time plan.

## Local `.env`

The backend needs `POLYGON_API_KEY` and `POLYGON_API_BASE_URL=https://api.massive.com`. `.env` is gitignored; it was populated from Secret Manager. `NEXT_PUBLIC_BACKEND_URL=http://localhost:4100` is set in the UI's `.env.local` — it holds no key, only a URL.
