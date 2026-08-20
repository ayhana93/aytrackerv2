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
import { adminApi, describeError, useApi, type DashboardResponse } from '../../../lib/admin';

/**
 * Who is on shift right now.
 *
 * Backed by the same query the dashboard's KPI counts against — an open position session, no end
 * time yet — just given its own page and its own room, because "who is working" is one of the two
 * things this deployment exists to answer and a four-row widget buried under a production chart
 * was not doing it justice.
 */

type ActivePosition = DashboardResponse['activePositions'][number];

const COLUMNS: readonly Column<ActivePosition>[] = [
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
    key: 'duration',
    header: 'Продължителност',
    numeric: true,
    render: (row) => {
      const minutes = Math.max(
        0,
        Math.round((Date.now() - new Date(row.startedAt).getTime()) / 60000),
      );
      const hours = Math.floor(minutes / 60);
      const rest = minutes % 60;
      return hours > 0 ? `${hours} ч ${rest} мин` : `${rest} мин`;
    },
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

export default function PeoplePage() {
  const state = useApi(() => adminApi.dashboard(), []);
  const data = state.status === 'ready' ? state.data : null;
  const loading = state.status === 'loading';
  const people = data?.activePositions ?? [];
  const onBreak = people.filter((row) => row.onBreak).length;
  const driving = people.filter((row) => row.kind === 'DRIVING' && !row.onBreak).length;

  return (
    <>
      <AdminHeader
        title="Хора"
        subtitle="На смяна в момента"
        actions={<ThemeToggle labels={{ light: 'Светла', dark: 'Тъмна', system: 'Системна' }} />}
      />

      <AdminBody>
        {state.status === 'error' ? (
          <Card>
            <p className="ay-small">{describeError(state.error)}</p>
          </Card>
        ) : null}

        <Grid>
          <Kpi label="На смяна" value={loading ? '—' : String(people.length)} caption="в момента" />
          <Kpi label="На път" value={loading ? '—' : String(driving)} caption="шофьори" />
          <Kpi label="На почивка" value={loading ? '—' : String(onBreak)} caption="в момента" />
        </Grid>

        <Card padded={false}>
          <CardHeader>
            <h2 className="ay-h3">На смяна</h2>
            {data ? <Badge tone="success">{people.length}</Badge> : null}
          </CardHeader>
          <DataTable
            columns={COLUMNS}
            rows={people}
            rowKey={(row) => row.id}
            empty={loading ? 'Зареждане…' : 'Никой не е на смяна в момента.'}
          />
        </Card>
      </AdminBody>
    </>
  );
}
