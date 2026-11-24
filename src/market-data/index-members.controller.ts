import { Controller, Get, Header, UseGuards } from "@nestjs/common";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import { FirebaseAuthGuard } from "../common/firebase-auth.guard";
import { INDEX_MEMBERS_DOC } from "../sync/index-members.job";

const CACHE_MS = 10 * 60_000;

/** GET /market-data/index-members — live S&P 500 / Nasdaq-100 / Dow 30 membership (index-members job). `dow30` is empty until the job has stored it. */
@Controller("market-data")
@UseGuards(FirebaseAuthGuard)
export class IndexMembersController {
  private cache: { at: number; body: { sp500: string[]; nasdaq100: string[]; dow30: string[]; updatedAt: string | null } } | null = null;

  constructor(private readonly firebase: FirebaseAdminService) {}

  @Get("index-members")
  @Header("Cache-Control", "private, max-age=600")
  async members() {
    if (this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.body;
    const d = (await this.firebase.firestore.doc(INDEX_MEMBERS_DOC).get()).data() ?? {};
    const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
    const body = { sp500: list(d.sp500), nasdaq100: list(d.nasdaq100), dow30: list(d.dow30), updatedAt: typeof d.updatedAt === "string" ? d.updatedAt : null };
    this.cache = { at: Date.now(), body };
    return body;
  }
}
