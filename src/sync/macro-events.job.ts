import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { MACRO_SERIES } from "../common/macro-series";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import {
  batchSetWithCreatedAt,
  type PendingWrite,
} from "../common/firestore-batch.util";
import { SyncMetaService } from "../common/sync-meta.service";
import { FredService } from "../vendors/fred/fred.service";
import { FmpService } from "../vendors/fmp/fmp.service";
import { SyncRegistry } from "../common/sync-registry.service";
import { addDays, isoDate } from "../common/date.util";

const JOB_NAME = "macro-events";
// FMP economic-calendar window: a little history so just-released prints show,
// plus the upcoming schedule FRED lacks.
const ECON_LOOKBACK_DAYS = 14;
const ECON_LOOKAHEAD_DAYS = 60;


@Injectable()
export class MacroEventsJob implements OnModuleInit {
  private readonly logger = new Logger(MacroEventsJob.name);

  constructor(
    private readonly fred: FredService,
    private readonly firebase: FirebaseAdminService,
    private readonly meta: SyncMetaService,
    private readonly registry: SyncRegistry,
    private readonly fmp: FmpService,
  ) {}

  onModuleInit() {
    this.registry.register(JOB_NAME, () => this.run(), {
      collections: ["macro_events"],
      cronExpression: "10 18 * * 1-5",
      timeZone: "America/New_York",
    });
  }

  async scheduled() {
    await this.registry.get(JOB_NAME)();
  }

