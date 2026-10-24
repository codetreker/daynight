import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readFile, readdir, realpath } from 'node:fs/promises';
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
export type UploadObservation = {
  readonly temporaryFiles: number;
  readonly temporaryBytes: number;
  readonly temporarySha256: string | null;
  readonly finalExists: boolean;
  readonly metadataRows: number;
  readonly memberRows: number;
  readonly memberVersion: string | null;
};
type UploadInput = {
  readonly projectId: string;
  readonly taskId: string;
  readonly path: string;
  readonly prefixBytes: number;
  readonly prefixSha256: string;
  readonly userId: string;
};
type FileObservation = Pick<UploadObservation, 'temporaryFiles' | 'temporaryBytes' | 'temporarySha256' | 'finalExists'>;
type DatabaseObservation = Pick<UploadObservation, 'metadataRows' | 'memberRows' | 'memberVersion'>;

const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const acceptanceRoot = join(repositoryRoot, 'packages/daynight-web/.tmp/acceptance');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const digest = /^[0-9a-f]{64}$/;
const runId = /^\d{14}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const absent = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT';
const emptyFiles = (): FileObservation => ({ temporaryFiles: 0, temporaryBytes: 0, temporarySha256: null, finalExists: false });
const requireValue = (condition: boolean): void => { if (!condition) throw new Error('Invalid combined acceptance target or observation.'); };
const attachmentPath = (value: string): boolean => typeof value === 'string' && value.isWellFormed() && value !== ''
  && !/[\\\p{Cc}\p{Cs}]/u.test(value) && value.split('/').every((part) => part !== '' && part !== '.' && part !== '..');

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

const directoryExists = async (path: string): Promise<boolean> => {
  try {
    const info = await lstat(path);
    requireValue(info.isDirectory() && !info.isSymbolicLink());
    return true;
  } catch (error) { if (absent(error)) return false; throw error; }
};
const nativeFiles = async (root: string, input: UploadInput): Promise<FileObservation> => {
  requireValue(await realpath(root) === root);
  let directory = root;
  for (const part of ['task-attachments', input.projectId, input.taskId.slice(0, 2), input.taskId, ...input.path.split('/').slice(0, -1)]) {
    directory = join(directory, part);
    if (!await directoryExists(directory)) return emptyFiles();
  }
  let temporaryFiles = 0; let temporaryBytes = 0; let temporarySha256: string | null = null;
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (absent(error)) return emptyFiles(); throw error; }
  for (const entry of entries) {
    if (!entry.name.startsWith('.daynight-upload-')) continue;
    requireValue(entry.isFile() && !entry.isSymbolicLink());
    let file: Awaited<ReturnType<typeof open>>;
    try { file = await open(join(directory, entry.name), constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if (absent(error)) continue; throw error; }
    try {
      const info = await file.stat();
      requireValue(info.isFile() && Number.isSafeInteger(info.size) && info.size >= 0);
      temporaryFiles++; temporaryBytes += info.size;
      requireValue(Number.isSafeInteger(temporaryBytes));
      temporarySha256 = null;
      if (temporaryFiles === 1 && info.size === input.prefixBytes) {
        const hash = createHash('sha256');
        const buffer = Buffer.alloc(Math.min(input.prefixBytes, 65_536));
        let position = 0;
        while (position < input.prefixBytes) {
          const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, input.prefixBytes - position), position);
          if (bytesRead === 0) break;
          hash.update(buffer.subarray(0, bytesRead)); position += bytesRead;
        }
        if (position === input.prefixBytes) temporarySha256 = hash.digest('hex');
      }
    } finally { await file.close(); }
  }
  let finalExists = false;
  try {
    const info = await lstat(join(directory, basename(input.path)));
    requireValue(info.isFile() && !info.isSymbolicLink()); finalExists = true;
  } catch (error) { if (!absent(error)) throw error; }
  return { temporaryFiles, temporaryBytes, temporarySha256, finalExists };
};

const containerProbe = `set -eu
directory=$1
[ -d "$directory" ] && [ ! -L "$directory" ] || exit 1
for segment in task-attachments "$2" "$3" "$4"; do
  directory="$directory/$segment"
  [ ! -L "$directory" ] || exit 1
  if [ ! -e "$directory" ]; then printf '0\\t0\\t-\\t0\\n'; exit 0; fi
  if [ ! -d "$directory" ]; then [ ! -e "$directory" ] || exit 1; printf '0\\t0\\t-\\t0\\n'; exit 0; fi
done
remaining=$5
while [ -n "$remaining" ]; do
  segment=\${remaining%%/*}
  if [ "$segment" = "$remaining" ]; then remaining=; else remaining=\${remaining#*/}; fi
  directory="$directory/$segment"
  [ ! -L "$directory" ] || exit 1
  if [ ! -e "$directory" ]; then printf '0\\t0\\t-\\t0\\n'; exit 0; fi
  if [ ! -d "$directory" ]; then [ ! -e "$directory" ] || exit 1; printf '0\\t0\\t-\\t0\\n'; exit 0; fi
done
files=0
bytes=0
checksum=-
for file in "$directory"/.daynight-upload-*; do
  [ ! -L "$file" ] || exit 1
  [ -e "$file" ] || continue
  [ -f "$file" ] || exit 1
  if size=$(stat -c %s "$file" 2>/dev/null); then :; elif [ ! -e "$file" ]; then continue; else exit 1; fi
  files=$((files + 1))
  bytes=$((bytes + size))
  checksum=-
  if [ "$files" -eq 1 ] && [ "$size" -eq "$7" ]; then
    if value=$(sha256sum "$file" 2>/dev/null); then checksum=\${value%% *}; elif [ -e "$file" ]; then exit 1; fi
  fi
done
final=0
[ ! -L "$directory/$6" ] || exit 1
if [ -e "$directory/$6" ]; then [ -f "$directory/$6" ] || exit 1; final=1; fi
printf '%s\\t%s\\t%s\\t%s\\n' "$files" "$bytes" "$checksum" "$final"
`;

