'use client';

import { useState } from 'react';
import dynamic from 'next/dynamic';
import {
  AdminBody,
  AdminHeader,
  Badge,
  Card,
  CardHeader,
  Grid,
  Kpi,
  ThemeToggle,
  type Column,
} from '@aytracker/ui';
import { adminApi, describeError, useApi, type TripRow } from '../../../lib/admin';

/**
 * Trips and their routes.
 *
 * The list answers "what happened"; picking a row answers "where". The map is only mounted once
 * a trip is selected — a tile layer and a Leaflet bundle are a lot to load for someone who came
 * to read the table.
 */

const RouteMap = dynamic(() => import('../../../components/route-map').then((m) => m.RouteMap), {
  // Leaflet touches `window` on import, so it cannot be server-rendered at all.
  ssr: false,
  loading: () => (
    <div
      style={{
        height: 420,
        borderRadius: 'var(--ay-radius-lg)',
        background: 'var(--ay-surface-sunken)',
      }}
    />
  ),
});

const STATUS_TONE: Readonly<
  Record<TripRow['status'], 'success' | 'warning' | 'accent' | 'neutral'>
> = {
  ACTIVE: 'accent',
  PAUSED: 'warning',
  COMPLETED: 'success',
  CANCELLED: 'neutral',
  PLANNED: 'neutral',
};

const STATUS_LABEL: Readonly<Record<TripRow['status'], string>> = {
  ACTIVE: 'В движение',
  PAUSED: 'На пауза',
  COMPLETED: 'Завършен',
  CANCELLED: 'Отказан',
  PLANNED: 'Планиран',
};

function km(meters: number): string {
  return `${(meters / 1000).toLocaleString('bg-BG', { maximumFractionDigits: 1 })} км`;
}

function duration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours > 0 ? `${hours} ч ${minutes} мин` : `${minutes} мин`;
}

