export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type AssistantTaskClaimKind = "claim" | "transfer" | "bind" | "renew" | "release";
export type AssistantTaskClaim = {
  holderBotId: string | null; credentialOperationId: string | null; claimGeneration: string;
  claimState: "unowned" | "pending" | "active" | "expired";
  claimedAt: string | null; renewedAt: string | null; leaseUntil: string | null; observedAt: string;
};
export type AssistantTask = AssistantTaskClaim & {
  id: string; ownerUserId: string; application: string; name: string; purpose: string; scope: string;
  kind: "continuous" | "once"; state: "active" | "paused" | "deleted"; takeover: "manual" | "auto";
  trigger: JsonValue; version: string; manualVersion: string; createdAt: string; updatedAt: string;
};
export type AssistantTaskClaimOperation = {
  operationId: string; kind: AssistantTaskClaimKind; taskId: string; actorBotId: string | null;
  requestFingerprint: string; admittedAt: string; resultingVersion: string; resultingGeneration: string;
  holderBotId: string | null; credentialOperationId: string | null; leaseUntil: string | null;
};
export type AssistantTaskClaimResult = { operation: AssistantTaskClaimOperation; currentClaim: AssistantTaskClaim };
export type AssistantTaskClaimInput = {
  operationId: string; ifVersion?: string; expectedGeneration?: string; claimGeneration?: string;
  claimToken?: string; targetBotId?: string;
};
export type AssistantTaskClaimExpectation = { kind?: AssistantTaskClaimKind; actorBotId?: string | null; requestFingerprint?: string };
export type AssistantTaskManual = { taskId: string; version: string; body: string; rules: JsonValue; source: string; proposalId: string | null; createdAt: string };
export type AssistantTaskAppendix = { id: string; taskId: string; text: string; sourceRecords: string[]; authorBotId: string | null; state: "active" | "edited" | "deleted"; version: string; createdAt: string; updatedAt: string };
export type AssistantTaskProposal = { id: string; taskId: string; baseVersion: string; body: string; rules: JsonValue; reason: string; evidenceRecords: string[]; authorBotId: string | null; widens: boolean; status: "pending" | "approved" | "edited" | "rejected"; decisionNote: string; createdAt: string; decidedAt: string | null };
export type AssistantTaskProposalResult = { proposal: AssistantTaskProposal; rejectedMatches: AssistantTaskProposal[] };
export type AssistantTaskItem = { id: string; taskId: string; key: string; episode: string; state: "open" | "closed"; category: string; followerBotId: string | null; appState: JsonValue; version: string; createdAt: string; updatedAt: string };
export type AssistantTaskRecord = { id: string; taskId: string; itemId: string | null; author: "bot" | "system"; authorBotId: string | null; kind: string; text: string; refs: JsonValue; createdAt: string };
export type AssistantTaskEvent = { id: string; taskId: string; targetBotId: string; type: string; payload: JsonValue; state: "pending" | "delivered" | "expired"; attention: boolean; createdAt: string; deliveredAt: string | null; seenAt: string | null; ackOperationId: string | null };
export type AssistantTaskInquiry = { id: string; taskId: string; itemId: string | null; fromBotId: string; toBotId: string; answerBotId: string | null; question: string; answer: string; state: "open" | "answered" | "timed_out"; createdAt: string; deadline: string; answeredAt: string | null };
export type AssistantTaskPage<T> = { items: T[]; nextCursor: string | null; observedAt: string };
export type AssistantTaskQuery = { limit?: number; cursor?: string; state?: string; itemId?: string; targetBotId?: string };
export type AssistantTaskCredential = { claimToken: string; claimGeneration: string };
export type CreateAssistantTaskInput = { id: string; name: string; purpose: string; scope: string; kind: "continuous" | "once"; takeover: "manual" | "auto"; application?: string; trigger?: JsonValue; manual: { body: string; rules: JsonValue } };
export type UpdateAssistantTaskInput = { ifVersion: string; name?: string; purpose?: string; scope?: string; takeover?: "manual" | "auto"; trigger?: JsonValue; state?: "active" | "paused" };
export type AddAssistantTaskAppendixInput = AssistantTaskCredential & { id: string; text: string; sourceRecords: string[] };
export type UpdateAssistantTaskAppendixInput = { ifVersion: string; text: string; sourceRecords?: string[] };
export type ProposeAssistantTaskInput = AssistantTaskCredential & { id: string; baseVersion: string; body: string; rules: JsonValue; reason: string; evidenceRecords: string[] };
export type DecideAssistantTaskInput = { ifVersion: string; decision: "approved" | "edited" | "rejected"; note?: string; body?: string; rules?: JsonValue };
export type SaveAssistantTaskItemInput = AssistantTaskCredential & { id?: string; ifVersion?: string; key: string; episode: string; state: "open" | "closed"; category: string; appState: JsonValue };
export type AddAssistantTaskRecordInput = Partial<AssistantTaskCredential> & { id: string; itemId?: string; kind: string; text: string; refs?: JsonValue };
export type AddAssistantTaskEventInput = AssistantTaskCredential & { id: string; targetBotId: string; type: string; payload?: JsonValue };
export type AskAssistantTaskInput = { id: string; itemId?: string; question: string };
