import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildThemeVariables } from './theme/css-variables';
import { contrastRatio, meetsContrastAA, readableForeground } from './brand/tokens';
import { UNBRANDED } from './brand/tokens';
import { darkColors, lightColors, type ThemeMode } from './tokens/color';

/**
 * The design system's own invariants.
 *
 * The one that pays for itself is the first: a `var(--ay-thing)` that nothing defines fails
 * silently. The rule collapses, the layout shifts a little, nothing errors, and nobody finds out
 * until a screenshot looks slightly wrong. Three of these shipped in the admin shell — a touch
 * target, a transition duration and a border radius that all resolved to nothing — and neither
 * the typechecker, the linter nor the build said a word.
 *
 * Lives inside the package rather than in tests/ because it reads the stylesheet next to it and
 * imports the token modules directly, which keeps it honest about what the package itself
 * guarantees rather than what its public entry point happens to re-export.
 */

const BASE_CSS = readFileSync(fileURLToPath(new URL('./styles/base.css', import.meta.url)), 'utf8');

const MODES: readonly ThemeMode[] = ['light', 'dark'];

function definedVariables(mode: ThemeMode): Set<string> {
  return new Set(Object.keys(buildThemeVariables({ mode, brand: UNBRANDED })));
}

/**
 * Every `var(--ay-…)` in the stylesheet, minus those given an inline fallback.
 *
 * A fallback is an explicit statement that the author knows the variable may be absent, so those
 * are exempt; everything else is a claim that the token exists.
 */
