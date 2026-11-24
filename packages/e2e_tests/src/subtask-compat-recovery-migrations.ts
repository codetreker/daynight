import { createHash } from 'node:crypto';

export type MigrationEntry = { version: number; checksum: string };
export type MigrationState = 'baseline' | 'partial' | 'candidate' | 'unexpected';

export const migrationLedgerQuery = `SELECT jsonb_build_object('entries', COALESCE(jsonb_agg(jsonb_build_object('version',m.version,'checksum',m.checksum) ORDER BY m.version),'[]'::jsonb), 'rows', COALESCE(jsonb_agg(to_jsonb(m) ORDER BY m.version),'[]'::jsonb))::text FROM schema_migrations m`;

// Registry order is authoritative: historical versions need not be contiguous.
export const parseMigrationManifest = (value: unknown, allowEmpty = false): MigrationEntry[] => {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.length > 10_000) throw new Error('Migration manifest is invalid.');
  let previous = 0;
  return value.map(item => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) throw new Error('Migration manifest entry is invalid.');
    const record = item as Record<string, unknown>;
    if (Object.keys(record).sort().join(',') !== 'checksum,version' || !Number.isSafeInteger(record.version) || (record.version as number) <= previous ||
      typeof record.checksum !== 'string' || !/^[a-f0-9]{64}$/.test(record.checksum)) throw new Error('Migration manifest entry is invalid.');
    previous = record.version as number;
    return { version: previous, checksum: record.checksum };
  });
};

export const migrationManifestHash = (manifest: MigrationEntry[]): string =>
  createHash('sha256').update(JSON.stringify(parseMigrationManifest(manifest))).digest('hex');

const same = (left: MigrationEntry, right: MigrationEntry): boolean => left.version === right.version && left.checksum === right.checksum;
export const requireMigrationPlan = (baseline: MigrationEntry[], candidate: MigrationEntry[], repair: MigrationEntry[]): void => {
  baseline = parseMigrationManifest(baseline); candidate = parseMigrationManifest(candidate); repair = parseMigrationManifest(repair);
  if (!baseline.some(entry => entry.version === 99)) throw new Error('Baseline migration registry does not reach version 99.');
  if (candidate.length <= baseline.length || !baseline.every((entry, index) => same(entry, candidate[index]!))) throw new Error('Baseline migration registry is not a strict candidate prefix.');
  if (repair.length !== candidate.length || !candidate.every((entry, index) => same(entry, repair[index]!))) throw new Error('Repair migration registry differs from candidate.');
};

export const classifyMigrationLedger = (observed: MigrationEntry[], baseline: MigrationEntry[], candidate: MigrationEntry[]): MigrationState => {
  observed = parseMigrationManifest(observed, true); baseline = parseMigrationManifest(baseline); candidate = parseMigrationManifest(candidate);
  if (!baseline.some(entry => entry.version === 99)) throw new Error('Baseline migration registry does not reach version 99.');
  if (candidate.length <= baseline.length || !baseline.every((entry, index) => same(entry, candidate[index]!))) throw new Error('Baseline migration registry is not a strict candidate prefix.');
  if (observed.length < baseline.length || observed.length > candidate.length || !observed.every((entry, index) => same(entry, candidate[index]!))) return 'unexpected';
  if (observed.length === baseline.length) return 'baseline';
  return observed.length === candidate.length ? 'candidate' : 'partial';
};

export type LedgerObservation = { state: MigrationState; settled: boolean; entries: MigrationEntry[]; raw: string };
export const observeMigrationLedger = async (input: {
  baseline: MigrationEntry[]; candidate: MigrationEntry[]; settled: boolean;
  query: () => Promise<string>; record: (value: Record<string, unknown>) => Promise<void>;
}): Promise<LedgerObservation> => {
  try {
    const data: unknown = JSON.parse(await input.query());
    if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new Error('Migration ledger response is invalid.');
    const object = data as { entries?: unknown; rows?: unknown };
    if (!Array.isArray(object.rows)) throw new Error('Migration ledger rows are invalid.');
    const entries = parseMigrationManifest(object.entries, true);
    const fromRows = parseMigrationManifest(object.rows.map(row => {
      if (typeof row !== 'object' || row === null || Array.isArray(row)) throw new Error('Migration ledger row is invalid.');
      const value = row as Record<string, unknown>;
      if (Object.keys(value).sort().join(',') !== 'applied_at,checksum,version' || typeof value.applied_at !== 'string' || value.applied_at.length > 64 ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value.applied_at)) throw new Error('Migration ledger row is invalid.');
      return { version: value.version, checksum: value.checksum };
    }), true);
    if (JSON.stringify(entries) !== JSON.stringify(fromRows)) throw new Error('Migration ledger rows disagree.');
    const state = classifyMigrationLedger(entries, input.baseline, input.candidate);
    const raw = JSON.stringify(object.rows);
    await input.record({ state, settled: input.settled, entries, rowsSHA256: createHash('sha256').update(raw).digest('hex') });
    return { state, settled: input.settled, entries, raw };
  } catch (error) {
    await input.record({ state: 'unknown', settled: input.settled, reason: 'ledger-observation-failed' });
    throw error;
  }
};

export const requireSettledCandidateLedger = (observation: LedgerObservation): void => {
  if (!observation.settled) throw new Error('Candidate migration outcome is unconfirmed.');
  if (observation.state === 'partial') throw new Error('Candidate startup left a partial migration ledger.');
  if (observation.state !== 'candidate') throw new Error('Candidate startup ledger does not match its registry.');
};
