/**
 * @aytracker/tracking-client — location collection on the device.
 *
 * A package rather than app code because the portals are written against one
 * `LocationCollector` interface: the worker screen and the driver screen both ask for a
 * collector and neither knows how it gets a fix.
 *
 * Read `capabilities.ts` first. It states, without hedging, what the web platform can and
 * cannot do about recording with the display off — which is the single fact that shapes every
 * tracking screen in this product.
 */

export * from './types';
export * from './capabilities';
export * from './queue';
export { WebLocationCollector } from './web-collector';

import { WebLocationCollector } from './web-collector';
import type { CollectorOptions, LocationCollector } from './types';

/**
 * The collector for this device.
 *
 * One implementation, because this is a web product. The indirection stays because the portals
 * are better off depending on the interface than on the class — but there is no branch here
 * choosing between backends, and no dormant native path pretending to be one.
 */
export function createLocationCollector(options: CollectorOptions): LocationCollector {
  return new WebLocationCollector(options);
}
