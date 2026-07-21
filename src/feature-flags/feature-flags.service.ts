import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FirebaseAdminService } from '../common/firebase-admin.provider';
import {
  FEATURE_FLAGS,
  FEATURE_FLAG_KEYS,
  parseFlag,
  type FeatureFlagDef,
} from './feature-flags.registry';

/** The single Firestore doc holding runtime overrides. */
const FLAGS_DOC = 'feature_flags/default';
/** Cache TTL — the doc is tiny and rarely changes; avoid a read per request. */
const CACHE_TTL_MS = 15_000;

export interface ResolvedFlag extends FeatureFlagDef {
  enabled: boolean;
  /** Where the winning value came from — makes the resolution auditable. */
  source: 'firestore' | 'env' | 'default';
}

@Injectable()
export class FeatureFlagsService implements OnModuleInit {
  private readonly logger = new Logger(FeatureFlagsService.name);
  private cache: { at: number; overrides: Record<string, boolean> } | null = null;

  constructor(
    private readonly firebase: FirebaseAdminService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Self-seed on boot so the Firestore doc exists without a manual step. Errors
   * (e.g. missing local credentials) are swallowed: the resolver falls back to
   * code/env defaults, so a failed seed degrades gracefully rather than
   * blocking startup. In production the runtime SA has access and this succeeds.
   */
  async onModuleInit(): Promise<void> {
    try {
      const { written } = await this.seed();
      if (written.length > 0) {
        this.logger.log(`feature_flags seeded ${written.length} flag(s) on boot`);
      }
    } catch (err) {
      this.logger.warn(`feature_flags auto-seed skipped: ${err.message}`);
    }
  }

  /** Firestore overrides, cached briefly. Missing doc = no overrides (not an error). */
  private async overrides(): Promise<Record<string, boolean>> {
    if (this.cache && Date.now() - this.cache.at < CACHE_TTL_MS) {
      return this.cache.overrides;
    }
    let overrides: Record<string, boolean> = {};
    try {
      const snap = await this.firebase.firestore.doc(FLAGS_DOC).get();
      const data = (snap.data()?.flags ?? {}) as Record<string, unknown>;
      for (const [k, v] of Object.entries(data)) {
        // Ignore anything not in the registry, and any non-boolean value —
        // a stray field must never silently become a flag.
        if (FEATURE_FLAG_KEYS.has(k) && typeof v === 'boolean') overrides[k] = v;
      }
    } catch (err) {
      // Fail OPEN to code/env defaults rather than dark: a Firestore blip must
      // not black out every gated screen at once.
      this.logger.warn(`feature_flags read failed, using defaults: ${err.message}`);
      overrides = this.cache?.overrides ?? {};
    }
    this.cache = { at: Date.now(), overrides };
    return overrides;
  }

  /** Resolve one flag through default → env → Firestore. */
  private resolveOne(def: FeatureFlagDef, overrides: Record<string, boolean>): ResolvedFlag {
    if (Object.prototype.hasOwnProperty.call(overrides, def.key)) {
      return { ...def, enabled: overrides[def.key], source: 'firestore' };
    }
    const envVal = parseFlag(this.config.get<string>(def.key));
    if (envVal !== null) return { ...def, enabled: envVal, source: 'env' };
    return { ...def, enabled: def.defaultOn, source: 'default' };
  }

  /** Every flag, resolved. */
  async getAll(): Promise<ResolvedFlag[]> {
    const overrides = await this.overrides();
    return FEATURE_FLAGS.map((def) => this.resolveOne(def, overrides));
  }

  /** A flat { FF_X: true } map — the shape the frontend consumes. */
  async getMap(): Promise<Record<string, boolean>> {
    const all = await this.getAll();
    return Object.fromEntries(all.map((f) => [f.key, f.enabled]));
  }

  /** Single-flag check for backend callers (e.g. a job gating itself). */
  async isEnabled(key: string): Promise<boolean> {
    if (!FEATURE_FLAG_KEYS.has(key)) return false;
    const all = await this.getAll();
    return all.find((f) => f.key === key)?.enabled ?? false;
  }

  /**
   * Set (or clear) a runtime override. Passing null removes the override so the
   * flag falls back to its env/default value. Writes via the Admin SDK, which
   * bypasses the server-write-only Firestore rule.
   */
  async setOverride(key: string, value: boolean | null): Promise<void> {
    if (!FEATURE_FLAG_KEYS.has(key)) {
      throw new Error(`unknown flag: ${key}`);
    }
    const ref = this.firebase.firestore.doc(FLAGS_DOC);
    if (value === null) {
      const { FieldValue } = await import('firebase-admin/firestore');
      await ref.set({ flags: { [key]: FieldValue.delete() } }, { merge: true });
    } else {
      await ref.set(
        { flags: { [key]: value }, updatedAt: new Date().toISOString() },
        { merge: true },
      );
    }
    this.cache = null; // force a re-read on the next resolve
  }

  /**
   * Seed the doc so it exists and clients have something to subscribe to. Only
   * writes keys that are absent — never clobbers an operator's existing toggle.
   */
  async seed(): Promise<{ written: string[] }> {
    const ref = this.firebase.firestore.doc(FLAGS_DOC);
    const snap = await ref.get();
    const existing = (snap.data()?.flags ?? {}) as Record<string, unknown>;
    const seed: Record<string, boolean> = {};
    for (const def of FEATURE_FLAGS) {
      if (!Object.prototype.hasOwnProperty.call(existing, def.key)) {
        seed[def.key] = def.defaultOn;
      }
    }
    if (Object.keys(seed).length > 0) {
      await ref.set(
        { flags: seed, seededAt: new Date().toISOString() },
        { merge: true },
      );
    }
    this.cache = null;
    return { written: Object.keys(seed) };
  }
}
