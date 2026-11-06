import { execFileSync } from "node:child_process";
import { appendFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const protectedRef = "/git/ref/heads/main";
const manifestPath = ".github/scripts/image-test-pairs.json";
const maximumBytes = 16 * 1024 * 1024;

type Candidate = { pr: number; sha: string; reviews: number[] };
export type Pair = { base: string; implementation: Candidate; tests: Candidate; productionTree: string; allowPaths: string[] };
export type Manifest = { schemaVersion: 1; pairs: Pair[] };
export type GitHubSource = { get: (path: string) => Promise<unknown>; fetchCommit?: (sha: string) => Promise<void> };
export type Evidence = {
  schemaVersion: 1; mode: "ordinary" | "paired-pr" | "paired-window"; registryChecked: boolean; manifestCommit: string; event: string; head: string; checkoutCommit: string;
  base: string | null; implementation: string | null; tests: string | null;
  combinedTree: string; combinedCommit: string; productionTree: string; pairCount: number; changedTestFiles: number; nodeVersion: string;
};
type Options = { cwd: string; manifestCommit?: string; event: string; head: string; pr?: number; repository: string; source: GitHubSource; expectedCombinedTree?: string };
type ObjectValue = Record<string, unknown>;

const object = (value: unknown, label: string): ObjectValue => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as ObjectValue;
};
const fields = (value: ObjectValue, allowed: string[], label: string): void => {
  if (Object.keys(value).sort().join("\0") !== [...allowed].sort().join("\0")) throw new Error(`${label} has missing or unknown fields.`);
};
const sha = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/.test(value) || /^0+$/.test(value)) throw new Error(`${label} requires a full lowercase nonzero commit/tree SHA.`);
  return value;
};
const positiveInteger = (value: unknown, label: string): number => {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error(`${label} must be a positive safe integer.`);
  return value as number;
};
const array = (value: unknown, label: string, maximum = 100): unknown[] => {
  if (!Array.isArray(value) || value.length > maximum) throw new Error(`${label} must be an array with at most ${maximum} entries.`);
  return value;
};
const candidate = (value: unknown): Candidate => {
  const record = object(value, "Candidate"); fields(record, ["pr", "sha", "reviews"], "Candidate");
  const reviews = array(record.reviews, "Candidate reviews").map((id) => positiveInteger(id, "Review ID"));
  if (reviews.length === 0 || new Set(reviews).size !== reviews.length) throw new Error("Candidate requires unique pinned review IDs.");
  return { pr: positiveInteger(record.pr, "PR number"), sha: sha(record.sha, "Candidate SHA"), reviews };
};

// Exact paths retain their test ownership even when a manifest writer makes a mistake.
const testPath = (value: unknown): string => {
  if (typeof value !== "string" || !/^[A-Za-z0-9_./-]+$/.test(value) || value.split("/").some((part) => part === "" || part === "." || part === ".." || part.startsWith(".")) || value.startsWith("/")) {
    throw new Error("Test path must be a normalized repository-relative path.");
  }
  const basename = value.split("/").at(-1)!;
  if (/^(?:package|tsconfig|jsconfig)(?:\..*)?\.json$|(?:^|[.-])(?:config|setup|coverage)(?:[.-]|$)|(?:^|[.-])lock(?:[.-]|$)/i.test(basename)) {
    throw new Error(`Forbidden configuration test path: ${value}.`);
  }
  const allowed = /^packages\/daynight\/test\/.+\.(?:ts|mts|cts|tsx|json|txt|md|png|jpe?g|webp|gif|avif|bin)$/.test(value)
    || /^packages\/daynight-web\/tests\/.+\.(?:ts|mts|tsx|json|txt|png|jpe?g|webp|gif|avif|bin)$/.test(value)
    || /^packages\/daynight-server\/(?:internal|test)\/.+_test\.go$/.test(value)
    || /^packages\/daynight-server\/(?:internal\/.+\/)?testdata\/.+\.(?:json|txt|md|png|jpe?g|webp|gif|avif|bin)$/.test(value);
  if (!allowed) throw new Error(`Forbidden or unknown test path: ${value}.`);
  return value;
};

