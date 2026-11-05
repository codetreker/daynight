import type { SessionV2Archive } from "./types.js";
import { canonicalSessionJson, fail, hashSessionBytes } from "./values.js";

// Validate the archive before selecting a run. This provenance digest does not
// replace the hash of the original archive bytes or attest to native disk facts.
export const sourceDigest = async (archive: SessionV2Archive, generation: string): Promise<string> => {
  const run = archive.runs.find(value => value.executionGeneration === generation);
  if (!run) return fail("stale_fence");
  const segments = new Set(run.segmentIds);
  return hashSessionBytes(canonicalSessionJson({ files: archive.files.filter(value => segments.has(value.segmentId)), index: archive.index.filter(value => segments.has(value.segmentId)) }));
};

export const emptySourceDigest = async (): Promise<string> => hashSessionBytes('{"files":[],"index":[]}');
