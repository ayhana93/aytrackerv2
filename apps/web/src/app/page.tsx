'use client';

import { Badge, Card, ThemeToggle } from '@aytracker/ui';

/**
 * Development index.
 *
 * A directory of the portals while the remaining screens are built, styled with the same tokens
 * so it exercises the theme rather than opting out of it.
 */
export default function HomePage() {
  return (
    <main className="ay-page">
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '1rem',
        }}
      >
        <div>
          <h1 className="ay-h1">AYtracker</h1>
          <p className="ay-small ay-muted">
            Платформа за производство и автопарк · светла и тъмна тема
          </p>
        </div>
        <ThemeToggle labels={{ light: 'Светла', dark: 'Тъмна', system: 'Системна' }} />
      </header>

      <div className="ay-page-grid">
        <a href="/worker" style={{ textDecoration: 'none', color: 'inherit' }}>
          <Card>
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--ay-space-2)' }}>
              <h2 className="ay-h2">Портал на работника</h2>
              <Badge tone="success">Готов</Badge>
            </div>
            <p className="ay-small ay-muted" style={{ marginTop: 'var(--ay-space-2)' }}>
              Смяна, позиция, бърза смяна на позиция. Изборът на позиция „Шофьор“ води към избор на
              МПС и прехвърля към портала на шофьора.
            </p>
          </Card>
        </a>

        <a href="/driver" style={{ textDecoration: 'none', color: 'inherit' }}>
          <Card>
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--ay-space-2)' }}>
              <h2 className="ay-h2">Портал на шофьора</h2>
              <Badge tone="success">Готов</Badge>
            </div>
            <p className="ay-small ay-muted" style={{ marginTop: 'var(--ay-space-2)' }}>
              Активен курс, състояние на проследяването и честна информация какво се случва при
              изгасен екран.
            </p>
          </Card>
        </a>

        <a href="/admin" style={{ textDecoration: 'none', color: 'inherit' }}>
          <Card>
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--ay-space-2)' }}>
              <h2 className="ay-h2">Админ панел</h2>
              <Badge tone="warning">В процес</Badge>
            </div>
            <p className="ay-small ay-muted" style={{ marginTop: 'var(--ay-space-2)' }}>
              Табло, производство, персонал, автопарк и разходи.
            </p>
          </Card>
        </a>
      </div>
    </main>
  );
}
