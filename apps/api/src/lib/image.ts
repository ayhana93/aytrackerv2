/**
 * What may become a customer's logo.
 *
 * A logo uploaded here renders on that customer's login page, so this file is a security boundary
 * rather than a convenience: it decides what bytes we will later serve from our own origin, and
 * with which `Content-Type`.
 *
 * Two rules do the work:
 *
 *   * **The type is sniffed, never declared.** The upload endpoint takes no content type from the
 *     caller. A declared `image/png` on a file whose bytes are HTML is stored XSS the moment the
 *     asset is served back.
 *   * **SVG is refused, not sanitized.** An SVG is a script container — `<script>`,
 *     `<foreignObject>` and event handlers all run in the page that renders it. Sanitizing is a
 *     bypass race; rasterizing needs a renderer this deployment does not have. See
 *     docs/white-label.md § 4.
 */

/** Half a megabyte. Comfortable for a logo at 2× density, far below anything worth serving. */
export const MAX_LOGO_BYTES = 512 * 1024;

export type LogoContentType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

export interface SniffedImage {
  readonly contentType: LogoContentType;
}

/**
 * The image type these bytes actually are, or null.
 *
 * Magic numbers only, and only the four raster formats every browser renders. Anything else —
 * including an SVG, which has no magic number because it is text — is not an image as far as this
 * product is concerned.
 */
export function sniffImageType(bytes: Uint8Array): LogoContentType | null {
  if (bytes.length < 12) return null;

  const starts = (...signature: number[]): boolean =>
    signature.every((byte, index) => bytes[index] === byte);

  // \x89 P N G \r \n \x1a \n
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  // JPEG: SOI marker. The trailing byte of the APP marker varies, so only the first two are fixed.
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
  // GIF87a / GIF89a
  if (starts(0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  // RIFF....WEBP — the four size bytes in between are not part of the signature.
  if (
    starts(0x52, 0x49, 0x46, 0x46) &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }

  return null;
}

/**
 * Base64 in, bytes out — or null when the string is not base64 at all.
 *
 * Accepts the `data:` prefix a browser's `FileReader.readAsDataURL` produces, because rewriting
 * that in every client is a way for one client to forget. `Buffer.from(..., 'base64')` never
 * throws and silently ignores anything it cannot decode, so the result is re-encoded and compared:
 * a body of prose would otherwise arrive as a handful of accidental bytes and be reported as "not
 * a supported image" rather than "that is not a file".
 */
export function decodeBase64Image(input: string): Uint8Array | null {
  const comma = input.startsWith('data:') ? input.indexOf(',') : -1;
  if (input.startsWith('data:') && comma === -1) return null;

  const payload = (comma === -1 ? input : input.slice(comma + 1)).replace(/\s+/g, '');
  if (payload === '' || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) return null;

  const bytes = Buffer.from(payload, 'base64');
  if (bytes.length === 0) return null;
  if (bytes.toString('base64').replace(/=+$/, '') !== payload.replace(/=+$/, '')) return null;

  return new Uint8Array(bytes);
}
