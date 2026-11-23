export type ArchiveRepairCode = "archive_incomplete" | "projection_gap" | "markdown_projection_failed";
export type ArchiveProbeResult = { kind: "blocked"; code: ArchiveRepairCode } | { kind: "attempt" } | { kind: "complete" };

export class ArchiveProtocolError extends Error {}

/** A terminal receipt for the original, identity-checked archive file. */
export class ArchiveFileFailedError extends Error {
  constructor(readonly code: string, readonly serverMessage: string) {
    super(`Archive file failed (${code}).`);
    this.name = "ArchiveFileFailedError";
  }
}

export class ArchiveRequestError extends Error {
  constructor(readonly status: number, readonly code: string | undefined, readonly payload?: unknown, readonly uploadVersion?: string | null, readonly responseByteLength?: number) {
    super(`Session archive request failed (${status}).`);
    this.name = "ArchiveRequestError";
  }
  get busy(): boolean { return this.status === 429 && this.code === "resource_busy"; }
}

export class ArchiveRepairRequiredError extends Error {
  constructor(readonly code: ArchiveRepairCode) {
    super(code === "markdown_projection_failed" ? "Markdown image projection requires repair. Run daynight worker repair-markdown --help and select the original Task, Project, claim, Session and worktree." : code === "archive_incomplete" ? "Pending archive has an unresolved projection gap: original history is incomplete." : "Pending archive has an unresolved projection gap: its source requires repair.");
    this.name = "ArchiveRepairRequiredError";
  }
}

export const archiveRepairCode = (source: { archive_incomplete: number; projection_gap: string | null }): ArchiveRepairCode | null =>
  source.archive_incomplete !== 0 ? "archive_incomplete" : source.projection_gap !== null && source.projection_gap !== "Recovered pending timeline requires full relay resynchronization." ? "projection_gap" : null;
