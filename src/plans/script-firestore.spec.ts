import type { Firestore } from "firebase-admin/firestore";
import {
  RestFirestore,
  decodeFields,
  encodeFields,
  scriptAuthFrom,
} from "../../scripts/lib/script-firestore";
import { seedStaff } from "../account/staff-seed";
import { applyCatalog } from "./catalog-apply";

/** The --auth=gcloud REST shim the operator scripts use, against a mocked Firestore REST API. */
function server(initial: Record<string, Record<string, unknown>> = {}) {
  const docs = new Map(
    Object.entries(initial).map(([k, v]) => [k, encodeFields(v)]),
  );
  const calls: Array<{
    method: string;
    url: string;
    body?: unknown;
    headers: Record<string, string>;
  }> = [];
  const base =
    "https://firestore.googleapis.com/v1/projects/p/databases/mc-regional/documents";
  const fetchImpl = jest.fn(
    (
      url: string,
      init: {
        method?: string;
        body?: string;
        headers?: Record<string, string>;
      } = {},
    ) => {
      const method = init.method ?? "GET";
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ method, url, body, headers: init.headers ?? {} });
      const ok = (j: unknown) =>
        Promise.resolve({
          status: 200,
          json: () => Promise.resolve(j),
          text: () => Promise.resolve(""),
        });
      const path = url.replace(`${base}/`, "").split("?")[0];
      if (url.endsWith(":commit")) {
        for (const w of body.writes) {
          const id = String(w.update.name).replace(
            "projects/p/databases/mc-regional/documents/",
            "",
          );
          docs.set(
            id,
            w.updateMask
              ? { ...(docs.get(id) ?? {}), ...w.update.fields }
              : w.update.fields,
          );
        }
        return ok({});
      }
      if (method === "PATCH") {
        docs.set(path, body.fields);
        return ok({});
      }
      if (!path.includes("/")) {
        return ok({
          documents: [...docs.entries()]
            .filter(([k]) => k.startsWith(`${path}/`))
            .map(([k, f]) => ({ name: `x/${k}`, fields: f })),
        });
      }
      const d = docs.get(path);
      return d
        ? ok({ name: path, fields: d })
        : Promise.resolve({
            status: 404,
            json: () => Promise.resolve({}),
            text: () => Promise.resolve(""),
          });
    },
  );
  return {
    db: new RestFirestore(
      "p",
      "mc-regional",
      "tok-in-memory",
      fetchImpl as never,
    ),
    docs,
    calls,
  };
}

describe("operator scripts: --auth=gcloud Firestore REST shim", () => {
  it("--auth=gcloud selects it; default is ADC", () => {
    expect(scriptAuthFrom(["--auth=gcloud"])).toBe("gcloud");
    expect(scriptAuthFrom([])).toBe("adc");
  });

  it("encodes and decodes Firestore values losslessly", () => {
    const v = {
      s: "x",
      n: 5900,
      f: 0.5,
      b: true,
      z: null,
      a: ["a", 1],
      m: { k: { deep: "y" } },
    };
    expect(decodeFields(encodeFields(v) as never)).toEqual(v);
  });

  it("every request carries the token and quota project; a missing doc is exists:false", async () => {
    const { db, calls } = server();
    expect((await db.doc("config/staff_access").get()).exists).toBe(false);
    expect(calls[0].headers).toMatchObject({
      authorization: "Bearer tok-in-memory",
      "x-goog-user-project": "p",
    });
  });

  it("seed-staff works through it (dry run writes nothing; apply writes once; idempotent)", async () => {
    const { db, docs } = server();
    const fs = db as unknown as Firestore;
    expect(
      (await seedStaff(fs, ["A@example.com"], { dryRun: true })).added,
    ).toEqual(["a@example.com"]);
    expect(docs.has("config/staff_access")).toBe(false);
    await seedStaff(fs, ["A@example.com", "b@example.com"], { dryRun: false });
    expect((await db.doc("config/staff_access").get()).data()?.emails).toEqual([
      "a@example.com",
      "b@example.com",
    ]);
    expect(
      (await seedStaff(fs, ["b@example.com"], { dryRun: false })).added,
    ).toEqual([]);
  });

  it("apply-catalog works through it: one atomic commit; retire is an update that requires the doc", async () => {
    const { db, calls } = server({
      "plans/free": { id: "free", amount: 0, active: true },
      "plans/plus": { id: "plus", amount: 2999, active: true },
      "plans/pro": { id: "pro", amount: 4999 },
    });
    const dir = require("fs").mkdtempSync(
      require("path").join(require("os").tmpdir(), "cat-"),
    );
    const r = await applyCatalog(db as unknown as Firestore, {
      dryRun: false,
      backupDir: dir,
      now: new Date("2026-11-10T00:00:00Z"),
    });
    expect(r.writes.length).toBe(5);
    const commits = calls.filter((c) => c.url.endsWith(":commit"));
    expect(commits).toHaveLength(1);
    const retire = (
      commits[0].body as { writes: Array<Record<string, unknown>> }
    ).writes.find((w) =>
      String((w.update as { name: string }).name).endsWith("plans/plus"),
    )!;
    expect(retire).toMatchObject({
      updateMask: { fieldPaths: ["active", "retiredAt", "updatedAt"] },
      currentDocument: { exists: true },
    });
    // Free is retired the same way (an update to active:false), never deleted.
    const writes = (commits[0].body as { writes: Array<Record<string, unknown>> }).writes;
    expect(writes.some((w) => "delete" in w)).toBe(false);
    expect(
      writes.find((w) => String((w.update as { name?: string } | undefined)?.name ?? "").endsWith("plans/free")),
    ).toMatchObject({ updateMask: { fieldPaths: ["active", "retiredAt", "updatedAt"] } });
    expect((await db.doc("plans/pro").get()).data()?.amount).toBe(5900);
    const again = await applyCatalog(db as unknown as Firestore, {
      dryRun: false,
      backupDir: dir,
    });
    expect(again.writes).toEqual([]);
  });
});
