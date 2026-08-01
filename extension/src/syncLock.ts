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

export function releaseSync(): void {
  syncing = false;
}
