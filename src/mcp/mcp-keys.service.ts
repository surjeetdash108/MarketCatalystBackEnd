import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { createHash, randomBytes } from "crypto";
import { FirebaseAdminService } from "../common/firebase-admin.provider";

/**
 * Credentials for the MCP blog-authoring server (see McpServerController).
 *
 * A raw key is generated once, shown to the admin exactly once in the create
 * response, and never stored — only its SHA-256 hash is kept, the same
 * "never store the secret itself" rule the rest of the backend applies to
 * real credentials. Revocation sets `revokedAt` rather than deleting the row,
 * so a revoked key still shows up in the admin's list (with its prefix) for
 * audit purposes.
 */

const COLLECTION = "mcp_api_keys";
const KEY_PREFIX = "mcp_live_";

export interface McpApiKeyView {
  id: string;
  label: string;
  prefix: string;
  createdAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
}

function isoOrNull(ts: unknown): string | null {
  return ts instanceof Timestamp ? ts.toDate().toISOString() : null;
}

@Injectable()
export class McpKeysService {
  private readonly logger = new Logger(McpKeysService.name);

  constructor(private readonly firebase: FirebaseAdminService) {}

  private get col() {
    return this.firebase.firestore.collection(COLLECTION);
  }

  private map(id: string, data: FirebaseFirestore.DocumentData): McpApiKeyView {
    return {
      id,
      label: typeof data.label === "string" ? data.label : "",
      prefix: typeof data.prefix === "string" ? data.prefix : "",
      createdAt: isoOrNull(data.createdAt) ?? new Date(0).toISOString(),
      revokedAt: isoOrNull(data.revokedAt),
      lastUsedAt: isoOrNull(data.lastUsedAt),
    };
  }

  /** Newest first — never returns the hash, and the raw key only ever exists at create(). */
  async list(): Promise<McpApiKeyView[]> {
    const snap = await this.col.orderBy("createdAt", "desc").get();
    return snap.docs.map((d) => this.map(d.id, d.data()));
  }

  async create(label: string): Promise<McpApiKeyView & { rawKey: string }> {
    const trimmed = label.trim();
    if (!trimmed) throw new BadRequestException("label is required");

    const rawKey = `${KEY_PREFIX}${randomBytes(32).toString("hex")}`;
    const hash = createHash("sha256").update(rawKey).digest("hex");
    const prefix = rawKey.slice(0, 16);

    const ref = this.col.doc();
    await ref.set({
      label: trimmed,
      hash,
      prefix,
      createdAt: FieldValue.serverTimestamp(),
      createdBy: "console-admin",
      revokedAt: null,
      lastUsedAt: null,
    });
    this.logger.log(`mcp api key created: ${prefix}… ("${trimmed}")`);

    const doc = await ref.get();
    return { ...this.map(ref.id, doc.data()), rawKey };
  }

  async revoke(id: string): Promise<{ id: string; revokedAt: string }> {
    const ref = this.col.doc(id);
    const snap = await ref.get();
    if (!snap.exists) throw new NotFoundException("key not found");
    const now = FieldValue.serverTimestamp();
    await ref.update({ revokedAt: now });
    // Re-read so the response carries the actual server timestamp, not a
    // sentinel — the admin UI shows this immediately after the call.
    const revokedAt =
      isoOrNull((await ref.get()).data()?.revokedAt) ??
      new Date().toISOString();
    return { id, revokedAt };
  }

  /**
   * Verifies a presented raw key for the MCP server itself (McpApiKeyGuard).
   * Looked up by hash (a point lookup — the hash is effectively unique),
   * never by iterating every stored key.
   */
  async verify(rawKey: string): Promise<{ id: string } | null> {
    if (!rawKey.startsWith(KEY_PREFIX)) return null;
    const hash = createHash("sha256").update(rawKey).digest("hex");
    const snap = await this.col.where("hash", "==", hash).limit(1).get();
    const doc = snap.docs[0];
    if (!doc) return null;
    if (doc.data().revokedAt) return null;
    // Best-effort — a failed usage-timestamp write must never block the
    // actual MCP call the key was presented for.
    doc.ref
      .update({ lastUsedAt: FieldValue.serverTimestamp() })
      .catch((err) => {
        this.logger.warn(
          `lastUsedAt update failed for ${doc.id}: ${(err as Error).message}`,
        );
      });
    return { id: doc.id };
  }
}
