'use client';

import { StaffLogin } from '../../../components/staff-login';
import { authApi } from '../../../lib/auth';

/**
 * Driver sign-in.
 *
 * Separate from the worker door rather than a mode of it. A driver who takes a vehicle straight
 * from the yard never touches a position picker, and asking them to sign in as a worker first
 * would be a screen they have no reason to see. Workers who move to driving during a shift are
 * handed over by the position picker instead, with the session already elevated.
 */
export default function DriverLoginPage() {
  return (
    <StaffLogin
      title="Вход за шофьори"
      subtitle="Влезте, за да започнете курс с вашето превозно средство."
      identifierLabel="Код на шофьора"
      identifierHint="Кодът, с който сте заведени във фирмата"
      submitLabel="Влезте"
      destination="/driver"
      onSubmit={({ organizationSlug, identifier, pin }) =>
        authApi.driverLogin({ organizationSlug, driverCode: identifier, pin })
      }
    />
  );
}
