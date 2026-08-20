import { redirect } from 'next/navigation';

/**
 * The bare domain has no page of its own.
 *
 * A supervisor opening this app wants the admin panel; a worker or driver opens `/worker` or
 * `/driver` directly from a bookmarked device, never through here. `/admin` itself redirects to
 * `/login` when there is no session, so this is the one redirect that covers every visitor.
 */
export default function RootPage() {
  redirect('/admin');
}