export const parseManifest = (value: unknown): Manifest => {
  const record = object(value, "Manifest"); fields(record, ["schemaVersion", "pairs"], "Manifest");
  if (record.schemaVersion !== 1) throw new Error("Unsupported manifest schema version.");
  const prs = new Set<number>(); const trees = new Set<string>();
  const pairs = array(record.pairs, "Manifest pairs", 100).map((value) => {
    const pair = object(value, "Pair"); fields(pair, ["base", "implementation", "tests", "productionTree", "allowPaths"], "Pair");
    const implementation = candidate(pair.implementation); const tests = candidate(pair.tests);
    if (prs.has(implementation.pr) || prs.has(tests.pr) || implementation.pr === tests.pr) throw new Error("Duplicate pair PR identities.");
    prs.add(implementation.pr); prs.add(tests.pr);
    const productionTree = sha(pair.productionTree, "Production tree");
    if (trees.has(productionTree)) throw new Error("Duplicate pair production tree.");
    trees.add(productionTree);
    const allowPaths = array(pair.allowPaths, "Allowed test paths", 1000).map(testPath);
    if (allowPaths.length === 0 || new Set(allowPaths).size !== allowPaths.length) throw new Error("Pair requires unique nonempty test paths.");
    return { base: sha(pair.base, "Base SHA"), implementation, tests, productionTree, allowPaths };
  });
  return { schemaVersion: 1, pairs };
};

