import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { ThemeProvider, UNBRANDED, themeInitScript, themeStyleTag } from '@aytracker/ui';
import '@aytracker/ui/styles.css';
import './globals.css';

/**
 * Root layout.
 *
 * Two things happen before the first paint, in this order, and the order is the point:
 *
 *   1. The full token set — including the customer's brand — is written into a `<style>` tag.
 *      A white-labelled login page that paints in AYtracker's colours and then flips to the
 *      customer's is worse than no branding at all.
 *
 *   2. A blocking inline script resolves the theme from storage or the OS and stamps
 *      `data-theme` on the root. Doing this in an effect means the page paints light and then
 *      flips — a white flash on a phone at 05:00, which is exactly when a night-shift worker
 *      opens it.
 *
 * Both are small enough that blocking on them costs less than the flash would.
 */
export const metadata: Metadata = {
  title: 'AYtracker',
  description: 'Manufacturing and fleet operations platform',
  applicationName: 'AYtracker',
  appleWebApp: { capable: true, statusBarStyle: 'default', title: 'AYtracker' },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // The worker and driver portals are apps in a cradle, not documents. Pinch-zooming a
  // full-screen control surface breaks the layout without helping anyone.
  maximumScale: 1,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#F4F6FA' },
    { media: '(prefers-color-scheme: dark)', color: '#080C14' },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  // Unbranded here, so the product's own palette renders. A tenant-scoped route resolves the real
  // brand from OrganizationBranding and passes it to both the style tag and the provider.
  const brand = UNBRANDED;

  return (
    <html lang="bg" suppressHydrationWarning>
      <head>
        <style
          // Tokens for both themes; `data-theme` selects which set applies.
          dangerouslySetInnerHTML={{
            __html: [
              themeStyleTag({ mode: 'light', brand }),
              `:root[data-theme='dark']{${themeStyleTag({ mode: 'dark', brand }).slice(6, -1)}}`,
            ].join('\n'),
          }}
        />
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body>
        <ThemeProvider brand={brand}>{children}</ThemeProvider>
      </body>
    </html>
  );
}
