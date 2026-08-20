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
import { adminApi, describeError, useApi, type VehicleRow } from '../../../lib/admin';

/**
 * Fleet management.
 *
 * The two questions a fleet manager opens this for are "which vehicle is free" and "who has
 * what", so those are what the table answers first. Costs live on their own screen: they come
 * from expense rows rather than from the vehicle, and putting a half-computed figure here would
 * be worse than sending someone one click further for a real one.
 */

const STATUS_LABEL: Readonly<Record<VehicleRow['status'], string>> = {
  ACTIVE: 'В движение',
  IN_MAINTENANCE: 'В сервиз',
  OUT_OF_SERVICE: 'Извън употреба',
  SOLD: 'Продадено',
  ARCHIVED: 'Архивирано',
};

const STATUS_TONE: Readonly<
  Record<VehicleRow['status'], 'success' | 'warning' | 'danger' | 'neutral'>
> = {
  ACTIVE: 'success',
  IN_MAINTENANCE: 'warning',
  OUT_OF_SERVICE: 'danger',
  SOLD: 'neutral',
  ARCHIVED: 'neutral',
};

const TYPE_LABEL: Readonly<Record<string, string>> = {
  VAN: 'Бус',
  TRUCK: 'Камион',
  CAR: 'Лек автомобил',
  TRAILER: 'Ремарке',
  FORKLIFT: 'Мотокар',
};

/**
 * Bulgarian agrees the adjective with the noun's number, so "1 свободни" is wrong the way
 * "1 vehicles" is wrong in English. Wired to the real interface this goes through
 * `@aytracker/localization`'s `plural()`, which resolves the CLDR category for the
 * organization's locale rather than assuming Bulgarian's two-form rule.
 */
function vehicleCount(count: number): string {
  return count === 1 ? '1 превозно средство' : `${count} превозни средства`;
}

function freeCount(count: number): string {
  return count === 1 ? '1 свободно' : `${count} свободни`;
}

const COLUMNS: readonly Column<VehicleRow>[] = [
  {
    key: 'registration',
    header: 'Регистрация',
    render: (row) => (
      <div>
        <div style={{ fontWeight: 550 }}>{row.registrationNumber}</div>
        <div className="ay-caption ay-muted">
          {row.make} {row.model}
        </div>
      </div>
    ),
  },
  { key: 'type', header: 'Тип', render: (row) => TYPE_LABEL[row.vehicleType] ?? row.vehicleType },
  {
    key: 'driver',
    header: 'Шофьор',
    render: (row) =>
      row.driver ? (
        <span style={{ display: 'inline-flex', gap: 'var(--ay-space-2)', alignItems: 'center' }}>
          {row.driver.name}
          {/*
            An automatic assignment was created by the worker→driver handoff and is released when
            they leave the position. A manual one is a fleet manager's decision that outlives the
            shift. Showing which is which is the difference between "free tomorrow" and "not".
          */}
          {row.driver.automatic ? <Badge tone="accent">за смяната</Badge> : null}
        </span>
      ) : (
        <span className="ay-muted">Свободно</span>
      ),
  },
  {
    key: 'odometer',
    header: 'Километраж',
    numeric: true,
    render: (row) => `${Number(row.odometer).toLocaleString('bg-BG')} км`,
  },
  {
    key: 'consumption',
    header: 'Разход',
    numeric: true,
    render: (row) =>
      row.averageConsumption ? (
        `${Number(row.averageConsumption).toFixed(1)} л/100км`
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

export default function FleetPage() {
  const state = useApi(() => adminApi.vehicles(), []);

  const vehicles = state.status === 'ready' ? state.data.vehicles : [];
  const available = vehicles.filter((v) => v.status === 'ACTIVE' && v.driver === null).length;
  const inMaintenance = vehicles.filter((v) => v.status === 'IN_MAINTENANCE').length;
  const onShift = vehicles.filter((v) => v.driver?.automatic === true).length;

  return (
    <>
      <AdminHeader
        title="Автопарк"
        subtitle={
          state.status === 'ready'
            ? `${vehicleCount(vehicles.length)} · ${freeCount(available)}`
            : 'Зареждане…'
        }
        actions={<ThemeToggle labels={{ light: 'Светла', dark: 'Тъмна', system: 'Системна' }} />}
      />

      <AdminBody>
        {state.status === 'error' ? (
          <Card>
            <p className="ay-small">{describeError(state.error)}</p>
          </Card>
        ) : null}

        <Grid>
          <Kpi label="Общо" value={String(vehicles.length)} caption="превозни средства" />
          <Kpi label="Свободни" value={String(available)} caption="без назначен шофьор" />
          <Kpi label="Заети за смяната" value={String(onShift)} caption="през избор на позиция" />
          <Kpi
            label="В сервиз"
            value={String(inMaintenance)}
            goodDirection="down"
            caption="не се предлагат за избор"
          />
        </Grid>

        <Card padded={false}>
          <CardHeader>
            <h2 className="ay-h3">Превозни средства</h2>
          </CardHeader>
          <DataTable
            columns={COLUMNS}
            rows={vehicles}
            rowKey={(row) => row.id}
            empty={state.status === 'loading' ? 'Зареждане…' : 'Няма регистрирани МПС.'}
          />
        </Card>
      </AdminBody>
    </>
  );
}
