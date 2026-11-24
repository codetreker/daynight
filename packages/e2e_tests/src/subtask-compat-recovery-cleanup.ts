import path from 'node:path';
import { recoverRunOwnership } from './fixture-owner.ts';
import { stopEvidenceGroup, type ProcessEvidence } from './process-evidence.ts';

export type RecoveryResource = { kind: 'container' | 'network' | 'volume' | 'image'; name: string };
export type RecoveryProcess = { id: string; operation: string; proof: ProcessEvidence | null };

// A resource observation is not permission to stop its users. The original
// browser owner and every recorded command must first have actual stop proof.
export const cleanupRecoveryResources = async (input: {
  repository: string; runId: string; mode: 'owner' | 'independent'; browserOwner?: unknown;
  processes: RecoveryProcess[]; resources: RecoveryResource[]; deadline: number;
  save: () => Promise<void>;
  inspect: (resource: RecoveryResource) => Promise<boolean>;
  stop: (resource: RecoveryResource) => Promise<void>;
  remove: (resource: RecoveryResource) => Promise<void>;
}): Promise<{ usersStopped: boolean; observations: Record<string, string>; failures: unknown[] }> => {
  const failures: unknown[] = [];
  for (const process of [...input.processes]) {
    try {
      if (!process.proof) throw new Error(`Original ${process.operation} process identity is unavailable.`);
      await stopEvidenceGroup(process.proof, [], input.deadline);
      const index = input.processes.indexOf(process);
      if (index < 0) throw new Error('Original process evidence disappeared.');
      input.processes.splice(index, 1);
      try { await input.save(); } catch (error) { input.processes.push(process); throw error; }
    } catch (error) { failures.push(error); }
  }
  let browserStopped = input.browserOwner === undefined;
  if (!browserStopped) {
    try {
      const expected = path.join(input.repository, '.tmp', 'product-e2e', input.runId);
      if (input.browserOwner !== expected) throw new Error('Browser ownership identity mismatch.');
      await recoverRunOwnership({ repository: input.repository, runDirectory: expected, mode: input.mode });
      browserStopped = true;
    } catch (error) { failures.push(error); }
  }
  const usersStopped = browserStopped && input.processes.length === 0 && failures.length === 0;
  const observations: Record<string, string> = {};
  let mayMutate = usersStopped;
  for (const resource of input.resources) {
    const key = `${resource.kind}:${resource.name}`;
    try {
      const present = await input.inspect(resource);
      // A failed observation can itself leave a command process unconfirmed.
      if (!mayMutate || input.processes.length !== 0) {
        mayMutate = false;
        observations[key] = present ? 'owned-retained' : 'absent-observed';
        continue;
      }
      if (present) {
        observations[key] = 'owned';
        if (resource.kind === 'container') await input.stop(resource);
        if (input.processes.length !== 0) throw new Error('Related process stop is unconfirmed.');
        await input.remove(resource);
      }
      if (await input.inspect(resource)) throw new Error(`Owned ${resource.kind} remains: ${resource.name}`);
      observations[key] = 'absent';
    } catch (error) { observations[key] = 'unconfirmed'; failures.push(error); mayMutate = false; }
  }
  return { usersStopped: usersStopped && input.processes.length === 0, observations, failures };
};
