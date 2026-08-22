'use client';

import { useEffect, useState } from 'react';
import { apiRequest } from './api';

/**
 * Whose product this is, as far as the person looking at the screen is concerned.
 *
 * Everywhere a signed-in or tenant-scoped screen would have said "AYTRACKER" it says the
 * organization's name instead, and shows the organization's logo. That is not decoration: the
 * people using the worker and driver portals work for the customer, not for us, and a factory
 * tablet that greets them with a vendor's name is a tablet nobody recognizes as theirs.
 *
 * The product name survives in exactly two places, both of which are ours rather than a tenant's:
 * the sign-up page, where no organization exists yet, and the admin login, which is the product's
 * own front door and has no tenant to be branded as.
 */

/** The fallback, used only where no organization is known. */
export const PRODUCT_NAME = 'AYTRACKER';

export interface PublicBrand {
  readonly organizationSlug: string;
  readonly organizationName: string;
  readonly logoUrl: string | null;
  readonly primaryColor: string | null;
  readonly loginMessage: string | null;
}

export const brandApi = {
  /** A tenant's public identity by the company code its staff type. Needs no session. */
  forSlug: (slug: string) => apiRequest<PublicBrand>('/branding/public', { query: { slug } }),
};

/**
 * The company code, remembered per device.
 *
 * A tablet by the workshop door serves the same organization every shift; a worker's own phone
 * serves the same organization for years. Asking again each time is asking for a value they have
 * to go and find. Wrapped in try/catch because a browser with site data blocked throws on the
 * accessor itself, and a login screen that will not render is worse than one that forgets.
 *
 * It lives here rather than in the login component because the portals need it too: it is how a
 * screen that has not fetched a session yet still knows whose logo to show.
 */
const SLUG_KEY = 'aytracker.organization';

export function rememberedSlug(): string {
  try {
    return window.localStorage.getItem(SLUG_KEY) ?? '';
  } catch {
    return '';
  }
}

export function rememberSlug(slug: string): void {
  try {
    window.localStorage.setItem(SLUG_KEY, slug);
  } catch {
    // A device that will not store it simply asks again. Not worth telling anyone about.
  }
}

/**
 * The branding for a company code, or null while there is none to show.
 *
 * Null covers three states on purpose — no code typed yet, a code that matches no organization,
 * and a request still in flight — because every one of them renders the same thing: the neutral
 * mark. Distinguishing them would put "no such company" under a half-typed code, which is both
 * wrong and a way to probe for tenant names.
 *
 * Debounced, because the caller is a text field a person is typing into.
 */
export function usePublicBrand(slug: string | null): PublicBrand | null {
  const [brand, setBrand] = useState<PublicBrand | null>(null);
  const normalized = slug?.trim().toLowerCase() ?? '';

  useEffect(() => {
    if (normalized === '') {
      setBrand(null);
      return;
    }

    let cancelled = false;
    const timer = setTimeout(() => {
      brandApi
        .forSlug(normalized)
        .then((found) => {
          if (!cancelled) setBrand(found);
        })
        .catch(() => {
          // An unknown code is the normal state of a field being typed into, not an error worth
          // showing. The form's own submit reports a genuinely wrong code, once, after a try.
          if (!cancelled) setBrand(null);
        });
    }, 300);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [normalized]);

  return brand;
}

/** The branding of whichever organization this device last signed in to. */
export function useRememberedBrand(): PublicBrand | null {
  const [slug, setSlug] = useState<string | null>(null);
  // Read in an effect rather than during render: localStorage does not exist on the server, and
  // reading it during render is what makes a page hydrate into different markup than it shipped.
  useEffect(() => setSlug(rememberedSlug()), []);
  return usePublicBrand(slug);
}
