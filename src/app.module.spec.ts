// blogs-admin imports the ESM-only `marked`; this spec reads module metadata only.
jest.mock("marked", () => ({ marked: { parse: (s: string) => s } }));

import { AppModule } from "./app.module";
import { BillingCoreModule } from "./billing/billing-core.module";
import { BillingModule } from "./billing/billing.module";
import { EntitlementsModule } from "./entitlements/entitlements.module";

/**
 * The billing modules must be mounted in the root module. Unit and e2e specs
 * build their own testing modules, so without this a missing import passed
 * every test while the real app failed to start ("Nest can't resolve
 * dependencies of the EntitlementGuard").
 */
describe("AppModule wiring", () => {
  it("mounts BillingCoreModule, EntitlementsModule and BillingModule", () => {
    const imports = Reflect.getMetadata("imports", AppModule) as unknown[];
    expect(imports).toEqual(expect.arrayContaining([BillingCoreModule, EntitlementsModule, BillingModule]));
  });
});
