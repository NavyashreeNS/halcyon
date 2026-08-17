import { Dashboard } from '@/components/dashboard';

/**
 * The dashboard is a client component that polls the gateway directly from the browser.
 *
 * Proxying through a Next server route was the obvious alternative and is the wrong call
 * here: it would put a second hop between the operator and the live state, add a cache the
 * operator cannot see, and make the page's freshness depend on the health of a service that
 * has nothing to do with inference. Talking straight to the control plane means what is on
 * screen is what the gateway believes, with one network hop of delay and no intermediary.
 */
export const dynamic = 'force-dynamic';

export default function Page() {
  return <Dashboard />;
}
