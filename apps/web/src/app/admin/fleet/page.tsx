'use client';

import { useState, type FormEvent } from 'react';
import {
  AdminBody,
  AdminHeader,
  Badge,
  Button,
  Card,
  CardHeader,
  DataTable,
  Field,
  Grid,
  Kpi,
  ThemeToggle,
  type Column,
} from '@aytracker/ui';
import {
  adminApi,
  describeError,
  useApi,
  type FuelType,
  type VehicleRow,
  type VehicleType,
} from '../../../lib/admin';
import { ApiError } from '../../../lib/api';

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

/**
 * Every member of the `VehicleType` enum, and only those.
 *
 * It previously carried a `TRAILER` the server has never had and omitted `BUS` and `OTHER`, which
 * meant a bus registered through any other path listed its type as the raw string `BUS`.
 */
const TYPE_LABEL: Readonly<Record<VehicleType, string>> = {
  CAR: 'Лек автомобил',
  VAN: 'Бус',
  TRUCK: 'Камион',
  BUS: 'Автобус',
  FORKLIFT: 'Мотокар',
  OTHER: 'Друго',
};

const FUEL_LABEL: Readonly<Record<FuelType, string>> = {
  DIESEL: 'Дизел',
  PETROL: 'Бензин',
  LPG: 'Газ (LPG)',
  CNG: 'Метан (CNG)',
  ELECTRIC: 'Електрическо',
  HYBRID: 'Хибрид',
  OTHER: 'Друго',
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
  // Bumped after a successful write, which re-reads the list from the server rather than pushing
  // the created row into it: status and assignment are both server-decided, and a list patched in
  // the browser drifts from the one the next visitor sees.
  const [version, setVersion] = useState(0);
  const [adding, setAdding] = useState(false);
  const state = useApi(() => adminApi.vehicles(), [version]);

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
        actions={
          <>
            <Button onClick={() => setAdding((open) => !open)} aria-expanded={adding}>
              {adding ? 'Затворете' : 'Ново МПС'}
            </Button>
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

        {adding ? (
          <NewVehicleForm
            onCreated={() => {
              setAdding(false);
              setVersion((current) => current + 1);
            }}
            onCancel={() => setAdding(false)}
          />
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
            empty={
              state.status === 'loading'
                ? 'Зареждане…'
                : 'Още няма регистрирано МПС. Добавете първото с бутона „Ново МПС“ горе вдясно.'
            }
          />
        </Card>
      </AdminBody>
    </>
  );
}

/**
 * Registering a vehicle.
 *
 * Six fields, and every one of them is needed to tell this vehicle from another or to treat it
 * correctly. VIN, tank size and consumption are real columns and deliberately not here: a vehicle
 * somebody cannot add today because the VIN is in a folder in another building is a vehicle that
 * gets tracked on paper instead. They belong on an edit screen, next to the documents.
 *
 * Inline on the page rather than in a dialog, for the same reason the positions form is: adding
 * three vans in a row should not mean opening and closing three dialogs.
 */
function NewVehicleForm({ onCreated, onCancel }: { onCreated: () => void; onCancel: () => void }) {
  const [registrationNumber, setRegistrationNumber] = useState('');
  const [make, setMake] = useState('');
  const [model, setModel] = useState('');
  const [vehicleType, setVehicleType] = useState<VehicleType>('VAN');
  const [fuelType, setFuelType] = useState<FuelType>('DIESEL');
  const [odometer, setOdometer] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ready = registrationNumber.trim().length > 0 && make.trim() !== '' && model.trim() !== '';

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    setSaving(true);
    setError(null);

    adminApi
      .createVehicle({
        registrationNumber: registrationNumber.trim(),
        make: make.trim(),
        model: model.trim(),
        vehicleType,
        fuelType,
        // A blank odometer means "not known", which is zero for a vehicle nobody has driven yet.
        // Sent as a string because the column is a Decimal — see CreateVehicleInput.
        odometerCurrent: odometer.trim() === '' ? '0' : odometer.trim().replace(',', '.'),
      })
      .then(onCreated)
      .catch((caught: unknown) => {
        if (caught instanceof ApiError && caught.code === 'vehicle.registration_taken') {
          setError('Вече има МПС с тази регистрация.');
          return;
        }
        if (caught instanceof ApiError && caught.status === 400) {
          setError('Проверете регистрацията и километража и опитайте отново.');
          return;
        }
        setError(
          caught instanceof ApiError ? describeError(caught) : 'МПС-то не можа да се запише.',
        );
      })
      .finally(() => setSaving(false));
  };

  return (
    <Card padded={false}>
      <CardHeader>
        <div>
          <h2 className="ay-h3">Ново МПС</h2>
          <p className="ay-caption ay-muted">
            Останалото — VIN, документи, разход — се допълва по-късно.
          </p>
        </div>
      </CardHeader>

      <form onSubmit={submit} style={{ padding: 'var(--ay-space-5)' }}>
        <div
          style={{
            display: 'grid',
            // Three across on a desktop, which puts the two hinted fields at the start of a row
            // each and keeps the rows level. `min(100%, …)` rather than a bare track size so a
            // narrow window collapses to one column instead of overflowing the card.
            gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 18rem), 1fr))',
            gap: 'var(--ay-space-4)',
          }}
        >
          <Field label="Регистрация" hint="Например: CA 1234 AB">
            <input
              className="ay-input"
              type="text"
              autoFocus
              required
              maxLength={64}
              value={registrationNumber}
              // Plates are read back to people and compared by eye; a lower-case one in a list of
              // upper-case ones reads as a different kind of row.
              onChange={(event) => setRegistrationNumber(event.target.value.toUpperCase())}
            />
          </Field>

          <Field label="Марка">
            <input
              className="ay-input"
              type="text"
              required
              maxLength={64}
              value={make}
              onChange={(event) => setMake(event.target.value)}
            />
          </Field>

          <Field label="Модел">
            <input
              className="ay-input"
              type="text"
              required
              maxLength={64}
              value={model}
              onChange={(event) => setModel(event.target.value)}
            />
          </Field>

          <Field label="Тип">
            <select
              className="ay-input"
              value={vehicleType}
              onChange={(event) => setVehicleType(event.target.value as VehicleType)}
            >
              {(Object.keys(TYPE_LABEL) as VehicleType[]).map((type) => (
                <option key={type} value={type}>
                  {TYPE_LABEL[type]}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Гориво">
            <select
              className="ay-input"
              value={fuelType}
              onChange={(event) => setFuelType(event.target.value as FuelType)}
            >
              {(Object.keys(FUEL_LABEL) as FuelType[]).map((fuel) => (
                <option key={fuel} value={fuel}>
                  {FUEL_LABEL[fuel]}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Километраж" hint="Текущият показан на километража">
            <input
              className="ay-input"
              type="text"
              inputMode="decimal"
              value={odometer}
              placeholder="0"
              onChange={(event) => setOdometer(event.target.value)}
            />
          </Field>
        </div>

        {error ? (
          <p
            className="ay-small"
            style={{ color: 'var(--ay-danger)', marginTop: 'var(--ay-space-4)' }}
            role="alert"
          >
            {error}
          </p>
        ) : null}

        <div
          style={{
            display: 'flex',
            gap: 'var(--ay-space-3)',
            marginTop: 'var(--ay-space-5)',
          }}
        >
          <Button type="submit" disabled={saving || !ready}>
            {saving ? 'Записване…' : 'Запишете МПС'}
          </Button>
          <Button type="button" variant="ghost" onClick={onCancel}>
            Откажете
          </Button>
        </div>
      </form>
    </Card>
  );
}
