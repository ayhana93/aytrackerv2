'use client';

import { StaffLogin } from '../../../components/staff-login';
import { authApi } from '../../../lib/auth';

/**
 * Worker sign-in.
 *
 * The screen a worker opens at the start of a shift: company code, employee number, PIN. It is
 * linked from the admin dashboard, because the person who has to hand these details to staff is
 * the one who just created the organization and has nowhere else to find them.
 */
export default function WorkerLoginPage() {
  return (
    <StaffLogin
      title="Вход за работници"
      subtitle="Влезте, за да изберете позиция и да започнете смяна."
      identifierLabel="Служебен номер"
      identifierHint="Номерът, с който сте заведени във фирмата"
      submitLabel="Влезте"
      destination="/worker"
      onSubmit={({ organizationSlug, identifier, pin }) =>
        authApi.workerLogin({ organizationSlug, employeeNumber: identifier, pin })
      }
    />
  );
}
