'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  AdminBody,
  AdminHeader,
  Badge,
  Button,
  Card,
  CardHeader,
  Grid,
  Kpi,
  ThemeToggle,
} from '@aytracker/ui';
import { LiveMap } from '../../../components/live-map';
import { RouteMap } from '../../../components/route-map';
import {
  adminApi,
  describeError,
  useApi,
  type LiveSubject,
  type LiveTrackResponse,
} from '../../../lib/admin';
import { ApiError } from '../../../lib/api';

/**
 * Who is out there, right now.
 *
 * One question, answered from one query. Employees and vehicles are not two lists here because
 * they are not two things: a worker driving a van is one person with one phone reporting one
 * stream, and showing them twice would be the clearest possible symptom of a duplicate pipeline.
 *
 * Nothing on this screen is computed in the browser. State, speed, staleness and distance are all
 * the server's — a figure a client can recompute is a figure a client can change, and these end
 * up in cost reports.
 */

const REFRESH_MS = 15_000;

const STATE_LABEL: Readonly<Record<string, string>> = {
  ACTIVE: 'Изпраща',
  DEGRADED: 'Слаб сигнал',
  OFFLINE: 'Офлайн',
  INTERRUPTED: 'Няма данни',
  PAUSED: 'На пауза',
  STOPPED: 'Спряно',
};

const STATE_TONE: Readonly<Record<string, 'success' | 'warning' | 'neutral'>> = {
  ACTIVE: 'success',
  DEGRADED: 'warning',
  OFFLINE: 'warning',
  INTERRUPTED: 'neutral',
  PAUSED: 'neutral',
  STOPPED: 'neutral',
};

type Filter = 'all' | 'driving' | 'working' | 'quiet';

export default function LivePage() {
  const [version, setVersion] = useState(0);
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<LiveSubject | null>(null);
  const state = useApi(() => adminApi.live(), [version]);

  /**
   * Polled rather than pushed.
   *
   * There is no WebSocket in this deployment, and adding a second realtime transport for one
   * screen is a lot of moving parts for fifteen seconds of latency. The map moves markers in
   * place, so a poll costs one small request and no visible redraw.
   */
  useEffect(() => {
    const timer = setInterval(() => setVersion((current) => current + 1), REFRESH_MS);
    return () => clearInterval(timer);
  }, []);

  const subjects = state.status === 'ready' ? state.data.subjects : [];

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return subjects.filter((subject) => {
      if (filter === 'driving' && subject.context !== 'DRIVER_TRIP' && !subject.trip) return false;
      if (filter === 'working' && (subject.context !== 'WORK' || subject.trip)) return false;
      if (filter === 'quiet' && subject.trackingState === 'ACTIVE') return false;
      if (!needle) return true;
      return (
        subject.name.toLowerCase().includes(needle) ||
        (subject.employeeNumber ?? '').toLowerCase().includes(needle) ||
        (subject.vehicle?.registrationNumber ?? '').toLowerCase().includes(needle)
      );
    });
  }, [subjects, filter, search]);

  const driving = subjects.filter((s) => s.trip !== null).length;
  const quiet = subjects.filter((s) => s.trackingState !== 'ACTIVE').length;
  const onBreak = subjects.filter((s) => s.onBreak).length;

  return (
    <>
      <AdminHeader
        title="На живо"
        subtitle={
          state.status === 'ready'
            ? `${subjects.length} проследявани · обновено преди малко`
            : 'Зареждане…'
        }
        actions={
          <>
            <Button variant="ghost" onClick={() => setVersion((current) => current + 1)}>
              Обнови
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

        <Grid>
          <Kpi label="Проследявани" value={String(subjects.length)} caption="в момента" />
          <Kpi label="В движение" value={String(driving)} caption="с автомобил" />
          <Kpi label="В почивка" value={String(onBreak)} caption="от отчетените" />
          <Kpi
            label="Без данни"
            value={String(quiet)}
            goodDirection="down"
            caption="устройството не изпраща"
          />
        </Grid>

        <Card padded={false}>
          <CardHeader>
            <div style={{ display: 'flex', gap: 'var(--ay-space-3)', alignItems: 'center' }}>
              {(
                [
                  ['all', 'Всички'],
                  ['driving', 'В движение'],
                  ['working', 'На обект'],
                  ['quiet', 'Без данни'],
                ] as const
              ).map(([id, label]) => (
                <Button
                  key={id}
                  variant={filter === id ? 'primary' : 'ghost'}
                  onClick={() => setFilter(id)}
                >
                  {label}
                </Button>
              ))}
              <input
                className="ay-input"
                type="search"
                placeholder="Име, номер или регистрация"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                style={{ maxWidth: '18rem', marginLeft: 'auto' }}
              />
            </div>
          </CardHeader>

          <div style={{ padding: 'var(--ay-space-4)' }}>
            {/*
              The map is given every visible subject, and moves its markers rather than
              rebuilding them — so a poll every fifteen seconds does not fight somebody who is
              mid-zoom on a van.
            */}
            <LiveMap subjects={visible} onSelect={setSelected} />
          </div>
        </Card>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 22rem), 1fr))',
            gap: 'var(--ay-space-4)',
          }}
        >
          {visible.length === 0 && state.status === 'ready' ? (
            <Card>
              <p className="ay-small ay-muted">
                Никой не се проследява в момента. Проследяването започва, когато служител започне
                смяна или шофьор започне курс — не преди това.
              </p>
            </Card>
          ) : null}

          {visible.map((subject) => (
            <SubjectCard key={subject.id} subject={subject} onOpen={() => setSelected(subject)} />
          ))}
        </div>

        {selected ? <DayTrack subject={selected} onClose={() => setSelected(null)} /> : null}
      </AdminBody>
    </>
  );
}

