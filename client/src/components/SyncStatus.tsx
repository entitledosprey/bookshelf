import type { SyncStatus as Status } from '../types';

/**
 * One quiet line. A sync failure is never alarming, because the shelf below it
 * renders from the local store, which is never deleted.
 */
export function SyncStatus({ status, pending, onSync }: {
  status: Status | null;
  pending: number;
  onSync: () => void;
}) {
  if (!status) return null;

  if (status.running) {
    return <p className="notice">Syncing your Goodreads shelves now.</p>;
  }

  const run = status.lastRun;

  if (!run) {
    return (
      <p className="notice">
        No sync has run yet. <button className="btn btn-ghost" onClick={onSync}>Sync now</button>
      </p>
    );
  }

  if (run.status === 'failed') {
    return (
      <p className="notice">
        The last sync failed: {run.error || 'unknown error'}. The shelf below is unaffected.{' '}
        <button className="btn btn-ghost" onClick={onSync}>Try again</button>
      </p>
    );
  }

  if (run.status === 'partial') {
    return (
      <p className="notice">
        The last sync did not finish every shelf, so some books may be missing. It will resume
        on the next run. <button className="btn btn-ghost" onClick={onSync}>Sync now</button>
      </p>
    );
  }

  if (pending > 0) {
    return (
      <p className="notice">
        Finding cover art and measurements for {pending} more {pending === 1 ? 'book' : 'books'}.
        Their spines will fill in as it goes.
      </p>
    );
  }

  return null;
}