function referencedVariables(): Set<string> {
  const referenced = new Set<string>();
  for (const match of BASE_CSS.matchAll(/var\((--ay-[a-z0-9-]+)\s*(,)?/g)) {
    if (match[2]) continue;
    referenced.add(match[1]!);
  }
  return referenced;
}

describe('css variables', () => {
  it.each(MODES)('every variable the stylesheet uses is defined in %s', (mode) => {
    const defined = definedVariables(mode);
    const missing = [...referencedVariables()].filter((name) => !defined.has(name));
    expect(missing).toEqual([]);
  });

  it('light and dark define exactly the same variable names', () => {
    // A token that exists in one theme only is a rule that silently stops applying when someone
    // switches themes — the hardest kind of visual bug to attribute.
    expect([...definedVariables('light')].sort()).toEqual([...definedVariables('dark')].sort());
  });

  it('the palettes carry the same keys', () => {
    expect(Object.keys(lightColors).sort()).toEqual(Object.keys(darkColors).sort());
  });
});

describe('contrast', () => {
  /**
   * The floor the interface must clear regardless of theme.
   *
   * Body text at AA, muted text at AA as well — "muted" must still be readable, not decorative.
   * Anything genuinely decorative uses `textSubtle`, which is held to the large-text bar.
   */
  it.each(MODES)('body and muted text clear AA on every surface in %s', (mode) => {
    const colors = mode === 'dark' ? darkColors : lightColors;
    for (const surface of [colors.bg, colors.surface, colors.surfaceSunken, colors.surfaceRaised]) {
      expect(meetsContrastAA(colors.text, surface), `text on ${surface}`).toBe(true);
      expect(meetsContrastAA(colors.textMuted, surface), `muted on ${surface}`).toBe(true);
    }
  });

  it.each(MODES)('text on the accent is readable in %s', (mode) => {
    const colors = mode === 'dark' ? darkColors : lightColors;
    expect(meetsContrastAA(colors.textOnAccent, colors.accent)).toBe(true);
  });

  it.each(MODES)('the sidebar reads in %s', (mode) => {
    const colors = mode === 'dark' ? darkColors : lightColors;
    expect(meetsContrastAA(colors.navTextActive, colors.navBg)).toBe(true);
    // The inactive item is the one at risk: it is quiet by design, and quiet is one step from
    // invisible. Held to the large-text bar because nav labels are set at 550 weight.
    expect(meetsContrastAA(colors.navText, colors.navBg, true)).toBe(true);
    expect(meetsContrastAA(colors.textOnAccent, colors.navActiveBg)).toBe(true);
  });

  it.each(MODES)('state colours read on their own soft backgrounds in %s', (mode) => {
    const colors = mode === 'dark' ? darkColors : lightColors;
    // Soft state backgrounds are translucent in dark, so they are tested over the surface they
    // actually sit on rather than in isolation.
    const base = mode === 'dark' ? darkColors.surface : lightColors.surface;
    expect(meetsContrastAA(colors.stateWorkingText, base)).toBe(true);
    expect(meetsContrastAA(colors.warningSoftText, base)).toBe(true);
    expect(meetsContrastAA(colors.dangerSoftText, base)).toBe(true);
    // The accent badge belongs in this list: it is the same shape of component and was the one
    // that rendered unreadable grey when the default brand was overriding the palette.
    expect(meetsContrastAA(colors.accentSoftText, base)).toBe(true);
  });
});

describe('an unbranded tenant gets the product palette', () => {
  /**
   * The bug this exists for: the default brand carried a grey placeholder hex, so the override
   * path fired for every tenant that had branded nothing and quietly replaced the design system's
   * blue with grey — across the sidebar, every accent badge and every focus ring.
   *
   * Nothing failed. It still rendered *a* colour, the contrast still passed, and the only way to
   * notice was to look at a screenshot and know what it was supposed to be. Hence an assertion
   * that the unbranded default equals the palette exactly.
   */
  it.each(MODES)('the accent family is untouched in %s', (mode) => {
    const colors = mode === 'dark' ? darkColors : lightColors;
    const vars = buildThemeVariables({ mode, brand: UNBRANDED });

    expect(vars['--ay-accent']).toBe(colors.accent);
    expect(vars['--ay-accent-soft']).toBe(colors.accentSoft);
    expect(vars['--ay-accent-soft-text']).toBe(colors.accentSoftText);
    expect(vars['--ay-text-on-accent']).toBe(colors.textOnAccent);
    expect(vars['--ay-nav-active-bg']).toBe(colors.navActiveBg);
    expect(vars['--ay-focus-ring']).toBe(colors.focusRing);
  });

  it.each(MODES)('passing no brand at all gives the same result in %s', (mode) => {
    expect(buildThemeVariables({ mode })).toEqual(buildThemeVariables({ mode, brand: UNBRANDED }));
  });

  it('the two themes get different accents, which one brand hex could not express', () => {
    // The reason an unset colour has to be null rather than a default hex: a single value applies
    // to both themes, and the dark accent is deliberately lifted so it reads on a near-black
    // ground. A default would flatten that distinction for everyone.
    expect(buildThemeVariables({ mode: 'light' })['--ay-accent']).not.toBe(
      buildThemeVariables({ mode: 'dark' })['--ay-accent'],
    );
  });
});

describe('a customer brand cannot make the interface unreadable', () => {
  /**
   * The white-label guarantee, tested at its worst case.
   *
   * A customer may pick any colour, including yellow. What must hold is that the text *on* that
   * colour stays readable, because `readableForeground` picks black or white by measurement
   * rather than assuming white.
   */
  it.each(['#FFFF00', '#000000', '#FFFFFF', '#2563EB', '#7C3AED', '#84CC16'])(
    'text on %s is readable',
    (brandColor) => {
      const foreground = readableForeground(brandColor);
      expect(contrastRatio(foreground, brandColor)).toBeGreaterThanOrEqual(4.5);
    },
  );

  it.each(MODES)('a brand override reaches the accent family and nothing else in %s', (mode) => {
    const neutral = buildThemeVariables({ mode, brand: UNBRANDED });
    const branded = buildThemeVariables({
      mode,
      brand: {
        ...UNBRANDED,
        colors: { primary: '#84CC16', secondary: '#84CC16', accent: '#84CC16' },
      },
    });

    const changed = new Set(Object.keys(branded).filter((key) => branded[key] !== neutral[key]));

    /**
     * Named one by one rather than matched by prefix.
     *
     * `--ay-text-on-accent` starts with `--ay-text` and *must* move with the brand — it is the
     * computed foreground that keeps a pale brand colour readable. A prefix rule would have
     * flagged the very mechanism that makes branding safe, so the list is explicit.
     */
    const mustNotMove = [
      '--ay-bg',
      '--ay-surface',
      '--ay-surface-sunken',
      '--ay-surface-raised',
      '--ay-text',
      '--ay-text-muted',
      '--ay-text-subtle',
      '--ay-border',
      '--ay-border-strong',
      '--ay-state-working',
      '--ay-state-working-text',
      '--ay-warning',
      '--ay-warning-soft-text',
      '--ay-danger',
      '--ay-danger-soft-text',
    ];
    for (const key of mustNotMove) {
      expect(neutral[key], `${key} is not a token`).toBeDefined();
      expect(changed.has(key), `${key} changed with the brand`).toBe(false);
    }

    // And the brand must actually have reached the accent, or the test would pass vacuously.
    expect(changed.has('--ay-accent')).toBe(true);
    expect(changed.has('--ay-text-on-accent')).toBe(true);
  });
});
