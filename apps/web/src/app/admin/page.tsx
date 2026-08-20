'use client';

import {
  AdminBody,
  AdminHeader,
  Badge,
  BarRow,
  Card,
  CardHeader,
  DataTable,
  Grid,
  Kpi,
  LineChart,
  ThemeToggle,
  type Column,
} from '@aytracker/ui';

/**
 * Admin dashboard.
 *
 * The screen a plant manager leaves open on a second monitor, so it is ordered by what they are
 * checking for rather than by what is easiest to render: the four numbers first, then the shape
 * of the shift, then the two lists that mean somebody has to do something.
 *
 * Every figure shown here comes from the server. The client renders; it never totals. See
 * docs/api.md — a production total computed in the browser is a production total a browser can
 * change.
 */

const HOURS = ['06', '07', '08', '09', '10', '11', '12', '13', '14'];

const PRODUCTION = {
  plan: [120, 120, 120, 120, 120, 60, 120, 120, 120],
  actual: [112, 128, 131, 124, 118, 54, 126, 133, 96],
};

interface Line {
  readonly id: string;
  readonly name: string;
  readonly produced: number;
  readonly target: number;
}

const LINES: readonly Line[] = [
  { id: 'ext', name: 'Екструзия', produced: 612, target: 640 },
  { id: 'pack', name: 'Опаковка', produced: 448, target: 400 },
  { id: 'paint', name: 'Боядисване', produced: 162, target: 240 },
];

interface ActivePosition {
  readonly id: string;
  readonly worker: string;
  readonly position: string;
  readonly since: string;
  readonly duration: string;
  readonly state: 'WORKING' | 'BREAK' | 'DRIVING';
}

const ACTIVE: readonly ActivePosition[] = [
  {
    id: '1',
    worker: 'Иван Петров',
    position: 'Шофьор · CA 1234 AB',
    since: '07:15',
    duration: '02:35',
    state: 'DRIVING',
  },
  {
    id: '2',
    worker: 'Мария Димитрова',
    position: 'Опаковка',
    since: '06:02',
    duration: '03:48',
    state: 'WORKING',
  },
  {
    id: '3',
    worker: 'Георги Стоянов',
    position: 'Машина 2',
    since: '09:30',
    duration: '00:20',
    state: 'BREAK',
  },
];

interface Warning {
  readonly id: string;
  readonly text: string;
  readonly detail: string;
  readonly tone: 'warning' | 'danger';
}

const WARNINGS: readonly Warning[] = [
  {
    id: 'w1',
    text: 'Прекъснато проследяване',
    detail: 'CA 1234 AB · 19 мин без данни · 09:12–09:31',
    tone: 'warning',
  },
  {
    id: 'w2',
    text: 'Изтичаща квалификация',
    detail: 'Боядисване · Мария Димитрова · след 12 дни',
    tone: 'warning',
  },
  {
    id: 'w3',
    text: 'Смяна над 10 часа',
    detail: 'Георги Стоянов · започната в 05:45',
    tone: 'danger',
  },
];

const STATE_LABEL: Readonly<Record<ActivePosition['state'], string>> = {
  WORKING: 'Работи',
  BREAK: 'Почивка',
  DRIVING: 'На път',
};

const STATE_TONE: Readonly<Record<ActivePosition['state'], 'success' | 'warning' | 'accent'>> = {
  WORKING: 'success',
  BREAK: 'warning',
  DRIVING: 'accent',
};

const ACTIVE_COLUMNS: readonly Column<ActivePosition>[] = [
  { key: 'worker', header: 'Работник', render: (row) => row.worker },
  { key: 'position', header: 'Позиция', render: (row) => row.position },
  { key: 'since', header: 'От', numeric: true, render: (row) => row.since },
  { key: 'duration', header: 'Времетраене', numeric: true, render: (row) => row.duration },
  {
    key: 'state',
    header: 'Състояние',
    render: (row) => <Badge tone={STATE_TONE[row.state]}>{STATE_LABEL[row.state]}</Badge>,
  },
];

