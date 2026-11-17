import { createHash, randomUUID } from "node:crypto";
import { isPreparedSessionV2StopProof, parseSessionV2Owner, parseSessionV2Runs } from "../../../session/v2/protocol.js";
import type { SessionV2Owner, SessionV2Run } from "../../../session/v2/types.js";
import { canonicalSessionJson, choice, exact, hash, literal, seq, uuid } from "../../../session/v2/values.js";
import type { HerdrTerminationMetadata } from "./lifecycle-types.js";

export type HerdrTerminationClosure = {
  schemaVersion: 1;
  closureId: string;
  backend: "herdr";
  owner: SessionV2Owner;
  claimId: string;
  sessionId: string;
  highestExecutionGeneration: string;
  launchesSettled: true;
  runs: { run: SessionV2Run; nativeLaunch: "not_submitted" | "observed" }[];
  domainId: string;
  sequence: string;
  closureDigest: string;
};

const digest = (value: Omit<HerdrTerminationClosure, "closureDigest">): string =>
  createHash("sha256").update(canonicalSessionJson(value)).digest("hex");

export const parseHerdrTerminationClosure = (value: unknown): HerdrTerminationClosure => {
  const o = exact(value, ["schemaVersion", "closureId", "backend", "owner", "claimId", "sessionId", "highestExecutionGeneration", "launchesSettled", "runs", "domainId", "sequence", "closureDigest"]);
  if (!Array.isArray(o.runs)) throw new Error("Herdr termination runs are missing.");
  const entries = o.runs.map(value => exact(value, ["run", "nativeLaunch"]));
  const highestExecutionGeneration = seq(o.highestExecutionGeneration);
  const runs = parseSessionV2Runs(entries.map(entry => entry.run), highestExecutionGeneration, true);
  const owner = parseSessionV2Owner(o.owner);
  const content = {
    schemaVersion: literal(o.schemaVersion, 1), closureId: uuid(o.closureId), backend: literal(o.backend, "herdr"), owner,
    claimId: uuid(o.claimId), sessionId: uuid(o.sessionId), highestExecutionGeneration,
    launchesSettled: literal(o.launchesSettled, true),
    runs: runs.map((run, index) => {
      const nativeLaunch = choice(entries[index]!.nativeLaunch, ["not_submitted", "observed"]);
      if (canonicalSessionJson(run.owner) !== canonicalSessionJson(owner) || run.stopProof === null
        || (nativeLaunch === "not_submitted") !== isPreparedSessionV2StopProof(run.stopProof)) throw new Error("Herdr termination requires the original stopped run and launch provenance.");
      return { run, nativeLaunch };
    }),
    domainId: uuid(o.domainId), sequence: seq(o.sequence),
  };
  const closureDigest = hash(o.closureDigest);
  if (digest(content) !== closureDigest) throw new Error("The Herdr termination closure digest does not match its original evidence.");
  return { ...content, closureDigest };
};

export const createHerdrTerminationClosure = (record: HerdrTerminationMetadata, domainId: string, sequence: string): HerdrTerminationClosure => {
  if (record.preparation !== null) throw new Error("The original Herdr preparation remains unsettled.");
  if (record.runs.length === 0) throw new Error("The original Herdr Session has no registered run.");
  if (record.runs.some(run => run.phase !== "stopped_confirmed" || run.run.stopProof === null || !["not_submitted", "observed"].includes(run.nativeLaunch))) throw new Error("An original Herdr launch or stop remains unconfirmed.");
  const content = { schemaVersion: 1 as const, closureId: randomUUID(), backend: "herdr" as const, owner: record.owner,
    claimId: record.claimId, sessionId: record.sessionId, highestExecutionGeneration: record.runs.at(-1)!.run.executionGeneration,
    launchesSettled: true as const, runs: record.runs.map(({ run, nativeLaunch }) => ({ run, nativeLaunch })), domainId, sequence };
  return parseHerdrTerminationClosure({ ...content, closureDigest: digest(content as Omit<HerdrTerminationClosure, "closureDigest">) });
};
