/**
 * Logos are drawn on a white tile. Some vendor images are a white mark on a
 * transparent background — made for dark pages — and show as an empty white
 * square (ALNY from FMP). invisibleOnWhite() spots them so the logo chain moves
 * on to the next source.
 *
 * Reads 8-bit RGBA / grey+alpha PNGs (the vendors' format) with node's zlib;
 * any other image (SVG, JPEG, palette PNG, unreadable) is reported visible, so
 * a logo is never dropped on a guess.
 */
import { inflateSync } from "zlib";

const PNG_SIG = "89504e470d0a1a0a";
/** A pixel counts as drawn when it is this opaque. */
const ALPHA_DRAWN = 40;
/** …and as "white" when every channel is at least this bright. */
const NEAR_WHITE = 235;

export function invisibleOnWhite(buf: Buffer): boolean {
  try {
    if (buf.length < 33 || buf.subarray(0, 8).toString("hex") !== PNG_SIG) return false;
    let pos = 8, w = 0, h = 0, depth = 0, color = -1, interlace = 0;
    const idat: Buffer[] = [];
    while (pos + 8 <= buf.length) {
      const len = buf.readUInt32BE(pos), type = buf.toString("ascii", pos + 4, pos + 8), body = buf.subarray(pos + 8, pos + 8 + len);
      if (type === "IHDR") { w = body.readUInt32BE(0); h = body.readUInt32BE(4); depth = body[8]; color = body[9]; interlace = body[12]; }
      else if (type === "IDAT") idat.push(body);
      else if (type === "IEND") break;
      pos += 12 + len;
    }
    // Only straightforward 8-bit images with an alpha channel can hide a white mark.
    const bpp = color === 6 ? 4 : color === 4 ? 2 : 0;
    if (!bpp || depth !== 8 || interlace !== 0 || !w || !h || w * h > 4_000_000) return false;
    const raw = inflateSync(Buffer.concat(idat));
    const stride = w * bpp;
    let prev = Buffer.alloc(stride), i = 0, drawn = 0, white = 0;
    for (let y = 0; y < h; y++) {
      const f = raw[i++], line = Buffer.from(raw.subarray(i, i + stride));
      i += stride;
      for (let x = 0; x < stride; x++) {
        const a = x >= bpp ? line[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
        if (f === 1) line[x] = (line[x] + a) & 255;
        else if (f === 2) line[x] = (line[x] + b) & 255;
        else if (f === 3) line[x] = (line[x] + ((a + b) >> 1)) & 255;
        else if (f === 4) {
          const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          line[x] = (line[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
        }
      }
      for (let x = 0; x < stride; x += bpp) {
        const alpha = line[x + bpp - 1];
        if (alpha < ALPHA_DRAWN) continue;
        drawn++;
        const lum = bpp === 4 ? Math.min(line[x], line[x + 1], line[x + 2]) : line[x];
        if (lum >= NEAR_WHITE) white++;
      }
      prev = line;
    }
    // Nothing drawn, or (nearly) everything drawn is white: an empty square on the tile.
    return drawn === 0 || white / drawn >= 0.97;
  } catch {
    return false;
  }
}