export default function AdminDashboardPage() {
  const maxLine = Math.max(...LINES.map((line) => line.target));
  const producedToday = PRODUCTION.actual.reduce((total, value) => total + value, 0);

  return (
    <>
      <AdminHeader
        title="Табло"
        subtitle="Дневна смяна · Завод 1 · 19 август"
        actions={<ThemeToggle labels={{ light: 'Светла', dark: 'Тъмна', system: 'Системна' }} />}
      />

      <AdminBody>
        <Grid>
          <Kpi
            label="Произведено днес"
            value={producedToday.toLocaleString('bg-BG')}
            unit="бр."
            delta={4.2}
            goodDirection="up"
            caption="спрямо вчера по същото време"
          />
          <Kpi
            label="Активни работници"
            value="24"
            delta={0}
            goodDirection="up"
            caption="от 31 на смяна"
          />
          <Kpi
            label="Изпълнение на плана"
            value="97.4"
            unit="%"
            delta={-2.1}
            goodDirection="up"
            caption="спад в 11:00 — планирана почивка"
          />
          {/* Fuel is a cost: a rise is bad news, and the colour has to say so. */}
          <Kpi
            label="Разход за гориво"
            value="184.20"
            unit="лв."
            delta={7.8}
            goodDirection="down"
            caption="4 маршрута · 612 км"
          />
        </Grid>

        <Card padded={false}>
          <CardHeader>
            <div>
              <h2 className="ay-h3">Производство по часове</h2>
              <p className="ay-caption ay-muted">План срещу реално, текуща смяна</p>
            </div>
            <Badge tone="neutral">06:00 – 14:00</Badge>
          </CardHeader>
          <div style={{ padding: 'var(--ay-space-5)' }}>
            <LineChart
              labels={HOURS}
              formatValue={(value) => `${value.toLocaleString('bg-BG')} бр.`}
              series={[
                // Only the actual is filled. The plan is the reference the eye measures against,
                // so it stays a bare line.
                { label: 'План', color: 'var(--ay-chart-plan)', points: PRODUCTION.plan },
                {
                  label: 'Реално',
                  color: 'var(--ay-chart-actual)',
                  points: PRODUCTION.actual,
                  area: true,
                },
              ]}
            />
          </div>
        </Card>

        <Grid wide>
          <Card padded={false}>
            <CardHeader>
              <h2 className="ay-h3">Производство по линии</h2>
            </CardHeader>
            <div
              style={{
                padding: 'var(--ay-space-5)',
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--ay-space-4)',
              }}
            >
              {LINES.map((line, index) => (
                <BarRow
                  key={line.id}
                  label={line.name}
                  value={line.produced}
                  max={maxLine}
                  color={`var(--ay-chart-${index + 1})`}
                  display={`${line.produced} / ${line.target}`}
                />
              ))}
            </div>
          </Card>

          <Card padded={false}>
            <CardHeader>
              <h2 className="ay-h3">Изисква внимание</h2>
              <Badge tone="warning">{WARNINGS.length}</Badge>
            </CardHeader>
            <ul>
              {WARNINGS.map((warning) => (
                <li
                  key={warning.id}
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 'var(--ay-space-3)',
                    padding: 'var(--ay-space-4) var(--ay-space-5)',
                    borderTop: '1px solid var(--ay-border)',
                  }}
                >
                  <span
                    aria-hidden="true"
                    style={{
                      marginTop: '0.35rem',
                      width: '0.5rem',
                      height: '0.5rem',
                      borderRadius: '50%',
                      flex: 'none',
                      background:
                        warning.tone === 'danger' ? 'var(--ay-danger)' : 'var(--ay-warning)',
                    }}
                  />
                  <div>
                    <p className="ay-small" style={{ fontWeight: 550 }}>
                      {warning.text}
                    </p>
                    {/*
                      Neutral wording, always. "Прекъснато проследяване" describes what the server
                      observed; it never asserts that a driver turned anything off. See
                      docs/tracking.md § anti-tampering.
                    */}
                    <p className="ay-caption ay-muted">{warning.detail}</p>
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        </Grid>

        <Card padded={false}>
          <CardHeader>
            <h2 className="ay-h3">Активни позиции</h2>
            <Badge tone="success">{ACTIVE.length} в момента</Badge>
          </CardHeader>
          <DataTable columns={ACTIVE_COLUMNS} rows={ACTIVE} rowKey={(row) => row.id} />
        </Card>
      </AdminBody>
    </>
  );
}
