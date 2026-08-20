/**
 * Semantic colour tokens, extracted from the design reference.
 *
 * Two rules govern this file:
 *
 *   1. **Nothing consumes a raw hex.** Components read semantic names (`surface`, `textMuted`,
 *      `stateWorking`). That is what lets the dark palette and a customer's brand swap
 *      underneath without touching a single component.
 *
 *   2. **The dark palette is authored, not derived.** Inverting lightness produces muddy,
 *      low-contrast surfaces and neon accents. Dark needs its own decisions: near-black grounds
 *      with a blue cast, elevation by *lightening* rather than shadowing, and accents lifted a
 *      step so they stay legible on a dark ground.
 */

export type ThemeMode = 'light' | 'dark';

export interface ColorTokens {
  /** Page ground. Never white — the reference uses a cool off-white so cards read as raised. */
  readonly bg: string;
  /** Card and panel surfaces. */
  readonly surface: string;
  /** Inset or secondary surfaces: table headers, wells, disabled fields. */
  readonly surfaceSunken: string;
  /** Raised above `surface`: sheets, popovers, the thing on top. */
  readonly surfaceRaised: string;

  readonly border: string;
  readonly borderStrong: string;

  readonly text: string;
  readonly textMuted: string;
  readonly textSubtle: string;
  /** Text on a filled brand surface. */
  readonly textOnAccent: string;

  readonly accent: string;
  readonly accentHover: string;
  readonly accentPressed: string;
  readonly accentSoft: string;
  readonly accentSoftText: string;

  /** The green "РАБОТИШ" / "ДВИЖЕНИЕ" state card. */
  readonly stateWorking: string;
  readonly stateWorkingText: string;
  readonly stateWorkingBorder: string;

  readonly warning: string;
  readonly warningSoft: string;
  readonly warningSoftText: string;

  readonly danger: string;
  readonly dangerSoft: string;
  readonly dangerSoftText: string;

  /** The admin sidebar. Dark in both themes — it is a structural region, not a surface. */
  readonly navBg: string;
  readonly navText: string;
  readonly navTextActive: string;
  readonly navActiveBg: string;
  /**
   * Hover on a nav item that is not the current page.
   *
   * Deliberately not the active background at reduced opacity: hovering must never look like
   * "you are here", or the sidebar stops answering the one question it exists to answer.
   */
  readonly navHoverBg: string;
  readonly navBorder: string;

  /** Translucent chrome (tab bars, sticky headers). Sits over scrolling content. */
  readonly chrome: string;
  readonly chromeBorder: string;

  /** Scrim behind a modal. */
  readonly scrim: string;

  readonly focusRing: string;
}

/**
 * Data-visualisation series.
 *
 * Ordered so the first four are maximally distinguishable, including for the most common forms
 * of colour vision deficiency — the reference uses blue/green/purple/amber, which happens to be
 * a good choice for exactly that reason.
 */
export interface ChartTokens {
  readonly series: readonly string[];
  /** Planned vs. actual on the production chart. */
  readonly plan: string;
  readonly actual: string;
  readonly grid: string;
  readonly axis: string;
}

/**
 * Light.
 *
 * Two deliberate departures from the palette this replaced, both of them the reason it read as
 * an unfinished admin template rather than a tool:
 *
 *   * **The greys are neutral, not blue.** The old ground and borders were blue-tinted
 *     (`#F4F6FA`, `#E5E9F0`, `#94A3B8`) and so was the accent, which put the entire interface in
 *     one narrow hue band. Nothing stood out because everything was already slightly blue.
 *     Neutral greys make the accent the only chromatic thing on screen, so it reads as emphasis
 *     without having to shout.
 *
 *   * **The borders are visible.** `#E5E9F0` on white is a 1.06:1 edge — technically drawn,
 *     practically invisible. Cards had no definition, table rows ran together, and the whole page
 *     read as one soft mass. A border either separates two things or should not be there.
 */
export const lightColors: ColorTokens = {
  bg: '#F5F5F6',
  surface: '#FFFFFF',
  surfaceSunken: '#FAFAFA',
  surfaceRaised: '#FFFFFF',

  // 1.16:1 against white. Still quiet, but it actually draws an edge.
  border: '#E4E4E7',
  borderStrong: '#D4D4D8',

  text: '#18181B',
  // 7.7:1 on white, 7.1:1 on the page ground. Muted must stay readable on both, because a caption
  // sits directly on the ground as often as it sits on a card.
  textMuted: '#52525B',
  textSubtle: '#71717A',
  textOnAccent: '#FFFFFF',

  /**
   * Indigo rather than the default blue.
   *
   * Blue-600 is the colour every framework ships with, and next to blue-grey neutrals it read as
   * "unstyled" rather than chosen. Indigo carries further from the neutrals and, more usefully,
   * sits well away from the green/amber/red the state badges own — so an accent badge is never
   * one glance from being read as a status.
   */
  accent: '#4F46E5',
  accentHover: '#4338CA',
  accentPressed: '#3730A3',
  accentSoft: '#EEF2FF',
  accentSoftText: '#4338CA',

  stateWorking: '#DCFCE7',
  stateWorkingText: '#15803D',
  stateWorkingBorder: '#BBF7D0',

  // Amber-700 rather than amber-600: this token is used as text on the dashboard, not only as a
  // dot, and amber-600 sits just under AA on white.
  warning: '#B45309',
  warningSoft: '#FEF3C7',
  warningSoftText: '#92400E',

  danger: '#DC2626',
  dangerSoft: '#FEE2E2',
  dangerSoftText: '#B91C1C',

  navBg: '#18181B',
  navText: '#A1A1AA',
  navTextActive: '#FFFFFF',
  navActiveBg: '#4F46E5',
  navHoverBg: 'rgba(255, 255, 255, 0.07)',
  navBorder: '#27272A',

  chrome: 'rgba(255, 255, 255, 0.72)',
  chromeBorder: 'rgba(24, 24, 27, 0.09)',

  scrim: 'rgba(9, 9, 11, 0.45)',

  focusRing: '#4F46E5',
};

