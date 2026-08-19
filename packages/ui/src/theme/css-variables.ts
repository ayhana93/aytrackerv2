import {
  chartFor,
  colorsFor,
  duration,
  easing,
  fontStack,
  layout,
  numericFontFeatures,
  radius,
  shadowsFor,
  space,
  touchTarget,
  typography,
  type ThemeMode,
} from '../tokens';
import { readableForeground, type Brand } from '../brand/tokens';

/**
 * Turns tokens plus a customer's brand into CSS custom properties.
 *
 * Pure, and deliberately so: it runs on the server and the result is inlined into the first HTML
 * response. A white-labelled login page that paints in AYtracker's colours and then flips to the
 * customer's is worse than no branding at all — the customer sees our product, then theirs.
 *
 * Precedence: base tokens → theme mode → brand overrides. The brand may only move the accent
 * family; it cannot reach the surface, text or state colours, because a customer choosing a
 * brand colour must not be able to make their own workers' interface unreadable.
 */
export function buildThemeVariables(input: {
  mode: ThemeMode;
  brand?: Brand | undefined;
}): Record<string, string> {
  const colors = colorsFor(input.mode);
  const chart = chartFor(input.mode);
  const shadow = shadowsFor(input.mode);

  const vars: Record<string, string> = {
    '--ay-bg': colors.bg,
    '--ay-surface': colors.surface,
    '--ay-surface-sunken': colors.surfaceSunken,
    '--ay-surface-raised': colors.surfaceRaised,

    '--ay-border': colors.border,
    '--ay-border-strong': colors.borderStrong,

    '--ay-text': colors.text,
    '--ay-text-muted': colors.textMuted,
    '--ay-text-subtle': colors.textSubtle,
    '--ay-text-on-accent': colors.textOnAccent,

    '--ay-accent': colors.accent,
    '--ay-accent-hover': colors.accentHover,
    '--ay-accent-pressed': colors.accentPressed,
    '--ay-accent-soft': colors.accentSoft,
    '--ay-accent-soft-text': colors.accentSoftText,

    '--ay-state-working': colors.stateWorking,
    '--ay-state-working-text': colors.stateWorkingText,
    '--ay-state-working-border': colors.stateWorkingBorder,

    '--ay-warning': colors.warning,
    '--ay-warning-soft': colors.warningSoft,
    '--ay-warning-soft-text': colors.warningSoftText,

    '--ay-danger': colors.danger,
    '--ay-danger-soft': colors.dangerSoft,
    '--ay-danger-soft-text': colors.dangerSoftText,

    '--ay-nav-bg': colors.navBg,
    '--ay-nav-text': colors.navText,
    '--ay-nav-text-active': colors.navTextActive,
    '--ay-nav-active-bg': colors.navActiveBg,
    '--ay-nav-border': colors.navBorder,

    '--ay-chrome': colors.chrome,
    '--ay-chrome-border': colors.chromeBorder,
    '--ay-scrim': colors.scrim,
    '--ay-focus-ring': colors.focusRing,

    '--ay-chart-plan': chart.plan,
    '--ay-chart-actual': chart.actual,
    '--ay-chart-grid': chart.grid,
    '--ay-chart-axis': chart.axis,

    '--ay-font': fontStack,
    '--ay-font-numeric': numericFontFeatures,

    '--ay-ease-out': easing.out,
    '--ay-ease-in-out': easing.inOut,
    '--ay-ease-drawer': easing.drawer,

    '--ay-duration-press': `${duration.press}ms`,
    '--ay-duration-popover': `${duration.popover}ms`,
    '--ay-duration-screen': `${duration.screen}ms`,
    '--ay-duration-sheet': `${duration.sheet}ms`,
    '--ay-duration-exit': `${duration.exit}ms`,

    '--ay-touch-min': touchTarget.min,
    '--ay-touch-comfortable': touchTarget.comfortable,

    '--ay-sidebar-width': layout.sidebarWidth,
    '--ay-tab-bar-height': layout.tabBarHeight,
    '--ay-portal-max-width': layout.portalMaxWidth,
    '--ay-content-max-width': layout.contentMaxWidth,
  };

  for (const [index, color] of chart.series.entries()) {
    vars[`--ay-chart-${index + 1}`] = color;
  }
  for (const [key, value] of Object.entries(space)) {
    vars[`--ay-space-${key}`] = value;
  }
  for (const [key, value] of Object.entries(radius)) {
    vars[`--ay-radius-${key}`] = value;
  }
  for (const [key, value] of Object.entries(shadow)) {
    vars[`--ay-shadow-${key}`] = value;
  }
  for (const [name, style] of Object.entries(typography)) {
    vars[`--ay-type-${name}-size`] = style.fontSize;
    vars[`--ay-type-${name}-leading`] = style.lineHeight;
    vars[`--ay-type-${name}-tracking`] = style.letterSpacing;
    vars[`--ay-type-${name}-weight`] = String(style.fontWeight);
  }

  if (input.brand) {
    Object.assign(vars, brandOverrides(input.brand, input.mode));
  }

  return vars;
}

