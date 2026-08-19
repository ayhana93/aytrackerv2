/**
 * Type scale.
 *
 * The rule that matters most here: **tracking is size-specific.** A single `letter-spacing`
 * value is wrong somewhere — large text needs negative tracking because letters read too far
 * apart as they grow, and small text needs a touch of positive tracking to stay legible. The
 * scale below carries tracking and leading with each size, so a component picks one token and
 * gets all three correct together.
 *
 * Leading moves inversely to size: tight on display, comfortable on body.
 *
 * Sizes are in `rem` so a worker who has raised their system text size gets a bigger interface
 * rather than a broken one — spacing is in `rem` for the same reason.
 */

export interface TypeStyle {
  readonly fontSize: string;
  readonly lineHeight: string;
  readonly letterSpacing: string;
  readonly fontWeight: number;
}

export const typography = {
  /** The 02:35:42 shift timer, the 12,458 KPI figure. Numbers that carry the screen. */
  display: {
    fontSize: '2.25rem',
    lineHeight: '1.05',
    letterSpacing: '-0.025em',
    fontWeight: 600,
  },
  /** KPI values on the admin dashboard. */
  metric: {
    fontSize: '1.75rem',
    lineHeight: '1.15',
    letterSpacing: '-0.02em',
    fontWeight: 600,
  },
  h1: {
    fontSize: '1.5rem',
    lineHeight: '1.25',
    letterSpacing: '-0.018em',
    fontWeight: 600,
  },
  h2: {
    fontSize: '1.125rem',
    lineHeight: '1.35',
    letterSpacing: '-0.012em',
    fontWeight: 600,
  },
  h3: {
    fontSize: '1rem',
    lineHeight: '1.4',
    letterSpacing: '-0.006em',
    fontWeight: 600,
  },
  body: {
    fontSize: '0.9375rem',
    lineHeight: '1.5',
    letterSpacing: '0',
    fontWeight: 400,
  },
  bodyStrong: {
    fontSize: '0.9375rem',
    lineHeight: '1.5',
    letterSpacing: '0',
    fontWeight: 550,
  },
  /** Table cells, list rows, secondary detail. */
  small: {
    fontSize: '0.8125rem',
    lineHeight: '1.45',
    letterSpacing: '0.005em',
    fontWeight: 400,
  },
  /** Labels above fields, chart axes, timestamps. */
  caption: {
    fontSize: '0.75rem',
    lineHeight: '1.4',
    letterSpacing: '0.01em',
    fontWeight: 500,
  },
  /** Section headers in the settings panel — "ЛОГО НА ФИРМАТА". */
  overline: {
    fontSize: '0.6875rem',
    lineHeight: '1.3',
    letterSpacing: '0.06em',
    fontWeight: 600,
  },
} as const satisfies Record<string, TypeStyle>;

export type TypeToken = keyof typeof typography;

/**
 * The system font stack.
 *
 * The platform font already ships optical sizing, tracking tables and legibility tuning that a
 * downloaded webfont would have to re-earn — and it costs zero bytes, which matters on a factory
 * phone over a weak connection. Cyrillic is covered on every target platform.
 */
export const fontStack =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

/**
 * Tabular figures for anything that ticks.
 *
 * A running timer with proportional digits jitters as the glyph widths change — the "1" is
 * narrower than the "8", so the whole clock twitches every second. `tabular-nums` fixes the
 * advance width and the number sits still.
 */
export const numericFontFeatures = '"tnum" 1, "lnum" 1';

export function typeStyleToCss(style: TypeStyle): Record<string, string> {
  return {
    'font-size': style.fontSize,
    'line-height': style.lineHeight,
    'letter-spacing': style.letterSpacing,
    'font-weight': String(style.fontWeight),
  };
}
