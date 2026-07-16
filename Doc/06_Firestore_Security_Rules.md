# Market Intelligence Platform — Firestore Security Rules

v1.1 | June 2026

> **⚠ Implementation status (updated 2026-07-09, first noted 2026-07-05):**
> The tier-gating design below (Stripe custom claims, Free/Pro/Premium
> collection-level blocks, Fastify API middleware field-stripping, ECS
> workers) was never implemented — no subscription/billing system exists
> yet. The real `firestore.rules` (same folder) relaxes every originally
> tier-gated collection to `allow read: if isAuthenticated()`, with an
> explicit `// TODO(tier-gating)` comment marking where to restore this
> design once Stripe/subscriptions actually exist. All market-data writes
> are still server-only via the NestJS backend's Admin SDK
> (`backend/src/common/firebase-admin.provider.ts`), matching Principle 2
> below — that part is accurate. §3 (`stock_comments`) is accurate and
> implemented as described. The collection list is also incomplete — see
> the real `firestore.rules` for `tickers`, `market_movers_history`,
> `sectors_history`, and `market_indices_history`, none of which existed
> when this doc was written. `portfolios/{id}` also now carries a
> materialized `totalValue`/`dayPL`/`dayPLPct`/`holdingsCount`/`updatedAt`
> summary (2026-07-08), written client-side under the same existing
> `allow update: if isOwner(uid)` rule — no rule change was needed for it.
> A composite Firestore index (`firestore.indexes.json`, new as of
> 2026-07-08 — none existed before) is now deployed for `ohlcv_bars`
> (`ticker` + `barDate`), required by both the RS Rating job and the Stock
> Detail chart's live-history hook; deploy with
> `firebase deploy --only firestore:indexes`.

The deployable rules file is `firestore.rules` in this folder. Deploy with:

```bash
firebase deploy --only firestore:rules
```

---

## 1. Core Design Principles

**Principle 1 — Tier via custom claims, not Firestore reads.**
Subscription tier (`free` / `pro` / `premium`) is stored as a Firebase Auth custom claim on the user's ID token, not read from Firestore during rule evaluation. This means zero extra Firestore reads per request and instant evaluation.

The backend sets the claim whenever a Stripe webhook fires (subscription created, updated, or cancelled):

```js
// Node.js — called from Stripe webhook handler in Fastify
await admin.auth().setCustomUserClaims(uid, { tier: 'pro' });
```

The client must refresh its token after an upgrade for the new claim to take effect:
```js
// React — force token refresh after Stripe checkout success
await firebase.auth().currentUser.getIdToken(/* forceRefresh */ true);
```

**Principle 2 — All market data is server-write-only.**
Every market data collection (`news`, `earnings_events`, `analyst_actions`, etc.) has `allow write: if false`. ECS workers use Firebase Admin SDK, which bypasses security rules entirely — so workers write freely. Clients can never write to these collections, even if they craft a direct Firestore SDK call.

**Principle 3 — User data is uid-scoped.**
All user sub-collections (`portfolios`, `watchlists`, `alerts`, `notifications`) are readable and writable only by the owning user. No user can read another user's data.

**Principle 4 — User-generated content (stock_comments) is user-scoped.**
The `stock_comments` collection stores user notes attached to stock charts. Each document has a `uid` field. Users can only read/write/delete their own notes. Other users cannot read another user's notes.

**Principle 5 — Field-level gating stays at the API layer.**
Firestore rules are all-or-nothing per document. They cannot strip individual fields before returning a document. Tier-gated fields (e.g. `aiNote` on analyst actions for Pro+ only) are stripped by the Fastify API middleware before the response reaches the client. Direct Firestore SDK reads from the client are not supported for field-level gates.

---

## 2. Collection Access Matrix

| Collection | Free | Pro | Premium | Write |
|---|---|---|---|---|
| `companies` | ✅ Read | ✅ Read | ✅ Read | Server only |
| `earnings_events` | ✅ Read | ✅ Read | ✅ Read | Server only |
| `earnings_summaries` | ❌ | ✅ Read | ✅ Read | Server only |
| `news` | ✅ Read | ✅ Read | ✅ Read | Server only |
| `analyst_actions` | ✅ Read (no AI note) | ✅ Read (full) | ✅ Read (full) | Server only |
| `macro_events` | ✅ Read | ✅ Read | ✅ Read | Server only |
| `market_movers` | ✅ Read | ✅ Read | ✅ Read | Server only |
| `options_flow` | ❌ | ✅ Read | ✅ Read | Server only |
| `block_trades` | ❌ | ✅ Read | ✅ Read | Server only |
| `fund_holdings` | ❌ | ✅ Read | ✅ Read | Server only |
| `story_stocks` | ❌ | ❌ | ✅ Read | Server only |
| `recaps` | ❌ | ✅ Read | ✅ Read | Server only |
| `stock_comments` | Owner only | Owner only | Owner only | Owner (authenticated) |
| `users/{uid}` | Owner only | Owner only | Owner only | Owner + server |
| `settings/{uid}` | Owner only | Owner only | Owner only | Owner |
| `users/{uid}/portfolios` | Owner only | Owner only | Owner only | Owner |
| `users/{uid}/watchlists` | Owner only | Owner only | Owner only | Owner |
| `users/{uid}/alerts` | Owner only | Owner only | Owner only | Owner |
| `users/{uid}/notifications` | Owner (read/delete/mark-read) | Same | Same | Server only |

