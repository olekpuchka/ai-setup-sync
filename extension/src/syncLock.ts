// Guards the workspace against concurrent writers. A sync and a post-sync command both
// write files, and a command that regenerates configs must not race a sync writing the
// files it reads — so they share one lock rather than each having their own flag.

let syncing = false;

/** True while a sync or a post-sync command holds the lock. */
export function isSyncing(): boolean {
  return syncing;
}

/** Claims the lock. Callers check `isSyncing()` first and bail with their own message. */
export function acquireSync(): void {
  syncing = true;
}

const releaseListeners = new Set<() => void>();

/** Calls `listener` each time the lock is released. Returns an unsubscribe function. */
export function onSyncReleased(listener: () => void): () => void {
  releaseListeners.add(listener);
  return () => releaseListeners.delete(listener);
}

export function releaseSync(): void {
  syncing = false;
  // Callers release in a `finally`, so a throwing listener would mask their own error and
  // skip the listeners after it.
  for (const listener of releaseListeners) {
    try {
      listener();
    } catch {
      /* a listener's failure must not affect the release */
    }
  }
}
