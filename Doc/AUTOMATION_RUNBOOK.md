# MarketCatalyst Automated Publishing Runbook

This runbook documents the daily automated publishing jobs for MarketCatalyst:
1. **Morning Pre-Market Intelligence Briefing** (7:35 AM CST / 8:35 AM EST)
2. **Evening End-Of-Day (EOD) Market Recap** (3:15 PM CST / 4:15 PM EST)

---

## 1. Automated Schedule Overview

| Job | Trigger / Schedule | Timezone | Post Type / Zone | Output Format | Purpose |
|---|---|---|---|---|---|
| **Pre-Market Post** (`premarket-post`) | `35 7 * * 1-5` (7:35 AM CT) | `America/Chicago` | `news` (Kick: *Markets*) | HTML (`#mc-post-doc`) | Movers, Key Points, 7:30 AM CT macro actuals, non-predictive scenarios, earnings on deck. |
| **EOD Market Recap** (`eod-recap`) | `15 16 * * 1-5` (4:15 PM ET / 3:15 PM CT) | `America/New_York` | `recap` (Kick: *Recap*) | HTML (`#mc-post-doc`) | Comprehensive institutional recap of market close across 16 ETFs, benchmarks, sectors, macro, movers. |

Both jobs skip weekends (Saturday/Sunday) and NYSE holidays automatically.

---

## 2. How to Manually Run via CLI (Terminal)

Both jobs have dedicated npm scripts in `MarketCatalystBackEnd/package.json`.

### A. Morning Pre-Market Automation

```bash
cd MarketCatalystBackEnd

# Standard run (respects weekday/holiday/already-published gates):
npm run post:premarket

# Force run (bypasses weekend/holiday/idempotency gates for testing):
npm run post:premarket -- --force
```

Alternatively via direct `ts-node`:
```bash
FORCE_RUN=true npx ts-node --transpile-only scripts/run-premarket-post.ts
```

### B. Evening EOD Market Recap Automation

```bash
cd MarketCatalystBackEnd

# Standard run (respects weekday/holiday/already-published gates):
npm run post:eod-recap

# Force run (bypasses weekend/holiday/idempotency gates for testing):
npm run post:eod-recap -- --force
```

Alternatively via direct `ts-node`:
```bash
FORCE_RUN=true npx ts-node --transpile-only scripts/run-eod-recap.ts
```

---

## 3. How to Trigger via HTTP API

If the backend server is running, authenticated administrators can trigger either job via `SyncController`:

```bash
# 1. Trigger Morning Pre-Market Post
curl -X POST https://api.marketcatalyst.ai/sync/premarket-post/run \
  -H "Authorization: Bearer <ADMIN_ID_TOKEN>"

# 2. Trigger Evening EOD Market Recap
curl -X POST https://api.marketcatalyst.ai/sync/eod-recap/run \
  -H "Authorization: Bearer <ADMIN_ID_TOKEN>"
```

To check job sync status:
```bash
curl https://api.marketcatalyst.ai/sync/premarket-post/status
curl https://api.marketcatalyst.ai/sync/eod-recap/status
```

---

## 4. Idempotency & Gates

Each job generates a unique idempotency key per trading day stored in `pdfName`:
* Pre-Market key: `premarket_post_YYYY-MM-DD`
* EOD Recap key: `eod_recap_YYYY-MM-DD`

If the job has already run for that day, it exits safely with `{ published: false, reason: "already-published" }`.
To bypass this check during manual verification, pass `--force` (which sets `FORCE_RUN=true`).

---

## 5. Storage & Public URLs

* **Database:** Stored in Firestore collection `posts`.
* **Slug Registration:** Claimed in Firestore collection `slugs/{slug}`.
* **Public URL Pattern:** `https://marketcatalyst.ai/posts/<slug>`

---

## 6. GCP Cloud Scheduler (Live Production Automation)

Both daily automations are registered in Google Cloud Scheduler under project `market-catalyst-502415` (`us-central1`):

| Scheduler Job ID | Schedule | Timezone | Trigger URI |
|---|---|---|---|
| `sync-premarket-post` | `35 7 * * 1-5` (7:35 AM CT) | `America/Chicago` | `.../sync/premarket-post/run` |
| `sync-eod-recap` | `15 16 * * 1-5` (4:15 PM ET / 3:15 PM CT) | `America/New_York` | `.../sync/eod-recap/run` |

### Check Scheduler Status:
```bash
gcloud scheduler jobs describe sync-premarket-post --location us-central1
gcloud scheduler jobs describe sync-eod-recap --location us-central1
```

### Manually Fire via Cloud Scheduler:
```bash
# Triggers the live Cloud Run worker via GCP
gcloud scheduler jobs run sync-premarket-post --location us-central1
gcloud scheduler jobs run sync-eod-recap --location us-central1
```

