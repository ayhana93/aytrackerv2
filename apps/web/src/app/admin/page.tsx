'use client';

import {
  AdminBody,
  AdminHeader,
  Badge,
  Card,
  CardHeader,
  DataTable,
  Grid,
  Kpi,
  ThemeToggle,
  type Column,
} from '@aytracker/ui';
import { useState } from 'react';
import { adminApi, describeError, useApi, type DashboardResponse } from '../../lib/admin';
import { useSession } from './auth-guard';

/**
 * Admin dashboard.
 *
 * Every number here comes from `/admin/dashboard` in one request. Nothing on this page adds,
 * averages or converts — the browser renders what the server computed.
 *
 * Scoped to what this deployment tracks: who is on shift and where the fleet is, in the last day.
 * Production figures are still computed server-side (other tenants may want them back), but this
 * screen does not render them — the KPIs, the warnings and the shift list are the whole page.
 */

type ActivePosition = DashboardResponse['activePositions'][number];

const ACTIVE_COLUMNS: readonly Column<ActivePosition>[] = [
  { key: 'worker', header: 'Работник', render: (row) => row.worker },
  {
    key: 'position',
    header: 'Позиция',
    render: (row) => (
      <span style={{ display: 'inline-flex', gap: 'var(--ay-space-2)', alignItems: 'center' }}>
        {row.position}
        {row.kind === 'DRIVING' ? <Badge tone="accent">МПС</Badge> : null}
      </span>
    ),
  },
  {
    key: 'since',
    header: 'От',
    numeric: true,
    render: (row) =>
      new Date(row.startedAt).toLocaleTimeString('bg-BG', { hour: '2-digit', minute: '2-digit' }),
  },
  {
    key: 'state',
    header: 'Състояние',
    render: (row) =>
      row.onBreak ? (
        <Badge tone="warning">Почивка</Badge>
      ) : row.kind === 'DRIVING' ? (
        <Badge tone="accent">На път</Badge>
      ) : (
        <Badge tone="success">Работи</Badge>
      ),
  },
];

/**
 * Warning text is built here, from a code the server sent.
 *
 * The server sends `kind`, `subject` and a machine-readable `detail`; the wording is the client's
 * job because it is language, not data. Every string below describes what was observed —
 * "приложението не изпраща данни", never "шофьорът е изключил проследяването". See
 * docs/tracking.md § anti-tampering.
 */
function warningText(warning: DashboardResponse['warnings'][number]): {
  title: string;
  detail: string;
} {
  switch (warning.kind) {
    case 'LONG_SHIFT':
      return {
        title: 'Смяна над 10 часа',
        detail: warning.detail
          ? `${warning.subject} · започната в ${new Date(warning.detail).toLocaleTimeString('bg-BG', { hour: '2-digit', minute: '2-digit' })}`
          : warning.subject,
      };
    case 'TRACKING_INTERRUPTED':
      return {
        title: 'Прекъснато проследяване',
        detail: warning.detail
          ? `${warning.subject} · последни данни в ${new Date(warning.detail).toLocaleTimeString('bg-BG', { hour: '2-digit', minute: '2-digit' })}`
          : `${warning.subject} · няма получени данни`,
      };
    case 'DOCUMENT_EXPIRING': {
      const [, days] = warning.detail.split(':');
      const remaining = Number(days ?? 0);
      return {
        title: 'Изтичащ документ',
        detail:
          remaining < 0
            ? `${warning.subject} · просрочен с ${Math.abs(remaining)} дни`
            : `${warning.subject} · след ${remaining} дни`,
      };
    }
    default:
      return { title: warning.kind, detail: warning.subject };
  }
}

/**
 * The two doors an admin has to give their staff, and the code that opens them.
 *
 * On the dashboard rather than buried in a settings page, because this is the first thing a new
 * organization needs and the moment it needs it: an owner who has just signed up has no workers,
 * no drivers and no way to tell anyone where to go. The links carry the company code in the
 * query string, so a link forwarded to a phone fills the first field in by itself and nobody has
 * to read a slug out over a factory floor.
 */
