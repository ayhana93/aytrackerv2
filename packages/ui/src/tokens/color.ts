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

export const lightColors: ColorTokens = {
  bg: '#F4F6FA',
  surface: '#FFFFFF',
  surfaceSunken: '#F8FAFC',
  surfaceRaised: '#FFFFFF',

  border: '#E5E9F0',
  borderStrong: '#CBD5E1',

  text: '#0F172A',
  // Measured against the page ground (#F4F6FA), not against white. A caption sits directly on the
  // ground as often as it sits on a card, and the lighter #64748B cleared AA on white while
  // missing it on the ground — readable in a component preview, marginal on the actual page.
  textMuted: '#5B6879',
  textSubtle: '#94A3B8',
  textOnAccent: '#FFFFFF',

  accent: '#2563EB',
  accentHover: '#1D4ED8',
  accentPressed: '#1E40AF',
  accentSoft: '#EFF6FF',
  accentSoftText: '#1D4ED8',

  stateWorking: '#DCFCE7',
  stateWorkingText: '#15803D',
  stateWorkingBorder: '#BBF7D0',

  warning: '#D97706',
  warningSoft: '#FEF3C7',
  warningSoftText: '#B45309',

  danger: '#DC2626',
  dangerSoft: '#FEE2E2',
  dangerSoftText: '#B91C1C',

  navBg: '#111827',
  navText: '#94A3B8',
  navTextActive: '#FFFFFF',
  navActiveBg: '#2563EB',
  navHoverBg: 'rgba(255, 255, 255, 0.06)',
  navBorder: '#1F2937',

  chrome: 'rgba(255, 255, 255, 0.72)',
  chromeBorder: 'rgba(15, 23, 42, 0.08)',

  scrim: 'rgba(15, 23, 42, 0.4)',

  focusRing: '#2563EB',
};

export const darkColors: ColorTokens = {
  // Near-black with a blue cast rather than neutral grey: it reads as the same product at night,
  // and it keeps the brand blue from looking alien against it.
  bg: '#080C14',
  surface: '#0F1623',
  surfaceSunken: '#0B111C',
  // In dark, elevation comes from *lighter* surfaces. A shadow on a black ground is invisible.
  surfaceRaised: '#16202F',

  border: '#1F2A3C',
  borderStrong: '#2E3B52',

  text: '#F1F5F9',
  // Deliberately above the 4.5:1 line against `surface` — muted must still be readable, not grey
  // mush. Anything genuinely decorative uses `textSubtle`.
  textMuted: '#94A3B8',
  textSubtle: '#64748B',
  /**
   * Near-black, not white — and this is the consequence of lifting the accent below.
   *
   * `accent` is lifted so it reads as *text* on a dark ground. That same lift makes it a lighter
   * *fill*, and white on #3B82F6 measures 3.68:1 — under AA for a primary button label. Black
   * against the same fill measures 5.71:1. Following the palette's own rule, the foreground is
   * chosen by measurement rather than by assuming white, which is what a light-blue button with
   * dark text amounts to. The alternative — darkening the fill — gives a muddy button on a
   * near-black ground and costs the accent its legibility as text.
   */
  textOnAccent: '#0B1220',

  // Lifted one step from the light palette. #2563EB on a black ground is heavy and dim.
  accent: '#3B82F6',
  accentHover: '#60A5FA',
  accentPressed: '#2563EB',
  accentSoft: 'rgba(59, 130, 246, 0.14)',
  accentSoftText: '#93C5FD',

  stateWorking: 'rgba(34, 197, 94, 0.14)',
  stateWorkingText: '#4ADE80',
  stateWorkingBorder: 'rgba(34, 197, 94, 0.28)',

  warning: '#F59E0B',
  warningSoft: 'rgba(245, 158, 11, 0.14)',
  warningSoftText: '#FCD34D',

  danger: '#EF4444',
  dangerSoft: 'rgba(239, 68, 68, 0.14)',
  dangerSoftText: '#FCA5A5',

  // The sidebar goes *darker* than the surface in dark mode, keeping the same structural
  // relationship it has in light: navigation recedes, content comes forward.
  navBg: '#060A11',
  navText: '#64748B',
  navTextActive: '#F1F5F9',
  // The same value as `accent`, so one foreground token serves both. Keeping the light palette's
  // #2563EB here would need white text while the accent needs dark — two rules for one idea.
  navActiveBg: '#3B82F6',
  navHoverBg: 'rgba(255, 255, 255, 0.05)',
  navBorder: '#161F2E',

  chrome: 'rgba(15, 22, 35, 0.72)',
  chromeBorder: 'rgba(255, 255, 255, 0.08)',

  scrim: 'rgba(0, 0, 0, 0.6)',

  focusRing: '#60A5FA',
};

export const lightChart: ChartTokens = {
  series: ['#3B82F6', '#22C55E', '#A855F7', '#F59E0B', '#EC4899', '#14B8A6'],
  plan: '#3B82F6',
  actual: '#22C55E',
  grid: '#EEF2F7',
  axis: '#94A3B8',
};

export const darkChart: ChartTokens = {
  series: ['#60A5FA', '#4ADE80', '#C084FC', '#FBBF24', '#F472B6', '#2DD4BF'],
  plan: '#60A5FA',
  actual: '#4ADE80',
  grid: '#18212F',
  axis: '#64748B',
};

export function colorsFor(mode: ThemeMode): ColorTokens {
  return mode === 'dark' ? darkColors : lightColors;
}

export function chartFor(mode: ThemeMode): ChartTokens {
  return mode === 'dark' ? darkChart : lightChart;
}
