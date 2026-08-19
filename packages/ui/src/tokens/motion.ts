/**
 * Motion tokens.
 *
 * Two questions decide every animation in this product, and they are answered here so no
 * component has to invent an answer:
 *
 *   **Should it animate at all?** Frequency decides. A worker changes position dozens of times a
 *   shift; a driver starts one trip a morning. The first must be instant, the second can breathe.
 *   See `shouldAnimate` below.
 *
 *   **How should it move?** Entering and exiting use `ease-out` — it starts fast, so the
 *   interface responds in the exact moment the eye is watching. `ease-in` is never used for UI:
 *   it delays the first movement and reads as sluggish at the same duration.
 *
 * The built-in CSS easings are too weak to feel intentional, so these are custom curves.
 */

export const easing = {
  /** Entering and exiting. The workhorse. */
  out: 'cubic-bezier(0.23, 1, 0.32, 1)',
  /** Moving or morphing something already on screen. */
  inOut: 'cubic-bezier(0.77, 0, 0.175, 1)',
  /** Sheets and drawers — the iOS curve. */
  drawer: 'cubic-bezier(0.32, 0.72, 0, 1)',
  /** Hover and colour changes only. */
  hover: 'ease',
  /** Constant motion: progress bars, the tracking pulse. */
  linear: 'linear',
} as const;

/**
 * Durations, in milliseconds.
 *
 * Everything a user touches stays under 300ms. Perceived speed is not a nicety here: a position
 * change that *feels* slow is a position change a worker stops making.
 */
export const duration = {
  /** Press feedback. Must be near-imperceptible. */
  press: 120,
  tooltip: 150,
  /** Dropdowns, the position picker's rows. */
  popover: 200,
  /** Full-screen step transitions in the worker flow. */
  screen: 260,
  /** Sheets and drawers, which travel further. */
  sheet: 320,
  /** Exits are faster than entrances — the decision is made, get out of the way. */
  exit: 180,
} as const;

/**
 * Spring configurations, in the bounce + duration form.
 *
 * Bounce is reserved for motion the user's own gesture put in flight. A sheet the driver flicked
 * away should overshoot slightly, because that is what a thrown object does. A menu that merely
 * appeared should not — overshoot there reads as the interface being pleased with itself.
 */
export const spring = {
  /** Critically damped. The default for anything that is not a gesture. */
  default: { type: 'spring', bounce: 0, duration: 0.4 },
  /** Released drags and flicks. */
  momentum: { type: 'spring', bounce: 0.2, duration: 0.4 },
  /** Sheets being dragged and released. */
  drawer: { type: 'spring', bounce: 0.2, duration: 0.3 },
} as const;

/**
 * Whether an interaction should animate, from how often it happens.
 *
 * The worker portal is the reason this exists. Position changes are the single most repeated
 * action in the product — the target is two to three seconds, dozens of times a shift. Animating
 * that path would tax every one of those repetitions for a flourish nobody asked for.
 */
export type InteractionFrequency = 'constant' | 'frequent' | 'occasional' | 'rare';

export function shouldAnimate(frequency: InteractionFrequency): boolean {
  return frequency !== 'constant';
}

export function durationFor(frequency: InteractionFrequency): number {
  switch (frequency) {
    // Keyboard shortcuts, the position picker opening. No animation at all.
    case 'constant':
      return 0;
    // Row selection, hover, tab switches. Present but nearly invisible.
    case 'frequent':
      return duration.press;
    // Confirming a position change, opening a sheet.
    case 'occasional':
      return duration.popover;
    // Starting a trip, completing onboarding. Room to be deliberate.
    case 'rare':
      return duration.sheet;
  }
}

/**
 * Reduced motion means gentler, not absent.
 *
 * Opacity and colour transitions survive because they aid comprehension. Movement, scale and
 * parallax are what cause discomfort, so those are what go.
 */
export const reducedMotionQuery = '(prefers-reduced-motion: reduce)';

export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia(reducedMotionQuery).matches;
}
