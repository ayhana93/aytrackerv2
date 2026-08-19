'use client';

import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react';
import type { TrackingState } from '@aytracker/tracking';
import { useTheme } from '../theme/theme-provider';

/**
 * Interface primitives.
 *
 * Thin wrappers over the classes in `styles/base.css`. Deliberately thin: the styling lives in
 * CSS so it runs off the main thread, and these components exist to give it names, sensible
 * defaults and the right ARIA — not to re-implement it in JavaScript.
 */

function cx(...values: (string | false | null | undefined)[]): string {
  return values.filter(Boolean).join(' ');
}

/* ------------------------------------------------------------------ Button */

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  readonly size?: 'default' | 'large';
  readonly block?: boolean;
}

export function Button({
  variant = 'primary',
  size = 'default',
  block = false,
  className,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cx(
        'ay-button',
        `ay-button-${variant}`,
        size === 'large' && 'ay-button-large',
        block && 'ay-button-block',
        className,
      )}
      {...rest}
    />
  );
}

/* -------------------------------------------------------------------- Card */

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  readonly padded?: boolean;
}

export function Card({ padded = true, className, ...rest }: CardProps) {
  return <div className={cx('ay-card', padded && 'ay-card-padded', className)} {...rest} />;
}

export function CardHeader({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cx('ay-card-header', className)} {...rest} />;
}

/* ------------------------------------------------------------------- Badge */

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  readonly tone?: 'accent' | 'success' | 'warning' | 'danger' | 'neutral';
}

export function Badge({ tone = 'neutral', className, ...rest }: BadgeProps) {
  return <span className={cx('ay-badge', `ay-badge-${tone}`, className)} {...rest} />;
}

/* --------------------------------------------------------------- StateCard */

export interface StateCardProps {
  /** "РАБОТИШ", "ДВИЖЕНИЕ" — the state, in the worker's own language. */
  readonly label: string;
  readonly detail?: string;
  /** The running value. Rendered with tabular figures so it does not twitch. */
  readonly value: string;
  readonly caption?: string;
}

export function StateCard({ label, detail, value, caption }: StateCardProps) {
  return (
    <div className="ay-state-card">
      <div>
        <div className="ay-state-card-label">{label}</div>
        {detail ? <div className="ay-small">{detail}</div> : null}
      </div>
      <div style={{ textAlign: 'right' }}>
        <div className="ay-h1 ay-numeric">{value}</div>
        {caption ? <div className="ay-caption">{caption}</div> : null}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- ListRow */

export interface ListRowProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'title'> {
  readonly title: ReactNode;
  readonly subtitle?: ReactNode;
  readonly leading?: ReactNode;
  readonly trailing?: ReactNode;
  readonly selected?: boolean;
  /** Renders a chevron. Omit for rows that act in place rather than navigating. */
  readonly chevron?: boolean;
}

export function ListRow({
  title,
  subtitle,
  leading,
  trailing,
  selected = false,
  chevron = true,
  className,
  ...rest
}: ListRowProps) {
  return (
    <button type="button" className={cx('ay-row', className)} aria-selected={selected} {...rest}>
      {leading}
      <span className="ay-row-main">
        <span style={{ display: 'block', fontWeight: 550 }}>{title}</span>
        {subtitle ? <span className="ay-small ay-muted">{subtitle}</span> : null}
      </span>
      {trailing}
      {chevron ? (
        <span className="ay-row-chevron" aria-hidden="true">
          ›
        </span>
      ) : null}
    </button>
  );
}

/* ------------------------------------------------------------------- Sheet */

export interface SheetProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly title?: string;
  readonly children: ReactNode;
}

/**
 * A bottom sheet.
 *
 * Enters and exits along the same path — up from the bottom, back down — so the way it arrived
 * predicts the way to dismiss it. The scrim dims the content behind because this is a blocking
 * decision; a non-blocking panel would use translucency and no scrim instead.
 */
export function Sheet({ open, onClose, title, children }: SheetProps) {
  if (!open) return null;
  return (
    <>
      <div className="ay-scrim" onClick={onClose} aria-hidden="true" />
      <div
        className="ay-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onClose();
        }}
      >
        <div className="ay-sheet-grabber" aria-hidden="true" />
        {title ? (
          <h2 className="ay-h2" style={{ marginBottom: 'var(--ay-space-4)' }}>
            {title}
          </h2>
        ) : null}
        {children}
      </div>
    </>
  );
}

/* --------------------------------------------------------- TrackingIndicator */

export interface TrackingIndicatorProps {
  readonly state: TrackingState;
  /** Already localized by the caller — this component never contains a user-facing string. */
  readonly label: string;
}

/**
 * The recording indicator.
 *
 * Neutral by construction: it reports the observed state and nothing about why. There is no
 * variant that says a driver switched tracking off, because the system cannot know that.
 */
export function TrackingIndicator({ state, label }: TrackingIndicatorProps) {
  return (
    <span className="ay-tracking">
      <span className="ay-tracking-dot" data-state={state} aria-hidden="true" />
      <span className="ay-caption">{label}</span>
    </span>
  );
}

/* -------------------------------------------------------------- ThemeToggle */

export interface ThemeToggleProps {
  /** Localized labels, supplied by the caller. */
  readonly labels: { light: string; dark: string; system: string };
}

export function ThemeToggle({ labels }: ThemeToggleProps) {
  const { preference, setPreference } = useTheme();
  const order = ['system', 'light', 'dark'] as const;
  const next = order[(order.indexOf(preference) + 1) % order.length]!;

  return (
    <button
      type="button"
      className="ay-button ay-button-ghost"
      style={{ minHeight: '2.25rem', padding: '0 var(--ay-space-3)' }}
      onClick={() => setPreference(next)}
      aria-label={labels[preference]}
      title={labels[preference]}
    >
      <span aria-hidden="true">
        {preference === 'dark' ? '◐' : preference === 'light' ? '○' : '◑'}
      </span>
      <span className="ay-caption">{labels[preference]}</span>
    </button>
  );
}

/* ------------------------------------------------------------------ Portal */

export function PortalShell({ children }: { children: ReactNode }) {
  return <div className="ay-portal">{children}</div>;
}

export function PortalBody({ children }: { children: ReactNode }) {
  return <div className="ay-portal-body">{children}</div>;
}

export interface AppBarProps {
  readonly title?: ReactNode;
  readonly leading?: ReactNode;
  readonly trailing?: ReactNode;
}

export function AppBar({ title, leading, trailing }: AppBarProps) {
  return (
    <header className="ay-appbar">
      {leading}
      <div style={{ flex: 1, minWidth: 0 }}>
        {typeof title === 'string' ? <span className="ay-h3">{title}</span> : title}
      </div>
      {trailing}
    </header>
  );
}

export interface TabBarProps {
  readonly items: readonly { id: string; label: string; icon: string }[];
  readonly activeId: string;
  readonly onSelect: (id: string) => void;
}

export function TabBar({ items, activeId, onSelect }: TabBarProps) {
  return (
    <nav className="ay-tabbar" aria-label="Portal">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          className="ay-tab"
          aria-current={item.id === activeId ? 'page' : undefined}
          onClick={() => onSelect(item.id)}
        >
          <span aria-hidden="true" style={{ fontSize: '1.125rem' }}>
            {item.icon}
          </span>
          <span>{item.label}</span>
        </button>
      ))}
    </nav>
  );
}
