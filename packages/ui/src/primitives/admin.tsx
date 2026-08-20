'use client';

import type { HTMLAttributes, ReactNode } from 'react';
import { kpiSentiment, niceCeiling, sum } from './chart-math';

/**
 * Admin primitives.
 *
 * The desktop half of the design system: the shell, the KPI grid, tables and charts. Same rule
 * as the portal primitives — the styling lives in `styles/base.css`, and these exist to name it,
 * give it the right semantics and keep the markup honest.
 *
 * The charts are inline SVG on purpose. A charting library would ship its own colour scale and
 * its own renderer, would not read the theme tokens, and would be larger than this entire
 * package. What is drawn here is four chart types, each about forty lines.
 */

function cx(...values: (string | false | null | undefined)[]): string {
  return values.filter(Boolean).join(' ');
}

/* ------------------------------------------------------------------- Shell */

export function AdminShell({ children }: { children: ReactNode }) {
  return <div className="ay-admin">{children}</div>;
}

export interface SidebarProps {
  readonly brand: ReactNode;
  readonly children: ReactNode;
}

export function Sidebar({ brand, children }: SidebarProps) {
  return (
    <nav className="ay-sidebar" aria-label="Основна навигация">
      <div className="ay-sidebar-brand">{brand}</div>
      {children}
    </nav>
  );
}

export function SidebarSection({ children }: { children: ReactNode }) {
  return <div className="ay-sidebar-section">{children}</div>;
}

export interface NavItemProps {
  readonly icon?: ReactNode;
  readonly label: string;
  readonly active?: boolean;
  readonly onSelect?: () => void;
}

