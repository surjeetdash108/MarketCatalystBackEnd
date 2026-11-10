import type { Firestore } from "firebase-admin/firestore";
import { FakeFirestore } from "../../test/support/fake-firestore";
import { seedStaff } from "./staff-seed";

const db = (fs: FakeFirestore) => fs as unknown as Firestore;

describe("staff seed (scripts/seed-staff.ts)", () => {
  it("dry run by default writes nothing", async () => {
    const fs = new FakeFirestore();
    const r = await seedStaff(db(fs), ["a@example.com"], { dryRun: true });
    expect(r.added).toEqual(["a@example.com"]);
    expect(fs.read("config", "staff_access")).toBeUndefined();
  });
  it("applies lowercased and deduped, and is idempotent", async () => {
    const fs = new FakeFirestore();
    fs.seed("config", "staff_access", { emails: ["keep@example.com"] });
    const r = await seedStaff(
      db(fs),
      ["A@Example.com", "a@example.com", " b@example.com "],
      { dryRun: false },
    );
    expect(r.added).toEqual(["a@example.com", "b@example.com"]);
    expect(fs.read("config", "staff_access")?.emails).toEqual([
      "a@example.com",
      "b@example.com",
      "keep@example.com",
    ]);
    const again = await seedStaff(db(fs), ["a@example.com"], { dryRun: false });
    expect(again.added).toEqual([]);
  });
  it("refuses non-addresses", async () => {
    await expect(
      seedStaff(db(new FakeFirestore()), ["nope"], { dryRun: true }),
    ).rejects.toThrow(/not email/);
  });
});
