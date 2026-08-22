import type { ReactNode } from 'react';

/**
 * The sidebar icon set.
 *
 * These replaced Unicode glyphs (▤ ☺ ⌗ ⛟ ⇄ ⏻), which looked fine in the editor and shipped
 * three separate problems: every glyph came from whichever font on the user's machine happened
 * to contain it, so stroke weight and optical size varied item to item; several had no
 * consistent metrics, so the labels did not align; and U+23FB, the power symbol, has emoji
 * presentation by default — the logout item rendered as a filled dark circle on a dark sidebar.
 *
 * Drawn on one 24×24 grid with one stroke weight, so the column reads as a set rather than as
 * six characters that happened to be nearby in the font. `currentColor` throughout: the active
 * item flips its label to white, and the icon has to come with it.
 */

function Glyph({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      // Nudged onto the text baseline. Without it an inline SVG sits on the line box bottom and
      // every label looks one pixel high.
      style={{ display: 'block', flex: 'none' }}
    >
      {children}
    </svg>
  );
}

/** Dashboard: panels, because that is what the screen is. */
export const IconDashboard = (
  <Glyph>
    <rect x="3" y="3" width="7" height="9" rx="1.5" />
    <rect x="14" y="3" width="7" height="5" rx="1.5" />
    <rect x="14" y="12" width="7" height="9" rx="1.5" />
    <rect x="3" y="16" width="7" height="5" rx="1.5" />
  </Glyph>
);

/** On shift: a person. */
export const IconPeople = (
  <Glyph>
    <circle cx="12" cy="8" r="3.5" />
    <path d="M5 20a7 7 0 0 1 14 0" />
  </Glyph>
);

/**
 * Staff: two people, the second half-behind the first.
 *
 * Deliberately different from `IconPeople` rather than a variant of it — one entry is "who is on
 * shift right now" and the other is "everyone who could be", and two icons a glance apart would
 * make a supervisor click the wrong one every time.
 */
export const IconStaff = (
  <Glyph>
    <circle cx="9.5" cy="8" r="3.2" />
    <path d="M3.5 19.5a6 6 0 0 1 12 0" />
    <path d="M15.5 5.2a3.2 3.2 0 0 1 0 5.6" />
    <path d="M17 14.2a6 6 0 0 1 3.5 5.3" />
  </Glyph>
);

/** History: a clock, hands set to a past hour rather than to twelve. */
export const IconHistory = (
  <Glyph>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 1.8" />
  </Glyph>
);

/** Zones and positions: a grid of places. */
export const IconZones = (
  <Glyph>
    <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
    <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
    <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
    <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
  </Glyph>
);

/** Fleet: a van. */
export const IconFleet = (
  <Glyph>
    <path d="M2.5 16V6.5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1V16" />
    <path d="M13.5 9h3.2a1 1 0 0 1 .82.43l2.8 4a1 1 0 0 1 .18.57V16" />
    <circle cx="7" cy="17.5" r="2" />
    <circle cx="17" cy="17.5" r="2" />
    <path d="M9 17.5h6M2.5 17.5h2.5M19 17.5h2" />
  </Glyph>
);

/** Trips: a route with a start and an end. */
export const IconRoute = (
  <Glyph>
    <circle cx="6" cy="18" r="2.5" />
    <circle cx="18" cy="6" r="2.5" />
    <path d="M8.5 18h5a4 4 0 0 0 0-8h-3a4 4 0 0 1 0-8h1" />
  </Glyph>
);

/** Settings: the sliders an operations manager actually moves. */
export const IconSettings = (
  <Glyph>
    <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
    <circle cx="16" cy="7" r="2" />
    <circle cx="10" cy="17" r="2" />
  </Glyph>
);

/** Sign out. */
export const IconSignOut = (
  <Glyph>
    <path d="M15 4.5h3a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-3" />
    <path d="M10 16l-4-4 4-4M6 12h9" />
  </Glyph>
);
