import { readFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyStorage, type StorageReceipt } from './storage.mts';
import type { CommandOptions } from './process.mts';

export type CombinedCommand = (file: string, args: readonly string[], options?: Omit<CommandOptions, 'cwd'> & { cwd?: string }) => Promise<string>;
export type CombinedTarget = {
  readonly target: 'native' | 'container';
  readonly baseUrl: string;
  readonly sourceGitSha: string;
  readonly acceptanceDirectory: string;
  readonly postgresContainer: string;
  readonly projectLabel: { readonly key: string; readonly value: string };
  readonly database: 'daynight';
  readonly storage: { readonly kind: 'native'; readonly root: string }
    | { readonly kind: 'container'; readonly root: '/var/lib/daynight/storage'; readonly containerId: string; readonly imageId: string };
};
const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const acceptanceRoot = join(repositoryRoot, 'packages/daynight-web/.tmp/acceptance');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const runId = /^\d{14}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const requireValue = (condition: boolean): void => { if (!condition) throw new Error('Invalid combined acceptance target or credential.'); };
const validateTarget = (target: CombinedTarget): void => {
  const origin = new URL(target.baseUrl);
  requireValue(origin.origin === target.baseUrl && origin.protocol === 'http:' && origin.hostname === '127.0.0.1' && origin.port !== '');
  requireValue(/^[0-9a-f]{40}$/.test(target.sourceGitSha) && target.database === 'daynight'
    && isAbsolute(target.acceptanceDirectory) && resolve(target.acceptanceDirectory) === target.acceptanceDirectory
    && dirname(target.acceptanceDirectory) === acceptanceRoot && runId.test(basename(target.acceptanceDirectory))
    && /^[a-zA-Z0-9_.-]+$/.test(target.postgresContainer));
  if (target.target === 'native') {
    const owner = `daynight-web-${basename(target.acceptanceDirectory)}`;
    requireValue(target.projectLabel.key === 'io.daynight.acceptance.run' && target.projectLabel.value === owner
      && target.postgresContainer === `${owner}-postgres` && target.storage.kind === 'native'
      && [join(target.acceptanceDirectory, 'native-storage/data'), join(target.acceptanceDirectory, 'native-storage/mount/data')].includes(target.storage.root));
  } else {
    requireValue(target.target === 'container' && target.projectLabel.key === 'com.docker.compose.project'
      && /^daynight-dev-ci-\d{14}-[1-9]\d*-\d{5}$/.test(target.projectLabel.value)
      && target.storage.kind === 'container' && target.storage.root === '/var/lib/daynight/storage');
    if (target.storage.kind === 'container') requireValue(/^[0-9a-f]{12,64}$/.test(target.storage.containerId)
      && /^sha256:[0-9a-f]{64}$/.test(target.storage.imageId));
  }
};

export const createAuthCombinedTarget = (target: CombinedTarget, run: CombinedCommand) => {
  try { validateTarget(target); }
  catch { throw new Error('Combined target ownership validation failed.'); }
  const command = async (args: readonly string[], timeoutMs = 10_000): Promise<string> => {
    const output = await run('docker', args, { cwd: repositoryRoot, quiet: true, timeoutMs });
    requireValue(output.length <= 4096);
    return output.trim();
  };
  const verifyOwnership = async (): Promise<void> => {
    const evidence = JSON.parse(await readFile(join(target.acceptanceDirectory, 'evidence.json'), 'utf8')) as {
      schemaVersion: unknown; runId: unknown; source?: { gitSha?: unknown };
      native?: { storageRoot?: string; storage?: StorageReceipt };
    };
    requireValue(evidence.schemaVersion === 3 && evidence.runId === basename(target.acceptanceDirectory)
      && evidence.source?.gitSha === target.sourceGitSha);
    if (target.storage.kind === 'native') {
      const storage = evidence.native?.storage;
      requireValue(storage !== undefined && evidence.native?.storageRoot === join(target.acceptanceDirectory, 'native-storage')
        && storage.directory === evidence.native.storageRoot && storage.root === target.storage.root);
      await verifyStorage(storage!);
    }
  };
  const verifyDatabase = async (): Promise<void> => {
    await verifyOwnership();
    const label = await command(['inspect', '--format', `{{index .Config.Labels "${target.projectLabel.key}"}}`, target.postgresContainer]);
    requireValue(label === target.projectLabel.value);
    if (target.target === 'container') requireValue(await command(['inspect', '--format', '{{index .Config.Labels "com.docker.compose.service"}}', target.postgresContainer]) === 'postgres');
  };
  const sql = async (query: string): Promise<unknown> => JSON.parse(await command(['exec', target.postgresContainer,
    'psql', '--no-psqlrc', '--set', 'ON_ERROR_STOP=1', '--username', 'daynight', '--dbname', target.database,
    '--tuples-only', '--no-align', '--command', query], 15_000));
  return {
    expirePAT: async (input: { readonly id: string; readonly userId: string }): Promise<{ id: string; userId: string; expiresAt: string }> => {
      try {
        requireValue(uuid.test(input.id) && uuid.test(input.userId));
        await verifyDatabase();
        const rows = await sql(`WITH expired AS (UPDATE personal_access_tokens SET expires_at=created_at+interval '1 microsecond' WHERE id='${input.id}' AND user_id='${input.userId}' AND created_at+interval '1 microsecond'<clock_timestamp() RETURNING id,user_id,expires_at) SELECT coalesce(json_agg(json_build_object('id',id::text,'userId',user_id::text,'expiresAt',expires_at)), '[]'::json) FROM expired`) as { id: string; userId: string; expiresAt: string }[];
        requireValue(Array.isArray(rows) && rows.length === 1 && rows[0]!.id === input.id && rows[0]!.userId === input.userId
          && typeof rows[0]!.expiresAt === 'string' && Number.isFinite(Date.parse(rows[0]!.expiresAt)));
        return rows[0]!;
      } catch { throw new Error('Combined PAT expiry failed.'); }
    },
  };
};
