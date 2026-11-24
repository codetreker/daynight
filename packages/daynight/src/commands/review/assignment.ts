import type { WorkerPromptTuple } from "../worker/prompt-source.js";

export type AssignedPullRequest = Readonly<{ projectId: string; repositoryId: string; repositoryUrl: string; number: number }>;
export type AssignmentObservation =
  | { kind: "enabled"; pullRequests: readonly AssignedPullRequest[] }
  | { kind: "disabled" }
  | { kind: "unavailable"; error?: unknown };
export type PromptCapture = Readonly<{ values: WorkerPromptTuple; isCurrent(): boolean }>;
export type AssignmentSource = {
  snapshot(): AssignmentObservation;
  subscribe(listener: () => void): () => void;
  capturePrompt(projectId: string, signal: AbortSignal): Promise<PromptCapture>;
};
