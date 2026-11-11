import childProcess from 'node:child_process';

const stoppedCommandGroup = (group: number): boolean => {
  try {
    const snapshot = childProcess.spawnSync('/bin/ps', ['-axo', 'pid=,pgid=,uid=,stat='], {
      encoding: 'utf8', timeout: 1000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
    });
    const uid = process.getuid?.();
    if (snapshot.error || snapshot.status !== 0 || snapshot.signal !== null ||
      snapshot.stderr !== '' || !snapshot.stdout.endsWith('\n') || uid === undefined ||
      !Number.isSafeInteger(snapshot.pid) || snapshot.pid <= 0) return false;
    const seen = new Set<number>();
    let observerSeen = false;
    let stopped = true;
    for (const line of snapshot.stdout.slice(0, -1).split('\n')) {
      const fields = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([?IRSUZT][A-Za-z+<>-]*)\s*$/.exec(line);
      if (!fields) return false;
      const pid = Number(fields[1]), pgid = Number(fields[2]), owner = Number(fields[3]);
      if (![pid, pgid, owner].every(Number.isSafeInteger) || pid <= 0 || pgid <= 0 || seen.has(pid)) return false;
      seen.add(pid);
      // macOS ps is setuid root, so its effective UID need not match ours.
      if (pid === snapshot.pid) observerSeen = pgid !== group && fields[4]![0] !== '?';
      if (pgid === group && (owner !== uid || !fields[4]!.startsWith('Z'))) stopped = false;
    }
    // A successful complete table must include the ps process itself. Empty or
    // partial output cannot establish that the owned group has disappeared.
    return observerSeen && stopped;
  } catch {
    return false;
  }
};

export const signalCommandGroup = (group: number, signal: NodeJS.Signals, platform = process.platform): void => {
  try { process.kill(-group, signal); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return;
    // Darwin excludes zombies when signalling a group, then reports EPERM if
    // none remain signalable. Preserve permission errors unless readback proves
    // that no owned member can still run; see the lifecycle validation note.
    if (platform === 'darwin' && code === 'EPERM' && stoppedCommandGroup(group)) return;
    throw error;
  }
};
