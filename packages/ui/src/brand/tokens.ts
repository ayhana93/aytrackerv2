/**
 * White-label theming — the plumbing, not the design.
 *
 * IMPORTANT: the visual design of AYtracker has not been decided yet, and is not decided here.
 * This file defines *how* a customer's brand reaches the interface: a small set of semantic CSS
 * custom properties, derived server-side from OrganizationBranding, applied at the root of every
 * portal. The palette below is a neutral, accessible placeholder so the temporary UI is legible
 * during development; it will be replaced wholesale once a design reference is provided.
 *
 * The architectural rules that will survive that replacement:
 *   * One application, many brands. Never a build per customer.
 *   * Components consume semantic tokens (`--ay-color-primary`), never a customer's raw hex.
 *   * Contrast is verified against the customer's colour, not assumed — a brand colour that
 *     fails WCAG AA against the surface gets a computed readable foreground rather than
 *     unreadable text.
 */

export interface BrandColors {
  readonly primary: string;
  readonly secondary: string;
  readonly accent: string;
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

/** Neutral placeholder. Not a design decision — see the note at the top of this file. */
export const PLACEHOLDER_BRAND: Brand = {
  organizationId: '',
  companyName: 'AYtracker',
  colors: { primary: '#1f2937', secondary: '#4b5563', accent: '#2563eb' },
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
  const onPrimary = readableForeground(brand.colors.primary);
  const onAccent = readableForeground(brand.colors.accent);

  return {
    '--ay-color-primary': brand.colors.primary,
    '--ay-color-primary-foreground': onPrimary,
    '--ay-color-secondary': brand.colors.secondary,
    '--ay-color-accent': brand.colors.accent,
    '--ay-color-accent-foreground': onAccent,
    '--ay-color-surface': mode === 'dark' ? '#0f172a' : '#ffffff',
    '--ay-color-surface-foreground': mode === 'dark' ? '#f8fafc' : '#0f172a',
  };
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
