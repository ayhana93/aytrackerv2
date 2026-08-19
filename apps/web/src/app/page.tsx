/**
 * Development landing page.
 *
 * A wireframe, deliberately. Per the brief, the visual design is not decided until a design
 * reference is supplied; building a polished landing page now would be deciding it by default.
 */
export default function HomePage() {
  return (
    <main>
      <h1>AYtracker</h1>
      <p>Multi-tenant manufacturing and fleet operations platform.</p>

      <section className="placeholder-notice">
        <h2>Development build</h2>
        <p>
          The interface is intentionally unstyled. Architecture, domain logic and the API are built
          first; the visual design begins once a design reference has been provided.
        </p>
      </section>

      <section>
        <h2>Portals</h2>
        <ul>
          <li>
            <a href="/worker">Worker portal</a> — shift, position change, production
          </li>
          <li>
            <a href="/driver">Driver portal</a> — assigned vehicle, trip, tracking
          </li>
          <li>
            <a href="/admin">Admin</a> — workforce, fleet, reporting
          </li>
        </ul>
      </section>

      <section>
        <h2>Documentation</h2>
        <p>
          Architecture decisions live in <code>docs/</code>. Start with{' '}
          <code>docs/architecture.md</code>.
        </p>
      </section>
    </main>
  );
}
