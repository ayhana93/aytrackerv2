'use client';

import { useState, type FormEvent } from 'react';
import {
  AdminBody,
  AdminHeader,
  Badge,
  Button,
  Card,
  CardHeader,
  Field,
  Grid,
  Kpi,
  ThemeToggle,
} from '@aytracker/ui';
import {
  adminApi,
  describeError,
  useApi,
  type PositionKind,
  type WorkAreaRow,
} from '../../../lib/admin';
import { ApiError } from '../../../lib/api';

/**
 * Zones, and the positions inside them.
 *
 * This is the screen that decides what the rest of the product can say. A position session
 * records a person against a *position*, and a position belongs to a *work area* — so an
 * organization that has not set this up has nothing to report on, and every grouped figure
 * elsewhere collapses to "—".
 *
 * The forms are inline rather than in dialogs. Setting up a factory floor means adding a dozen
 * positions in a row, and a modal that opens, takes one name and closes turns a two-minute job
 * into twelve interruptions. The area you are adding to stays on screen the whole time.
 */

const KIND_LABEL: Readonly<Record<PositionKind, string>> = {
  STANDARD: 'Работно място',
  DRIVING: 'Шофиране',
};

export default function AreasPage() {
  // Bumped after every successful write. The list is re-read from the server rather than patched
  // in place: a position's code and live occupancy are both server-decided, and a client that
  // guessed them would show one thing until the next refresh and another after it.
  const [version, setVersion] = useState(0);
  const state = useApi(() => adminApi.areas(), [version]);
  const reload = () => setVersion((current) => current + 1);

  const [newArea, setNewArea] = useState('');
  const [addingArea, setAddingArea] = useState(false);
  const [areaError, setAreaError] = useState<string | null>(null);

  const areas = state.status === 'ready' ? state.data.areas : [];
  const positionCount = areas.reduce((total, area) => total + area.positions.length, 0);
  const occupied = areas.reduce(
    (total, area) => total + area.positions.filter((position) => position.occupied > 0).length,
    0,
  );

  const submitArea = (event: FormEvent) => {
    event.preventDefault();
    const name = newArea.trim();
    if (!name) return;
    setAddingArea(true);
    setAreaError(null);

    adminApi
      .createArea({ name })
      .then(() => {
        setNewArea('');
        reload();
      })
      .catch((caught: unknown) => {
        setAreaError(caught instanceof ApiError ? describeError(caught) : 'Неуспешно записване.');
      })
      .finally(() => setAddingArea(false));
  };

  return (
    <>
      <AdminHeader
        title="Зони и позиции"
        subtitle="Структурата, по която се отчита работата"
        actions={<ThemeToggle labels={{ light: 'Светла', dark: 'Тъмна', system: 'Системна' }} />}
      />

      <AdminBody>
        {state.status === 'error' ? (
          <Card>
            <p className="ay-small">{describeError(state.error)}</p>
          </Card>
        ) : null}

        <Grid>
          <Kpi
            label="Зони"
            value={state.status === 'loading' ? '—' : String(areas.length)}
            caption="крила, цехове, обекти"
          />
          <Kpi
            label="Позиции"
            value={state.status === 'loading' ? '—' : String(positionCount)}
            caption="общо във всички зони"
          />
          <Kpi
            label="Заети в момента"
            value={state.status === 'loading' ? '—' : String(occupied)}
            caption="позиции с човек на тях"
          />
        </Grid>

        <Card>
          {/*
            The button lives inside the field rather than beside it. Side by side in a row aligned
            to `flex-end`, it sank to the level of the hint text under the input — the hint is part
            of the field, so the field is taller than the button, and the button ended up level
            with a line of grey help text instead of the input it submits.
          */}
          <form onSubmit={submitArea}>
            <Field
              label="Нова зона"
              hint="Например: Цех 1, Склад, Транспорт, Офис — етаж 2"
              action={
                <Button type="submit" disabled={addingArea || newArea.trim().length < 2}>
                  {addingArea ? 'Добавяне…' : 'Добавете зона'}
                </Button>
              }
            >
              <input
                className="ay-input"
                type="text"
                value={newArea}
                maxLength={80}
                onChange={(event) => setNewArea(event.target.value)}
              />
            </Field>
          </form>
          {areaError ? (
            <p
              className="ay-small"
              style={{ color: 'var(--ay-danger)', marginTop: 'var(--ay-space-3)' }}
              role="alert"
            >
              {areaError}
            </p>
          ) : null}
        </Card>

        {state.status === 'ready' && areas.length === 0 ? (
          <Card>
            <p className="ay-small" style={{ fontWeight: 550 }}>
              Още няма нито една зона.
            </p>
            <p className="ay-caption ay-muted" style={{ marginTop: 'var(--ay-space-1)' }}>
              Зоната е част от обекта — цех, склад, етаж, транспорт. Позициите се създават вътре в
              зона, а отчетите групират работата по зони.
            </p>
          </Card>
        ) : null}

        {areas.map((area) => (
          <AreaCard key={area.id} area={area} onChanged={reload} />
        ))}
      </AdminBody>
    </>
  );
}

