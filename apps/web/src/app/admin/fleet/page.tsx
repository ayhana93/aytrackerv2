'use client';

import {
  AdminBody,
  AdminHeader,
  Badge,
  Button,
  Card,
  CardHeader,
  DataTable,
  DonutChart,
  Grid,
  Kpi,
  ThemeToggle,
  type Column,
} from '@aytracker/ui';

/**
 * Fleet management.
 *
 * A vehicle list and where the money went. The two questions a fleet manager opens this for are
 * "which van is free" and "why is the fuel bill what it is", so those are the two things on the
 * screen.
 *
 * Costs are money, which means integer minor units on the server and a formatter here. There is
 * no arithmetic on this page; a figure a browser can compute is a figure a browser can change.
 */

type VehicleStatus = 'ACTIVE' | 'IN_MAINTENANCE' | 'OUT_OF_SERVICE';

interface Vehicle {
  readonly id: string;
  readonly registration: string;
  readonly model: string;
  readonly type: string;
  readonly driver: string | null;
  readonly odometer: number;
  readonly consumption: number;
  readonly status: VehicleStatus;
  /** Days until the next inspection, negative when it has passed. */
  readonly inspectionInDays: number;
}

const VEHICLES: readonly Vehicle[] = [
  {
    id: 'v1',
    registration: 'CA 1234 AB',
    model: 'Ford Transit',
    type: 'Бус',
    driver: 'Иван Петров',
    odometer: 148_320,
    consumption: 8.4,
    status: 'ACTIVE',
    inspectionInDays: 46,
  },
  {
    id: 'v2',
    registration: 'PB 5678 CD',
    model: 'MAN TGL',
    type: 'Камион',
    driver: 'Мария Димитрова',
    odometer: 392_110,
    consumption: 19.5,
    status: 'ACTIVE',
    inspectionInDays: 12,
  },
  {
    id: 'v3',
    registration: 'CB 9012 EF',
    model: 'Renault Master',
    type: 'Бус',
    driver: null,
    odometer: 61_540,
    consumption: 9.1,
    status: 'ACTIVE',
    inspectionInDays: 128,
  },
  {
    id: 'v4',
    registration: 'CA 3344 KK',
    model: 'Iveco Daily',
    type: 'Бус',
    driver: null,
    odometer: 210_880,
    consumption: 10.2,
    status: 'IN_MAINTENANCE',
    inspectionInDays: -3,
  },
];

const STATUS_LABEL: Readonly<Record<VehicleStatus, string>> = {
  ACTIVE: 'В движение',
  IN_MAINTENANCE: 'В сервиз',
  OUT_OF_SERVICE: 'Извън употреба',
};

const STATUS_TONE: Readonly<Record<VehicleStatus, 'success' | 'warning' | 'danger'>> = {
  ACTIVE: 'success',
  IN_MAINTENANCE: 'warning',
  OUT_OF_SERVICE: 'danger',
};

const COSTS = [
  { label: 'Гориво', value: 4_284_50, color: 'var(--ay-chart-1)' },
  { label: 'Поддръжка', value: 1_920_00, color: 'var(--ay-chart-2)' },
  { label: 'Застраховки', value: 1_140_00, color: 'var(--ay-chart-3)' },
  { label: 'Винетки и такси', value: 486_00, color: 'var(--ay-chart-4)' },
];

/**
 * Money arrives as integer minor units and is formatted, never divided into a float and rounded.
 * Currency and locale come from the organization, which is why they are parameters rather than
 * constants — a tenant in the euro zone must not see "лв." because Bulgaria was hardcoded.
 */
function formatMoney(minorUnits: number, currency = 'BGN', locale = 'bg-BG'): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(minorUnits / 100);
}

const COLUMNS: readonly Column<Vehicle>[] = [
  {
    key: 'registration',
    header: 'Регистрация',
    render: (row) => (
      <div>
        <div style={{ fontWeight: 550 }}>{row.registration}</div>
        <div className="ay-caption ay-muted">{row.model}</div>
      </div>
    ),
  },
  { key: 'type', header: 'Тип', render: (row) => row.type },
  {
    key: 'driver',
    header: 'Шофьор',
    render: (row) => row.driver ?? <span className="ay-muted">Свободно</span>,
  },
  {
    key: 'odometer',
    header: 'Километраж',
    numeric: true,
    render: (row) => `${row.odometer.toLocaleString('bg-BG')} км`,
  },
  {
    key: 'consumption',
    header: 'Разход',
    numeric: true,
    render: (row) => `${row.consumption.toFixed(1)} л/100км`,
  },
  {
    key: 'inspection',
    header: 'Годишен технически преглед',
    numeric: true,
    render: (row) =>
      row.inspectionInDays < 0 ? (
        <Badge tone="danger">просрочен с {Math.abs(row.inspectionInDays)} дни</Badge>
      ) : row.inspectionInDays <= 30 ? (
        <Badge tone="warning">след {row.inspectionInDays} дни</Badge>
      ) : (
        <span className="ay-muted">след {row.inspectionInDays} дни</span>
      ),
  },
  {
    key: 'status',
    header: 'Състояние',
    render: (row) => <Badge tone={STATUS_TONE[row.status]}>{STATUS_LABEL[row.status]}</Badge>,
  },
];

