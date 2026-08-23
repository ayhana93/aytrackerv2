/**
 * Where a logo is served from, in one place.
 *
 * The URL is absolute rather than a path because the browser that renders it is on a different
 * origin from the API in every deployment this product has — a relative `/api/v1/...` in an
 * `<img src>` resolves against the web app, which does not serve it.
 *
 * Built from `API_URL` rather than from the incoming request's Host header. A Host header is
 * attacker-controlled, and this value ends up stored in nothing but is rendered on login pages;
 * deriving it from configuration keeps a spoofed header from redirecting a tenant's logo at a
 * host somebody else owns.
 */
export function logoAssetUrl(apiUrl: string, logoId: string): string {
  return new URL(`/api/v1/branding/logos/${logoId}`, apiUrl).toString();
}

/**
 * The name to show for an organization.
 *
 * `branding.companyName` wins because it is the display name a customer chose; the organization's
 * own `name` is what they registered with and is what everything else — invoices, support, the
 * tenant list — knows them as. Falling back to it means a customer who has set no branding still
 * sees themselves, never the product's name.
 */
export function displayName(
  organization: { name: string },
  branding: { companyName: string | null } | null,
): string {
  const chosen = branding?.companyName?.trim();
  return chosen ? chosen : organization.name;
}
