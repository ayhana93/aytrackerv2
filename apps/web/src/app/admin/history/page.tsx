'use client';

import { useState } from 'react';
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
import { adminApi, describeError, useApi, type HistoryRow } from '../../../lib/admin';

/**
 * Who worked where, and for how long.
 *
 * Two readings of the same range, because two different questions get asked of it: the roll-up
 * answers "how many hours does this person have", the list answers "what did they actually do".
 * Neither substitutes for the other — a total with no rows behind it is impossible to check, and
 * rows with no total have to be added up by hand.
 *
 * Both figures come from the server. The browser does not sum anything on this page: these are
 * the hours someone will hold a payslip against, and a total the client computed is a total that
 * silently changes when the list is capped.
 */

const RANGES = [
  { days: 1, label: 'Днес' },
  { days: 7, label: '7 дни' },
  { days: 30, label: '30 дни' },
] as const;

function duration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours === 0) return `${minutes} мин`;
  return `${hours} ч ${String(minutes).padStart(2, '0')} мин`;
}

function time(iso: string): string {
  return new Date(iso).toLocaleString('bg-BG', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function HistoryPage() {
  const [days, setDays] = useState<number>(7);

  /**
   * Pinned when the range is chosen, not recomputed on render.
   *
   * `new Date()` in the render body is a different value every pass, so it would be a dependency
   * that always changed: the effect refetches, the refetch renders, the render makes a new
   * `from`. That loop ran the API into its own rate limiter on the trips screen once already.
   */
  const [from, setFrom] = useState(() => new Date(Date.now() - 7 * 86_400_000).toISOString());

  const state = useApi(() => adminApi.history({ from, limit: 500 }), [from]);

  const pick = (nextDays: number) => {
    setDays(nextDays);
    setFrom(new Date(Date.now() - nextDays * 86_400_000).toISOString());
  };

  const data = state.status === 'ready' ? state.data : null;
  const loading = state.status === 'loading';
  const totalSeconds = (data?.byWorker ?? []).reduce((sum, row) => sum + row.seconds, 0);

  const columns: readonly Column<HistoryRow>[] = [
    { key: 'worker', header: 'Работник', render: (row) => row.worker },
    {
      key: 'position',
      header: 'Позиция',
      render: (row) => (
        <span style={{ display: 'inline-flex', gap: 'var(--ay-space-2)', alignItems: 'center' }}>
          {row.position}
          {row.positionKind === 'DRIVING' ? <Badge tone="accent">МПС</Badge> : null}
        </span>
      ),
    },
    { key: 'area', header: 'Зона', render: (row) => row.workArea ?? '—' },
    { key: 'from', header: 'От', render: (row) => time(row.startedAt) },
    {
      key: 'to',
      header: 'До',
      render: (row) =>
        row.endedAt ? (
          time(row.endedAt)
        ) : (
          // Not blank, and not a guessed end time. The session is still running, and the row has
          // to say which of those it is.
          <Badge tone="success">в момента</Badge>
        ),
    },
    {
      key: 'duration',
      header: 'Часове',
      numeric: true,
      render: (row) => (row.isOpen ? `${duration(row.seconds)} досега` : duration(row.seconds)),
    },
    {
      key: 'flags',
      header: '',
      render: (row) =>
        row.wasCorrected ? (
          <Badge tone="warning" title="Часовете са коригирани ръчно">
            коригиран
          </Badge>
        ) : null,
    },
  ];

  return (
    <>
      <AdminHeader
        title="История"
        subtitle="Кой къде и колко е работил"
        actions={
          <>
            <div style={{ display: 'flex', gap: 'var(--ay-space-1)' }} role="group">
              {RANGES.map((range) => (
                <button
                  key={range.days}
                  type="button"
                  className={`ay-button ${days === range.days ? 'ay-button-primary' : 'ay-button-ghost'}`}
                  aria-pressed={days === range.days}
                  onClick={() => pick(range.days)}
                >
                  {range.label}
                </button>
              ))}
            </div>
            <ThemeToggle labels={{ light: 'Светла', dark: 'Тъмна', system: 'Системна' }} />
          </>
        }
      />

      <AdminBody>
        {state.status === 'error' ? (
          <Card>
            <p className="ay-small">{describeError(state.error)}</p>
          </Card>
        ) : null}

        <Grid>
          <Kpi
            label="Отработени часове"
            value={loading ? '—' : duration(totalSeconds)}
            caption="общо за периода"
          />
          <Kpi
            label="Работници"
            value={loading ? '—' : String(data?.byWorker.length ?? 0)}
            caption="с работа в периода"
          />
          <Kpi
            label="Записи"
            value={loading ? '—' : String(data?.sessions.length ?? 0)}
            caption={data?.truncated ? 'показани са последните' : 'в периода'}
          />
        </Grid>

        <Card padded={false}>
          <CardHeader>
            <h2 className="ay-h3">По работник</h2>
            {loading ? <span className="ay-caption ay-muted">Зареждане…</span> : null}
          </CardHeader>
          <ul>
            {(data?.byWorker ?? []).map((row) => (
              <li
                key={row.workerId}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--ay-space-3)',
                  padding: 'var(--ay-space-3) var(--ay-space-5)',
                  borderTop: '1px solid var(--ay-border)',
                }}
              >
                <span className="ay-small" style={{ flex: 1, minWidth: 0 }}>
                  {row.worker}
                </span>
                {row.open ? <Badge tone="success">на смяна</Badge> : null}
                <span className="ay-caption ay-muted">
                  {row.sessions === 1 ? '1 запис' : `${row.sessions} записа`}
                </span>
                <span
                  className="ay-small ay-numeric"
                  style={{ fontWeight: 600, minWidth: '7rem', textAlign: 'right' }}
                >
                  {duration(row.seconds)}
                </span>
              </li>
            ))}
            {data && data.byWorker.length === 0 ? (
              <li style={{ padding: 'var(--ay-space-5)' }}>
                <p className="ay-small ay-muted">Няма отчетена работа в този период.</p>
              </li>
            ) : null}
          </ul>
        </Card>

        <Card padded={false}>
          <CardHeader>
            <h2 className="ay-h3">Записи</h2>
            {data?.truncated ? (
              // Said plainly rather than left to be inferred from a round number of rows.
              <span className="ay-caption ay-muted">
                Показани са последните {data.sessions.length}. Стеснете периода за пълен списък.
              </span>
            ) : null}
          </CardHeader>
          <DataTable
            columns={columns}
            rows={data?.sessions ?? []}
            rowKey={(row) => row.id}
            empty={loading ? 'Зареждане…' : 'Няма записи в този период.'}
          />
        </Card>
      </AdminBody>
    </>
  );
}
