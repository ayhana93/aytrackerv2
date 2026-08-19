import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { PLACEHOLDER_BRAND, brandToCssVariables, cssVariablesToStyleString } from '@aytracker/ui';
import './globals.css';

/**
 * Root layout.
 *
 * The brand's CSS custom properties are written into the root element's inline style during
 * server rendering. That ordering matters for a white-label product: a customer's login page
 * must never paint in AYtracker's colours and then flip to theirs.
 *
 * In a tenant-scoped route the brand comes from OrganizationBranding; here it is the neutral
 * placeholder, because this layout also serves the anonymous marketing and login routes.
 */
export const metadata: Metadata = {
  title: 'AYtracker',
  description: 'Manufacturing and fleet operations platform',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  const brandStyle = cssVariablesToStyleString(brandToCssVariables(PLACEHOLDER_BRAND, 'light'));

  return (
    <html lang="en" style={{ cssText: brandStyle } as never}>
      <body>{children}</body>
    </html>
  );
}
