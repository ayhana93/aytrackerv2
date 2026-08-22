'use client';

import { useEffect, useState, type FormEvent } from 'react';
import {
  AdminBody,
  AdminHeader,
  Button,
  Card,
  CardHeader,
  Field,
  ThemeToggle,
} from '@aytracker/ui';
import { adminApi, describeError, useApi, type SettingsResponse } from '../../../lib/admin';
import { ApiError } from '../../../lib/api';

/**
 * Organization settings.
 *
 * Three groups, and each one exists because something downstream is wrong without it.
 *
 *   * **Fuel.** The price of a litre is the missing half of every fuel figure in the product.
 *     With it, a driver sees what a route has cost and a manager sees cost per kilometre;
 *     without it, both can only count litres. There is no default, and there should not be —
 *     a national average rendered as this organization's cost is an invented number wearing a
 *     currency symbol.
 *
 *   * **Shifts.** Who may open one, and how long an abandoned one is allowed to run before it
 *     is closed at the cap rather than left counting overnight.
 *
 *   * **Tracking.** The sampling floor handed to every driver's phone. Tightening it buys
 *     precision with battery on devices the person setting it does not hold, so the effect is
 *     spelled out next to the field.
 */
export default function SettingsPage() {
  const state = useApi(() => adminApi.settings(), []);

  return (
    <>
      <AdminHeader
        title="Настройки"
        subtitle="Как работи системата за вашата фирма"
        actions={<ThemeToggle labels={{ light: 'Светла', dark: 'Тъмна', system: 'Системна' }} />}
      />

      <AdminBody>
        {state.status === 'error' ? (
          <Card>
            <p className="ay-small">{describeError(state.error)}</p>
          </Card>
        ) : null}

        {state.status === 'loading' ? (
          <Card>
            <p className="ay-small ay-muted">Зареждане…</p>
          </Card>
        ) : null}

        {state.status === 'ready' ? <SettingsForm initial={state.data} /> : null}
      </AdminBody>
    </>
  );
}

