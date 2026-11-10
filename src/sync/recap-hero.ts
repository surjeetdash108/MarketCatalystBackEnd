import { Logger } from "@nestjs/common";
import type { FirebaseAdminService } from "../common/firebase-admin.provider";

/**
 * The recap's hero image: our own brand mark, drawn once and reused.
 *
 * A system-written post has no photograph to lead with, and the alternative —
 * leaving the hero empty — shows as "Image not available" on the article and a
 * blank thumbnail on the board. A branded card is honest about what the post is
 * and identical for every recap, which is the point: readers learn to
 * recognise it.
 *
 * Written to a FIXED path, so this is idempotent — the first recap creates it
 * and every later one reuses the same object rather than filling Storage with a
 * copy per day.
 */

const PATH = "blog-media/system/recap-hero.svg";
const logger = new Logger("RecapHero");

/** The brand mark from the app's shell: ascending bars, trend line, node. */
function heroSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 480" width="1200" height="480" role="img" aria-label="MarketCatalyst market recap">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1200" y2="480" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#0b0f16"/><stop offset="1" stop-color="#121d3d"/>
    </linearGradient>
    <linearGradient id="mark" x1="120" y1="360" x2="420" y2="120" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#2fe6a6"/><stop offset="0.5" stop-color="#38d6e6"/><stop offset="1" stop-color="#5b8cff"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="480" fill="url(#bg)"/>
  <g transform="translate(432 110) scale(7.6)">
    <rect x="5" y="27" width="6" height="12" rx="2" fill="url(#mark)"/>
    <rect x="14" y="21" width="6" height="18" rx="2" fill="url(#mark)"/>
    <rect x="23" y="15" width="6" height="24" rx="2" fill="url(#mark)"/>
    <rect x="32" y="9" width="6" height="30" rx="2" fill="url(#mark)"/>
    <path d="M7 30 L16 23 L25 17 L35 8" fill="none" stroke="url(#mark)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="35" cy="8" r="3.6" fill="#0b0f16" stroke="url(#mark)" stroke-width="2.4"/>
  </g>
  <text x="600" y="430" text-anchor="middle" font-family="Inter, system-ui, sans-serif" font-size="34" font-weight="700" fill="#eaf0fb" letter-spacing="1">MarketCatalyst</text>
</svg>`;
}

export async function ensureRecapHero(firebase: FirebaseAdminService): Promise<string | null> {
  const url = `https://storage.googleapis.com/${firebase.bucket.name}/${PATH}`;
  try {
    const file = firebase.bucket.file(PATH);
    const [exists] = await file.exists();
    if (!exists) {
      await file.save(Buffer.from(heroSvg(), "utf8"), {
        contentType: "image/svg+xml",
        resumable: false,
      });
      // Public for the same reason the post is: a hero is part of the article.
      await file.makePublic();
      logger.log(`recap hero created at ${PATH}`);
    }
    return url;
  } catch (err) {
    // A missing hero is a worse-looking post, not a failed one — the recap is
    // still worth publishing without it.
    logger.warn(`recap hero unavailable: ${(err as Error).message}`);
    return null;
  }
}