function StaffEntrances() {
  const session = useSession();
  const [copied, setCopied] = useState<string | null>(null);
  const slug = session.organizationSlug;

  const copy = (value: string, which: string) => {
    void navigator.clipboard
      .writeText(value)
      .then(() => setCopied(which))
      // No message on failure: clipboard access is denied outright in some browsers, and the
      // address is on the screen to be typed either way.
      .catch(() => undefined);
  };

  const doors = [
    {
      id: 'worker',
      title: 'Вход за работници',
      detail: 'Служебен номер и ПИН. Оттам се избира позиция и започва смяна.',
      href: slug ? `/worker/login?org=${encodeURIComponent(slug)}` : '/worker/login',
    },
    {
      id: 'driver',
      title: 'Вход за шофьори',
      detail: 'Код на шофьора и ПИН. Оттам започва курс с превозно средство.',
      href: slug ? `/driver/login?org=${encodeURIComponent(slug)}` : '/driver/login',
    },
  ];

  return (
    <Card padded={false}>
      <CardHeader>
        <div>
          <h2 className="ay-h3">Вход за персонала</h2>
          <p className="ay-caption ay-muted">
            Изпратете тези адреси на хората си. Кодът на фирмата е {slug ?? '—'}.
          </p>
        </div>
        {slug ? (
          <button
            type="button"
            className="ay-button ay-button-ghost"
            onClick={() => copy(slug, 'slug')}
          >
            {copied === 'slug' ? 'Копиран' : 'Копирайте кода'}
          </button>
        ) : null}
      </CardHeader>

      <ul>
        {doors.map((door) => (
          <li
            key={door.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--ay-space-4)',
              padding: 'var(--ay-space-4) var(--ay-space-5)',
              borderTop: '1px solid var(--ay-border)',
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <a className="ay-small" style={{ fontWeight: 550 }} href={door.href}>
                {door.title}
              </a>
              <p className="ay-caption ay-muted">{door.detail}</p>
            </div>
            <button
              type="button"
              className="ay-button ay-button-ghost"
              onClick={() => copy(new URL(door.href, window.location.origin).toString(), door.id)}
            >
              {copied === door.id ? 'Копиран' : 'Копирайте връзката'}
            </button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export default function AdminDashboardPage() {
  const state = useApi(() => adminApi.dashboard(), []);

  if (state.status === 'error') {
    return (
      <>
        <AdminHeader title="Табло" />
        <AdminBody>
          <Card>
            <p className="ay-small">{describeError(state.error)}</p>
          </Card>
        </AdminBody>
      </>
    );
  }

  const data = state.status === 'ready' ? state.data : null;
  const loading = state.status === 'loading';
  const driving = (data?.activePositions ?? []).filter((row) => row.kind === 'DRIVING').length;

  return (
    <>
      <AdminHeader
        title="Табло"
        subtitle={
          data
            ? `${new Date(data.range.from).toLocaleString('bg-BG', { day: '2-digit', month: 'long', hour: '2-digit', minute: '2-digit' })} → сега`
            : 'Зареждане…'
        }
        actions={<ThemeToggle labels={{ light: 'Светла', dark: 'Тъмна', system: 'Системна' }} />}
      />

      <AdminBody>
        <Grid>
          <Kpi
            label="На смяна"
            value={loading ? '—' : String(data?.totals.activeWorkers ?? 0)}
            caption="в момента"
          />
          <Kpi label="На път" value={loading ? '—' : String(driving)} caption="шофьори в момента" />
          <Kpi
            label="Курсове"
            value={loading ? '—' : String(data?.totals.trips ?? 0)}
            caption={
              data
                ? `${(data.totals.distanceMeters / 1000).toLocaleString('bg-BG', { maximumFractionDigits: 0 })} км`
                : undefined
            }
          />
          <Kpi
            label="Време без данни"
            value={loading ? '—' : `${Math.round((data?.totals.untrackedSeconds ?? 0) / 60)}`}
            unit="мин"
            goodDirection="down"
            caption="не се брои за разстояние"
          />
        </Grid>

        <StaffEntrances />

        <Grid wide>
          <Card padded={false}>
            <CardHeader>
              <h2 className="ay-h3">На смяна</h2>
              {data ? <Badge tone="success">{data.activePositions.length}</Badge> : null}
            </CardHeader>
            <DataTable
              columns={ACTIVE_COLUMNS}
              rows={(data?.activePositions ?? []).slice(0, 8)}
              rowKey={(row) => row.id}
              empty={loading ? 'Зареждане…' : 'Никой не е на смяна в момента.'}
            />
            {data && data.activePositions.length > 8 ? (
              <div style={{ padding: 'var(--ay-space-4) var(--ay-space-5)' }}>
                <a href="/admin/people" className="ay-small">
                  Виж всички ({data.activePositions.length}) →
                </a>
              </div>
            ) : null}
          </Card>

          <Card padded={false}>
            <CardHeader>
              <h2 className="ay-h3">Изисква внимание</h2>
              {data ? (
                <Badge tone={data.warnings.length > 0 ? 'warning' : 'success'}>
                  {data.warnings.length}
                </Badge>
              ) : null}
            </CardHeader>
            <ul>
              {(data?.warnings ?? []).map((warning) => {
                const text = warningText(warning);
                return (
                  <li
                    key={warning.id}
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: 'var(--ay-space-3)',
                      padding: 'var(--ay-space-4) var(--ay-space-5)',
                      borderTop: '1px solid var(--ay-border)',
                    }}
                  >
                    <span
                      aria-hidden="true"
                      style={{
                        marginTop: '0.35rem',
                        width: '0.5rem',
                        height: '0.5rem',
                        borderRadius: '50%',
                        flex: 'none',
                        background:
                          warning.severity === 'CRITICAL'
                            ? 'var(--ay-danger)'
                            : 'var(--ay-warning)',
                      }}
                    />
                    <div>
                      <p className="ay-small" style={{ fontWeight: 550 }}>
                        {text.title}
                      </p>
                      <p className="ay-caption ay-muted">{text.detail}</p>
                    </div>
                  </li>
                );
              })}
              {data && data.warnings.length === 0 ? (
                <li style={{ padding: 'var(--ay-space-5)' }}>
                  <p className="ay-small ay-muted">Нищо не изисква внимание.</p>
                </li>
              ) : null}
            </ul>
          </Card>
        </Grid>
      </AdminBody>
    </>
  );
}