function SettingsForm({ initial }: { initial: SettingsResponse }) {
  const [settings, setSettings] = useState(initial);
  const [fuelPrice, setFuelPrice] = useState(initial.fuelPricePerLiter ?? '');
  const [selfStart, setSelfStart] = useState(initial.allowWorkerSelfShiftStart);
  const [maxShift, setMaxShift] = useState(String(initial.maxShiftDurationMinutes));
  const [gpsInterval, setGpsInterval] = useState(String(initial.gpsMinIntervalSeconds));
  const [gpsDistance, setGpsDistance] = useState(String(initial.gpsMinDistanceMeters));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // The confirmation is a moment, not a state. Left on screen it becomes wallpaper, and the next
  // save produces no visible change at all.
  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(false), 4000);
    return () => clearTimeout(timer);
  }, [saved]);

  const price = fuelPrice.trim().replace(',', '.');
  const priceValid = price === '' || (/^\d{1,6}(\.\d{1,4})?$/.test(price) && Number(price) > 0);
  const minutes = Number(maxShift);
  const shiftValid = Number.isInteger(minutes) && minutes >= 60 && minutes <= 1440;
  const interval = Number(gpsInterval);
  const intervalValid = Number.isInteger(interval) && interval >= 5 && interval <= 300;
  const distance = Number(gpsDistance);
  const distanceValid = Number.isInteger(distance) && distance >= 10 && distance <= 2000;
  const valid = priceValid && shiftValid && intervalValid && distanceValid;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!valid || saving) return;
    setSaving(true);
    setError(null);
    setSaved(false);

    adminApi
      .updateSettings({
        // An empty field means "no price", which is a real choice and different from omitting
        // the field. Sent as null so the server clears it rather than keeping the old one.
        fuelPricePerLiter: price === '' ? null : price,
        allowWorkerSelfShiftStart: selfStart,
        maxShiftDurationMinutes: minutes,
        gpsMinIntervalSeconds: interval,
        gpsMinDistanceMeters: distance,
      })
      .then((next) => {
        setSettings(next);
        setFuelPrice(next.fuelPricePerLiter ?? '');
        setSaved(true);
      })
      .catch((caught: unknown) => {
        setError(
          caught instanceof ApiError ? describeError(caught) : 'Настройките не бяха записани.',
        );
      })
      .finally(() => setSaving(false));
  };

  return (
    <form onSubmit={submit} style={{ display: 'grid', gap: 'var(--ay-space-5)' }}>
      <Card padded={false}>
        <CardHeader>
          <div>
            <h2 className="ay-h3">Гориво</h2>
            <p className="ay-caption ay-muted">
              Без цена системата показва литри, но не и стойност. Нищо не се измисля.
            </p>
          </div>
        </CardHeader>
        <div style={{ padding: 'var(--ay-space-5)', display: 'grid', gap: 'var(--ay-space-4)' }}>
          <Field
            label={`Цена на литър (${settings.currency})`}
            hint="Например 2.45. Оставете празно, ако не искате прогнози за стойност."
          >
            <input
              className="ay-input ay-numeric"
              type="text"
              inputMode="decimal"
              value={fuelPrice}
              placeholder="2.45"
              onChange={(event) => setFuelPrice(event.target.value.replace(/[^\d.,]/g, ''))}
            />
          </Field>
          {!priceValid ? (
            <p className="ay-small" style={{ color: 'var(--ay-danger)' }}>
              Въведете цена като 2.45.
            </p>
          ) : null}
          <p className="ay-caption ay-muted">
            Разходът за курс се изчислява от изминатите километри и средния разход на автомобила,
            който се въвежда в „Автопарк“. Това винаги е прогноза — реалните разходи идват от
            касовите бележки.
          </p>
        </div>
      </Card>

      <Card padded={false}>
        <CardHeader>
          <div>
            <h2 className="ay-h3">Смени</h2>
            <p className="ay-caption ay-muted">Кой започва смяна и колко дълго може да е тя.</p>
          </div>
        </CardHeader>
        <div style={{ padding: 'var(--ay-space-5)', display: 'grid', gap: 'var(--ay-space-4)' }}>
          <label
            className="ay-small"
            style={{ display: 'flex', gap: 'var(--ay-space-3)', alignItems: 'flex-start' }}
          >
            <input
              type="checkbox"
              checked={selfStart}
              onChange={(event) => setSelfStart(event.target.checked)}
              style={{ marginTop: '0.2rem' }}
            />
            <span>
              Работниците могат сами да започват смяна
              <span className="ay-caption ay-muted" style={{ display: 'block' }}>
                Ако е изключено, смяната се започва само от ръководител.
              </span>
            </span>
          </label>

          <Field
            label="Максимална дължина на смяна (минути)"
            hint="Забравена смяна се затваря автоматично на този таван, а не в 03:00 сутринта."
          >
            <input
              className="ay-input ay-numeric"
              type="number"
              min={60}
              max={1440}
              value={maxShift}
              onChange={(event) => setMaxShift(event.target.value)}
            />
          </Field>
          {!shiftValid ? (
            <p className="ay-small" style={{ color: 'var(--ay-danger)' }}>
              Между 60 и 1440 минути.
            </p>
          ) : null}
        </div>
      </Card>

      <Card padded={false}>
        <CardHeader>
          <div>
            <h2 className="ay-h3">Проследяване</h2>
            <p className="ay-caption ay-muted">
              Колко често телефоните на шофьорите изпращат позиция.
            </p>
          </div>
        </CardHeader>
        <div style={{ padding: 'var(--ay-space-5)', display: 'grid', gap: 'var(--ay-space-4)' }}>
          <Field
            label="Минимален интервал (секунди)"
            hint="По-малка стойност е по-точно, но изразходва повече батерия."
          >
            <input
              className="ay-input ay-numeric"
              type="number"
              min={5}
              max={300}
              value={gpsInterval}
              onChange={(event) => setGpsInterval(event.target.value)}
            />
          </Field>

          <Field
            label="Минимално разстояние (метри)"
            hint="Точки по-близки от това не се изпращат — така спиране на светофар не пълни маршрута."
          >
            <input
              className="ay-input ay-numeric"
              type="number"
              min={10}
              max={2000}
              value={gpsDistance}
              onChange={(event) => setGpsDistance(event.target.value)}
            />
          </Field>

          {!intervalValid || !distanceValid ? (
            <p className="ay-small" style={{ color: 'var(--ay-danger)' }}>
              Интервалът е между 5 и 300 секунди, разстоянието между 10 и 2000 метра.
            </p>
          ) : null}

          <p className="ay-caption ay-muted">
            Курсът се записва непрекъснато от началото до края. Шофьорът няма бутон за пауза —
            спиранията се виждат сами на маршрута.
          </p>
        </div>
      </Card>

      {error ? (
        <p className="ay-small" style={{ color: 'var(--ay-danger)' }} role="alert">
          {error}
        </p>
      ) : null}

      <div style={{ display: 'flex', gap: 'var(--ay-space-3)', alignItems: 'center' }}>
        <Button type="submit" disabled={saving || !valid}>
          {saving ? 'Записване…' : 'Запишете настройките'}
        </Button>
        {saved ? (
          <span className="ay-small" style={{ color: 'var(--ay-state-working)' }} role="status">
            Записано.
          </span>
        ) : null}
      </div>
    </form>
  );
}
