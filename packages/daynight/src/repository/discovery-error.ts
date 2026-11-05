import { canonicalId } from "../api/validation.js";

export class ProjectDiscoveryError extends Error {
  readonly kind: "missing" | "ambiguous";
  readonly projectIds: readonly string[];

  constructor(projectIds: readonly string[]) {
    if (projectIds.length === 1) throw new RangeError("Project discovery failure requires zero or multiple candidates.");
    if (new Set(projectIds).size !== projectIds.length || projectIds.some((id) => typeof id !== "string" || canonicalId(id) !== id)) {
      throw new TypeError("Project discovery candidates must be distinct canonical project UUIDs.");
    }
    super(projectIds.length === 0 ? "Project does not exist."
      : `Multiple projects match this repository (${projectIds.join(", ")}); specify --project <id>.`);
    this.name = "ProjectDiscoveryError";
    this.kind = projectIds.length === 0 ? "missing" : "ambiguous";
    this.projectIds = Object.freeze([...projectIds]);
  }
}