const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
const gitEnvironment = (): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
  TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR,
  GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: nullDevice, GIT_TERMINAL_PROMPT: "0",
});
const disabledFilters = new Map<string, string[]>();
const filterOptions = (cwd: string): string[] => {
  const cached = disabledFilters.get(cwd);
  if (cached) return cached;
  let names = "";
  try {
    names = execFileSync("git", ["-C", cwd, "config", "--name-only", "--get-regexp", "^filter\\..*\\.(clean|smudge|process|required)$"], {
      env: gitEnvironment(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000, maxBuffer: maximumBytes,
    });
  } catch (error) { if ((error as { status?: number }).status !== 1) throw error; }
  const drivers = new Set(names.trim().split("\n").filter(Boolean).map((name) => name.replace(/\.(?:clean|smudge|process|required)$/, "")));
  const args = [...drivers].flatMap((driver) => ["-c", `${driver}.clean=`, "-c", `${driver}.smudge=`, "-c", `${driver}.process=`, "-c", `${driver}.required=false`]);
  // Checkout may have used a system/global newline setting. Preserve only safe built-in values.
  const configurationEnvironment: NodeJS.ProcessEnv = { ...gitEnvironment(), HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  delete configurationEnvironment.GIT_CONFIG_NOSYSTEM; delete configurationEnvironment.GIT_CONFIG_GLOBAL;
  for (const [key, allowed] of [
    ["core.autocrlf", ["true", "false", "input"]], ["core.eol", ["lf", "crlf", "native"]],
    ["core.filemode", ["true", "false"]], ["core.symlinks", ["true", "false"]],
  ] as const) {
    let value: string;
    try {
      value = execFileSync("git", ["-C", cwd, "config", "--get", key], { env: configurationEnvironment, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000, maxBuffer: 1024 }).trim().toLowerCase();
    } catch (error) { if ((error as { status?: number }).status === 1) continue; throw error; }
    if ((allowed as readonly string[]).includes("true")) {
      if (["", "yes", "on", "1"].includes(value)) value = "true";
      else if (["no", "off", "0"].includes(value)) value = "false";
    }
    if (!(allowed as readonly string[]).includes(value)) throw new Error(`Unsupported safe Git checkout setting: ${key}.`);
    args.push("-c", `${key}=${value}`);
  }
  disabledFilters.set(cwd, args);
  return args;
};
const git = (cwd: string, args: string[], options: { index?: string; input?: Buffer | string; env?: NodeJS.ProcessEnv } = {}): Buffer => {
  // Only immutable fetches receive read credentials. Local Git commands cannot run filters or hooks.
  return execFileSync("git", ["-c", `core.hooksPath=${nullDevice}`, "-c", "core.fsmonitor=false", ...filterOptions(cwd), "-C", cwd, ...args], {
    env: { ...gitEnvironment(), ...(options.index ? { GIT_INDEX_FILE: options.index } : {}), ...options.env }, input: options.input,
    stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"], timeout: 30_000, maxBuffer: maximumBytes,
  });
};
const gitText = (cwd: string, args: string[], options?: { index?: string; input?: Buffer | string; env?: NodeJS.ProcessEnv }): string => git(cwd, args, options).toString("utf8").trim();
const isAncestor = (cwd: string, ancestor: string, descendant: string): boolean => {
  try { git(cwd, ["merge-base", "--is-ancestor", ancestor, descendant]); return true; } catch (error) {
    if ((error as { status?: number }).status === 1) return false;
    throw error;
  }
};
const commit = async (options: Options, value: string): Promise<void> => {
  let kind: string | undefined;
  try { kind = gitText(options.cwd, ["cat-file", "-t", value]); } catch { /* Missing objects are fetched only by immutable ID. */ }
  if (kind === undefined && options.source.fetchCommit) { await options.source.fetchCommit(value); kind = gitText(options.cwd, ["cat-file", "-t", value]); }
  if (kind !== "commit") throw new Error(`Required commit is unavailable or has the wrong object type: ${value}.`);
};
const tree = (cwd: string, revision: string): string => gitText(cwd, ["rev-parse", `${revision}^{tree}`]);
const strippedTree = (cwd: string, revision: string, paths: string[], index: string): string => {
  git(cwd, ["read-tree", revision], { index });
  git(cwd, ["update-index", "--force-remove", "--", manifestPath, ...paths], { index });
  return gitText(cwd, ["write-tree"], { index });
};
type Entry = { mode: string; oid: string };
const entries = (cwd: string, revision: string): Map<string, Entry> => {
  const result = new Map<string, Entry>();
  const output = git(cwd, ["ls-tree", "-rz", "--full-tree", revision]).toString("utf8");
  for (const item of output.split("\0").filter(Boolean)) {
    const match = /^(\d+) (?:blob|commit) ([0-9a-f]{40})\t([\s\S]+)$/.exec(item);
    if (!match) throw new Error("Invalid Git tree entry.");
    result.set(match[3]!, { mode: match[1]!, oid: match[2]! });
  }
  return result;
};
const existingPath = (path: string) => {
  try { return lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return undefined; }
};
const sameEntry = (left: Entry | undefined, right: Entry | undefined): boolean => left?.mode === right?.mode && left?.oid === right?.oid;

const pull = async (source: GitHubSource, id: number, repository: string): Promise<ObjectValue> => {
  const value = object(await source.get(`/pulls/${id}`), "Pull request");
  if (value.number !== id || !["open", "closed"].includes(value.state as string) || typeof value.merged !== "boolean") throw new Error("Unreadable pull request state.");
  const head = object(value.head, "PR HEAD");
  const base = object(value.base, "PR base");
  sha(base.sha, "PR base SHA");
  if (typeof base.ref !== "string" || base.ref.length === 0) throw new Error("Unreadable PR base ref.");
  sha(head.sha, "PR HEAD SHA");
  if (value.merged === true) sha(value.merge_commit_sha, "Actual PR merge commit");
  if (object(head.repo, "HEAD repository").full_name !== repository || object(base.repo, "Base repository").full_name !== repository) throw new Error("Candidate must belong to the configured repository.");
  positiveInteger(object(value.user, "PR author").id, "PR author ID");
  return value;
};
const checkReviews = async (source: GitHubSource, candidate: Candidate, authors: Set<number>): Promise<void> => {
  const all: ObjectValue[] = [];
  for (let page = 1; page <= 100; page++) {
    const values = array(await source.get(`/pulls/${candidate.pr}/reviews?per_page=100&page=${page}`), "PR reviews", 100);
    all.push(...values.map((value) => object(value, "Review")));
    if (values.length < 100) break;
    if (page === 100) throw new Error("Review pagination exceeded its bound.");
  }
  const latest = new Map<number, ObjectValue>();
  for (const review of all) {
    const user = object(review.user, "Review author");
    const id = positiveInteger(user.id, "Review author ID");
    positiveInteger(review.id, "Review ID");
    if (!["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED", "PENDING"].includes(review.state as string)) throw new Error("Unknown review state.");
    if (review.state === "PENDING" || review.state === "COMMENTED") continue;
    if (typeof review.submitted_at !== "string" || !Number.isFinite(Date.parse(review.submitted_at))) throw new Error("Unreadable review timestamp.");
    const previous = latest.get(id);
    if (!previous || Date.parse(review.submitted_at) > Date.parse(previous.submitted_at as string) || (review.submitted_at === previous.submitted_at && (review.id as number) > (previous.id as number))) latest.set(id, review);
  }
  if ([...latest.values()].some((review) => review.state === "CHANGES_REQUESTED")) throw new Error(`PR ${candidate.pr} still has a change-request review.`);
  for (const id of candidate.reviews) {
    const review = all.find((review) => review.id === id);
    if (!review || review.state !== "APPROVED" || review.commit_id !== candidate.sha) throw new Error(`Pinned review ${id} is missing, dismissed, or for another commit.`);
    const user = object(review.user, "Review author");
    if (authors.has(user.id as number) || user.type !== "User") throw new Error(`Pinned review ${id} is not independent of both candidate authors.`);
    if (latest.get(user.id as number)?.id !== id) throw new Error(`Pinned review ${id} is no longer the reviewer's current review.`);
  }
};

type PullReader = (pr: number) => Promise<ObjectValue>;
const changedPaths = (before: Map<string, Entry>, after: Map<string, Entry>, ignoreRegistry = false): string[] =>
  [...new Set([...before.keys(), ...after.keys()])].filter((path) => (!ignoreRegistry || path !== manifestPath) && !sameEntry(before.get(path), after.get(path)));

const readManifest = (cwd: string, revision: string): Manifest => {
  const entry = entries(cwd, revision).get(manifestPath);
  if (entry?.mode !== "100644") throw new Error("Manifest must be a regular nonexecutable JSON file.");
  const bytes = git(cwd, ["cat-file", "blob", entry.oid]);
  if (bytes.length > 1024 * 1024) throw new Error("Manifest exceeds its byte limit.");
  return parseManifest(JSON.parse(bytes.toString("utf8")));
};

const verifyCandidate = async (pair: Pair, options: Options, getPull: PullReader, index: string) => {
  const [implementationPR, testPR] = await Promise.all([getPull(pair.implementation.pr), getPull(pair.tests.pr)]);
  for (const [candidate, pr] of [[pair.implementation, implementationPR], [pair.tests, testPR]] as const) {
    if (pr.state === "closed" && pr.merged !== true) throw new Error(`PR ${candidate.pr} was closed without merging.`);
    if (object(pr.head, "Candidate HEAD").sha !== candidate.sha) throw new Error(`PR ${candidate.pr} HEAD no longer matches its pinned candidate.`);
  }
  const authors = new Set([object(implementationPR.user, "I author").id as number, object(testPR.user, "T author").id as number]);
  await Promise.all([checkReviews(options.source, pair.implementation, authors), checkReviews(options.source, pair.tests, authors)]);
  const testBase = sha(object(testPR.base, "T base").sha, "T base SHA");
  for (const revision of [pair.base, pair.implementation.sha, pair.tests.sha, testBase]) await commit(options, revision);
  if (!isAncestor(options.cwd, pair.base, pair.implementation.sha) || !isAncestor(options.cwd, pair.implementation.sha, pair.tests.sha)) throw new Error("Pair base/I/T ancestor relationship is invalid.");
  const before = entries(options.cwd, pair.implementation.sha); const after = entries(options.cwd, pair.tests.sha);
  if (testPR.merged !== true) {
    const actualBase = entries(options.cwd, gitText(options.cwd, ["merge-base", testBase, pair.tests.sha]));
    const actualDiff = changedPaths(actualBase, after);
    if (actualDiff.length !== pair.allowPaths.length || actualDiff.some((path) => !pair.allowPaths.includes(path))) throw new Error("The actual test PR diff does not exactly match the approved test paths.");
  }
  // Merging main into a T candidate may synchronize the registry, but no product input.
  const changed = changedPaths(before, after, true);
  if (changed.length === 0 || changed.length !== pair.allowPaths.length || changed.some((path) => !pair.allowPaths.includes(path))) throw new Error("Candidate diff does not exactly match its allowed test paths.");
  for (const path of changed) {
    testPath(path);
    const old = before.get(path); const next = after.get(path);
    if (!next || next.mode !== "100644" || (old && old.mode !== "100644")) throw new Error(`Test must remain a regular nonexecutable file: ${path}.`);
    if (old) {
      // Additive patches still require independent semantic review of the complete candidate.
      const statistics = git(options.cwd, ["diff", "--no-ext-diff", "--no-textconv", "--numstat", pair.implementation.sha, pair.tests.sha, "--", path]).toString("utf8").split("\t");
      if (statistics[1] !== "0") throw new Error(`Existing tests cannot be deleted or weakened: ${path}.`);
    }
  }
  for (const revision of [pair.implementation.sha, pair.tests.sha]) {
    if (strippedTree(options.cwd, revision, pair.allowPaths, index) !== pair.productionTree) throw new Error("Production tree differs from the approved implementation.");
  }
  return { before, after, changed };
};

const changedPairs = (before: Manifest, after: Manifest): Pair[] => after.pairs.filter((pair) => {
  const previous = before.pairs.find((candidate) => candidate.implementation.pr === pair.implementation.pr);
  return !previous || JSON.stringify(previous) !== JSON.stringify(pair);
});

const verifyRegistryTransition = async (before: Manifest, after: Manifest, options: Options, getPull: PullReader, mainCommit: string): Promise<void> => {
  for (const previous of before.pairs) {
    const replacement = after.pairs.find((pair) => pair.implementation.pr === previous.implementation.pr);
    const implementation = await getPull(previous.implementation.pr);
    if (replacement) {
      if (implementation.merged === true && replacement.implementation.sha !== previous.implementation.sha) throw new Error("Registry cannot replace an already-merged implementation identity.");
      continue;
    }
    const tests = await getPull(previous.tests.pr);
    if (implementation.merged !== true || tests.merged !== true) throw new Error("Registry cannot remove a pair before its implementation and tests reach main.");
    const revisions = [sha(implementation.merge_commit_sha, "Implementation merge commit"), sha(tests.merge_commit_sha, "Test merge commit")];
    for (const revision of revisions) {
      await commit(options, revision);
      if (!isAncestor(options.cwd, revision, mainCommit)) throw new Error("Registry cannot remove a pair before its implementation and tests reach main.");
    }
  }
};

export const validatePairs = async (options: Options): Promise<Evidence> => {
  disabledFilters.delete(options.cwd);
  if (options.manifestCommit !== undefined) sha(options.manifestCommit, "Manifest commit");
  sha(options.head, "Event HEAD");
  if (options.expectedCombinedTree !== undefined) sha(options.expectedCombinedTree, "Expected combined tree");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(options.repository)) throw new Error("Invalid repository identity.");
  if (!["pull_request", "push"].includes(options.event)) throw new Error("Unsupported image pair event.");
  if (options.event === "pull_request") positiveInteger(options.pr, "Event PR number");
  const rules = array(await options.source.get("/rules/branches/main"), "Protected main rules", 1000).map((value) => object(value, "Main rule"));
  for (const required of ["deletion", "non_fast_forward"]) {
    if (!rules.some((rule) => rule.type === required)) throw new Error(`Main lacks required ${required} protection.`);
  }
  const reviewProtection = rules.some((rule) => {
    if (rule.type !== "pull_request") return false;
    const parameters = object(rule.parameters, "Main PR protection");
    return Number.isSafeInteger(parameters.required_approving_review_count) && (parameters.required_approving_review_count as number) >= 1
      && parameters.dismiss_stale_reviews_on_push === true && parameters.required_review_thread_resolution === true;
  });
  const checksProtection = rules.some((rule) => rule.type === "required_status_checks"
    && array(object(rule.parameters, "Main check protection").required_status_checks, "Required checks", 1000).some((check) => object(check, "Required check").context === "checks"));
  if (!reviewProtection || !checksProtection) throw new Error("Main requires independent approval, stale-review dismissal, resolved threads and checks protection.");
  const ref = object(await options.source.get(protectedRef), "Protected main ref");
  const refObject = object(ref.object, "Protected main object");
  if (refObject.type !== "commit") throw new Error("Protected main must reference a commit.");
  const mainCommit = sha(refObject.sha, "Protected main commit");
  const manifestCommit = options.manifestCommit ?? (options.event === "push" ? options.head : mainCommit);
  if (options.event === "push" && manifestCommit !== options.head) throw new Error("Push manifest commit must match its event HEAD.");
  for (const revision of new Set([mainCommit, manifestCommit, options.head])) await commit(options, revision);
  if (!isAncestor(options.cwd, manifestCommit, mainCommit)) throw new Error("Manifest commit is not retained by protected main.");
  if (options.event === "push" && !isAncestor(options.cwd, options.head, mainCommit)) throw new Error("Push event commit is not retained by protected main.");
  const manifest = readManifest(options.cwd, manifestCommit);
  const cwd = resolve(options.cwd);
  const checkoutCommit = gitText(cwd, ["rev-parse", "HEAD"]);
  if (options.event === "push" && checkoutCommit !== options.head) throw new Error("Main checkout does not match the event HEAD.");
  if (gitText(cwd, ["status", "--porcelain", "--untracked-files=no"]) !== "") throw new Error("Image pair composition requires a clean tracked checkout.");
  const pulls = new Map<number, Promise<ObjectValue>>();
  const getPull: PullReader = (pr) => { if (!pulls.has(pr)) pulls.set(pr, pull(options.source, pr, options.repository)); return pulls.get(pr)!; };
  const incorporated = async (pr: ObjectValue): Promise<boolean> => {
    if (pr.merged !== true) return false;
    const merged = sha(pr.merge_commit_sha, "Actual PR merge commit");
    await commit(options, merged);
    return isAncestor(cwd, merged, checkoutCommit);
  };
  const active: Pair[] = [];
  for (const pair of manifest.pairs) {
    const [implementation, tests] = await Promise.all([getPull(pair.implementation.pr), getPull(pair.tests.pr)]);
    const hasImplementation = await incorporated(implementation); const hasTests = await incorporated(tests);
    if (hasTests && !hasImplementation) throw new Error("Recorded tests are incorporated without their implementation merge commit.");
    if (hasImplementation && !hasTests) active.push(pair);
  }
  if (active.length > 1) throw new Error("Multiple active implementation-to-test windows overlap.");
  mkdirSync(join(cwd, ".tmp"), { recursive: true });
  const scratch = mkdtempSync(join(cwd, ".tmp/image-pair-index-"));
  try {
    const index = join(scratch, "index");
    const evidence: Evidence = { schemaVersion: 1, mode: "ordinary", registryChecked: false, manifestCommit, event: options.event, head: options.head, checkoutCommit,
      base: null, implementation: null, tests: null, combinedTree: tree(cwd, checkoutCommit), combinedCommit: checkoutCommit,
      productionTree: strippedTree(cwd, checkoutCommit, [], index), pairCount: 0, changedTestFiles: 0, nodeVersion: process.version };
    const registered = options.event === "pull_request" ? manifest.pairs.find((pair) => pair.implementation.pr === options.pr || pair.tests.pr === options.pr) : undefined;
    if (registered && active.length > 0 && active[0] !== registered) throw new Error("Registered PR conflicts with another active test window.");
    const selected = registered ?? active[0];
    if (options.event === "pull_request") {
      const eventPR = await getPull(options.pr!);
      if (object(eventPR.head, "Event PR HEAD").sha !== options.head) throw new Error("Event HEAD differs from the current pull request.");
      const base = sha(object(eventPR.base, "Event PR base").sha, "Event PR base SHA");
      await commit(options, base);
      const comparison = gitText(cwd, ["merge-base", base, options.head]);
      if (!sameEntry(entries(cwd, comparison).get(manifestPath), entries(cwd, options.head).get(manifestPath))) {
        const proposed = readManifest(cwd, options.head);
        for (const pair of changedPairs(manifest, proposed)) await verifyCandidate(pair, options, getPull, index);
        await verifyRegistryTransition(manifest, proposed, options, getPull, mainCommit);
        evidence.registryChecked = true;
      }
    }
    if (options.event === "push") {
      const parent = gitText(cwd, ["rev-list", "--parents", "-n", "1", options.head]).split(" ")[1];
      const previousEntry = parent ? entries(cwd, parent).get(manifestPath) : undefined;
      if (!sameEntry(previousEntry, entries(cwd, options.head).get(manifestPath))) {
        const previous = previousEntry ? readManifest(cwd, parent!) : { schemaVersion: 1 as const, pairs: [] };
        for (const pair of changedPairs(previous, manifest)) await verifyCandidate(pair, options, getPull, index);
        await verifyRegistryTransition(previous, manifest, options, getPull, options.head);
        evidence.registryChecked = true;
      }
    }
    const materialize: Array<{ path: string; oid: string }> = [];
    if (selected) {
      const { before, after, changed } = await verifyCandidate(selected, options, getPull, index);
      if (registered && options.head !== (registered.implementation.pr === options.pr ? registered.implementation.sha : registered.tests.sha)) throw new Error("Event HEAD differs from the pinned candidate.");
      const current = entries(cwd, checkoutCommit);
      if (strippedTree(cwd, checkoutCommit, selected.allowPaths, index) !== selected.productionTree) throw new Error("Production tree differs from the approved implementation.");
      for (const path of changed) {
        const old = before.get(path); const next = after.get(path)!;
        if (!sameEntry(current.get(path), old) && !sameEntry(current.get(path), next)) throw new Error(`Current test bytes drifted from the approved pair: ${path}.`);
        const full = join(cwd, path); const leaf = existingPath(full);
        if (leaf && !current.get(path)) throw new Error(`Refusing to overwrite untracked test file: ${path}.`);
        if (leaf && (!leaf.isFile() || leaf.isSymbolicLink())) throw new Error(`Unsafe test file: ${path}.`);
        for (let parent = dirname(full); parent !== cwd; parent = dirname(parent)) {
          const directory = existingPath(parent);
          if (directory && (!directory.isDirectory() || directory.isSymbolicLink())) throw new Error(`Unsafe test parent path: ${path}.`);
        }
        materialize.push({ path, oid: next.oid });
      }
      git(cwd, ["read-tree", checkoutCommit], { index });
      for (const path of selected.allowPaths) {
        const entry = after.get(path)!;
        git(cwd, ["update-index", "--add", "--cacheinfo", entry.mode, entry.oid, path], { index });
      }
      evidence.combinedTree = gitText(cwd, ["write-tree"], { index });
      if (strippedTree(cwd, evidence.combinedTree, selected.allowPaths, index) !== selected.productionTree) throw new Error("Combined tree changed production files.");
      Object.assign(evidence, { mode: registered ? "paired-pr" : "paired-window", base: selected.base, implementation: selected.implementation.sha, tests: selected.tests.sha,
        productionTree: selected.productionTree, pairCount: 1, changedTestFiles: changed.length });
    }
    if (options.expectedCombinedTree !== undefined && evidence.combinedTree !== options.expectedCombinedTree) throw new Error("Combined tree differs from the input selected by the detection job.");
    // A deterministic local commit preserves the existing clean-checkout identity gates.
    // It is never pushed; production bytes and all candidate identities remain in evidence.
    if (evidence.combinedTree !== tree(cwd, checkoutCommit)) {
      evidence.combinedCommit = gitText(cwd, ["-c", "commit.gpgSign=false", "commit-tree", evidence.combinedTree, "-p", checkoutCommit], {
        input: `Verified image test input ${manifestCommit}\n`,
        env: { GIT_AUTHOR_NAME: "Daynight CI", GIT_AUTHOR_EMAIL: "ci@daynight.invalid", GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z", GIT_COMMITTER_NAME: "Daynight CI", GIT_COMMITTER_EMAIL: "ci@daynight.invalid", GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z" },
      });
    }
    for (const [ordinal, item] of materialize.entries()) {
      const path = join(cwd, item.path); mkdirSync(dirname(path), { recursive: true });
      const temporary = join(scratch, `test-${ordinal}`);
      writeFileSync(temporary, git(cwd, ["cat-file", "blob", item.oid]), { mode: 0o644 });
      renameSync(temporary, path);
    }
    if (evidence.combinedCommit !== checkoutCommit) {
      git(cwd, ["read-tree", evidence.combinedTree]);
      git(cwd, ["update-ref", "--no-deref", "HEAD", evidence.combinedCommit, checkoutCommit], { env: { GIT_COMMITTER_NAME: "Daynight CI", GIT_COMMITTER_EMAIL: "ci@daynight.invalid" } });
    }
    for (const item of materialize) {
      if (!readFileSync(join(cwd, item.path)).equals(git(cwd, ["cat-file", "blob", item.oid]))) throw new Error(`Materialized test bytes differ from the reviewed blob: ${item.path}.`);
    }
    if (gitText(cwd, ["status", "--porcelain", "--untracked-files=no"]) !== "" || tree(cwd, "HEAD") !== evidence.combinedTree) throw new Error("Combined checkout is not clean or has the wrong identity.");
    writeFileSync(join(cwd, ".tmp/image-test-pairs.json"), `${JSON.stringify(evidence, null, 2)}\n`);
    return evidence;
  } finally { rmSync(scratch, { recursive: true, force: true }); }
};

export const githubSource = (repository: string, token: string, cwd: string): GitHubSource => ({
  async get(path) {
    if (!path.startsWith("/") || path.startsWith("//")) throw new Error("Invalid GitHub API path.");
    const response = await fetch(`https://api.github.com/repos/${repository}${path}`, { headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28" }, redirect: "error", signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`GitHub read failed (${response.status}) for ${path}.`);
    const bytes = await response.text();
    if (bytes.length > maximumBytes) throw new Error("GitHub response exceeds its byte limit.");
    return JSON.parse(bytes);
  },
  async fetchCommit(value) {
    sha(value, "Fetched commit");
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: process.env.HOME,
      GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: nullDevice,
      GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "credential.helper", GIT_CONFIG_VALUE_0: "",
      GIT_CONFIG_KEY_1: "http.https://github.com/.extraheader", GIT_CONFIG_VALUE_1: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
    };
    try {
      execFileSync("git", ["-c", `core.hooksPath=${nullDevice}`, "-C", cwd, "fetch", "--no-tags", "--no-write-fetch-head", `https://github.com/${repository}.git`, value], { env, stdio: ["ignore", "pipe", "pipe"], timeout: 60_000, maxBuffer: maximumBytes });
    } catch { throw new Error(`Cannot read immutable Git commit ${value}.`); }
  },
});

if (import.meta.main) {
  try {
    const repository = process.env.GITHUB_REPOSITORY ?? "";
    const token = process.env.GITHUB_TOKEN ?? "";
    if (!token) throw new Error("Image pair validation requires a read-only GitHub token.");
    const evidence = await validatePairs({ cwd: process.cwd(), repository, source: githubSource(repository, token, process.cwd()),
      ...((process.env.IMAGE_PAIR_MANIFEST_COMMIT || process.env.IMAGE_PAIR_EXPECTED_COMBINED_TREE !== undefined) ? { manifestCommit: process.env.IMAGE_PAIR_MANIFEST_COMMIT ?? "" } : {}), event: process.env.IMAGE_PAIR_EVENT ?? "", head: process.env.IMAGE_PAIR_HEAD ?? "",
      ...(process.env.IMAGE_PAIR_PR ? { pr: Number(process.env.IMAGE_PAIR_PR) } : {}),
      ...(process.env.IMAGE_PAIR_EXPECTED_COMBINED_TREE !== undefined ? { expectedCombinedTree: process.env.IMAGE_PAIR_EXPECTED_COMBINED_TREE } : {}),
    });
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `manifest_commit=${evidence.manifestCommit}\ncombined_tree=${evidence.combinedTree}\ncombined_commit=${evidence.combinedCommit}\nproduction_tree=${evidence.productionTree}\npair_count=${evidence.pairCount}\n`);
    console.log(`Verified image test input: ${JSON.stringify(evidence)}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Image pair input validation failed.");
    process.exitCode = 1;
  }
}
