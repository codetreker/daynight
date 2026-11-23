import { renameSync, writeFileSync } from 'node:fs';
import type { ProviderDiagnostics } from './provider.ts';

// A live snapshot survives an unconfirmed runtime stop; the final snapshot is
// written separately after provider shutdown has established its boundary.
export const writeProviderDiagnostics = (filename: string, value: ProviderDiagnostics): void => {
  const temporary = `${filename}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, filename);
};

export const providerDiagnosticSink = (filename: string, onFailure: (error: unknown) => void): ((value: ProviderDiagnostics) => void) => {
  let failed = false;
  return value => {
    if (failed) return;
    try { writeProviderDiagnostics(filename, value); }
    catch (error) { failed = true; onFailure(error); }
  };
};