function SubjectCard({ subject, onOpen }: { subject: LiveSubject; onOpen: () => void }) {
  return (
    <Card>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          gap: 'var(--ay-space-3)',
        }}
      >
        <div>
          <p className="ay-h3">{subject.name}</p>
          <p className="ay-caption ay-muted">
            {subject.vehicle
              ? `${subject.vehicle.registrationNumber} · ${subject.vehicle.make} ${subject.vehicle.model}`
              : (subject.position ?? 'Без позиция')}
          </p>
        </div>
        <Badge tone={STATE_TONE[subject.trackingState] ?? 'neutral'}>
          {STATE_LABEL[subject.trackingState] ?? subject.trackingState}
        </Badge>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: 'var(--ay-space-3)',
          marginTop: 'var(--ay-space-4)',
        }}
      >
        <Figure label="Пробег" value={`${(subject.distanceMeters / 1000).toFixed(1)} км`} />
        <Figure
          label="Скорост"
          value={subject.speedKph === null ? '—' : `${subject.speedKph} км/ч`}
        />
        <Figure label="Последно" value={freshness(subject.secondsSinceFix)} />
      </div>

      {/*
        Where the position came from. A phone in a driver's pocket is not the van, and saying so
        is the difference between a fact and an assumption somebody acts on.
      */}
      {subject.vehicle ? (
        <p className="ay-caption ay-subtle" style={{ marginTop: 'var(--ay-space-3)' }}>
          Позицията идва от телефона на служителя.
        </p>
      ) : null}

      {subject.batteryLevel !== null && subject.batteryLevel < 0.15 ? (
        <p className="ay-caption" style={{ color: 'var(--ay-warning-soft-text)' }}>
          Батерия {Math.round(subject.batteryLevel * 100)}% — записът може да оредее.
        </p>
      ) : null}

      {subject.devicePermission === 'denied' ? (
        <p className="ay-caption" style={{ color: 'var(--ay-warning-soft-text)' }}>
          Устройството съобщава, че достъпът до местоположение е отказан.
        </p>
      ) : null}

      <Button block variant="secondary" style={{ marginTop: 'var(--ay-space-4)' }} onClick={onOpen}>
        Виж деня
      </Button>
    </Card>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="ay-caption ay-muted">{label}</p>
      <p className="ay-small ay-numeric" style={{ fontWeight: 600 }}>
        {value}
      </p>
    </div>
  );
}