export const createAuthCombinedTarget = (target: CombinedTarget, run: CombinedCommand) => {
  try { validateTarget(target); }
  catch { throw new Error('Combined target ownership validation failed.'); }
  const command = async (args: readonly string[], timeoutMs = 10_000): Promise<string> => {
    const output = await run('docker', args, { cwd: repositoryRoot, quiet: true, timeoutMs });
    requireValue(output.length <= 4096);
    return output.trim();
  };
  const verifyDatabase = async (): Promise<void> => {
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
    const label = await command(['inspect', '--format', `{{index .Config.Labels "${target.projectLabel.key}"}}`, target.postgresContainer]);
    requireValue(label === target.projectLabel.value);
    if (target.target === 'container') requireValue(await command(['inspect', '--format', '{{index .Config.Labels "com.docker.compose.service"}}', target.postgresContainer]) === 'postgres');
  };
  const sql = async (query: string): Promise<unknown> => JSON.parse(await command(['exec', target.postgresContainer,
    'psql', '--no-psqlrc', '--set', 'ON_ERROR_STOP=1', '--username', 'daynight', '--dbname', target.database,
    '--tuples-only', '--no-align', '--command', query], 15_000));
  return {
    observeUpload: async (input: UploadInput): Promise<UploadObservation> => {
      try {
        requireValue(uuid.test(input.projectId) && uuid.test(input.taskId) && uuid.test(input.userId) && attachmentPath(input.path)
          && Number.isSafeInteger(input.prefixBytes) && input.prefixBytes > 0 && digest.test(input.prefixSha256));
        await verifyDatabase();
        let files: FileObservation;
        if (target.storage.kind === 'native') files = await nativeFiles(target.storage.root, input);
        else {
          const identity = await command(['inspect', '--format', '{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}|{{.Image}}', target.storage.containerId]);
          requireValue(identity === `${target.projectLabel.value}|server|${target.storage.imageId}`);
          const parts = input.path.split('/');
          const fields = (await command(['exec', target.storage.containerId, 'sh', '-c', containerProbe, 'auth-combined-upload',
            target.storage.root, input.projectId, input.taskId.slice(0, 2), input.taskId, parts.slice(0, -1).join('/'), parts.at(-1)!, String(input.prefixBytes)])).split('\t');
          requireValue(fields.length === 4 && fields.slice(0, 2).every((value) => /^(0|[1-9]\d*)$/.test(value))
            && (fields[2] === '-' || digest.test(fields[2]!)) && (fields[3] === '0' || fields[3] === '1'));
          files = { temporaryFiles: Number(fields[0]), temporaryBytes: Number(fields[1]), temporarySha256: fields[2] === '-' ? null : fields[2]!, finalExists: fields[3] === '1' };
          requireValue(Number.isSafeInteger(files.temporaryFiles) && Number.isSafeInteger(files.temporaryBytes));
        }
        const path = `convert_from(decode('${Buffer.from(input.path).toString('hex')}','hex'),'UTF8')`;
        const database = await sql(`SELECT json_build_object('metadataRows',(SELECT count(*) FROM task_attachments WHERE project_id='${input.projectId}' AND task_id='${input.taskId}' AND path=${path}),'memberRows',(SELECT count(*) FROM project_members WHERE project_id='${input.projectId}' AND user_id='${input.userId}'),'memberVersion',(SELECT version::text FROM project_members WHERE project_id='${input.projectId}' AND user_id='${input.userId}'))`) as DatabaseObservation;
        requireValue((database.metadataRows === 0 || database.metadataRows === 1) && (database.memberRows === 0 || database.memberRows === 1)
          && (database.memberRows === 0 ? database.memberVersion === null : typeof database.memberVersion === 'string'
            && /^[1-9]\d*$/.test(database.memberVersion) && BigInt(database.memberVersion) <= 9223372036854775807n));
        return { ...files, ...database };
      } catch { throw new Error('Combined upload observation failed.'); }
    },
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
