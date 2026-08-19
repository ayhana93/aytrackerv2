/**
 * @aytracker/tracking-client — location collection on the device.
 *
 * Shared between the web app and a native wrapper, which is why it is a package rather than
 * app code: the driver portal is written against one `LocationCollector` and does not know or
 * care whether a browser or a background service is underneath.
 *
 * Read `capabilities.ts` first. It states, without hedging, what the web platform can and
 * cannot do about recording with the display off.
 */

export * from './types';
export * from './capabilities';
export * from './queue';
export { WebLocationCollector } from './web-collector';
export { NativeLocationCollector } from './native-collector';

import { detectCapabilities } from './capabilities';
import { NativeLocationCollector } from './native-collector';
import { WebLocationCollector } from './web-collector';
import type { CollectorOptions, LocationCollector } from './types';

/**
 * Picks the best collector this device can actually run.
 *
 * Native when a wrapper is present, browser otherwise. The caller pairs this with
 * `detectCapabilities()` so the interface can tell the driver what will happen when the screen
 * goes off — rather than letting them find out at the end of the route.
 */
export function createLocationCollector(options: CollectorOptions): LocationCollector {
  return detectCapabilities().native
    ? new NativeLocationCollector(options)
    : new WebLocationCollector(options);
}