/**
 * One person's working day, as a route with its trips marked.
 *
 * The segments come from the points themselves — consecutive fixes sharing a trip id are one
 * driving stretch, the rest is ordinary working time. Nothing is stored twice to produce this.
 */
function DayTrack({ subject, onClose }: { subject: LiveSubject; onClose: () => void }) {
  const [track, setTrack] = useState<LiveTrackResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setTrack(null);
    setError(null);
    adminApi
      .liveTrack(subject.id)
      .then(setTrack)
      .catch((caught: unknown) =>
        setError(caught instanceof ApiError ? describeError(caught) : 'Маршрутът не се зареди.'),
      );
  }, [subject.id]);

  return (
    <Card padded={false}>
      <CardHeader>
        <div>
          <h2 className="ay-h3">{subject.name} — днес</h2>
          <p className="ay-caption ay-muted">
            {track
              ? `${(track.session.distanceMeters / 1000).toFixed(1)} км · ${Math.round(
                  track.session.untrackedSeconds / 60,
                )} мин без данни`
              : 'Зареждане…'}
          </p>
        </div>
        <Button variant="ghost" onClick={onClose}>
          Затвори
        </Button>
      </CardHeader>

      <div style={{ padding: 'var(--ay-space-4)' }}>
        {error ? <p className="ay-small">{error}</p> : null}

        {track && track.track.pointCount === 0 ? (
          <p className="ay-small ay-muted">Още няма записани точки за този ден.</p>
        ) : null}

        {track && track.track.pointCount > 0 ? (
          <>
            <RouteMap track={track.track} stops={track.stops} height={380} />

            <div style={{ marginTop: 'var(--ay-space-4)' }}>
              <p className="ay-caption ay-muted" style={{ marginBottom: 'var(--ay-space-2)' }}>
                Денят
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--ay-space-2)' }}>
                {track.segments.map((segment, index) => (
                  <div
                    key={`${segment.from}-${index}`}
                    style={{ display: 'flex', gap: 'var(--ay-space-3)', alignItems: 'center' }}
                  >
                    <Badge tone={segment.context === 'DRIVER_TRIP' ? 'accent' : 'neutral'}>
                      {segment.context === 'DRIVER_TRIP' ? 'Курс' : 'Работа'}
                    </Badge>
                    <span className="ay-small ay-numeric">
                      {clock(segment.from)} – {clock(segment.to)}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/*
              Gaps are shown, never smoothed over. A day with nineteen minutes missing is a
              different fact from a fully tracked one, and the person reading this is entitled to
              know which they are looking at.
            */}
            {track.gaps.length > 0 ? (
              <div style={{ marginTop: 'var(--ay-space-4)' }}>
                <p className="ay-caption ay-muted">Прекъсвания</p>
                {track.gaps.map((gap, index) => (
                  <p key={index} className="ay-small ay-muted">
                    {clock(gap.startedAt)} – {gap.endedAt ? clock(gap.endedAt) : 'сега'} ·{' '}
                    {Math.round(gap.seconds / 60)} мин без получени данни
                  </p>
                ))}
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </Card>
  );
}

function freshness(seconds: number | null): string {
  if (seconds === null) return 'няма';
  if (seconds < 60) return 'сега';
  if (seconds < 3600) return `${Math.round(seconds / 60)} мин`;
  return `${Math.round(seconds / 3600)} ч`;
}

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString('bg-BG', { hour: '2-digit', minute: '2-digit' });
}
