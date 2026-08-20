'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { ThemeMode } from '../tokens';
import { UNBRANDED, type Brand } from '../brand/tokens';

export type ThemePreference = ThemeMode | 'system';

export const THEME_STORAGE_KEY = 'ay-theme';

interface ThemeContextValue {
  /** What the user chose. */
  readonly preference: ThemePreference;
  /** What is actually rendering — `system` resolved against the OS setting. */
  readonly mode: ThemeMode;
  readonly brand: Brand;
  setPreference(preference: ThemePreference): void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

/**
 * The script that runs before first paint.
 *
 * It has to be inline and blocking. Reading the stored preference in an effect means the page
 * paints light, then flips — a white flash in a dark room, on a phone, at 05:00, which is
 * exactly when a night-shift worker opens this. Better to block for a fraction of a millisecond.
 *
 * It also sets `color-scheme` so form controls, scrollbars and the browser's own chrome match
 * before any of our CSS has loaded.
 */
export const themeInitScript = `
(function(){
  try {
    var stored = localStorage.getItem('${THEME_STORAGE_KEY}');
    var mode = stored === 'light' || stored === 'dark'
      ? stored
      : (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    var root = document.documentElement;
    root.setAttribute('data-theme', mode);
    root.style.colorScheme = mode;
  } catch (e) {
    document.documentElement.setAttribute('data-theme', 'light');
  }
})();
`.trim();

export interface ThemeProviderProps {
  readonly children: ReactNode;
  /** The customer's branding, resolved server-side from OrganizationBranding. */
  readonly brand?: Brand;
  /** Server-rendered default. The init script has usually already corrected the DOM. */
  readonly defaultPreference?: ThemePreference;
}

export function ThemeProvider({
  children,
  brand = UNBRANDED,
  defaultPreference = 'system',
}: ThemeProviderProps) {
  const [preference, setPreferenceState] = useState<ThemePreference>(defaultPreference);
  const [systemMode, setSystemMode] = useState<ThemeMode>('light');

  // Adopt what the init script already decided, so the first client render agrees with the DOM
  // instead of fighting it.
  useEffect(() => {
    const stored = readStoredPreference();
    if (stored) setPreferenceState(stored);

    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const sync = (): void => setSystemMode(query.matches ? 'dark' : 'light');
    sync();
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);

  const mode: ThemeMode = preference === 'system' ? systemMode : preference;

  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute('data-theme', mode);
    root.style.colorScheme = mode;
  }, [mode]);

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    try {
      if (next === 'system') {
        localStorage.removeItem(THEME_STORAGE_KEY);
      } else {
        localStorage.setItem(THEME_STORAGE_KEY, next);
      }
    } catch {
      // Private mode, storage disabled — the preference simply does not persist. Not worth
      // failing a render over.
    }
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({ preference, mode, brand, setPreference }),
    [preference, mode, brand, setPreference],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used inside a ThemeProvider.');
  }
  return context;
}

function readStoredPreference(): ThemePreference | null {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return stored === 'light' || stored === 'dark' ? stored : null;
  } catch {
    return null;
  }
}
