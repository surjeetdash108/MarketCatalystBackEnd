/**
 * Seeds a fully-populated TEST user for the normal (non-admin) user module, so
 * every user-facing screen has real data to render without clicking through the
 * whole product first.
 *
 * Writes exactly what the user-data controllers read (src/user-data/*):
 *
 *   Firebase Auth                                    password account + displayName
 *   users/{uid}                                      investor profile + subscription
 *   settings/{uid}                                   theme / font / alert toggle
 *   users/{uid}/watchlists/{id}                      two named lists
 *   users/{uid}/portfolios/default/holdings/{TICKER}  portfolio positions
 *   users/{uid}/notifications/{id}                   bell items (some unread)
 *   stock_comments/{auto}                            per-stock chart notes
 *   feature_requests/{auto}                          one submitted request
 *
 * Nothing here is an HTTP route and nothing grants admin: the admin role lives
 * in website_members (see MarketCatalystWebsite/scripts/seed-admin.ts) and is
 * never touched by this script.
 *
 * Usage (from MarketCatalystBackend):
 *   npm run seed:test-user
 *   npm run seed:test-user -- --email=qa1@marketcatalyst.test --plan=pro --reset
 *
 * Flags (all optional):
 *   --email=<address>     default test.user@marketcatalyst.test
 *   --password=<pw>       default TestUser@12345 (Firebase minimum is 6 chars)
 *   --plan=free|plus|pro  default free — the plan a real signup lands on
 *   --project=<id>        default FIREBASE_PROJECT_ID from .env
 *   --database=<id>       default FIRESTORE_DATABASE_ID from .env
 *   --reset               delete this user's existing seeded docs first, so a
 *                         re-run is a clean slate rather than a merge
 *
 * Re-runnable: without --reset every write is a merge/overwrite at a fixed doc
 * id, except stock_comments and feature_requests, which use auto-ids and would
 * duplicate — those are skipped when the user already has some.
 */
import "dotenv/config";
import { getApps, initializeApp, cert, applicationDefault } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, Firestore, Timestamp } from "firebase-admin/firestore";