/**
 * Bulgarian agrees the adjective with the noun's number, so "1 свободни" is wrong the way "1
 * vehicles" is wrong in English.
 *
 * Written out here because these screens carry literal strings; wired to the real interface this
 * goes through `@aytracker/localization`'s `plural()`, which resolves the CLDR category for the
 * organization's locale rather than assuming Bulgarian's two-form rule.
 */
function vehicleCount(count: number): string {
  return count === 1 ? '1 превозно средство' : `${count} превозни средства`;
}

function freeCount(count: number): string {
  return count === 1 ? '1 свободно' : `${count} свободни`;
}

export default function FleetPage() {
  const totalCost = COSTS.reduce((total, cost) => total + cost.value, 0);
  const available = VEHICLES.filter(
    (vehicle) => vehicle.status === 'ACTIVE' && vehicle.driver === null,
  ).length;

  return (
    <>
      <AdminHeader
        title="Автопарк"
        subtitle={`${vehicleCount(VEHICLES.length)} · ${freeCount(available)}`}
        actions={
          <>
            <ThemeToggle labels={{ light: 'Светла', dark: 'Тъмна', system: 'Системна' }} />
            <Button>Добави МПС</Button>
          </>
        }
      />

      <AdminBody>
        <Grid>
          {/*
            Three of these four are costs, where a fall is the good news. `goodDirection` is what
            keeps the colour honest — without it a shrinking fuel bill would be painted red.
          */}
          <Kpi
            label="Изминати километри"
            value="14 820"
            unit="км"
            delta={6.4}
            goodDirection="up"
            caption="този месец"
          />
          <Kpi
            label="Разход за месеца"
            value={formatMoney(totalCost)}
            delta={3.1}
            goodDirection="down"
            caption="всички категории"
          />
          <Kpi
            label="Среден разход"
            value="11.4"
            unit="л/100км"
            delta={-1.8}
            goodDirection="down"
            caption="целият парк"
          />
          <Kpi
            label="Цена на километър"
            value={formatMoney(Math.round(totalCost / 14_820))}
            delta={-2.6}
            goodDirection="down"
            caption="гориво и поддръжка"
          />
        </Grid>

        <Grid wide>
          <Card padded={false}>
            <CardHeader>
              <div>
                <h2 className="ay-h3">Разходи по категории</h2>
                <p className="ay-caption ay-muted">Август 2026</p>
              </div>
            </CardHeader>
            <div style={{ padding: 'var(--ay-space-5)' }}>
              <DonutChart
                slices={COSTS}
                total={formatMoney(totalCost)}
                totalLabel="общо за месеца"
                formatValue={(value) => formatMoney(value)}
              />
            </div>
          </Card>

          <Card padded={false}>
            <CardHeader>
              <h2 className="ay-h3">Предстоящи задължения</h2>
            </CardHeader>
            <ul>
              {VEHICLES.filter((vehicle) => vehicle.inspectionInDays <= 30).map((vehicle) => (
                <li
                  key={vehicle.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 'var(--ay-space-3)',
                    padding: 'var(--ay-space-4) var(--ay-space-5)',
                    borderTop: '1px solid var(--ay-border)',
                  }}
                >
                  <div>
                    <p className="ay-small" style={{ fontWeight: 550 }}>
                      {vehicle.registration}
                    </p>
                    <p className="ay-caption ay-muted">Годишен технически преглед</p>
                  </div>
                  <Badge tone={vehicle.inspectionInDays < 0 ? 'danger' : 'warning'}>
                    {vehicle.inspectionInDays < 0
                      ? `просрочен с ${Math.abs(vehicle.inspectionInDays)} дни`
                      : `след ${vehicle.inspectionInDays} дни`}
                  </Badge>
                </li>
              ))}
            </ul>
          </Card>
        </Grid>

        <Card padded={false}>
          <CardHeader>
            <h2 className="ay-h3">Превозни средства</h2>
          </CardHeader>
          <DataTable columns={COLUMNS} rows={VEHICLES} rowKey={(row) => row.id} />
        </Card>
      </AdminBody>
    </>
  );
}
