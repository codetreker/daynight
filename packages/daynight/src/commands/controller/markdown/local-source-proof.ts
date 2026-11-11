/** Internal evidence from held OS objects; this is not a native Read grant. */
export type LocalImageObjectIdentity =
  | { readonly kind: "posix"; readonly dev: string; readonly ino: string }
  | { readonly kind: "windows"; readonly dev: string; readonly ino: string; readonly fileId: string };
export type LocalImageTraversalStep =
  | { readonly kind: "open"; readonly parent: LocalImageObjectIdentity; readonly name: string; readonly object: LocalImageObjectIdentity; readonly directory: boolean }
  | { readonly kind: "link"; readonly parent: LocalImageObjectIdentity; readonly name: string; readonly object: LocalImageObjectIdentity; readonly target: string; readonly relative: boolean }
  | { readonly kind: "parent"; readonly from: LocalImageObjectIdentity; readonly to: LocalImageObjectIdentity };
export type LocalImageSourceProof = {
  readonly requested: { readonly locator: string; readonly path: string };
  readonly root: { readonly cwd: string; readonly identity: LocalImageObjectIdentity; readonly traversal: readonly LocalImageTraversalStep[] };
  readonly traversal: readonly LocalImageTraversalStep[];
  readonly opened: LocalImageObjectIdentity | null;
};
export type LocalImageCheckpoint = { readonly stage: "initial" | "opened" | "block" | "final"; readonly proof: LocalImageSourceProof };

// Reparse expansion can revisit a drive-to-root prefix. Bound the evidence
// while retaining the existing forty-link traversal allowance for normal roots.
const maxBytes = 262_144, maxSteps = 4096;
const refuse = (): never => { throw Object.assign(new Error("Local image source evidence is unavailable."), { code: "source_forbidden" }); };
const record = (value: unknown, keys: string[]): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) return refuse();
  return value as Record<string, unknown>;
};
const text = (value: unknown): string => {
  if (typeof value !== "string" || !value || value.length > 8192 || Buffer.byteLength(value) > 8192 || !value.isWellFormed() || /\p{Cc}/u.test(value)) return refuse();
  return value;
};
const uint64 = (value: unknown): string => {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]{0,19})$/.test(value) || BigInt(value) > 18_446_744_073_709_551_615n) return refuse();
  return value;
};
const identity = (value: unknown): LocalImageObjectIdentity => {
  const candidate = value as { kind?: unknown } | null;
  if (candidate?.kind === "posix") {
    const item = record(value, ["kind", "dev", "ino"]);
    return Object.freeze({ kind: "posix", dev: uint64(item.dev), ino: uint64(item.ino) });
  }
  const item = record(value, ["kind", "dev", "ino", "fileId"]);
  if (item.kind !== "windows" || typeof item.fileId !== "string" || !/^[a-f0-9]{48}$/.test(item.fileId)) return refuse();
  return Object.freeze({ kind: "windows", dev: uint64(item.dev), ino: uint64(item.ino), fileId: item.fileId });
};
const step = (value: unknown): LocalImageTraversalStep => {
  const candidate = value as { kind?: unknown } | null;
  if (candidate?.kind === "parent") {
    const item = record(value, ["kind", "from", "to"]);
    return Object.freeze({ kind: "parent", from: identity(item.from), to: identity(item.to) });
  }
  if (candidate?.kind === "link") {
    const item = record(value, ["kind", "parent", "name", "object", "target", "relative"]);
    if (typeof item.relative !== "boolean") return refuse();
    return Object.freeze({ kind: "link", parent: identity(item.parent), name: text(item.name), object: identity(item.object), target: text(item.target), relative: item.relative });
  }
  const item = record(value, ["kind", "parent", "name", "object", "directory"]);
  if (item.kind !== "open" || typeof item.directory !== "boolean") return refuse();
  return Object.freeze({ kind: "open", parent: identity(item.parent), name: text(item.name), object: identity(item.object), directory: item.directory });
};