function AreaCard({ area, onChanged }: { area: WorkAreaRow; onChanged: () => void }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<PositionKind>('STANDARD');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setSaving(true);
    setError(null);

    adminApi
      .createPosition({ workAreaId: area.id, name: trimmed, kind })
      .then(() => {
        setName('');
        setKind('STANDARD');
        onChanged();
      })
      .catch((caught: unknown) => {
        setError(caught instanceof ApiError ? describeError(caught) : 'Неуспешно записване.');
      })
      .finally(() => setSaving(false));
  };

  const archivePosition = (positionId: string) => {
    adminApi
      .updatePosition(positionId, { status: 'ARCHIVED' })
      .then(onChanged)
      .catch((caught: unknown) => {
        // The server refuses while somebody is standing on the position, and that refusal is the
        // useful message — not a generic failure.
        setError(
          caught instanceof ApiError && caught.code === 'position.occupied'
            ? 'В момента някой работи на тази позиция.'
            : 'Позицията не можа да се архивира.',
        );
      });
  };

  return (
    <Card padded={false}>
      <CardHeader>
        <div>
          <h2 className="ay-h3">{area.name}</h2>
          <p className="ay-caption ay-muted">
            {area.code} ·{' '}
            {area.positions.length === 1 ? '1 позиция' : `${area.positions.length} позиции`}
          </p>
        </div>
      </CardHeader>

      {area.positions.length > 0 ? (
        <ul>
          {area.positions.map((position) => (
            <li
              key={position.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--ay-space-3)',
                padding: 'var(--ay-space-3) var(--ay-space-5)',
                borderTop: '1px solid var(--ay-border)',
              }}
            >
              <span className="ay-small" style={{ flex: 1, minWidth: 0 }}>
                {position.name}
              </span>
              {position.kind === 'DRIVING' ? (
                <Badge tone="accent">{KIND_LABEL.DRIVING}</Badge>
              ) : null}
              {position.occupied > 0 ? (
                <Badge tone="success">
                  {position.occupied === 1 ? '1 човек' : `${position.occupied} души`}
                </Badge>
              ) : (
                <span className="ay-caption ay-subtle">свободна</span>
              )}
              <Button
                variant="ghost"
                className="ay-button-row-action"
                onClick={() => archivePosition(position.id)}
                aria-label={`Архивирайте ${position.name}`}
              >
                Архивирайте
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p
          className="ay-caption ay-muted"
          style={{ padding: 'var(--ay-space-4) var(--ay-space-5)' }}
        >
          Няма позиции в тази зона.
        </p>
      )}

      <div
        style={{
          padding: 'var(--ay-space-4) var(--ay-space-5)',
          borderTop: '1px solid var(--ay-border)',
        }}
      >
        <form
          onSubmit={submit}
          style={{ display: 'flex', gap: 'var(--ay-space-3)', alignItems: 'flex-end' }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <Field label="Нова позиция">
              <input
                className="ay-input"
                type="text"
                value={name}
                maxLength={80}
                placeholder="Например: Машина 3, Опаковка, Шофьор"
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
          </div>
          <div style={{ width: '11rem' }}>
            {/*
              Kind is a choice with a consequence, so it is on the creation form rather than
              buried in an edit screen: taking a DRIVING position opens a vehicle assignment and
              a trip, and getting it wrong means a driver whose route is never recorded.
            */}
            <Field label="Вид">
              <select
                className="ay-input"
                value={kind}
                onChange={(event) => setKind(event.target.value as PositionKind)}
              >
                <option value="STANDARD">{KIND_LABEL.STANDARD}</option>
                <option value="DRIVING">{KIND_LABEL.DRIVING}</option>
              </select>
            </Field>
          </div>
          <Button type="submit" variant="secondary" disabled={saving || name.trim().length < 2}>
            {saving ? 'Добавяне…' : 'Добавете'}
          </Button>
        </form>

        {error ? (
          <p
            className="ay-small"
            style={{ color: 'var(--ay-danger)', marginTop: 'var(--ay-space-3)' }}
            role="alert"
          >
            {error}
          </p>
        ) : null}
      </div>
    </Card>
  );
}
