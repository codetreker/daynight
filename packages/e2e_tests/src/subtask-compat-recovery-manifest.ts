import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CommandResult } from './command.ts';
import { parseMigrationManifest, type MigrationEntry } from './subtask-compat-recovery-migrations.ts';

export type RegistryKind = 'legacy' | 'baseline';
export const makeRegistryProbe = (template: string, registry: RegistryKind): string => {
  const marker = 'for _, migration := range schemaMigrations {';
  if (template.split(marker).length !== 2 || template.split('migration.checksum()').length !== 2) throw new Error('Migration probe template is invalid.');
  return registry === 'legacy' ? template : template.replace(marker, 'for _, migration := range migrationChecksums(schemaMigrations) {').replace('migration.checksum()', 'migration.checksum');
};
export const registryProbeHash = (template: string, registry: RegistryKind): string => createHash('sha256').update(makeRegistryProbe(template, registry)).digest('hex');

// The private checkout compiles the production registry and its checksum method;
// the probe never opens a database or substitutes for the production Server.
export const readRegisteredMigrations = async (input: {
  source: string; probe: string; overlayFile: string; environment: NodeJS.ProcessEnv;
  command: (name: string, values: string[], cwd?: string, timeoutMs?: number, environment?: NodeJS.ProcessEnv) => Promise<CommandResult>;
}): Promise<{ entries: MigrationEntry[]; probeSHA256: string; registry: 'legacy' | 'baseline' }> => {
  const module = path.join(input.source, 'packages/daynight-server');
  const overlay = JSON.parse(await readFile(path.join(module, 'scripts/unit-overlay.json'), 'utf8')) as { Replace: Record<string, string> };
  if (!overlay || typeof overlay.Replace !== 'object' || overlay.Replace === null || Array.isArray(overlay.Replace)) throw new Error('Migration probe overlay is invalid.');
  const webDistribution = path.join(module, 'internal/service/webui/dist') + path.sep;
  const webFixtures = path.join(module, 'internal/service/webui/testdata') + path.sep;
  const replacements = Object.fromEntries(Object.entries(overlay.Replace).map(([from, to]) => {
    if (typeof to !== 'string' || path.isAbsolute(from) || path.isAbsolute(to)) throw new Error('Migration probe overlay is invalid.');
    const source = path.resolve(module, from), fixture = path.resolve(module, to);
    if (!source.startsWith(webDistribution) || !fixture.startsWith(webFixtures)) throw new Error('Migration probe overlay may only replace Web fixtures.');
    return [source, fixture];
  }));
  await writeFile(input.overlayFile, JSON.stringify({ Replace: replacements }), { mode: 0o600 });
  const filename = path.join(module, 'internal/core/store/postgres/zz_recovery_migration_manifest.go');
  const commandName = `recovery-manifest-${randomUUID()}`, commandDirectory = path.join(module, '.tmp', commandName);
  // Compile the actual production checksum function when a baseline is present.
  let registry: 'legacy' | 'baseline' = 'baseline';
  try { await readFile(path.join(module, 'internal/core/store/postgres/migration_ledger.go')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    registry = 'legacy';
  }
  const template = await readFile(input.probe, 'utf8');
  const probe = makeRegistryProbe(template, registry);
  const probeSHA256 = registryProbeHash(template, registry);
  await writeFile(filename, probe, { flag: 'wx', mode: 0o600 });
  let directoryCreated = false, commandStarted = false, commandFinished = false;
  try {
    await mkdir(path.dirname(commandDirectory), { recursive: true, mode: 0o700 });
    await mkdir(commandDirectory, { mode: 0o700 }); directoryCreated = true;
    await writeFile(path.join(commandDirectory, 'main.go'), `package main
import (
  "encoding/json"
  "fmt"
  postgres "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
)
func main() {
  data, err := json.Marshal(postgres.RecoveryMigrationManifest())
  if err != nil { panic(err) }
  fmt.Printf("DAYNIGHT_RECOVERY_MANIFEST=%s\\n", data)
}
`, { flag: 'wx', mode: 0o600 });
    const environment = { ...input.environment };
    delete environment.DAYNIGHT_TEST_DATABASE_URL;
    delete environment.DAYNIGHT_TEST_STORE_ROOT_DATABASE_URL;
    delete environment.DAYNIGHT_TEST_REDIS_URL;
    commandStarted = true;
    const result = await input.command('go', ['run', `-overlay=${input.overlayFile}`, `./.tmp/${commandName}`], module, 600_000, environment);
    commandFinished = true;
    const markers = [...result.stdout.matchAll(/^DAYNIGHT_RECOVERY_MANIFEST=(.+)$/gm)];
    if (result.exitCode !== 0 || markers.length !== 1) throw new Error('Registered migration manifest probe did not return exactly once.');
    return { entries: parseMigrationManifest(JSON.parse(markers[0]![1]!)), probeSHA256, registry };
  } finally {
    // A rejected command may still have an unconfirmed process. Preserve its
    // source until the owning runner has verified that process has stopped.
    if (!commandStarted || commandFinished) {
      const cleanup = await Promise.allSettled([rm(filename), ...(directoryCreated ? [rm(commandDirectory, { recursive: true, force: true })] : [])]);
      const failures = cleanup.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason);
      if (failures.length) throw new AggregateError(failures, 'Migration manifest probe cleanup failed.');
    }
  }
};