---

## 3. stock_comments Collection

The `stock_comments` collection stores user notes on stock charts, written from the Stock Detail page (`screens/stock.tsx`) using the Firebase client SDK.

### Schema
```
Collection: stock_comments
Document ID: auto-generated

{
  uid:       string,     // Firebase Auth user ID
  sym:       string,     // stock ticker (e.g. "NVDA")
  name:      string,     // company name (e.g. "NVIDIA Corp.")
  comment:   string,     // note text entered by user
  createdAt: Timestamp   // Firestore server timestamp
}
```

### Rule design
```js
// stock_comments: users can only read/write/delete their own notes
match /stock_comments/{docId} {
  allow read, delete: if request.auth != null
                     && resource.data.uid == request.auth.uid;

  allow create: if request.auth != null
               && request.resource.data.uid == request.auth.uid
               && request.resource.data.comment is string
               && request.resource.data.comment.size() <= 2000
               && request.resource.data.sym is string;

  allow update: if false;  // notes are immutable — delete and re-create to edit
}
```

### Firestore queries used
```ts
// Load notes for current user + ticker
const q = query(
  collection(db, 'stock_comments'),
  where('uid', '==', currentUser.uid),
  where('sym', '==', sym),
  orderBy('createdAt', 'asc')
);

// Save a note
await addDoc(collection(db, 'stock_comments'), {
  uid: currentUser.uid,
  sym,
  name,
  comment,
  createdAt: Timestamp.now(),
});

// Delete a note
await deleteDoc(doc(db, 'stock_comments', noteId));
```

### Composite index required
```json
{
  "collectionGroup": "stock_comments",
  "fields": [
    { "fieldPath": "uid",  "order": "ASCENDING" },
    { "fieldPath": "sym",  "order": "ASCENDING" },
    { "fieldPath": "createdAt", "order": "ASCENDING" }
  ]
}
```

---

## 4. Subscription Tier Gating Details

### What's gated at the rules level (collection-level block)

These collections return a `permission-denied` error to clients without the right tier:

- `earnings_summaries` — requires Pro+
- `options_flow` — requires Pro+
- `block_trades` — requires Pro+
- `fund_holdings` (+ sub-collections) — requires Pro+
- `recaps` — requires Pro+
- `story_stocks` — requires Premium only

### What's gated at the API middleware level (field stripping)

These collections are readable by all tiers but the API strips restricted fields before returning the response:

| Collection | Restricted Field | Required Tier |
|---|---|---|
| `analyst_actions` | `aiNote` | Pro+ |
| `news` | `body` (full text) | Pro+ (basic summary free) |
| `earnings_events` | `transcriptUrl` | Pro+ |

The client always calls the REST API (`/api/v1/...`), not Firestore directly, for these endpoints. Direct Firestore SDK reads are only used for user-owned data.

### What's gated at the API middleware level (watchlist count)

- Free tier: max 5 tickers per watchlist. Firestore rules cannot count sub-collection documents, so this is enforced in the `POST /api/v1/watchlists/:id/tickers` handler.

---

## 5. Notifications: Write Rules

Notifications are created exclusively by the alert engine (server, Admin SDK). Clients can:
- **Read** their notifications
- **Mark as read** (update `read` field to `true` only — no other field changes allowed)
- **Delete** a notification (dismiss)

They cannot create notifications directly. The rule enforces this precisely:

```js
allow update: if isOwner(uid)
              && request.resource.data.diff(resource.data).affectedKeys().hasOnly(['read'])
              && request.resource.data.read == true;
```

---

## 6. User Document: Tier Protection

The `users/{uid}` document holds the `tier` field, which must only be updated by the server (Stripe webhook → Admin SDK). The `noTierOrUidChange()` helper blocks any client update that tries to modify `tier`, `uid`, `stripeCustomerId`, or `stripeSubId`:

```js
function noTierOrUidChange() {
  return !request.resource.data.diff(resource.data).affectedKeys()
           .hasAny(['uid', 'tier', 'stripeCustomerId', 'stripeSubId']);
}
```