/** Bound evidence as traversal proceeds, before opening or reading more objects. */
export class LocalImageTraversal {
  readonly steps: LocalImageTraversalStep[] = [];
  private bytes = 2;
  push(value: LocalImageTraversalStep): void {
    const checked = step(value), size = Buffer.byteLength(JSON.stringify(checked)) + 1;
    if (this.steps.length >= maxSteps || this.bytes + size > maxBytes) refuse();
    this.steps.push(checked); this.bytes += size;
  }
}
const traversal = (value: unknown): readonly LocalImageTraversalStep[] => {
  if (!Array.isArray(value) || value.length > maxSteps) return refuse();
  const result = new LocalImageTraversal();
  for (const item of value) result.push(item);
  return Object.freeze(result.steps);
};

/** Validate both sides of helper IPC, including the aggregate encoded envelope. */
export function parseLocalImageCheckpoint(value: unknown): LocalImageCheckpoint {
  const item = record(value, ["stage", "proof"]);
  if (item.stage !== "initial" && item.stage !== "opened" && item.stage !== "block" && item.stage !== "final") return refuse();
  const raw = record(item.proof, ["requested", "root", "traversal", "opened"]);
  const requested = record(raw.requested, ["locator", "path"]), root = record(raw.root, ["cwd", "identity", "traversal"]);
  const proof: LocalImageSourceProof = Object.freeze({
    requested: Object.freeze({ locator: text(requested.locator), path: text(requested.path) }),
    root: Object.freeze({ cwd: text(root.cwd), identity: identity(root.identity), traversal: traversal(root.traversal) }),
    traversal: traversal(raw.traversal), opened: raw.opened === null ? null : identity(raw.opened),
  });
  if (item.stage === "initial" ? proof.opened !== null || proof.traversal.length !== 0 : proof.opened === null) return refuse();
  const kind = proof.root.identity.kind;
  for (const entry of [...proof.root.traversal, ...proof.traversal]) {
    const identities = entry.kind === "parent" ? [entry.from, entry.to] : [entry.parent, entry.object];
    if (identities.some(value => value.kind !== kind)) return refuse();
    if (entry.kind !== "parent" && (entry.name === "." || entry.name === ".." || entry.name.includes("/") || kind === "windows" && entry.name.includes("\\"))) return refuse();
  }
  if (proof.opened) {
    const last = proof.traversal.at(-1);
    if (proof.opened.kind !== kind || last?.kind !== "open" || last.directory || JSON.stringify(last.object) !== JSON.stringify(proof.opened)) return refuse();
  }
  const result = Object.freeze({ stage: item.stage, proof });
  if (Buffer.byteLength(JSON.stringify({ type: "checkpoint", ...result })) > maxBytes) return refuse();
  return result;
}

/** A copy may authorize only one request/root and one opened object proof. */
export function createLocalImageProofSequence(expected: { locator: string; path: string; cwd: string; platform: NodeJS.Platform; root?: { dev: string; ino: string } | undefined }) {
  let stage: LocalImageCheckpoint["stage"] | undefined, initial: string | undefined, opened: string | undefined;
  return {
    accept(value: unknown): LocalImageCheckpoint {
      const checkpoint = parseLocalImageCheckpoint(value), proof = checkpoint.proof;
      if (proof.requested.locator !== expected.locator || proof.requested.path !== expected.path || proof.root.cwd !== expected.cwd || proof.root.identity.kind !== (expected.platform === "win32" ? "windows" : "posix")) return refuse();
      if (expected.root && (proof.root.identity.dev !== expected.root.dev || proof.root.identity.ino !== expected.root.ino)) return refuse();
      const baseline = JSON.stringify({ requested: proof.requested, root: proof.root });
      const serialized = JSON.stringify(proof);
      if (checkpoint.stage === "initial") { if (stage !== undefined) return refuse(); initial = baseline; }
      else {
        if (baseline !== initial) return refuse();
        if (checkpoint.stage === "opened") { if (stage !== "initial") return refuse(); opened = serialized; }
        else if (serialized !== opened || (checkpoint.stage === "block" ? stage !== "opened" && stage !== "block" : stage !== "block")) return refuse();
      }
      stage = checkpoint.stage; return checkpoint;
    },
    complete(): void { if (stage !== "final") refuse(); },
  };
}
