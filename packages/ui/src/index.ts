/**
 * @aytracker/ui — the design system.
 *
 * Tokens, theming and interface primitives, built from the design reference. Two properties are
 * load-bearing:
 *
 *   * **Light and dark are both first-class.** The dark palette is authored rather than derived,
 *     because inverting lightness produces muddy surfaces and neon accents.
 *
 *   * **A customer's brand reaches only the accent family.** It cannot touch surface, text or
 *     state colours, and the foreground on a branded surface is computed for contrast — so no
 *     colour a customer picks can make their own workers' interface unreadable.
 */

export * from './tokens';
export * from './theme';
export * from './brand/index';
export * from './primitives/index';