function arg(name: string): string | undefined {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`));
  return found?.slice(name.length + 3);
}
const hasFlag = (name: string) => process.argv.includes(`--${name}`);

const EMAIL = arg("email") ?? "test.user@marketcatalyst.test";
const PASSWORD = arg("password") ?? "TestUser@12345";
const PLAN = (arg("plan") ?? "free").toLowerCase();
const PROJECT = arg("project") ?? process.env.FIREBASE_PROJECT_ID;
const DATABASE = arg("database") ?? process.env.FIRESTORE_DATABASE_ID ?? "";
const RESET = hasFlag("reset");

if (!PROJECT) {
  console.error("No project: pass --project=<id> or set FIREBASE_PROJECT_ID in .env.");
  process.exit(1);
}
if (!["free", "plus", "pro"].includes(PLAN)) {
  console.error(`--plan must be one of free|plus|pro (got "${PLAN}").`);
  process.exit(1);
}

function initApp() {
  if (getApps().length) return getApps()[0];
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (clientEmail && privateKey) {
    return initializeApp({
      credential: cert({ projectId: PROJECT, clientEmail, privateKey }),
      projectId: PROJECT,
    });
  }
  return initializeApp({ credential: applicationDefault(), projectId: PROJECT });
}

const app = initApp();
const auth = getAuth(app);
const useNamed = DATABASE !== "" && DATABASE !== "(default)";
const db: Firestore = useNamed ? getFirestore(app, DATABASE) : getFirestore(app);

/** ISO string N days in the past; a negative N is N days in the future. */
const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString();

// ── Seed payloads ──────────────────────────────────────────────────────────

/** Matches InvestorProfile in MarketCatalystUI/app/profile/profile-fields.tsx.
 *  Every option string below is one the dropdowns actually offer, so the
 *  profile screen renders a selected value rather than a blank select. */
const PROFILE = {
  profile_image: "",
  name: "Test Investor",
  email: EMAIL,
  mobileNumber: "+1 415 555 0142",
  age: "34",
  incomeRange: "$100,000 - $250,000",
  investmentExperience: "Intermediate",
  investmentGoals: "Wealth creation",
  riskTolerance: "Moderate",
  investmentHorizon: "5 - 10 years",
  currentPortfolioValue: "125000",
  preferredAssetClasses: ["Stocks", "Mutual Funds"],
};

/** Free keeps the free tier's own limits (5 tickers per watchlist, free
 *  entitlements). A paid plan gets a live, unexpired subscription ~11 months
 *  out so entitlement gating can be exercised without a billing flow —
 *  SubscriptionsService treats the date, not the stored status, as truth. */
const SUBSCRIPTION =
  PLAN === "free"
    ? {
        currentPlan: "free",
        subscriptionStatus: "NONE",
        subscriptionStartDate: null,
        subscriptionExpiryDate: null,
      }
    : {
        currentPlan: PLAN,
        subscriptionStatus: "ACTIVE",
        subscriptionStartDate: iso(30),
        subscriptionExpiryDate: iso(-335),
      };

/** The default list stays at 5 tickers — FREE_WATCHLIST_LIMIT in
 *  watchlist.controller.ts — so a free test account can still add and remove
 *  and see the cap message, rather than starting out already over it. */
const WATCHLISTS = [
  { id: "default", name: "My Watchlist", tickers: ["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL"] },
  { id: "tech-momentum", name: "Tech Momentum", tickers: ["AMD", "TSLA", "AVGO"] },
];

const HOLDINGS = [
  { ticker: "AAPL", shares: 40, positionSize: "Large", conviction: "High", costBasis: 178.42 },
  { ticker: "MSFT", shares: 15, positionSize: "Medium", conviction: "High", costBasis: 402.1 },
  { ticker: "NVDA", shares: 25, positionSize: "Large", conviction: "Medium", costBasis: 118.75 },
  { ticker: "JPM", shares: 20, positionSize: "Small", conviction: "Medium", costBasis: 210.3 },
  // No cost basis — exercises the "unrealized P&L hidden" branch.
  { ticker: "KO", shares: 60, positionSize: "Small", conviction: "Low", costBasis: null },
];

const NOTIFICATIONS = [
  {
    id: "seed-note-1",
    header: "Apple lifts services guidance for the December quarter",
    detail:
      "Management pointed to record App Store engagement and a faster-than-expected ramp in ad revenue.",
    tickers: ["AAPL"],
    direction: "positive",
    read: false,
    publishedAt: iso(0),
  },
  {
    id: "seed-note-2",
    header: "Nvidia supply commentary sends AI names lower",
    detail:
      "Channel checks suggest tighter allocation into the first half, pressuring the wider semi complex.",
    tickers: ["NVDA", "AMD"],
    direction: "negative",
    read: false,
    publishedAt: iso(1),
  },
  {
    id: "seed-note-3",
    header: "Microsoft closes its cloud infrastructure acquisition",
    detail: "Terms were not disclosed; the deal is not expected to be material to FY guidance.",
    tickers: ["MSFT"],
    direction: "neutral",
    read: true,
    publishedAt: iso(4),
  },
];

const STOCK_NOTES = [
  {
    sym: "AAPL",
    name: "Apple Inc.",
    comment: "Adding on any retest of the 200-day. Services margin is the whole thesis.",
  },
  {
    sym: "NVDA",
    name: "NVIDIA Corporation",
    comment: "Trimmed a third into strength. Revisit after the next print.",
  },
  {
    sym: "MSFT",
    name: "Microsoft Corporation",
    comment: "Core hold — watching Azure growth deceleration quarter over quarter.",
  },
];

const FEATURE_REQUEST =
  "Please let me set a price alert straight from the watchlist row instead of opening the stock page first.";

// ── Run ────────────────────────────────────────────────────────────────────

async function deleteCollection(path: string) {
  const snap = await db.collection(path).get();
  if (snap.empty) return;
  const batch = db.batch();
  snap.docs.forEach((d) => batch.delete(d.ref));
  await batch.commit();
}

async function deleteWhereUid(collection: string, uid: string) {
  const snap = await db.collection(collection).where("uid", "==", uid).get();
  if (snap.empty) return;
  const batch = db.batch();
  snap.docs.forEach((d) => batch.delete(d.ref));
  await batch.commit();
}

async function main() {
  console.log(`Project ${PROJECT}, database ${useNamed ? DATABASE : "(default)"}`);

  // 1. Auth account — created if absent; if it already exists the password is
  //    reset to the seed value so the credentials printed below always work.
  let user;
  try {
    user = await auth.getUserByEmail(EMAIL);
    await auth.updateUser(user.uid, {
      password: PASSWORD,
      displayName: PROFILE.name,
      emailVerified: true,
      disabled: false,
    });
    console.log(`Auth: reused ${user.uid} (password reset to the seed value)`);
  } catch {
    user = await auth.createUser({
      email: EMAIL,
      password: PASSWORD,
      displayName: PROFILE.name,
      emailVerified: true,
    });
    console.log(`Auth: created ${user.uid}`);
  }
  const uid = user.uid;

  if (RESET) {
    await Promise.all([
      deleteCollection(`users/${uid}/watchlists`),
      deleteCollection(`users/${uid}/portfolios/default/holdings`),
      deleteCollection(`users/${uid}/notifications`),
      deleteWhereUid("stock_comments", uid),
      deleteWhereUid("feature_requests", uid),
    ]);
    console.log("Reset: cleared existing seeded documents");
  }

  // 2. Profile + subscription at users/{uid} — read by ProfileController and
  //    SubscriptionsService.forUser().
  const existing = await db.doc(`users/${uid}`).get();
  await db.doc(`users/${uid}`).set(
    {
      ...PROFILE,
      ...SUBSCRIPTION,
      tier: PLAN,
      /** Marks the account as seeded, so it is greppable and safe to purge. */
      seededTestAccount: true,
      createdAt: existing.get("createdAt") ?? iso(45),
      updatedAt: new Date().toISOString(),
    },
    { merge: true },
  );
  console.log(`users/${uid}: profile + ${PLAN} subscription`);

  // 3. settings/{uid} — SettingsController.
  await db.doc(`settings/${uid}`).set({ alert: true, darkMode: true, font: "default" }, { merge: true });
  console.log(`settings/${uid}: theme + alert toggle`);

  // 4. Watchlists.
  for (const wl of WATCHLISTS) {
    const ref = db.doc(`users/${uid}/watchlists/${wl.id}`);
    const prior = await ref.get();
    await ref.set(
      {
        name: wl.name,
        tickers: wl.tickers,
        createdAt: prior.get("createdAt") ?? iso(40),
        updatedAt: new Date().toISOString(),
      },
      { merge: true },
    );
  }
  console.log(`watchlists: ${WATCHLISTS.map((w) => `${w.name} (${w.tickers.length})`).join(", ")}`);

  // 5. Portfolio holdings — the doc id IS the ticker, matching PortfolioController.
  const holdingsBatch = db.batch();
  for (const h of HOLDINGS) {
    holdingsBatch.set(db.doc(`users/${uid}/portfolios/default/holdings/${h.ticker}`), {
      ...h,
      addedAt: iso(20),
    });
  }
  await holdingsBatch.commit();
  console.log(`portfolio: ${HOLDINGS.length} holdings`);

  // 6. Notification bell items, shaped like NotificationsService.publish() writes.
  const notifBatch = db.batch();
  for (const n of NOTIFICATIONS) {
    const { id, read, ...rest } = n;
    notifBatch.set(
      db.doc(`users/${uid}/notifications/${id}`),
      {
        ...rest,
        type: "news",
        imageUrl: null,
        matchedTickers: rest.tickers,
        source: "Seed",
        url: null,
        reasons: ["seeded"],
        read,
        createdAt: rest.publishedAt,
        updatedAt: new Date().toISOString(),
      },
      { merge: true },
    );
  }
  await notifBatch.commit();
  const unread = NOTIFICATIONS.filter((n) => !n.read).length;
  console.log(`notifications: ${NOTIFICATIONS.length} (${unread} unread)`);

  // 7. Stock notes + feature request — auto-id collections, so these are only
  //    seeded when the user has none; otherwise a re-run would pile up copies.
  const notes = await db.collection("stock_comments").where("uid", "==", uid).limit(1).get();
  if (notes.empty) {
    const b = db.batch();
    STOCK_NOTES.forEach((n, i) =>
      b.set(db.collection("stock_comments").doc(), {
        uid,
        ...n,
        createdAt: Timestamp.fromMillis(Date.now() - (i + 1) * 86_400_000),
      }),
    );
    await b.commit();
    console.log(`stock_comments: ${STOCK_NOTES.length} notes`);
  } else {
    console.log("stock_comments: already present, left alone (use --reset to replace)");
  }

  const reqs = await db.collection("feature_requests").where("uid", "==", uid).limit(1).get();
  if (reqs.empty) {
    await db.collection("feature_requests").add({
      uid,
      text: FEATURE_REQUEST,
      createdAt: Timestamp.fromMillis(Date.now() - 3 * 86_400_000),
    });
    console.log("feature_requests: 1 request");
  } else {
    console.log("feature_requests: already present, left alone (use --reset to replace)");
  }

  console.log("\nDone. Sign in to the user app with:");
  console.log(`  email    ${EMAIL}`);
  console.log(`  password ${PASSWORD}`);
  console.log(`  uid      ${uid}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
