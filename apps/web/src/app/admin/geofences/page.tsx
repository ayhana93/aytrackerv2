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
  ThemeToggle,
  type Column,
} from '@aytracker/ui';
import { GeofenceMap } from '../../../components/geofence-map';
import {
  adminApi,
  describeError,
  useApi,
  type GeofenceRow,
  type GeofenceVisitRow,
} from '../../../lib/admin';
import { ApiError } from '../../../lib/api';

/**
 * Zones: the places this company cares about arriving at.
 *
 * A fence is placed by clicking the map, not by typing coordinates. The two failure modes of a
 * coordinate form are a swapped latitude and longitude and a radius nobody can picture, and both
 * disappear when the circle is drawn where it will actually be.
 *
 * The visit list beside it is the point of the feature: not "there is a fence at the customer"
 * but "the van was at the customer from 10:14 to 10:41". A visit still open shows as open — the
 * record says they went in and has not seen them leave, and inventing a departure time would be
 * the easiest possible way to make this screen wrong.
 */

const KIND_LABEL: Readonly<Record<GeofenceRow['kind'], string>> = {
  SITE: 'Обект',
  CUSTOMER: 'Клиент',
  RESTRICTED: 'Забранена',
  OTHER: 'Друга',
};

const DEFAULT_RADIUS = 200;

function minutes(seconds: number): string {
  const total = Math.round(seconds / 60);
  if (total < 60) return `${total} мин`;
  return `${Math.floor(total / 60)} ч ${total % 60} мин`;
}

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString('bg-BG', { hour: '2-digit', minute: '2-digit' });
}