/**
 * Dark.
 *
 * Neutral near-blacks, matching the light palette's move away from a blue cast. The previous set
 * tinted every dark surface blue, which fought the accent instead of framing it.
 */
export const darkColors: ColorTokens = {
  bg: '#09090B',
  surface: '#18181B',
  surfaceSunken: '#131316',
  // In dark, elevation comes from *lighter* surfaces. A shadow on a black ground is invisible.
  surfaceRaised: '#27272A',

  border: '#27272A',
  borderStrong: '#3F3F46',

  text: '#FAFAFA',
  // Deliberately above the 4.5:1 line against `surface` — muted must still be readable, not grey
  // mush. Anything genuinely decorative uses `textSubtle`.
  textMuted: '#A1A1AA',
  textSubtle: '#71717A',
  /**
   * Near-black, not white — and this is the consequence of lifting the accent below.
   *
   * `accent` is lifted so it reads as *text* on a dark ground. That same lift makes it a lighter
   * *fill*, and white on #818CF8 measures 2.8:1 — far under AA for a primary button label. The
   * deep indigo below measures 5.4:1 against the same fill. Following the palette's own rule, the
   * foreground is chosen by measurement rather than by assuming white. The alternative —
   * darkening the fill — gives a muddy button on a near-black ground and costs the accent its
   * legibility as text.
   */
  textOnAccent: '#1E1B4B',

  // Lifted two steps from the light palette. Indigo-600 on a black ground is heavy and dim.
  accent: '#818CF8',
  accentHover: '#A5B4FC',
  accentPressed: '#6366F1',
  accentSoft: 'rgba(129, 140, 248, 0.16)',
  accentSoftText: '#C7D2FE',

  stateWorking: 'rgba(34, 197, 94, 0.15)',
  stateWorkingText: '#4ADE80',
  stateWorkingBorder: 'rgba(34, 197, 94, 0.3)',

  warning: '#F59E0B',
  warningSoft: 'rgba(245, 158, 11, 0.15)',
  warningSoftText: '#FCD34D',

  danger: '#EF4444',
  dangerSoft: 'rgba(239, 68, 68, 0.15)',
  dangerSoftText: '#FCA5A5',

  // The sidebar goes *darker* than the surface in dark mode, keeping the same structural
  // relationship it has in light: navigation recedes, content comes forward.
  navBg: '#060608',
  navText: '#8A8A93',
  navTextActive: '#FAFAFA',
  // The same value as `accent`, so one foreground token serves both. Keeping the light palette's
  // #4F46E5 here would need white text while the accent needs dark — two rules for one idea.
  navActiveBg: '#818CF8',
  navHoverBg: 'rgba(255, 255, 255, 0.06)',
  navBorder: '#1C1C20',

  chrome: 'rgba(24, 24, 27, 0.72)',
  chromeBorder: 'rgba(255, 255, 255, 0.08)',

  scrim: 'rgba(0, 0, 0, 0.65)',

  focusRing: '#818CF8',
};

/**
 * Series order is indigo → orange → teal → pink.
 *
 * Blue and orange first because they are the pair that survives every common form of colour
 * vision deficiency; teal and pink next because they separate from both. Green is deliberately
 * *not* in the first four — it is the working-state colour everywhere else in the interface, and
 * a green line on a chart next to a green badge invites reading one as the other.
 */
export const lightChart: ChartTokens = {
  series: ['#4F46E5', '#EA580C', '#0D9488', '#DB2777', '#7C3AED', '#65A30D'],
  plan: '#4F46E5',
  actual: '#0D9488',
  grid: '#EFEFF1',
  axis: '#71717A',
};

export const darkChart: ChartTokens = {
  series: ['#818CF8', '#FB923C', '#2DD4BF', '#F472B6', '#A78BFA', '#A3E635'],
  plan: '#818CF8',
  actual: '#2DD4BF',
  grid: '#1F1F23',
  axis: '#71717A',
};

export function colorsFor(mode: ThemeMode): ColorTokens {
  return mode === 'dark' ? darkColors : lightColors;
}

export function chartFor(mode: ThemeMode): ChartTokens {
  return mode === 'dark' ? darkChart : lightChart;
}
