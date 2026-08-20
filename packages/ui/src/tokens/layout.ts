/**
 * Spacing, radii, shadows and touch targets.
 *
 * Spacing is a 4px-based scale expressed in `rem`, so raising the system text size scales the
 * layout with the type instead of cramping it.
 */

export const space = {
  0: '0',
  1: '0.25rem',
  2: '0.5rem',
  3: '0.75rem',
  4: '1rem',
  5: '1.25rem',
  6: '1.5rem',
  8: '2rem',
  10: '2.5rem',
  12: '3rem',
  16: '4rem',
} as const;

export const radius = {
  sm: '6px',
  md: '10px',
  /** Cards and panels — the reference uses a generous but not pill-like corner. */
  lg: '14px',
  xl: '20px',
  full: '9999px',
} as const;

/**
 * Shadows for the light theme only.
 *
 * In dark, elevation is expressed by lightening the surface — a shadow on a near-black ground is
 * invisible, so `themeShadows` returns flat values there and the surface tokens do the work.
 */
export const lightShadow = {
  none: 'none',
  sm: '0 1px 2px rgba(15, 23, 42, 0.05)',
  md: '0 1px 3px rgba(15, 23, 42, 0.08), 0 1px 2px rgba(15, 23, 42, 0.04)',
  lg: '0 4px 12px rgba(15, 23, 42, 0.08), 0 2px 4px rgba(15, 23, 42, 0.04)',
  /** Sheets and popovers, which must read as clearly detached. */
  overlay: '0 16px 48px rgba(15, 23, 42, 0.18), 0 4px 12px rgba(15, 23, 42, 0.08)',
} as const;

export const darkShadow = {
  none: 'none',
  sm: 'none',
  md: 'none',
  lg: 'none',
  // The one place a dark shadow earns its keep: a sheet lifting off the ground needs separation
  // that a surface-lightening step alone does not give.
  overlay: '0 16px 48px rgba(0, 0, 0, 0.56)',
} as const;

export type ShadowToken = keyof typeof lightShadow;

export function shadowsFor(mode: 'light' | 'dark'): Record<ShadowToken, string> {
  return mode === 'dark' ? darkShadow : lightShadow;
}

/**
 * Minimum touch target.
 *
 * 44px is the floor, and the worker portal is why it is not negotiable: the primary users are
 * wearing gloves, on a factory floor, in a hurry. Anything smaller costs them a mis-tap, and a
 * mis-tap on the position picker costs a supervisor a correction.
 */
export const touchTarget = {
  min: '44px',
  /** The primary actions on the worker home screen deserve more than the minimum. */
  comfortable: '52px',
} as const;

export const layout = {
  /** Admin sidebar. */
  sidebarWidth: '17rem',
  /** Bottom tab bar on the worker and driver portals. */
  tabBarHeight: '4rem',
  /** Mobile content max width, so the portals stay usable on a tablet. */
  portalMaxWidth: '30rem',
  contentMaxWidth: '90rem',
} as const;

/**
 * Safe-area insets.
 *
 * The driver portal runs full-screen on a phone in a cradle; the tab bar must clear the home
 * indicator or the "КРАЙ НА МАРШРУТ" button sits under it.
 */
export const safeArea = {
  top: 'env(safe-area-inset-top, 0px)',
  bottom: 'env(safe-area-inset-bottom, 0px)',
} as const;

export const zIndex = {
  base: 0,
  sticky: 10,
  tabBar: 20,
  scrim: 40,
  sheet: 50,
  popover: 60,
  toast: 70,
} as const;
