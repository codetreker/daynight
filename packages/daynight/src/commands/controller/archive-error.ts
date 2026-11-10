export type ArchiveRepairCode = "archive_incomplete" | "projection_gap";
export type ArchiveProbeResult = { kind: "blocked"; code: ArchiveRepairCode } | { kind: "attempt" } | { kind: "complete" };

export class ArchiveRepairRequiredError extends Error {
  constructor(readonly code: ArchiveRepairCode) {
    super(code === "archive_incomplete" ? "Pending archive has an unresolved projection gap: original history is incomplete." : "Pending archive has an unresolved projection gap: its source requires repair.");
    this.name = "ArchiveRepairRequiredError";
  }
}

export const archiveRepairCode = (source: { archive_incomplete: number; projection_gap: string | null }): ArchiveRepairCode | null =>
  source.archive_incomplete !== 0 ? "archive_incomplete" : source.projection_gap !== null && source.projection_gap !== "Recovered pending timeline requires full relay resynchronization." ? "projection_gap" : null;
