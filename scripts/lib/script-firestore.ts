import { execFileSync } from "child_process";
import type { Firestore } from "firebase-admin/firestore";
import { applicationDefault, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

/**
 * Firestore for operator scripts (apply-catalog, seed-staff).
 *   --auth=adc     Application Default Credentials via the Admin SDK (default)
 *   --auth=gcloud  the signed-in gcloud account over the Firestore REST API: a
 *                  short-lived token from `gcloud auth print-access-token`, held
 *                  in memory only — never printed or written. (The client
 *                  libraries don't accept a bare user token; REST does.)
 * FIRESTORE_EMULATOR_HOST set → the emulator (no credentials).
 *
 * The REST shim implements only what those scripts use: doc(path).get/set,
 * collection(name).get(), collection(name).doc(id), batch().set/update/commit.
 */
export type ScriptAuth = "adc" | "gcloud";

export function scriptAuthFrom(argv: string[]): ScriptAuth {
  return argv.find((x) => x.startsWith("--auth="))?.slice(7) === "gcloud"
    ? "gcloud"
    : "adc";
}

export function scriptFirestore(
  project: string,
  database: string,
  auth: ScriptAuth,
): Firestore {
  if (process.env.FIRESTORE_EMULATOR_HOST || auth === "adc") {
    const app =
      getApps()[0] ??
      initializeApp(
        process.env.FIRESTORE_EMULATOR_HOST
          ? { projectId: project }
          : { credential: applicationDefault(), projectId: project },
      );
    return database === "(default)"
      ? getFirestore(app)
      : getFirestore(app, database);
  }
  const token = execFileSync("gcloud", ["auth", "print-access-token"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  if (!token)
    throw new Error("gcloud is not signed in (run: gcloud auth login)");
  return new RestFirestore(project, database, token) as unknown as Firestore;
}

// ── Firestore REST value encoding ─────────────────────────────────────────

type Value = Record<string, unknown>;
export function encodeValue(v: unknown): Value {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number")
    return Number.isInteger(v)
      ? { integerValue: String(v) }
      : { doubleValue: v };
  if (typeof v === "string") return { stringValue: v };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(encodeValue) } };
  if (typeof v === "object")
    return { mapValue: { fields: encodeFields(v as Record<string, unknown>) } };
  throw new Error(`unsupported value ${typeof v}`);
}
export const encodeFields = (o: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(o)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [k, encodeValue(v)]),
  );
export function decodeValue(x: Value): unknown {
  if ("nullValue" in x) return null;
  if ("booleanValue" in x) return x.booleanValue;
  if ("integerValue" in x) return Number(x.integerValue);
  if ("doubleValue" in x) return x.doubleValue;
  if ("stringValue" in x) return x.stringValue;
  if ("timestampValue" in x) return x.timestampValue;
  if ("arrayValue" in x)
    return ((x.arrayValue as { values?: Value[] }).values ?? []).map(
      decodeValue,
    );
  if ("mapValue" in x)
    return decodeFields(
      (x.mapValue as { fields?: Record<string, Value> }).fields ?? {},
    );
  return undefined;
}
export const decodeFields = (f: Record<string, Value>) =>
  Object.fromEntries(Object.entries(f).map(([k, v]) => [k, decodeValue(v)]));

type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

export class RestFirestore {
  private readonly base: string;
  constructor(
    private readonly project: string,
    database: string,
    private readonly token: string,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
  ) {
    this.base = `projects/${project}/databases/${database}/documents`;
  }

  private async call(
    path: string,
    init: { method?: string; body?: unknown } = {},
  ) {
    const r = await this.fetchImpl(
      `https://firestore.googleapis.com/v1/${path}`,
      {
        method: init.method ?? "GET",
        headers: {
          authorization: `Bearer ${this.token}`,
          "x-goog-user-project": this.project,
          "content-type": "application/json",
        },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      },
    );
    if (r.status === 404) return null;
    if (r.status >= 300)
      throw new Error(
        `Firestore REST ${r.status}: ${(await r.text()).slice(0, 200)}`,
      );
    return (await r.json()) as Record<string, unknown>;
  }

  doc(path: string) {
    const name = `${this.base}/${path}`;
    return {
      id: path.split("/").pop()!,
      get: async () => {
        const d = await this.call(name);
        return {
          exists: !!d,
          id: path.split("/").pop()!,
          data: () =>
            d
              ? decodeFields((d.fields as Record<string, Value>) ?? {})
              : undefined,
        };
      },
      set: async (data: Record<string, unknown>) => {
        await this.call(name, {
          method: "PATCH",
          body: { fields: encodeFields(data) },
        });
      },
      _name: name,
    };
  }

  collection(col: string) {
    return {
      doc: (id: string) => this.doc(`${col}/${id}`),
      get: async () => {
        const docs: Array<{ id: string; data: () => Record<string, unknown> }> =
          [];
        let token = "";
        do {
          const q = new URLSearchParams({
            pageSize: "300",
            ...(token ? { pageToken: token } : {}),
          });
          const r = (await this.call(`${this.base}/${col}?${q}`)) ?? {};
          for (const d of (r.documents as Array<{
            name: string;
            fields?: Record<string, Value>;
          }>) ?? []) {
            const data = decodeFields(d.fields ?? {});
            docs.push({ id: d.name.split("/").pop()!, data: () => data });
          }
          token = String(r.nextPageToken ?? "");
        } while (token);
        return { docs, empty: docs.length === 0, size: docs.length };
      },
    };
  }

  /** All writes in one atomic commit. set = replace; update = merge the given fields (doc must exist). */
  batch() {
    const writes: unknown[] = [];
    return {
      set: (ref: { _name: string }, data: Record<string, unknown>) =>
        void writes.push({
          update: { name: ref._name, fields: encodeFields(data) },
        }),
      update: (ref: { _name: string }, data: Record<string, unknown>) =>
        void writes.push({
          update: { name: ref._name, fields: encodeFields(data) },
          updateMask: { fieldPaths: Object.keys(data) },
          currentDocument: { exists: true },
        }),
      commit: async () => {
        if (writes.length)
          await this.call(`${this.base}:commit`, {
            method: "POST",
            body: { writes },
          });
      },
    };
  }

  /** Read-then-write without a server transaction (operator scripts run alone). */
  async runTransaction<T>(
    fn: (tx: {
      get: (r: { get: () => Promise<unknown> }) => Promise<unknown>;
      set: (
        r: { set: (d: Record<string, unknown>) => Promise<void> },
        d: Record<string, unknown>,
      ) => void;
    }) => Promise<T>,
  ): Promise<T> {
    const pending: Array<() => Promise<void>> = [];
    const out = await fn({
      get: (r) => r.get(),
      set: (r, d) => void pending.push(() => r.set(d)),
    });
    for (const p of pending) await p();
    return out;
  }
}
