export default function HomePage() {
  return (
    <main>
      <h1>Vellum</h1>
      <p className="tagline">Self-hostable AI bookkeeper for freelancers and small teams.</p>
      <p>
        Pre-alpha; not usable yet. The code is public from day one, and the history reads as the
        project comes together rather than after it is done.
      </p>
      <p>
        Repository:{' '}
        <a href="https://github.com/gaaegiazaryan/vellum">github.com/gaaegiazaryan/vellum</a>
      </p>
      <p>
        Architecture and decisions are written down as Architecture Decision Records in{' '}
        <code>docs/adr/</code>. There are three so far, covering the monorepo layout, the ORM
        choice, and the authentication strategy.
      </p>
      <p className="muted">
        AGPL-3.0-or-later. No telemetry, no signup wall, no tracking pixel on this page.
      </p>
    </main>
  );
}