  async run() {
    try {
      const writes: PendingWrite[] = [];
      const col = this.firebase.firestore.collection("macro_events");
      let written = 0;
      for (const series of MACRO_SERIES) {
        try {
          const obs = await this.fred.getLatestObservations(series.seriesId, 2);
          const [latest, prior] = obs;
          if (!latest) {
            this.logger.warn(
              `No observations returned for ${series.name} (${series.seriesId})`,
            );
            continue;
          }
          const actual = latest.value === "." ? null : Number(latest.value);
          const previous =
            prior && prior.value !== "." ? Number(prior.value) : null;
          writes.push({
            ref: col.doc(series.seriesId),
            data: {
              name: series.name,
              seriesId: series.seriesId,
              country: series.country,
              unit: series.unit,
              importance: series.importance,
              eventDate: latest.date,
              actual,
              previous,
              estimate: null,
              source: "fred",
              updatedAt: new Date().toISOString(),
            },
          });
          written++;
        } catch (err) {
          this.logger.error(
            `Failed syncing ${series.name} (${series.seriesId}): ${err.message}`,
          );
        }
      }
      // ── FMP economic calendar (forward release schedule + estimates) ──
      // FRED gives only past observations, so the "This/Next week" calendar tabs
      // are empty. FMP adds the upcoming US releases with estimates. Removable:
      // set ECON_CALENDAR_SOURCE=none to revert to FRED-only.
      let econWritten = 0;
      if (process.env.ECON_CALENDAR_SOURCE !== "none" && this.fmp.enabled) {
        try {
          const now = new Date();
          const events = await this.fmp.getEconomicCalendar(
            isoDate(addDays(now, -ECON_LOOKBACK_DAYS)),
            isoDate(addDays(now, ECON_LOOKAHEAD_DAYS)),
          );
          const keep = new Set<string>();
          // ONE RELEASE, TWO ROWS. FMP publishes the Beige Book twice on the
          // same day — as "Beige Book" and as "Fed Beige Book", both with no
          // figures. The doc id is slug-derived, so the two never collide and a
          // single release reaches the calendar as two entries.
          //
          // Only ISSUER words are ignored here: words naming WHO publishes a
          // number, never WHAT it measures.
          //
          // DO NOT widen this into "one name contains the other". Measured
          // against a real calendar, that rule merges "Core CPI YoY" into "CPI
          // YoY", "Retail Sales Ex Autos MoM" into "Retail Sales MoM" and "U-6
          // Unemployment Rate" into "Unemployment Rate" — different releases
          // carrying different numbers. The words that distinguish them (core,
          // ex, u-6, mom, yoy) have exactly the same shape as the word that
          // marks a duplicate (fed), so structure alone cannot tell the two
          // cases apart. A list of measurement-free words can, which is why the
          // rule is a vocabulary and not a pattern.
          const QUALIFIER = new Set([
            "fed",
            "federal",
            "reserve",
            "us",
            "usa",
            "national",
            "the",
            "of",
          ]);
          const canonical = (name: string) =>
            name
              .toLowerCase()
              .replace(/\bu\.?\s?s\.?\b/g, "us")
              .replace(/\([^)]*\)/g, " ")
              .replace(/[^a-z0-9]+/g, " ")
              .trim()
              .split(" ")
              .filter((t) => t && !QUALIFIER.has(t))
              .join(" ");
          // Most non-null figures wins; the longer (more specific) name breaks
          // a tie. Neither depends on the order the vendor returned rows in.
          const richness = (e: {
            event: string;
            actual?: unknown;
            estimate?: unknown;
            previous?: unknown;
          }) =>
            [e.actual, e.estimate, e.previous].filter((v) => v != null).length *
              100 +
            e.event.length;
          const bestByKey = new Map<string, (typeof events)[number]>();
          const collapsed: string[] = [];
          for (const e of events) {
            if (!e.event || !e.date) continue;
            const country = (e.country ?? "").toUpperCase();
            if (country !== "US" && country !== "USD") continue;
            const impact = (e.impact ?? "").toLowerCase();
            if (impact !== "high" && impact !== "medium") continue; // drop low-impact noise
            const key = `${e.date.slice(0, 10)}|${canonical(e.event)}`;
            const seen = bestByKey.get(key);
            if (!seen) {
              bestByKey.set(key, e);
              continue;
            }
            const [win, lost] =
              richness(e) > richness(seen) ? [e, seen] : [seen, e];
            bestByKey.set(key, win);
            collapsed.push(
              `${e.date.slice(0, 10)} "${lost.event}" -> "${win.event}"`,
            );
          }
          // Surfaced rather than silent: a new duplicate shape shows up in the
          // job log instead of only on the calendar, where a reader finds it.
          if (collapsed.length > 0) {
            this.logger.warn(
              `macro-events: collapsed ${collapsed.length} duplicate release(s) — ${collapsed.join("; ")}`,
            );
          }
          for (const e of bestByKey.values()) {
            const impact = (e.impact ?? "").toLowerCase();
            const day = e.date.slice(0, 10);
            const slug = e.event
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, "-")
              .replace(/^-|-$/g, "")
              .slice(0, 60);
            const id = `fmp_${slug}_${day}`;
            if (keep.has(id)) continue;
            keep.add(id);
            writes.push({
              ref: col.doc(id),
              data: {
                name: e.event,
                seriesId: slug,
                country: "US",
                unit: e.unit ?? null,
                importance: impact,
                eventDate: day,
                actual: e.actual,
                previous: e.previous,
                estimate: e.estimate,
                source: "fmp",
                updatedAt: new Date().toISOString(),
              },
            });
            econWritten++;
          }
          // Drop stale FMP docs (passed/rescheduled) not in this run's set.
          // Data-loss guard: if the FMP calendar came back empty (its documented
          // silent-empty 200), the keep-set is empty and this delete would wipe
          // every source==fmp doc. Skip it and warn; a genuinely-empty calendar
          // is a no-op, never a wipe of the FMP-sourced macro events.
          if (keep.size === 0) {
            this.logger.warn(
              "macro-events: FMP calendar returned 0 rows — skipping delete-pass to avoid wiping source==fmp docs in collection macro_events",
            );
          } else {
            const existing = await col.where("source", "==", "fmp").get();
            const stale = existing.docs.filter((d) => !keep.has(d.id));
            for (let i = 0; i < stale.length; i += 400) {
              const batch = this.firebase.firestore.batch();
              for (const d of stale.slice(i, i + 400)) batch.delete(d.ref);
              await batch.commit();
            }
          }
        } catch (err) {
          this.logger.error(`FMP economic calendar failed: ${err.message}`);
        }
      }

      await batchSetWithCreatedAt(this.firebase.firestore, writes);
      await this.meta.record(JOB_NAME, { ok: true, count: written + econWritten });
      this.logger.log(
        `macro-events: ${written} FRED series, ${econWritten} FMP calendar events`,
      );
      return { count: written, econWritten };
    } catch (err) {
      await this.meta.record(JOB_NAME, {
        ok: false,
        error: err.message,
      });
      throw err;
    }
  }
}