/**
 * The brand's reach into the token set.
 *
 * Only the accent family. The foreground on a filled brand surface is *computed* from the
 * customer's colour rather than configured, so a customer whose brand is a pale yellow gets
 * black text on their buttons instead of unreadable white. Accessibility is not a setting the
 * customer can switch off by picking a colour.
 */
function brandOverrides(brand: Brand, mode: ThemeMode): Record<string, string> {
  const overrides: Record<string, string> = {};
  const primary = brand.colors.primary;

  if (isHexColor(primary)) {
    overrides['--ay-accent'] = primary;
    overrides['--ay-text-on-accent'] = readableForeground(primary);
    overrides['--ay-accent-hover'] = shiftLightness(primary, mode === 'dark' ? 0.12 : -0.08);
    overrides['--ay-accent-pressed'] = shiftLightness(primary, mode === 'dark' ? 0.2 : -0.16);
    overrides['--ay-accent-soft'] = withAlpha(primary, mode === 'dark' ? 0.16 : 0.08);
    overrides['--ay-accent-soft-text'] =
      mode === 'dark' ? shiftLightness(primary, 0.24) : shiftLightness(primary, -0.12);
    overrides['--ay-nav-active-bg'] = primary;
    overrides['--ay-focus-ring'] = primary;
  }
  if (isHexColor(brand.colors.accent)) {
    overrides['--ay-brand-accent'] = brand.colors.accent;
  }
  return overrides;
}

function isHexColor(value: string): boolean {
  return /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value);
}

function parseHex(hex: string): { r: number; g: number; b: number } {
  const normalized = hex.replace('#', '');
  const expanded =
    normalized.length === 3
      ? normalized
          .split('')
          .map((char) => char + char)
          .join('')
      : normalized;
  return {
    r: Number.parseInt(expanded.slice(0, 2), 16),
    g: Number.parseInt(expanded.slice(2, 4), 16),
    b: Number.parseInt(expanded.slice(4, 6), 16),
  };
}

function withAlpha(hex: string, alpha: number): string {
  const { r, g, b } = parseHex(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * Moves a colour toward white (positive) or black (negative).
 *
 * Not a true HSL rotation: mixing toward the extremes keeps the hue stable, which is what a
 * customer expects from "my brand blue, pressed". A hue-preserving lightness change in HSL can
 * drift noticeably on saturated colours.
 */
function shiftLightness(hex: string, amount: number): string {
  const { r, g, b } = parseHex(hex);
  const target = amount > 0 ? 255 : 0;
  const ratio = Math.abs(amount);
  const mix = (channel: number): number => Math.round(channel + (target - channel) * ratio);
  return `#${[mix(r), mix(g), mix(b)]
    .map((channel) => channel.toString(16).padStart(2, '0'))
    .join('')}`;
}

export function variablesToStyleString(variables: Record<string, string>): string {
  return Object.entries(variables)
    .map(([key, value]) => `${key}:${value}`)
    .join(';');
}

/** Serialised for a `<style>` tag in the document head during server rendering. */
export function themeStyleTag(input: { mode: ThemeMode; brand?: Brand | undefined }): string {
  return `:root{${variablesToStyleString(buildThemeVariables(input))}}`;
}