function time(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('bg-BG', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function TripsPage() {
  const [selected, setSelected] = useState<string | null>(null);

  /**
   * Computed once, not per render.
   *
   * `new Date(...).toISOString()` in the render body produces a different string every time,
   * which made it a dependency that always changed: the effect refetched, the refetch rendered,
   * the render made a new `from`. The browser hit the API until the rate limiter started
   * returning 429, and the screen never settled. A range that means "the last 30 days as of when
   * this screen opened" has to be pinned when the screen opens.
   */
  const [from] = useState(() => new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString());
  const list = useApi(() => adminApi.trips({ from, limit: 200 }), [from]);
  const track = useApi(
    () => (selected ? adminApi.track(selected) : Promise.resolve(null)),
    [selected],
  );

  const columns: readonly Column<TripRow>[] = [
    { key: 'vehicle', header: 'МПС', render: (row) => row.vehicle },
    { key: 'driver', header: 'Шофьор', render: (row) => row.driver },
    { key: 'started', header: 'Начало', render: (row) => time(row.startedAt) },
    {
      key: 'distance',
      header: 'Разстояние',
      numeric: true,
      render: (row) => km(row.distanceMeters),
    },
    {
      key: 'duration',
      header: 'Времетраене',
      numeric: true,
      render: (row) => duration(row.durationSeconds),
    },
    {
      key: 'untracked',
      header: 'Без данни',
      numeric: true,
      // Shown for every trip, not only the bad ones. A blank column would let a reader assume
      // full coverage; a zero states it.
      render: (row) =>
        row.untrackedSeconds > 0 ? (
          <Badge tone="warning">{duration(row.untrackedSeconds)}</Badge>
        ) : (
          <span className="ay-muted">—</span>
        ),
    },
    {
      key: 'status',
      header: 'Състояние',
      render: (row) => <Badge tone={STATUS_TONE[row.status]}>{STATUS_LABEL[row.status]}</Badge>,
    },
  ];

  const trips = list.status === 'ready' ? list.data.trips : [];
  const totals = trips.reduce(
    (accumulated, trip) => ({
      distance: accumulated.distance + trip.distanceMeters,
      untracked: accumulated.untracked + trip.untrackedSeconds,
    }),
    { distance: 0, untracked: 0 },
  );

  return (
    <>
      <AdminHeader
        title="Маршрути"
        subtitle="Последните 30 дни"
        actions={<ThemeToggle labels={{ light: 'Светла', dark: 'Тъмна', system: 'Системна' }} />}
      />

      <AdminBody>
        {list.status === 'error' ? (
          <Card>
            <p className="ay-small">{describeError(list.error)}</p>
          </Card>
        ) : null}

        <Grid>
          <Kpi label="Курсове" value={String(trips.length)} caption="в периода" />
          <Kpi label="Изминати километри" value={km(totals.distance)} caption="сума за периода" />
          <Kpi
            label="Време без данни"
            value={duration(totals.untracked)}
            goodDirection="down"
            caption="не се брои за разстояние"
          />
        </Grid>

        <Card padded={false}>
          <CardHeader>
            <h2 className="ay-h3">Курсове</h2>
            {list.status === 'loading' ? (
              <span className="ay-caption ay-muted">Зареждане…</span>
            ) : null}
          </CardHeader>
          <div className="ay-table-scroll">
            <table className="ay-table">
              <thead>
                <tr>
                  {columns.map((column) => (
                    <th key={column.key} className={column.numeric ? 'ay-num' : undefined}>
                      {column.header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {trips.map((trip) => (
                  <tr
                    key={trip.id}
                    onClick={() => setSelected(trip.id)}
                    aria-selected={trip.id === selected}
                    style={{
                      cursor: 'pointer',
                      background: trip.id === selected ? 'var(--ay-accent-soft)' : undefined,
                    }}
                  >
                    {columns.map((column) => (
                      <td key={column.key} className={column.numeric ? 'ay-num' : undefined}>
                        {column.render(trip)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {trips.length === 0 && list.status === 'ready' ? (
              <p
                className="ay-small ay-muted"
                style={{ padding: 'var(--ay-space-8)', textAlign: 'center' }}
              >
                Няма курсове в този период.
              </p>
            ) : null}
          </div>
        </Card>

        {selected ? (
          <Card padded={false}>
            <CardHeader>
              <div>
                <h2 className="ay-h3">Маршрут</h2>
                {track.status === 'ready' && track.data ? (
                  <p className="ay-caption ay-muted">
                    {track.data.trip.vehicle.registrationNumber} · {track.data.trip.driver} ·{' '}
                    {track.data.track.pointCount} точки
                  </p>
                ) : null}
              </div>
              <button
                type="button"
                className="ay-button ay-button-ghost"
                onClick={() => setSelected(null)}
              >
                Затвори
              </button>
            </CardHeader>

            <div style={{ padding: 'var(--ay-space-5)' }}>
              {track.status === 'loading' ? (
                <p className="ay-small ay-muted">Зареждане на маршрута…</p>
              ) : null}

              {track.status === 'error' ? (
                <p className="ay-small">{describeError(track.error)}</p>
              ) : null}

              {track.status === 'ready' && track.data ? (
                <>
                  <RouteMap
                    track={track.data.track}
                    label={`Маршрут на ${track.data.trip.vehicle.registrationNumber}`}
                  />

                  <Grid style={{ marginTop: 'var(--ay-space-5)' }}>
                    <Kpi
                      label="Записано разстояние"
                      value={km(track.data.track.distanceMeters)}
                      caption="без периодите без данни"
                    />
                    <Kpi
                      label="Времетраене"
                      value={duration(track.data.trip.durationSeconds)}
                      caption={`пауза ${duration(track.data.trip.pausedSeconds)}`}
                    />
                    <Kpi
                      label="Без данни"
                      value={duration(track.data.trip.untrackedSeconds)}
                      goodDirection="down"
                      caption={
                        track.data.gaps.length === 1
                          ? '1 прекъсване'
                          : `${track.data.gaps.length} прекъсвания`
                      }
                    />
                  </Grid>

                  {track.data.gaps.length > 0 ? (
                    <div style={{ marginTop: 'var(--ay-space-5)' }}>
                      <p className="ay-small" style={{ fontWeight: 550 }}>
                        Периоди без данни
                      </p>
                      {/*
                        Worded as an observation, never an accusation. A tunnel, a flat battery
                        and a closed app are indistinguishable from the server, so the interface
                        reports the silence and stops there. See docs/tracking.md.
                      */}
                      <p className="ay-caption ay-muted" style={{ marginTop: 'var(--ay-space-1)' }}>
                        Приложението не е изпращало данни. Разстоянието за тези периоди не е
                        начислено.
                      </p>
                      <ul style={{ marginTop: 'var(--ay-space-3)' }}>
                        {track.data.gaps.map((gap) => (
                          <li
                            key={gap.startedAt}
                            style={{
                              display: 'flex',
                              justifyContent: 'space-between',
                              padding: 'var(--ay-space-2) 0',
                              borderTop: '1px solid var(--ay-border)',
                            }}
                          >
                            <span className="ay-small">
                              {time(gap.startedAt)} →{' '}
                              {gap.endedAt ? time(gap.endedAt) : 'продължава'}
                            </span>
                            <span className="ay-small ay-numeric ay-muted">
                              {duration(gap.seconds)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </>
              ) : null}
            </div>
          </Card>
        ) : null}
      </AdminBody>
    </>
  );
}
