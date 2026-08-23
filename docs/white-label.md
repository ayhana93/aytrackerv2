# White-label branding

Every customer uses AYtracker with their own branding. **One application, many brands** — never a
build or a deployment per customer.

---

## 1. Model

```
Organization ──1:1── OrganizationBranding ──► BrandProvider ──► shared UI
```

```
OrganizationBranding
  logoUrl, logoLightUrl, logoDarkUrl, faviconUrl,
  primaryColor, secondaryColor, accentColor,
  companyName, loginMessage, customSupportEmail,
  customDomain, customAppName          ← reserved, not yet implemented
```

The reserved fields exist so adding custom domains later is a feature, not a migration that
churns the schema.

---

## 2. Where branding appears

| Surface         | Shows                                       |
| --------------- | ------------------------------------------- |
| Worker login    | Customer logo, company name, login message  |
| Driver login    | Same                                        |
| Admin dashboard | Logo in the shell, brand colours throughout |
| Emails (future) | Logo, name, support address                 |

```
[ COMPANY LOGO ]

Welcome

Employee ID
PIN

[ LOGIN ]
```

---

## 3. Theming

A small set of **semantic** custom properties. Components consume tokens, never a customer's raw
hex value:

```css
--ay-color-primary            --ay-color-primary-foreground
--ay-color-secondary          --ay-color-accent
--ay-color-accent-foreground  --ay-color-surface
--ay-color-surface-foreground
```

`brandToCssVariables(brand, mode)` is a **pure function**, so it runs on the server and is inlined
into the first HTML response. A white-labelled login page must never flash AYtracker's colours
before the customer's arrive.

### Accessibility is not the customer's to switch off

```ts
readableForeground(backgroundHex)  // WCAG relative luminance → black or white
contrastRatio(fg, bg)
meetsContrastAA(fg, bg, largeText?)
```

A customer whose brand colour is a light yellow does not end up with white-on-yellow buttons. The
foreground is **computed**, not configured. An invalid colour degrades to black rather than
crashing a customer's login page.

Logo selection falls back: `logoDarkUrl → logoUrl` in dark mode, `logoLightUrl → logoUrl` in
light.

---

## 4. Asset security

Branding assets are rendered into a customer's login page. That makes them a supply chain.

**Object storage, never the database — with one recorded exception.** Blobs in Postgres bloat
backups and slow every query on the table.

The exception is the logo an organization uploads from `/admin/settings`. There is no bucket in
this deployment and a file written to a container filesystem is gone on the next deploy, which
would show customers their branding vanishing at random. Those bytes live in `organization_logos`,
a table of its own that nothing selects from except `GET /api/v1/branding/logos/:id` — so the cost
the rule was aimed at, every query on a hot table dragging a blob behind it, does not arise. When
object storage exists, `OrganizationBranding.logoUrl` is already the field that points at it and
the migration is a backfill rather than a redesign.

**Upload validation:**

| Check      | Rule                                                |
| ---------- | --------------------------------------------------- |
| MIME type  | Sniffed from content, never trusted from the header |
| Extension  | Must match the sniffed type                         |
| Size       | Logo ≤ 2 MB, favicon ≤ 256 KB                       |
| Dimensions | Bounded; rejects decompression bombs                |
| **SVG**    | Rasterized on upload, or rejected                   |

**Why SVG is special:** an SVG is a script container. `<script>`, `<foreignObject>` and event
handlers all execute in the page that renders it. One tenant's logo renders on that tenant's login
page — so an unsanitized SVG is stored XSS against their own workers. Rasterizing to PNG removes
the entire class of problem; sanitizing is possible but is a bypass race nobody should sign up
for.

**URL validation:** `assetUrlSchema(allowedHosts)` accepts only `https` URLs on the configured
storage host. Accepting an arbitrary URL would let one tenant point another's users at a host they
control.

**Serving:** assets are public-read by URL (they are logos), with `Content-Type` set from the
**sniffed** type — never from the upload's declared one — and `X-Content-Type-Options: nosniff`.
The id addresses one immutable upload, so the response is cached for a year; choosing a different
logo produces a different URL rather than changing what this one returns.

`GET /api/v1/branding/public?slug=…` serves a tenant's name, logo, colour and login message with
no session, because a login page has to render them before anybody has proved who they are. It
publishes nothing the company code did not already publish, and nothing else is exposed there.

---

## 5. Permissions

```
branding.read        viewer and above     see the logo gallery
branding.update      admin and owner      upload, choose and delete a logo
organization.read    viewer and above     see the name and the login code
organization.update  admin and owner      rename the organization
users.manage         admin and owner      change a member's login email
```

Every change is audited — `organization.updated`, `branding.logo_uploaded`,
`branding.logo_selected`, `branding.logo_deleted`, `member.email_changed` — with before and after
values where a value changed.

An organization's **name is not a label**: it replaces the product's name in the admin sidebar, on
the worker and driver login screens and in both portals. `AYTRACKER` survives only where no tenant
is known — the sign-up page and the admin login, which are the product's own front doors.

A member's **email is a login identity**, so changing one ends that user's sessions
(`credentialsChangedAt`), is refused for an account that administers the platform rather than the
tenant, and can only reach a member of the caller's own organization.

White-label is an entitlement (`branding.white_label`, Professional and above). Organizations
without it get AYtracker's neutral defaults.

---

## 6. Not yet implemented

Reserved in the schema, deliberately not built:

- **Custom domain** — `customDomain` exists; needs DNS verification, certificate provisioning and
  a routing layer.
- **Custom email sender** — needs SPF/DKIM verification per customer.
- **Custom email templates**
- **Custom login background**
- **Per-theme logos** — `logoLightUrl` / `logoDarkUrl` exist; the settings screen uploads one logo
  and the gallery previews it on white, which is where a single asset has to work.
- **Custom app name** — `customAppName` exists.
- **Custom support and legal links**

Building all of these now would be speculative. The schema and the token layer are shaped so each
is additive.

---

## 7. The design phase

**The visual design of AYtracker has not been decided.**

What exists is the _plumbing_: tokens, contrast checking, server-side inlining, logo fallbacks.
What does not exist is any decision about typography, spacing, component style, or dashboard
aesthetics.

The placeholder palette in `PLACEHOLDER_BRAND` is neutral and accessible so wireframes are
legible during development. It is not a design decision and is labelled as such in the source.

When the design reference arrives, the tokens are where the customer's brand plugs into it — the
theming layer does not change, only what it feeds.