export default function GeofencesPage() {
  // Bumped after a save. `useApi` re-runs on a dependency change, which is the whole reload.
  const [reloadKey, setReloadKey] = useState(0);
  const state = useApi(() => adminApi.geofences(), [reloadKey]);
  const fences = state.status === 'ready' ? state.data.geofences : [];

  const [selected, setSelected] = useState<GeofenceRow | null>(null);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<GeofenceRow['kind']>('CUSTOMER');
  const [radius, setRadius] = useState(String(DEFAULT_RADIUS));
  const [draft, setDraft] = useState<{ latitude: number; longitude: number } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const radiusMeters = Number(radius);
  const radiusValid =
    Number.isInteger(radiusMeters) && radiusMeters >= 20 && radiusMeters <= 50_000;
  const canSave = name.trim().length > 0 && draft !== null && radiusValid && !saving;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!canSave || !draft) return;
    setSaving(true);
    setError(null);

    adminApi
      .createGeofence({
        name: name.trim(),
        kind,
        latitude: draft.latitude,
        longitude: draft.longitude,
        radiusMeters,
      })
      .then(() => {
        setName('');
        setDraft(null);
        setRadius(String(DEFAULT_RADIUS));
        setReloadKey((key) => key + 1);
      })
      .catch((caught: unknown) => {
        setError(caught instanceof ApiError ? describeError(caught) : 'Зоната не беше записана.');
      })
      .finally(() => setSaving(false));
  };

  const columns: readonly Column<GeofenceRow>[] = [
    { key: 'name', header: 'Зона', render: (row) => row.name },
    { key: 'kind', header: 'Вид', render: (row) => KIND_LABEL[row.kind] },
    { key: 'radius', header: 'Радиус', numeric: true, render: (row) => `${row.radiusMeters} м` },
    { key: 'visits', header: 'Посещения', numeric: true, render: (row) => String(row.visitCount) },
    {
      key: 'state',
      header: 'Състояние',
      render: (row) =>
        row.isActive ? <Badge tone="success">Активна</Badge> : <Badge>Изключена</Badge>,
    },
  ];

  return (
    <>
      <AdminHeader
        title="Геозони"
        subtitle="Обекти, клиенти и места, за които се отчита пристигане"
        actions={<ThemeToggle labels={{ light: 'Светла', dark: 'Тъмна', system: 'Системна' }} />}
      />

      <AdminBody>
        {state.status === 'error' ? (
          <Card>
            <p className="ay-small">{describeError(state.error)}</p>
          </Card>
        ) : null}

        <Card padded={false}>
          <CardHeader>
            <div>
              <h2 className="ay-h3">Карта</h2>
              <p className="ay-caption ay-muted">
                Щракнете върху картата, за да поставите нова зона.
              </p>
            </div>
          </CardHeader>
          <div style={{ padding: 'var(--ay-space-4)' }}>
            <GeofenceMap
              fences={fences}
              draft={
                draft
                  ? { ...draft, radiusMeters: radiusValid ? radiusMeters : DEFAULT_RADIUS }
                  : null
              }
              onPick={setDraft}
            />
          </div>
        </Card>

        <Card padded={false}>
          <CardHeader>
            <h2 className="ay-h3">Нова зона</h2>
            {draft ? (
              <Badge tone="accent">
                {draft.latitude.toFixed(5)}, {draft.longitude.toFixed(5)}
              </Badge>
            ) : null}
          </CardHeader>
          <form
            onSubmit={submit}
            style={{ padding: 'var(--ay-space-5)', display: 'grid', gap: 'var(--ay-space-4)' }}
          >
            <Field label="Име" hint="Както го наричат хората — „Склад Изток“, а не адрес.">
              <input
                className="ay-input"
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={120}
              />
            </Field>

            <Field label="Вид">
              <select
                className="ay-input"
                value={kind}
                onChange={(event) => setKind(event.target.value as GeofenceRow['kind'])}
              >
                {(Object.keys(KIND_LABEL) as GeofenceRow['kind'][]).map((value) => (
                  <option key={value} value={value}>
                    {KIND_LABEL[value]}
                  </option>
                ))}
              </select>
            </Field>

            <Field
              label="Радиус (метри)"
              hint="Под 20 м зоната е в границите на GPS грешката и ще се задейства сама."
            >
              <input
                className="ay-input ay-numeric"
                type="number"
                min={20}
                max={50000}
                value={radius}
                onChange={(event) => setRadius(event.target.value)}
              />
            </Field>

            {!draft ? <p className="ay-small ay-muted">Изберете място върху картата.</p> : null}
            {error ? (
              <p className="ay-small" style={{ color: 'var(--ay-danger)' }} role="alert">
                {error}
              </p>
            ) : null}

            <div>
              <Button type="submit" disabled={!canSave}>
                {saving ? 'Записване…' : 'Добавете зоната'}
              </Button>
            </div>
          </form>
        </Card>

        <Card padded={false}>
          <CardHeader>
            <h2 className="ay-h3">Зони</h2>
            <Badge>{fences.length}</Badge>
          </CardHeader>
          <DataTable
            columns={columns}
            rows={fences}
            rowKey={(row) => row.id}
            empty="Няма зададени зони."
          />
        </Card>

        {fences.length > 0 ? (
          <Card padded={false}>
            <CardHeader>
              <div>
                <h2 className="ay-h3">Посещения</h2>
                <p className="ay-caption ay-muted">
                  {selected ? selected.name : 'Изберете зона по-долу.'}
                </p>
              </div>
              <div style={{ display: 'flex', gap: 'var(--ay-space-2)', flexWrap: 'wrap' }}>
                {fences.map((fence) => (
                  <Button
                    key={fence.id}
                    variant={selected?.id === fence.id ? 'primary' : 'ghost'}
                    onClick={() => setSelected(fence)}
                  >
                    {fence.name}
                  </Button>
                ))}
              </div>
            </CardHeader>
            {selected ? <Visits geofence={selected} /> : null}
          </Card>
        ) : null}
      </AdminBody>
    </>
  );
}

function Visits({ geofence }: { geofence: GeofenceRow }) {
  const state = useApi(() => adminApi.geofenceVisits(geofence.id), [geofence.id]);
  const visits = state.status === 'ready' ? state.data.visits : [];

  const columns: readonly Column<GeofenceVisitRow>[] = [
    { key: 'who', header: 'Кой', render: (row) => row.who },
    { key: 'in', header: 'Влизане', numeric: true, render: (row) => clock(row.enteredAt) },
    {
      key: 'out',
      header: 'Излизане',
      numeric: true,
      // An open visit says so. There is no estimated exit time on this screen, because an exit
      // nobody observed is a guess, and a guess in this column becomes a number on an invoice.
      render: (row) => (row.exitedAt ? clock(row.exitedAt) : <Badge tone="accent">В зоната</Badge>),
    },
    {
      key: 'dwell',
      header: 'Престой',
      numeric: true,
      render: (row) => minutes(row.dwellSeconds) + (row.isOpen ? ' и продължава' : ''),
    },
  ];

  return (
    <DataTable
      columns={columns}
      rows={visits}
      rowKey={(row) => row.id}
      empty={state.status === 'loading' ? 'Зареждане…' : 'Няма посещения в избрания период.'}
    />
  );
}
