import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { randomBytes } from "crypto";
import { FirebaseAdminService } from "../common/firebase-admin.provider";

/**
 * The blog's image library.
 *
 * Deliberately the SAME `media` collection and the same storage layout the
 * Website's admin already writes (MarketCatalystWebsite/lib/media/library.ts).
 * Two galleries over two collections would mean an image uploaded in one
 * console is invisible in the other, and whichever one an editor happened to
 * open would look empty. The shape below matches that module field for field.
 */

const COLLECTION = "media";

/** Matches the Website's limit; a hero image has no business being larger. */
const MAX_BYTES = 8 * 1024 * 1024;

export interface MediaItem {
  id: string;
  url: string;
  storagePath: string;
  contentType: string;
  size: number;
  originalFilename: string;
  uploadedBy: string;
  createdAt: string;
}

/**
 * What the bytes actually ARE, not what the upload claimed.
 *
 * The data URI carries a media type the browser wrote, and the filename an
 * extension the user chose; neither is evidence. Reading the file signature is
 * what stops a script being stored as `photo.png` and served back from our own
 * origin. Ported from the Website's validate-image.ts so both admins enforce
 * one rule.
 */
function readSignature(buf: Buffer): { contentType: string; extension: string } {
  const ascii = (from: number, to: number) => buf.subarray(from, to).toString("ascii");

  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { contentType: "image/jpeg", extension: "jpg" };
  }
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) {
    return { contentType: "image/png", extension: "png" };
  }
  if (buf.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") {
    return { contentType: "image/webp", extension: "webp" };
  }
  if (buf.length >= 6 && (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a")) {
    return { contentType: "image/gif", extension: "gif" };
  }
  throw new BadRequestException("not a supported image (JPEG, PNG, WebP or GIF)");
}

function safeBaseName(filename: string): string {
  const base = (filename || "upload").split(/[/\\]/).pop() ?? "upload";
  return base.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 100) || "upload";
}

@Injectable()
export class MediaAdminService {
  private readonly logger = new Logger(MediaAdminService.name);

  constructor(private readonly firebase: FirebaseAdminService) {}

  private get col() {
    return this.firebase.firestore.collection(COLLECTION);
  }

  private map(id: string, data: FirebaseFirestore.DocumentData): MediaItem {
    const createdAt = data.createdAt as Timestamp | undefined;
    return {
      id,
      url: data.url ?? "",
      storagePath: data.storagePath ?? "",
      contentType: data.contentType ?? "",
      size: typeof data.size === "number" ? data.size : 0,
      originalFilename: data.originalFilename ?? "",
      uploadedBy: data.uploadedBy ?? "",
      createdAt: createdAt ? createdAt.toDate().toISOString() : new Date(0).toISOString(),
    };
  }

  async list(): Promise<MediaItem[]> {
    // Newest first, so the image just uploaded is the one at hand.
    const snap = await this.col.orderBy("createdAt", "desc").limit(200).get();
    return snap.docs.map((d) => this.map(d.id, d.data()));
  }

  /** dataUri is `data:<type>;base64,<bytes>` — the console reads the file. */
  async upload(dataUri: string, filename: string): Promise<MediaItem> {
    const comma = dataUri.indexOf(",");
    if (!dataUri.startsWith("data:") || comma < 0) {
      throw new BadRequestException("expected a data URI");
    }
    const buf = Buffer.from(dataUri.slice(comma + 1), "base64");
    if (buf.byteLength === 0) throw new BadRequestException("empty file");
    if (buf.byteLength > MAX_BYTES) {
      throw new BadRequestException(
        `image is ${(buf.byteLength / 1024 / 1024).toFixed(1)} MB — the limit is 8 MB`,
      );
    }

    const { contentType, extension } = readSignature(buf);
    const name = `${Date.now()}-${randomBytes(6).toString("hex")}-${safeBaseName(filename)}`;
    const storagePath = `blog-media/console-admin/${name}.${extension}`;

    const file = this.firebase.bucket.file(storagePath);
    await file.save(buf, { contentType, resumable: false });
    // Public because a hero image IS public the moment the post is: the same
    // trust boundary as the article that carries it. This is also what gives a
    // stable storage.googleapis.com URL, which next/image is configured for.
    await file.makePublic();
    const url = `https://storage.googleapis.com/${this.firebase.bucket.name}/${storagePath}`;

    const ref = this.col.doc();
    await ref.set({
      url,
      storagePath,
      contentType,
      size: buf.byteLength,
      originalFilename: safeBaseName(filename),
      uploadedBy: "console-admin",
      createdAt: FieldValue.serverTimestamp(),
    });
    this.logger.log(`media uploaded: ${storagePath} (${buf.byteLength} bytes)`);
    return this.map(ref.id, (await ref.get()).data()!);
  }

  async remove(id: string): Promise<{ id: string }> {
    const ref = this.col.doc(id);
    const doc = await ref.get();
    if (doc.exists) {
      const path = doc.data()?.storagePath;
      if (typeof path === "string" && path) {
        // The row goes either way: a stored object with no record is invisible
        // in the gallery, but a record pointing at nothing renders as a broken
        // image in every post that used it.
        try {
          await this.firebase.bucket.file(path).delete({ ignoreNotFound: true });
        } catch (err) {
          this.logger.warn(`storage delete failed for ${path}: ${(err as Error).message}`);
        }
      }
      await ref.delete();
    }
    return { id };
  }
}
