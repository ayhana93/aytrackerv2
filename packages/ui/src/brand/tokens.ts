/**
 * White-label theming — how a customer's brand reaches the interface.
 *
 * The product's own colours are not here. They live in `tokens/color.ts`, authored per theme, and
 * they are what renders when a customer has set nothing. This file is only the override path: a
 * small set of semantic CSS custom properties, derived server-side from OrganizationBranding.
 *
 * The rules:
 *   * One application, many brands. Never a build per customer.
 *   * Components consume semantic tokens (`--ay-accent`), never a customer's raw hex.
 *   * Contrast is verified against the customer's colour, not assumed — a brand colour that
 *     fails WCAG AA against the surface gets a computed readable foreground rather than
 *     unreadable text.
 *   * **An unset colour is `null`, never a stand-in value.** A default hex here silently replaces
 *     the design system's own accent for every tenant that has not branded anything, and because
 *     it still renders as *a* colour nobody notices. That is exactly what happened: a grey
 *     placeholder primary overrode the product blue across every screen.
 */

export interface BrandColors {
  /** The customer's colour, or null when they have set none and the product palette applies. */
  readonly primary: string | null;
  readonly secondary: string | null;
  readonly accent: string | null;
}

export interface BrandAssets {
  readonly logoUrl: string | null;
  readonly logoLightUrl: string | null;
  readonly logoDarkUrl: string | null;
  readonly faviconUrl: string | null;
}

export interface Brand {
  readonly organizationId: string;
  readonly companyName: string;
  readonly colors: BrandColors;
  readonly assets: BrandAssets;
  readonly loginMessage: string | null;
  readonly supportEmail: string | null;
}

/**
 * No customer branding.
 *
 * Every colour is null, so nothing is overridden and the design system's own palette renders —
 * including its per-theme accent, which a single brand hex could not express.
 */
export const UNBRANDED: Brand = {
  organizationId: '',
  companyName: 'AYtracker',
  colors: { primary: null, secondary: null, accent: null },
  assets: { logoUrl: null, logoLightUrl: null, logoDarkUrl: null, faviconUrl: null },
  loginMessage: null,
  supportEmail: null,
};

// Canonical definition lives with the colour tokens; re-exported here so the brand helpers
// below read naturally without importing from two places.
export type { ThemeMode } from '../tokens/color';
import type { ThemeMode } from '../tokens/color';

/**
 * Turns a brand into CSS custom properties.
 *
 * Kept as a pure function so it can run on the server and be inlined into the first HTML
 * response — a white-labelled login page must not flash AYtracker's colours before the
 * customer's arrive.
 */
export function brandToCssVariables(
  brand: Brand,
  mode: ThemeMode = 'light',
): Record<string, string> {
  const variables: Record<string, string> = {
    '--ay-color-surface': mode === 'dark' ? '#0f172a' : '#ffffff',
    '--ay-color-surface-foreground': mode === 'dark' ? '#f8fafc' : '#0f172a',
  };

  // A colour the customer has not set emits no variable at all, so the design system's own token
  // stands. Emitting a fallback hex here would be the same mistake in a different place.
  if (brand.colors.primary) {
    variables['--ay-color-primary'] = brand.colors.primary;
    variables['--ay-color-primary-foreground'] = readableForeground(brand.colors.primary);
  }
  if (brand.colors.secondary) {
    variables['--ay-color-secondary'] = brand.colors.secondary;
  }
  if (brand.colors.accent) {
    variables['--ay-color-accent'] = brand.colors.accent;
    variables['--ay-color-accent-foreground'] = readableForeground(brand.colors.accent);
  }

  return variables;
}

export function cssVariablesToStyleString(variables: Record<string, string>): string {
  return Object.entries(variables)
    .map(([key, value]) => `${key}:${value}`)
    .join(';');
}

/** Relative luminance per WCAG 2.1. */
export function relativeLuminance(hexColor: string): number {
  const { r, g, b } = hexToRgb(hexColor);
  const channel = (value: number): number => {
    const normalized = value / 255;
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(foreground: string, background: string): number {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Picks black or white text for a brand colour.
 *
 * A customer whose brand colour is a light yellow must not end up with white-on-yellow buttons.
 * Accessibility is not something the customer can switch off by choosing a colour.
 */
export function readableForeground(backgroundHex: string): string {
  return contrastRatio('#ffffff', backgroundHex) >= contrastRatio('#000000', backgroundHex)
    ? '#ffffff'
    : '#000000';
}

/**
 * How far a colour clears the WCAG bar, as three states rather than a boolean.
 *
 * A boolean forces a choice of bar, and whichever one is chosen the answer is misleading half the
 * time: 3.5:1 announced as "AA" is a lie for body text, and announced as "fails" is a lie for a
 * heading. The branding screen shows all three so a customer picking a colour knows exactly what
 * they are trading.
 */
export type ContrastGrade = 'AA' | 'AA_LARGE' | 'FAIL';

export function gradeContrast(foreground: string, background: string): ContrastGrade {
  const ratio = contrastRatio(foreground, background);
  if (ratio >= 4.5) return 'AA';
  if (ratio >= 3) return 'AA_LARGE';
  return 'FAIL';
}

export function meetsContrastAA(
  foreground: string,
  background: string,
  largeText = false,
): boolean {
  return contrastRatio(foreground, background) >= (largeText ? 3 : 4.5);
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const normalized = hex.replace('#', '');
  const expanded =
    normalized.length === 3
      ? normalized
          .split('')
          .map((char) => char + char)
          .join('')
      : normalized;
  if (!/^[0-9a-fA-F]{6}$/.test(expanded)) {
    // An invalid colour must not crash a customer's login page.
    return { r: 0, g: 0, b: 0 };
  }
  return {
    r: Number.parseInt(expanded.slice(0, 2), 16),
    g: Number.parseInt(expanded.slice(2, 4), 16),
    b: Number.parseInt(expanded.slice(4, 6), 16),
  };
}

/** The logo to render for a theme, falling back through the available assets. */
export function logoForMode(brand: Brand, mode: ThemeMode): string | null {
  if (mode === 'dark') return brand.assets.logoDarkUrl ?? brand.assets.logoUrl;
  return brand.assets.logoLightUrl ?? brand.assets.logoUrl;
}