This means a client cannot self-upgrade by writing `tier: 'premium'` directly to Firestore.

---

## 7. Deployment & Testing

**Deploy:**
```bash
firebase deploy --only firestore:rules
```

**Test rules locally with the Emulator:**
```bash
firebase emulators:start --only firestore
```

**Run the rules test suite** (add to `firestore.test.ts`):

Test cases to cover:
- Unauthenticated user cannot read any collection
- Free user cannot read `earnings_summaries`, `options_flow`, `block_trades`, `fund_holdings`, `recaps`
- Free user cannot read `story_stocks`
- Pro user can read `earnings_summaries`, `options_flow`, `block_trades`, `fund_holdings`, `recaps`
- Pro user cannot read `story_stocks`
- Premium user can read `story_stocks`
- User A cannot read `users/userB/portfolios`
- Client cannot write to `news`, `earnings_events`, or any market data collection
- Client cannot set `tier: 'premium'` on their own user document
- Client can mark notification as read but cannot change any other field
- Client cannot create a notification document
- User can create a `stock_comments` document with their own uid
- User cannot create a `stock_comments` document with another user's uid
- User can read their own `stock_comments` notes
- User cannot read another user's `stock_comments` notes
- User can delete their own `stock_comments` note
- User cannot update a `stock_comments` note (notes are immutable)

**Testing a tier upgrade flow end-to-end:**
1. Stripe webhook fires → backend calls `admin.auth().setCustomUserClaims(uid, { tier: 'pro' })`
2. Client calls `getIdToken(true)` to force-refresh
3. Subsequent Firestore reads to `earnings_summaries` now succeed

---

## 8. Firestore Indexes (firestore.indexes.json)

Define these composite indexes alongside the rules deployment:

```json
{
  "indexes": [
    { "collectionGroup": "news",             "fields": [{ "fieldPath": "tickers",    "arrayConfig": "CONTAINS" }, { "fieldPath": "publishedAt", "order": "DESCENDING" }] },
    { "collectionGroup": "news",             "fields": [{ "fieldPath": "categories", "arrayConfig": "CONTAINS" }, { "fieldPath": "publishedAt", "order": "DESCENDING" }] },
    { "collectionGroup": "analyst_actions",  "fields": [{ "fieldPath": "ticker",     "order": "ASCENDING"  }, { "fieldPath": "publishedAt",  "order": "DESCENDING" }] },
    { "collectionGroup": "analyst_actions",  "fields": [{ "fieldPath": "actionType", "order": "ASCENDING"  }, { "fieldPath": "publishedAt",  "order": "DESCENDING" }] },
    { "collectionGroup": "earnings_events",  "fields": [{ "fieldPath": "reportDate", "order": "ASCENDING"  }, { "fieldPath": "session",      "order": "ASCENDING"  }] },
    { "collectionGroup": "earnings_events",  "fields": [{ "fieldPath": "reportDate", "order": "ASCENDING"  }, { "fieldPath": "resultPosted", "order": "ASCENDING"  }] },
    { "collectionGroup": "options_flow",     "fields": [{ "fieldPath": "ticker",     "order": "ASCENDING"  }, { "fieldPath": "tradeTime",    "order": "DESCENDING" }] },
    { "collectionGroup": "options_flow",     "fields": [{ "fieldPath": "isUnusual",  "order": "ASCENDING"  }, { "fieldPath": "tradeTime",    "order": "DESCENDING" }] },
    { "collectionGroup": "block_trades",     "fields": [{ "fieldPath": "ticker",     "order": "ASCENDING"  }, { "fieldPath": "tradeTime",    "order": "DESCENDING" }] },
    { "collectionGroup": "market_movers",    "fields": [{ "fieldPath": "date",       "order": "DESCENDING" }, { "fieldPath": "session",      "order": "ASCENDING"  }, { "fieldPath": "type", "order": "ASCENDING" }] },
    { "collectionGroup": "story_stocks",     "fields": [{ "fieldPath": "isActive",   "order": "ASCENDING"  }, { "fieldPath": "publishedAt",  "order": "DESCENDING" }] },
    { "collectionGroup": "companies",        "fields": [{ "fieldPath": "sector",     "order": "ASCENDING"  }, { "fieldPath": "marketCap",    "order": "DESCENDING" }] },
    { "collectionGroup": "companies",        "fields": [{ "fieldPath": "industryGroup", "order": "ASCENDING" }, { "fieldPath": "updatedAt",  "order": "DESCENDING" }] },
    { "collectionGroup": "stock_comments",   "fields": [{ "fieldPath": "uid",        "order": "ASCENDING"  }, { "fieldPath": "sym",          "order": "ASCENDING"  }, { "fieldPath": "createdAt", "order": "ASCENDING" }] }
  ]
}
```
