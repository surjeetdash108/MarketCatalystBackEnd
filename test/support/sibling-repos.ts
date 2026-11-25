import { existsSync } from "fs";
import { join } from "path";

/**
 * The UI and Website repos sit beside this one locally. CI checks out this repo
 * alone, so tests that compare against them (generated catalogs, shared types,
 * the cross-repo placeholder checker) skip there instead of failing.
 */
export const REPOS_ROOT = join(__dirname, "../../..");
export const HAS_UI = existsSync(join(REPOS_ROOT, "MarketCatalystUI/app"));
export const HAS_WEBSITE = existsSync(join(REPOS_ROOT, "MarketCatalystWebsite/lib"));
export const HAS_SIBLINGS = HAS_UI && HAS_WEBSITE;
/** `describe` when the sibling repos are checked out, `describe.skip` otherwise. */
export const describeWithSiblings: jest.Describe = HAS_SIBLINGS ? describe : describe.skip;
