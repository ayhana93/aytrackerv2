import type { ReactNode } from 'react';
import { FieldApp } from '../../components/field-app';

/**
 * The worker portal's route tree, including its login screen.
 *
 * Exists so the service worker is registered before sign-in rather than after it — see
 * `components/field-app.tsx`.
 */
export default function WorkerLayout({ children }: { children: ReactNode }) {
  return <FieldApp>{children}</FieldApp>;
}
