'use client';

/**
 * The organization's name and logo, wherever the product used to put its own.
 *
 * One component because the fallback rules are the interesting part and three copies of them
 * drift: an organization that has uploaded no logo still gets a mark — the first letter of its
 * name — rather than a gap where a logo should be, and one that has uploaded one gets the image
 * at a fixed height with its own width, because a logo squeezed into a square is somebody's
 * trademark rendered wrong.
 *
 * The image carries an empty `alt` and the name is rendered as text beside it. A logo is not
 * information the name does not already carry, so announcing both makes a screen reader say the
 * company twice.
 */

export interface BrandMarkProps {
  readonly name: string;
  readonly logoUrl: string | null;
  /** `sidebar` for the admin shell, `hero` for a login screen. */
  readonly size?: 'sidebar' | 'hero';
  /** Renders the mark alone, for a bar that has no room for a name. */
  readonly nameless?: boolean;
  /** Overrides the logo height where a specific bar demands one. */
  readonly logoHeight?: string;
}

export function BrandMark({
  name,
  logoUrl,
  size = 'sidebar',
  logoHeight,
  nameless = false,
}: BrandMarkProps) {
  const hero = size === 'hero';
  const markSize = hero ? '2.5rem' : undefined;
  const height = logoHeight ?? (hero ? '2.75rem' : '1.75rem');

  return (
    <>
      {logoUrl ? (
        <img
          src={logoUrl}
          alt=""
          style={{ height, width: 'auto', maxWidth: hero ? '14rem' : '9rem', objectFit: 'contain' }}
        />
      ) : (
        <span
          className="ay-sidebar-mark"
          aria-hidden="true"
          {...(markSize ? { style: { width: markSize, height: markSize } } : {})}
        >
          {initial(name)}
        </span>
      )}
      {nameless ? null : (
        <span
          className={hero ? 'ay-h2' : undefined}
          style={{
            fontWeight: 650,
            letterSpacing: '-0.01em',
            ...(hero ? {} : { fontSize: '0.9375rem' }),
          }}
        >
          {name}
        </span>
      )}
    </>
  );
}

/**
 * The letter in the square when there is no logo.
 *
 * `[...name]` rather than `name[0]`: Cyrillic is fine either way, but an emoji or any character
 * outside the basic plane would be cut in half by an index, and a company that puts one in its
 * name would see a replacement glyph on every screen.
 */
function initial(name: string): string {
  const first = [...name.trim()][0];
  return (first ?? 'A').toUpperCase();
}