export function NavItem({ icon, label, active = false, onSelect }: NavItemProps) {
  return (
    <button
      type="button"
      className="ay-nav-item"
      // `aria-current="page"` rather than a class alone: the styling and the announcement come
      // from the same fact, so they cannot drift apart.
      aria-current={active ? 'page' : undefined}
      onClick={onSelect}
    >
      {icon ? (
        <span className="ay-nav-icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      {label}
    </button>
  );
}

export interface AdminHeaderProps {
  readonly title: ReactNode;
  readonly subtitle?: ReactNode;
  readonly actions?: ReactNode;
}

export function AdminHeader({ title, subtitle, actions }: AdminHeaderProps) {
  return (
    <header className="ay-admin-header">
      <div>
        <h1 className="ay-h2">{title}</h1>
        {subtitle ? <p className="ay-caption ay-muted">{subtitle}</p> : null}
      </div>
      {actions ? (
        <div style={{ display: 'flex', gap: 'var(--ay-space-3)', alignItems: 'center' }}>
          {actions}
        </div>
      ) : null}
    </header>
  );
}

export function AdminBody({ children }: { children: ReactNode }) {
  return <div className="ay-admin-body">{children}</div>;
}

export function Grid({
  wide = false,
  className,
  ...rest
}: HTMLAttributes<HTMLDivElement> & { wide?: boolean }) {
  return <div className={cx(wide ? 'ay-grid-wide' : 'ay-grid', className)} {...rest} />;
}

/* --------------------------------------------------------------------- KPI */

export interface KpiProps {
  readonly label: string;
  readonly value: string;
  readonly unit?: string;
  /** Signed percentage against the comparison period, or null when there is nothing to compare. */
  readonly delta?: number | null;
  /**
   * Which direction is good news.
   *
   * Required whenever a delta is shown, and deliberately without a default, because the component
   * cannot know: a rise in output is good, a rise in fuel cost per kilometre is not. Colouring
   * every increase green would tell a fleet manager their costs are improving while they climb.
   */
  readonly goodDirection?: 'up' | 'down';
  readonly caption?: string;
}

/**
 * One number, large, with its change against the previous period.
 *
 * The delta is the part that earns the card. A figure with nothing to compare it to tells a
 * supervisor what happened; a figure with a direction tells them whether to do something.
 */
export function Kpi({ label, value, unit, delta = null, goodDirection = 'up', caption }: KpiProps) {
  const movement = delta === null || delta === 0 ? 'flat' : delta > 0 ? 'up' : 'down';
  const arrow = movement === 'up' ? '▲' : movement === 'down' ? '▼' : '—';
  // The arrow says which way the number went; the colour says whether that is good. Keeping them
  // separate is what lets one component serve output and cost without lying about either.
  const sentiment = kpiSentiment(delta, goodDirection);

  return (
    <div className="ay-card ay-card-padded">
      <div className="ay-kpi-label">
        <span>{label}</span>
        {delta !== null ? (
          <span className="ay-delta" data-direction={sentiment}>
            <span aria-hidden="true">{arrow}</span>
            {Math.abs(delta).toFixed(1)}%
          </span>
        ) : null}
      </div>
      <div className="ay-kpi-value">
        {value}
        {unit ? (
          <span className="ay-small ay-muted" style={{ marginLeft: 'var(--ay-space-2)' }}>
            {unit}
          </span>
        ) : null}
      </div>
      {caption ? <p className="ay-caption ay-muted">{caption}</p> : null}
    </div>
  );
}

/* ------------------------------------------------------------------- Table */

export interface Column<Row> {
  readonly key: string;
  readonly header: string;
  /** Right-aligned with tabular figures. Use for anything a reader compares down a column. */
  readonly numeric?: boolean;
  readonly render: (row: Row) => ReactNode;
}

export interface DataTableProps<Row> {
  readonly columns: readonly Column<Row>[];
  readonly rows: readonly Row[];
  readonly rowKey: (row: Row) => string;
  readonly empty?: ReactNode;
}

export function DataTable<Row>({ columns, rows, rowKey, empty }: DataTableProps<Row>) {
  if (rows.length === 0) {
    return (
      <div style={{ padding: 'var(--ay-space-8)', textAlign: 'center' }}>
        <p className="ay-small ay-muted">{empty ?? 'Няма записи.'}</p>
      </div>
    );
  }

  return (
    // Its own scroll container, so a fleet table with twelve columns never makes the page scroll
    // sideways underneath the sidebar.
    <div className="ay-table-scroll">
      <table className="ay-table">
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key} className={column.numeric ? 'ay-num' : undefined} scope="col">
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)}>
              {columns.map((column) => (
                <td key={column.key} className={column.numeric ? 'ay-num' : undefined}>
                  {column.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------------------ Charts */

export interface Series {
  readonly label: string;
  readonly color: string;
  readonly points: readonly number[];
  /**
   * Fill the region under the line.
   *
   * Off by default, and at most one series should turn it on. Two translucent areas both drawn
   * from the baseline stack into an opaque wash that hides the very shape the chart exists to
   * show — the reference chart fills one series and strokes the other for exactly this reason.
   */
  readonly area?: boolean;
}

export interface LineChartProps {
  readonly series: readonly Series[];
  readonly labels: readonly string[];
  readonly height?: number;
  /** Formats the axis ticks and the legend totals. */
  readonly formatValue?: (value: number) => string;
}

/**
 * A time series, plan against actual.
 *
 * Drawn in a fixed 0–100 user space and scaled by `viewBox`, so it is resolution-independent and
 * needs no measurement pass — the chart is correct on the server render, before any JavaScript
 * has decided how wide it is.
 */
export function LineChart({ series, labels, height = 220, formatValue }: LineChartProps) {
  const peak = Math.max(1, ...series.flatMap((s) => [...s.points]));
  // Round the top of the scale up to a clean number and leave headroom, so the highest point is
  // not welded to the top edge and the axis ticks read as quantities rather than fractions.
  const max = niceCeiling(peak * 1.1);
  const columns = Math.max(1, labels.length - 1);
  const ticks = [1, 0.75, 0.5, 0.25, 0];

  const toX = (index: number): number => (index / columns) * 100;
  const toY = (value: number): number => 100 - (value / max) * 100;

  return (
    <figure style={{ margin: 0 }}>
      <div style={{ display: 'flex', gap: 'var(--ay-space-3)' }}>
        {/*
          The axis lives outside the SVG. Inside it the non-uniform scale that makes the chart
          responsive would stretch the numerals horizontally.
        */}
        <div
          aria-hidden="true"
          style={{
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
            height,
            color: 'var(--ay-chart-axis)',
            fontSize: '0.6875rem',
            fontVariantNumeric: 'tabular-nums',
            textAlign: 'right',
          }}
        >
          {ticks.map((fraction) => (
            <span key={fraction} style={{ transform: 'translateY(-0.4em)' }}>
              {Math.round(max * fraction).toLocaleString('bg-BG')}
            </span>
          ))}
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <svg
            className="ay-chart"
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            style={{ height, display: 'block' }}
            role="img"
            aria-label={series
              .map(
                (s) =>
                  `${s.label}: ${formatValue ? formatValue(sum(s.points)) : sum(s.points).toString()}`,
              )
              .join(', ')}
          >
            {ticks.map((fraction) => (
              <line
                key={fraction}
                className="ay-chart-grid"
                x1="0"
                x2="100"
                y1={(1 - fraction) * 100}
                y2={(1 - fraction) * 100}
                // The stroke must not stretch with the non-uniform scale, or horizontal rules end
                // up thicker than vertical ones.
                vectorEffect="non-scaling-stroke"
              />
            ))}

            {series.map((s) => (
              <g key={s.label}>
                {s.area ? (
                  <path
                    className="ay-chart-area"
                    fill={s.color}
                    d={`M 0 100 ${s.points.map((value, index) => `L ${toX(index)} ${toY(value)}`).join(' ')} L 100 100 Z`}
                  />
                ) : null}
                <path
                  className="ay-chart-line"
                  stroke={s.color}
                  vectorEffect="non-scaling-stroke"
                  d={s.points
                    .map((value, index) => `${index === 0 ? 'M' : 'L'} ${toX(index)} ${toY(value)}`)
                    .join(' ')}
                />
              </g>
            ))}
          </svg>

          {/*
            Inside the chart column, not the figure. Sitting outside it the row would span the
            y-axis gutter too, and every tick would drift left of the point it labels.
          */}
          <div
            aria-hidden="true"
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              marginTop: 'var(--ay-space-2)',
              color: 'var(--ay-chart-axis)',
              fontSize: '0.6875rem',
            }}
          >
            {labels.map((label) => (
              <span key={label}>{label}</span>
            ))}
          </div>
        </div>
      </div>

      {/*
        The legend doubles as the accessible summary: a screen reader gets the series names and
        their totals, which is the information the shape of the line is carrying.
      */}
      <div className="ay-legend">
        {series.map((s) => (
          <span key={s.label} className="ay-legend-item">
            <span className="ay-legend-swatch" style={{ background: s.color }} aria-hidden="true" />
            {s.label}
            {formatValue ? (
              <strong style={{ color: 'var(--ay-text)' }}>{formatValue(sum(s.points))}</strong>
            ) : null}
          </span>
        ))}
      </div>
    </figure>
  );
}

export interface Slice {
  readonly label: string;
  readonly value: number;
  readonly color: string;
}

export interface DonutChartProps {
  readonly slices: readonly Slice[];
  readonly total: string;
  readonly totalLabel: string;
  readonly formatValue: (value: number) => string;
}

/**
 * Cost breakdown.
 *
 * A donut rather than a pie because the hole holds the total, which is the number a fleet manager
 * actually came for. The slices answer the follow-up question.
 */
export function DonutChart({ slices, total, totalLabel, formatValue }: DonutChartProps) {
  const sum = slices.reduce((accumulator, slice) => accumulator + slice.value, 0) || 1;
  const radius = 15.915_494_309_189_535; // circumference = 100, so each slice's length is its %.
  let offset = 25; // Start at twelve o'clock rather than three.

  return (
    <div
      style={{ display: 'flex', alignItems: 'center', gap: 'var(--ay-space-6)', flexWrap: 'wrap' }}
    >
      <div style={{ position: 'relative', width: '9rem', height: '9rem', flex: 'none' }}>
        <svg viewBox="0 0 36 36" role="img" aria-label={totalLabel} style={{ width: '100%' }}>
          {slices.map((slice) => {
            const percent = (slice.value / sum) * 100;
            const circle = (
              <circle
                key={slice.label}
                cx="18"
                cy="18"
                r={radius}
                fill="none"
                stroke={slice.color}
                strokeWidth="3.6"
                strokeDasharray={`${percent} ${100 - percent}`}
                strokeDashoffset={offset}
              />
            );
            offset -= percent;
            return circle;
          })}
        </svg>
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'grid',
            placeItems: 'center',
            textAlign: 'center',
          }}
        >
          <div>
            <div className="ay-h2 ay-numeric">{total}</div>
            <div className="ay-caption ay-muted">{totalLabel}</div>
          </div>
        </div>
      </div>

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--ay-space-2)',
          flex: 1,
          minWidth: '12rem',
        }}
      >
        {slices.map((slice) => (
          <div
            key={slice.label}
            style={{ display: 'flex', alignItems: 'center', gap: 'var(--ay-space-3)' }}
          >
            <span
              className="ay-legend-swatch"
              style={{ background: slice.color }}
              aria-hidden="true"
            />
            <span className="ay-small" style={{ flex: 1 }}>
              {slice.label}
            </span>
            <span className="ay-small ay-numeric">{formatValue(slice.value)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export interface BarRowProps {
  readonly label: string;
  readonly value: number;
  readonly max: number;
  readonly color?: string;
  readonly display: string;
}

/** A labelled proportion. Used for production by line, where the ranking is the message. */
export function BarRow({ label, value, max, color, display }: BarRowProps) {
  const percent = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--ay-space-2)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--ay-space-3)' }}>
        <span className="ay-small">{label}</span>
        <span className="ay-small ay-numeric ay-muted">{display}</span>
      </div>
      <div
        className="ay-bar-track"
        role="meter"
        aria-valuenow={Math.round(percent)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
      >
        <div
          className="ay-bar-fill"
          style={{ width: `${percent}%`, background: color ?? 'var(--ay-accent)' }}
        />
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------- Form */

export interface FieldProps {
  readonly label: string;
  readonly hint?: string;
  readonly children: ReactNode;
}

export function Field({ label, hint, children }: FieldProps) {
  return (
    <label className="ay-field">
      <span className="ay-label">{label}</span>
      {children}
      {hint ? <span className="ay-caption ay-muted">{hint}</span> : null}
    </label>
  );
}
