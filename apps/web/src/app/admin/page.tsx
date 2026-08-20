'use client';

import {
  AdminBody,
  AdminHeader,
  Badge,
  BarRow,
  Card,
  CardHeader,
  DataTable,
  Grid,
  Kpi,
  LineChart,
  ThemeToggle,
  type Column,
} from '@aytracker/ui';
import { adminApi, describeError, useApi, type DashboardResponse } from '../../lib/admin';

/**
 * Admin dashboard.
 *
 * Every number here comes from `/admin/dashboard` in one request. Nothing on this page adds,
 * averages or converts — the browser renders what the server computed, because a total a client
 * can compute is a total a client can change, and these feed cost reports and, in some
 * organizations, pay.
 *
 * Ordered by what a plant manager is checking for: the four numbers, then the shape of the
 * shift, then the two lists that mean somebody has to do something.
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

function hourLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString('bg-BG', { hour: '2-digit' });
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

  // Only every third hour is labelled. Twenty-four labels on a phone-width chart overlap into an
  // unreadable smear, and the shape is what the chart is for.
  const hourly = data?.hourly ?? [];
  const labels = hourly.map((bucket, index) =>
    index % 3 === 0 ? hourLabel(bucket.hour) : ' '.repeat(index),
  );
  const maxArea = Math.max(1, ...(data?.byWorkArea ?? []).map((area) => area.produced));

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
            label="Произведено"
            value={loading ? '—' : (data?.totals.producedGood ?? 0).toLocaleString('bg-BG')}
            unit="бр."
            caption={data ? `брак ${data.totals.producedScrap.toLocaleString('bg-BG')}` : undefined}
          />
          <Kpi
            label="Активни позиции"
            value={loading ? '—' : String(data?.totals.activeWorkers ?? 0)}
            caption="в момента"
          />
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

        <Card padded={false}>
          <CardHeader>
            <div>
              <h2 className="ay-h3">Производство по часове</h2>
              <p className="ay-caption ay-muted">Годна продукция срещу брак</p>
            </div>
          </CardHeader>
          <div style={{ padding: 'var(--ay-space-5)' }}>
            {hourly.length > 0 ? (
              <LineChart
                labels={labels}
                formatValue={(value) => `${value.toLocaleString('bg-BG')} бр.`}
                series={[
                  {
                    label: 'Годни',
                    color: 'var(--ay-chart-actual)',
                    points: hourly.map((bucket) => bucket.good),
                    area: true,
                  },
                  {
                    label: 'Брак',
                    color: 'var(--ay-chart-4)',
                    points: hourly.map((bucket) => bucket.scrap),
                  },
                ]}
              />
            ) : (
              <p className="ay-small ay-muted">
                {loading ? 'Зареждане…' : 'Няма записано производство в този период.'}
              </p>
            )}
          </div>
        </Card>

        <Grid wide>
          <Card padded={false}>
            <CardHeader>
              <h2 className="ay-h3">Производство по зони</h2>
            </CardHeader>
            <div
              style={{
                padding: 'var(--ay-space-5)',
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--ay-space-4)',
              }}
            >
              {(data?.byWorkArea ?? []).map((area, index) => (
                <BarRow
                  key={area.name}
                  label={area.name}
                  value={area.produced}
                  max={maxArea}
                  color={`var(--ay-chart-${(index % 6) + 1})`}
                  display={area.produced.toLocaleString('bg-BG')}
                />
              ))}
              {data && data.byWorkArea.length === 0 ? (
                <p className="ay-small ay-muted">Няма данни.</p>
              ) : null}
            </div>
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

        <Card padded={false}>
          <CardHeader>
            <h2 className="ay-h3">Активни позиции</h2>
            {data ? <Badge tone="success">{data.activePositions.length}</Badge> : null}
          </CardHeader>
          <DataTable
            columns={ACTIVE_COLUMNS}
            rows={data?.activePositions ?? []}
            rowKey={(row) => row.id}
            empty={loading ? 'Зареждане…' : 'Никой не е на смяна в момента.'}
          />
        </Card>
      </AdminBody>
    </>
  );
}
