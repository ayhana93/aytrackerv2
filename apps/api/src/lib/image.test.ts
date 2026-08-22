import { describe, expect, it } from 'vitest';
import { decodeBase64Image, sniffImageType } from './image.js';

/**
 * The gate on what may become a customer's logo.
 *
 * These are security tests wearing the clothes of format tests. The asset that passes here is
 * later served from our own origin, with the `Content-Type` this file decides, onto a page where
 * that customer's staff type their PIN — so the interesting cases are not "does a PNG work" but
 * "what happens to a file that is lying about what it is".
 */

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0x80, 0]);
const WEBP = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50,
]);

describe('what counts as an image', () => {
  it('recognizes the four raster formats every browser renders', () => {
    expect(sniffImageType(PNG)).toBe('image/png');
    expect(sniffImageType(JPEG)).toBe('image/jpeg');
    expect(sniffImageType(GIF)).toBe('image/gif');
    expect(sniffImageType(WEBP)).toBe('image/webp');
  });

  /**
   * The one that matters.
   *
   * An SVG is a script container: `<script>`, `<foreignObject>` and event handlers all execute in
   * the page that renders it, and a logo renders on its own tenant's login page. Refused rather
   * than sanitized — sanitizing is a bypass race. See docs/white-label.md § 4.
   */
  it('refuses an SVG, whatever it claims to be', () => {
    const svg = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    );
    expect(sniffImageType(svg)).toBeNull();
  });

  it('refuses HTML dressed as an image', () => {
    expect(
      sniffImageType(new TextEncoder().encode('<!doctype html><script>x</script>')),
    ).toBeNull();
  });

  /**
   * A RIFF container that is not a WebP — an AVI, say — must not pass as one. Checking only the
   * `RIFF` prefix would serve a video file with an `image/webp` header.
   */
  it('refuses a RIFF container that is not WebP', () => {
    const avi = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x41, 0x56, 0x49, 0x20, 0, 0,
    ]);
    expect(sniffImageType(avi)).toBeNull();
  });

  it('refuses a file too short to have a signature', () => {
    expect(sniffImageType(new Uint8Array([0x89, 0x50]))).toBeNull();
  });
});

describe('reading what the browser sent', () => {
  it('accepts the data URL a FileReader produces', () => {
    const encoded = Buffer.from(PNG).toString('base64');
    expect(decodeBase64Image(`data:image/png;base64,${encoded}`)).toEqual(PNG);
  });

  it('accepts bare base64 too', () => {
    expect(decodeBase64Image(Buffer.from(PNG).toString('base64'))).toEqual(PNG);
  });

  it('ignores the whitespace a wrapped payload carries', () => {
    const encoded = Buffer.from(PNG).toString('base64');
    const wrapped = `${encoded.slice(0, 8)}\n${encoded.slice(8)}`;
    expect(decodeBase64Image(wrapped)).toEqual(PNG);
  });

  /**
   * `Buffer.from(x, 'base64')` never throws: it silently drops what it cannot decode, so a body of
   * prose arrives as a handful of accidental bytes. Caught here so the caller is told the file
   * could not be read, rather than being told their prose is not a supported image format.
   */
  it('rejects a string that is not base64 at all', () => {
    expect(decodeBase64Image('this is not a file, it is a sentence')).toBeNull();
    expect(decodeBase64Image('')).toBeNull();
    expect(decodeBase64Image('data:image/png;base64')).toBeNull();
  });
});
