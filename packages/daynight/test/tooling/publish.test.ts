import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import { preflightRelease, prepareRelease, publishRelease, runPnpmPublish, runNpmView } from "../../scripts/publish.js";
import type { ReleaseReceipt, ReleaseServices } from "../../scripts/publish.js";

const root = path.resolve(import.meta.dirname, "../../../../.tmp/publish-tests");
const script = path.resolve(import.meta.dirname, "../../scripts/publish.ts");
const sourceSha = "a".repeat(40);
const otherSha = "b".repeat(40);
const bytes = Buffer.from("exact prepared package bytes");
const hash = (value: Uint8Array) => `sha512-${createHash("sha512").update(value).digest("base64")}`;
const directories: string[] = [];
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const fixture = () => {
  mkdirSync(root, { recursive: true });
  const cwd = mkdtempSync(path.join(root, "release "));
  directories.push(cwd);
  const artifact = path.join(cwd, ".tmp/npm-release/artifact");
  mkdirSync(artifact, { recursive: true });
  const receipt: ReleaseReceipt = {
    name: "@codetreker/daynight", version: "1.2.3", sourceSha, integrity: hash(bytes),
    tarball: "package.tgz", tag: "daynight-v1.2.3", repository: "codetreker/daynight",
  };
  const save = () => writeFileSync(path.join(artifact, "release.json"), JSON.stringify(receipt));
  save();
  writeFileSync(path.join(artifact, "package.tgz"), bytes);
  return { cwd, artifact, receipt, save };
};
const sourceCheckout = (cwd: string): string => {
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", timeout: 20_000 }).trim();
  git("init", "--initial-branch=main");
  const tree = execFileSync("git", ["mktree"], { cwd, input: "", encoding: "utf8" }).trim();
  const sha = execFileSync("git", ["hash-object", "-t", "commit", "-w", "--stdin"], {
    cwd, encoding: "utf8", input: `tree ${tree}\nauthor Fixture <fixture@example.invalid> 1700000000 +0000\ncommitter Fixture <fixture@example.invalid> 1700000000 +0000\n\nRelease fixture\n`,
  }).trim();
  git("update-ref", "refs/heads/main", sha);
  return sha;
};
const preflightFixture = () => {
  const f = fixture();
  const app = path.join(f.cwd, "packages/daynight");
  mkdirSync(app, { recursive: true });
  writeFileSync(path.join(app, "package.json"), JSON.stringify({
    name: f.receipt.name, version: f.receipt.version,
    repository: { type: "git", url: "git+https://github.com/codetreker/daynight.git", directory: "packages/daynight" },
  }));
  rmSync(f.artifact, { recursive: true });
  return { ...f, sha: sourceCheckout(f.cwd) };
};
type Metadata = { name: string; version: string; gitHead: string; dist: { integrity: string; tarball: string } };
const metadata = (receipt: ReleaseReceipt): Metadata => ({
  name: receipt.name, version: receipt.version, gitHead: receipt.sourceSha,
  dist: { integrity: receipt.integrity, tarball: "https://registry.npmjs.org/@codetreker/daynight/-/daynight-1.2.3.tgz" },
});
const harness = (receipt: ReleaseReceipt) => {
  const state: {
    metadata: Metadata | undefined; latest: { version: string } | undefined; tag: string | undefined; tagType: string; tarball: Uint8Array;
    postStatus: number; publicationError: Error | undefined; delay: number; tarballDelay: number; tarballStatus: number;
  } = { metadata: undefined, latest: { version: "1.2.2" }, tag: undefined, tagType: "commit", tarball: bytes, postStatus: 201, publicationError: undefined, delay: 0, tarballDelay: 0, tarballStatus: 200 };
  const events: string[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.startsWith("https://api.github.com/")) {
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-github-token");
      if (init?.method === "POST") {
        events.push("tag:create");
        expect(JSON.parse(String(init.body))).toEqual({ ref: `refs/tags/${receipt.tag}`, sha: receipt.sourceSha });
        if (state.postStatus !== 201) return json({}, state.postStatus);
        state.tag = receipt.sourceSha;
        return json({ ref: `refs/tags/${receipt.tag}`, object: { type: "commit", sha: state.tag } }, 201);
      }
      events.push("tag:lookup");
      return state.tag === undefined ? json({}, 404) : json({ ref: `refs/tags/${receipt.tag}`, object: { type: state.tagType, sha: state.tag } });
    }
    expect(url.endsWith(".tgz")).toBe(true);
    expect(new Headers(init?.headers).has("Authorization")).toBe(false);
    events.push("tarball:download");
    if (state.tarballDelay > 0) { state.tarballDelay--; return json({}, 404); }
    return new Response(Buffer.from(state.tarball), { status: state.tarballStatus });
  });
  const npmView = vi.fn(async (version: string, _cwd: string, _signal?: AbortSignal) => {
    if (version === "latest") { events.push("registry:latest"); return state.latest; }
    expect(version).toBe(receipt.version);
    events.push("registry:version");
    if (state.delay > 0) { state.delay--; return undefined; }
    return state.metadata;
  });
  const publish = vi.fn(async () => {
    events.push("npm:publish");
    if (state.publicationError !== undefined) throw state.publicationError;
    state.metadata = metadata(receipt);
  });
  const wait = vi.fn(async (_milliseconds: number) => { events.push("wait"); });
  const services: ReleaseServices = { fetch: fetchMock as typeof fetch, npmView, publish, wait, token: "test-github-token", apiUrl: "https://api.github.com" };
  return { state, events, services, publish, wait, fetchMock, npmView };
};
const npmStub = (cwd: string, body: string) => {
  const filename = path.join(cwd, "npm-cli.mjs");
  writeFileSync(filename, body);
  vi.stubEnv("NPM_CLI_JS", filename);
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("npm view publication lookup", () => {
  it.each([false, true])("reads JSON metadata through the npm subprocess (singleton array: %s)", async (array) => {
    const f = fixture();
    const output = path.join(f.cwd, "invocation.json");
    npmStub(f.cwd, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(output)}, JSON.stringify(process.argv.slice(2)));\nconsole.log(${JSON.stringify(JSON.stringify(array ? [metadata(f.receipt)] : metadata(f.receipt)))});\n`);
    await expect(runNpmView("1.2.3", f.cwd)).resolves.toEqual(metadata(f.receipt));
    expect(JSON.parse(readFileSync(output, "utf8"))).toEqual([
      "view", "@codetreker/daynight@1.2.3", "--json", "--registry", "https://registry.npmjs.org", `--cache=${path.join(f.cwd, ".tmp/npm-view-cache")}`,
    ]);
    await expect(runNpmView("latest", f.cwd)).resolves.toEqual(metadata(f.receipt));
  });

  it("treats only npm's structured E404 failure as absent", async () => {
    const f = fixture();
    npmStub(f.cwd, `console.log(JSON.stringify({error: {code: 'E404'}})); process.exit(1);`);
    await expect(runNpmView("1.2.3", f.cwd)).resolves.toBeUndefined();
    for (const failure of ["E401", "E403", "ECONNRESET", "ETIMEDOUT"]) {
      npmStub(f.cwd, `console.log(JSON.stringify({error: {code: '${failure}'}})); process.exit(1);`);
      await expect(runNpmView("1.2.3", f.cwd)).rejects.toThrow(failure);
    }
    npmStub(f.cwd, `console.error('network E404 without JSON'); process.exit(1);`);
    await expect(runNpmView("1.2.3", f.cwd)).rejects.toThrow("network E404 without JSON");
  });

  it.each(["not JSON", "null", "[]", "[{}, {}]", "{}", '{"error":{"code":"E404"}}', '{"name":"another","version":"1.2.3"}', '{"name":"@codetreker/daynight","version":"1.2.4"}'])("rejects malformed successful npm output %s", async (output) => {
    const f = fixture();
    npmStub(f.cwd, `console.log(${JSON.stringify(output)});`);
    await expect(runNpmView("1.2.3", f.cwd)).rejects.toThrow();
  });

  it.each(["request", "visibility"])("terminates a stalled npm subprocess at its %s deadline", async (deadline) => {
    const f = fixture();
    npmStub(f.cwd, "setInterval(() => {}, 1000);");
    const originalTimeout = AbortSignal.timeout;
    const expiration = new DOMException("npm lookup deadline expired", "TimeoutError");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(expiration), 100);
    vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
      expect(milliseconds).toBe(30_000);
      return deadline === "request" ? controller.signal : originalTimeout(milliseconds);
    });
    try {
      await expect(runNpmView("1.2.3", f.cwd, deadline === "visibility" ? controller.signal : undefined)).rejects.toMatchObject({ message: "npm view @codetreker/daynight@1.2.3 failed.", cause: expiration });
    } finally { clearTimeout(timer); }
  });

  it("exposes a missing npm CLI", async () => {
    const f = fixture();
    vi.stubEnv("NPM_CLI_JS", path.join(f.cwd, "missing.mjs"));
    await expect(runNpmView("1.2.3", f.cwd)).rejects.toThrow("Unable to read npm publication metadata");
  });
});

describe("release version preflight", () => {
  it.each([{ tag: false, npm: false }, { tag: true, npm: false }, { tag: false, npm: true }, { tag: true, npm: true }])("skips exactly when a release marker exists ($tag tag, $npm npm)", async ({ tag, npm }) => {
    const f = preflightFixture();
    const h = harness(f.receipt);
    if (tag) h.state.tag = otherSha;
    if (npm) h.state.metadata = { ...metadata(f.receipt), gitHead: otherSha, dist: { integrity: "different bytes", tarball: "not a URL" } };
    await expect(preflightRelease(f.sha, f.cwd, h.services)).resolves.toEqual({ version: "1.2.3", skip: tag || npm });
    expect(h.events).toEqual(tag ? ["tag:lookup"] : ["tag:lookup", "registry:version"]);
    expect(h.publish).not.toHaveBeenCalled();
    expect(h.wait).not.toHaveBeenCalled();
  });

  it.each(["commit", "tag", "tree", "blob"])("accepts an existing %s tag target", async (type) => {
    const f = preflightFixture();
    const h = harness(f.receipt);
    h.state.tag = otherSha;
    h.state.tagType = type;
    await expect(preflightRelease(f.sha, f.cwd, h.services)).resolves.toMatchObject({ skip: true });
    expect(h.npmView).not.toHaveBeenCalled();
  });

  it("exposes tag and npm lookup errors", async () => {
    const f = preflightFixture();
    const h = harness(f.receipt);
    for (const status of [401, 403, 429, 500]) {
      h.services.fetch = vi.fn(async () => json({}, status)) as typeof fetch;
      await expect(preflightRelease(f.sha, f.cwd, h.services)).rejects.toThrow(`HTTP ${status}`);
    }
    const tagFailure = new Error("GitHub connection reset");
    h.services.fetch = vi.fn(async () => { throw tagFailure; }) as typeof fetch;
    await expect(preflightRelease(f.sha, f.cwd, h.services)).rejects.toBe(tagFailure);
    h.services.fetch = h.fetchMock as typeof fetch;
    const failure = new Error("npm lookup connection reset");
    h.services.npmView = vi.fn(async () => { throw failure; });
    await expect(preflightRelease(f.sha, f.cwd, h.services)).rejects.toBe(failure);
    expect(h.publish).not.toHaveBeenCalled();
  });

  it.each([null, [], {}, { ref: "refs/tags/another", object: { type: "tag", sha: otherSha } }, { ref: "refs/tags/daynight-v1.2.3", object: { type: "tag", sha: "invalid" } }])("rejects malformed successful tag lookup %j", async (response) => {
    const f = preflightFixture();
    const h = harness(f.receipt);
    h.services.fetch = vi.fn(async () => json(response)) as typeof fetch;
    await expect(preflightRelease(f.sha, f.cwd, h.services)).rejects.toThrow();
    expect(h.services.fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects a different checkout source before external requests", async () => {
    const f = preflightFixture();
    const h = harness(f.receipt);
    await expect(preflightRelease(otherSha, f.cwd, h.services)).rejects.toThrow("differs from release source");
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it("exports a successful skip as Actions outputs without publication artifacts", () => {
    const f = preflightFixture();
    const stub = path.join(f.cwd, "fetch.mjs");
    const output = path.join(f.cwd, "github-output");
    writeFileSync(stub, `globalThis.fetch = async () => new Response(JSON.stringify({ ref: 'refs/tags/daynight-v1.2.3', object: { type: 'tag', sha: '${otherSha}' } }));\n`);
    const result = spawnSync(process.execPath, ["--import", pathToFileURL(stub).href, script, "preflight", f.sha], {
      cwd: f.cwd, encoding: "utf8", timeout: 20_000, env: { ...process.env, GH_TOKEN: "fixture-token", GITHUB_TOKEN: "fixture-token", GITHUB_OUTPUT: output },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Skipping existing release @codetreker/daynight@1.2.3.");
    expect(readFileSync(output, "utf8")).toBe("version=1.2.3\nskip=true\n");
  });

  it.each(["\n", "\r\n"])("rechecks every workflow attempt and gates publication on the skip output (%j line endings)", (newline) => {
    type Step = { id?: string; run?: string; if?: string; uses?: string; env?: Record<string, string>; with?: Record<string, unknown> };
    type Job = { if?: string; outputs?: Record<string, string>; permissions?: Record<string, string>; environment?: string; steps: Step[] };
    const content = readFileSync(path.resolve(import.meta.dirname, "../../../../.github/workflows/publish.yml"), "utf8");
    const { jobs } = parseYaml(content.replace(/\r?\n/g, newline)) as { jobs: { preflight: Job; prepare: Job; publish: Job } };
    expect(jobs.preflight.if).toBeUndefined();
    expect(jobs.preflight.outputs?.skip).toBe("${{ steps.release.outputs.skip }}");
    expect(jobs.prepare.outputs).not.toHaveProperty("attempt");
    for (const job of [jobs.prepare, jobs.publish]) expect(job.if).toBe("needs.preflight.outputs.skip == 'false'");
    const recheckIndex = jobs.publish.steps.findIndex((step) => step.id === "preflight");
    const publicationIndex = jobs.publish.steps.findIndex((step) => step.run === 'node packages/daynight/scripts/publish.ts publish "$GITHUB_SHA"');
    const downloadIndex = jobs.publish.steps.findIndex((step) => step.uses?.startsWith("actions/download-artifact@"));
    const publisherIndex = jobs.publish.steps.findIndex((step) => step.run === "npm install --prefix .tmp/pnpm-publish --no-save --package-lock=false --ignore-scripts --no-audit --no-fund pnpm@11.28.6");
    expect(recheckIndex).toBeGreaterThan(-1);
    for (const index of [publisherIndex, downloadIndex, publicationIndex]) {
      expect(index).toBeGreaterThan(recheckIndex);
      expect(jobs.publish.steps[index]!.if).toBe("steps.preflight.outputs.skip != 'true'");
    }
    expect(publicationIndex).toBeGreaterThan(publisherIndex);
    expect(jobs.publish.steps.find((step) => step.uses?.startsWith("actions/setup-node@"))?.with).toMatchObject({
      "node-version": 24, "registry-url": "https://registry.npmjs.org/", "package-manager-cache": false,
    });
    expect(jobs.prepare.steps.find((step) => step.uses?.startsWith("pnpm/action-setup@"))?.with?.version).toBe("11.28.6");
    expect(jobs.publish.permissions?.["id-token"]).toBe("write");
    expect(jobs.publish.environment).toBeUndefined();
    const npmCli = "${{ github.workspace }}/.tmp/npm-cli/node_modules/npm/bin/npm-cli.js";
    expect(jobs.publish.steps[publicationIndex]!.env?.NPM_CLI_JS).toBe(npmCli);
    expect(jobs.publish.steps[publicationIndex]!.env?.PNPM_CLI_JS).toBe("${{ github.workspace }}/.tmp/pnpm-publish/node_modules/pnpm/bin/pnpm.cjs");
    for (const [job, lookupId] of [[jobs.preflight, "release"], [jobs.publish, "preflight"]] as const) {
      const lookupIndex = job.steps.findIndex((step) => step.id === lookupId);
      const installIndex = job.steps.findIndex((step) => step.run?.startsWith("npm install --prefix .tmp/npm-cli ") && step.run.endsWith(" npm@12.2.0"));
      expect(installIndex).toBeGreaterThan(-1);
      expect(lookupIndex).toBeGreaterThan(installIndex);
      expect(job.steps[installIndex]!.if).toBeUndefined();
      expect(job.steps[lookupIndex]).toMatchObject({ run: 'node packages/daynight/scripts/publish.ts preflight "$GITHUB_SHA"', env: { NPM_CLI_JS: npmCli } });
      expect(job.steps[lookupIndex]!.if).toBeUndefined();
    }
  });
});

describe("npm release publication", () => {
  it.each(["tag", "npm"])("successfully skips an existing %s despite different source or bytes and a missing local tarball", async (marker) => {
    const f = fixture();
    const h = harness(f.receipt);
    rmSync(path.join(f.artifact, "package.tgz"));
    if (marker === "tag") { h.state.tag = otherSha; h.state.tagType = "tag"; }
    else h.state.metadata = { ...metadata(f.receipt), gitHead: otherSha, dist: { integrity: "unrelated bytes", tarball: "not a URL" } };
    await expect(publishRelease(sourceSha, f.cwd, h.services)).resolves.toEqual(f.receipt);
    expect(h.events).toEqual(marker === "tag" ? ["tag:lookup"] : ["tag:lookup", "registry:version"]);
    expect(h.publish).not.toHaveBeenCalled();
  });

  it("waits beyond two minutes for metadata, verifies downloaded bytes, then tags the prepared source", async () => {
    const f = fixture();
    const h = harness(f.receipt);
    h.state.delay = 28;
    await publishRelease(sourceSha, f.cwd, h.services);
    expect(h.publish).toHaveBeenCalledExactlyOnceWith(path.join(f.artifact, "package.tgz"), path.join(f.cwd, ".tmp/npm-release"));
    expect(h.wait).toHaveBeenCalledTimes(27);
    expect(h.wait.mock.calls.reduce((elapsed, [milliseconds]) => elapsed + milliseconds, 0)).toBeGreaterThan(120_000);
    expect(h.state.tag).toBe(sourceSha);
    expect(h.events.indexOf("npm:publish")).toBeLessThan(h.events.indexOf("tarball:download"));
    expect(h.events.indexOf("tarball:download")).toBeLessThan(h.events.indexOf("tag:create"));
    expect(h.npmView.mock.calls.slice(2).every(([, cwd, signal]) => cwd === f.cwd && signal instanceof AbortSignal)).toBe(true);
  });

  it("treats a concurrent existing npm version after a rejected publish as a successful skip", async () => {
    const f = fixture();
    const h = harness(f.receipt);
    h.services.publish = async () => {
      h.state.metadata = { ...metadata(f.receipt), gitHead: otherSha, dist: { integrity: "another artifact", tarball: "not a URL" } };
      throw new Error("npm version already exists");
    };
    await expect(publishRelease(sourceSha, f.cwd, h.services)).resolves.toEqual(f.receipt);
    expect(h.events).not.toContain("tarball:download");
    expect(h.events).not.toContain("tag:create");
    expect(h.npmView.mock.calls.map(([version]) => version)).toEqual(["1.2.3", "latest", "1.2.3"]);
  });

  it("preserves a publish failure when npm confirms the version remains absent", async () => {
    const f = fixture();
    const h = harness(f.receipt);
    const failure = new Error("npm rejected OIDC credentials");
    h.state.publicationError = failure;
    await expect(publishRelease(sourceSha, f.cwd, h.services)).rejects.toBe(failure);
    expect(h.events).not.toContain("tag:create");
  });

  it("exposes both publish and status lookup failures", async () => {
    const f = fixture();
    const h = harness(f.receipt);
    const failure = new Error("npm rejected OIDC credentials");
    const lookupFailure = new Error("registry unavailable");
    h.state.publicationError = failure;
    const original = h.services.npmView;
    h.services.npmView = async (...args) => {
      if (h.publish.mock.calls.length > 0) throw lookupFailure;
      return original(...args);
    };
    await expect(publishRelease(sourceSha, f.cwd, h.services)).rejects.toMatchObject({ errors: [failure, lookupFailure], cause: failure });
  });

  it("skips a previously published version after tag creation failed without repairing the tag", async () => {
    const f = fixture();
    const h = harness(f.receipt);
    h.state.postStatus = 403;
    await expect(publishRelease(sourceSha, f.cwd, h.services)).rejects.toThrow("tag creation failed: HTTP 403");
    h.state.postStatus = 201;
    h.state.latest = { version: "9.0.0" };
    await publishRelease(sourceSha, f.cwd, h.services);
    expect(h.publish).toHaveBeenCalledTimes(1);
    expect(h.events.filter((event) => event === "registry:latest")).toHaveLength(1);
    expect(h.state.tag).toBeUndefined();
    expect(h.events.filter((event) => event === "tag:create")).toHaveLength(1);
  });

  it.each(["source", "integrity", "bytes", "url"])("rejects a fresh publication's mismatched %s before tagging", async (field) => {
    const f = fixture();
    const h = harness(f.receipt);
    h.services.publish = async () => {
      await h.publish();
      if (field === "source") h.state.metadata!.gitHead = otherSha;
      if (field === "integrity") h.state.metadata!.dist.integrity = hash(Buffer.from("another package"));
      if (field === "bytes") h.state.tarball = Buffer.from("wrong public bytes");
      if (field === "url") h.state.metadata!.dist.tarball = "https://example.com/package.tgz";
    };
    await expect(publishRelease(sourceSha, f.cwd, h.services)).rejects.toThrow(field === "source" || field === "integrity"
      ? "differs from the prepared source or tarball integrity" : field === "bytes" ? "Public npm tarball bytes differ" : "Published tarball URL must use the public npm registry");
    expect(h.events).not.toContain("tag:create");
  });

  it.each([sourceSha, otherSha])("accepts only the same source during concurrent tag creation (%s)", async (concurrentSha) => {
    const f = fixture();
    const h = harness(f.receipt);
    const original = h.services.fetch;
    h.services.fetch = (async (input, init) => {
      if (init?.method === "POST") { h.state.tag = concurrentSha; return json({}, 422); }
      return original(input, init);
    }) as typeof fetch;
    const result = publishRelease(sourceSha, f.cwd, h.services);
    if (concurrentSha === sourceSha) await expect(result).resolves.toEqual(f.receipt);
    else await expect(result).rejects.toThrow("already points to a different target");
    expect(h.state.tag).toBe(concurrentSha);
  });

  it("skips a version that becomes latest between the initial version and latest lookups", async () => {
    const f = fixture();
    const h = harness(f.receipt);
    h.state.latest = { version: f.receipt.version };
    rmSync(path.join(f.artifact, "package.tgz"));
    await expect(publishRelease(sourceSha, f.cwd, h.services)).resolves.toEqual(f.receipt);
    expect(h.publish).not.toHaveBeenCalled();
    expect(h.events).toEqual(["tag:lookup", "registry:version", "registry:latest"]);
  });

  it.each(["1.2.4", "2.0.0", "1.2.4-beta.1"])("rejects a new version that does not advance stable latest %s", async (latest) => {
    const f = fixture();
    const h = harness(f.receipt);
    h.state.latest = { version: latest };
    await expect(publishRelease(sourceSha, f.cwd, h.services)).rejects.toThrow();
    expect(h.publish).not.toHaveBeenCalled();
  });

  it("supports an absent package and compares stable version components numerically", async () => {
    const f = fixture();
    const h = harness(f.receipt);
    f.receipt.version = "1.10.0";
    f.receipt.tag = "daynight-v1.10.0";
    f.save();
    h.state.latest = { version: "1.9.999" };
    await publishRelease(sourceSha, f.cwd, h.services);
    h.state.metadata = undefined;
    h.state.tag = undefined;
    h.state.latest = undefined;
    await publishRelease(sourceSha, f.cwd, h.services);
    expect(h.publish).toHaveBeenCalledTimes(2);
  });

  it.each(["metadata", "tarball", "shared"])("bounds persistent %s propagation by the shared ten-minute budget", async (target) => {
    const f = fixture();
    const h = harness(f.receipt);
    if (target === "metadata") h.services.publish = async () => { h.events.push("npm:publish"); };
    if (target === "tarball") h.state.tarballStatus = 404;
    if (target === "shared") { h.state.delay = 61; h.state.tarballDelay = 100; }
    await expect(publishRelease(sourceSha, f.cwd, h.services)).rejects.toThrow("and tarball within 10 minutes");
    expect(h.wait).toHaveBeenCalledTimes(120);
    expect(h.wait.mock.calls.reduce((elapsed, [milliseconds]) => elapsed + milliseconds, 0)).toBe(600_000);
    expect(h.events.filter((event) => event === "registry:version")).toHaveLength(target === "metadata" ? 122 : target === "shared" ? 62 : 2);
    expect(h.events.filter((event) => event === "tarball:download")).toHaveLength(target === "metadata" ? 0 : target === "shared" ? 61 : 121);
    expect(h.events).not.toContain("tag:create");
  });

  it("waits for public tarball propagation before tagging", async () => {
    const f = fixture();
    const h = harness(f.receipt);
    h.state.tarballDelay = 2;
    await publishRelease(sourceSha, f.cwd, h.services);
    expect(h.wait).toHaveBeenCalledTimes(2);
    expect(h.events.filter((event) => event === "tarball:download")).toHaveLength(3);
    expect(h.events.lastIndexOf("tarball:download")).toBeLessThan(h.events.indexOf("tag:create"));
  });

  it.each([401, 429, 500])("exposes tarball HTTP %s immediately", async (status) => {
    const f = fixture();
    const h = harness(f.receipt);
    h.state.tarballStatus = status;
    await expect(publishRelease(sourceSha, f.cwd, h.services)).rejects.toThrow(`Public npm tarball download failed: HTTP ${status}`);
    expect(h.wait).not.toHaveBeenCalled();
    expect(h.events).not.toContain("tag:create");
  });

  it.each([false, true])("bounds a stalled tarball response by the request or shared deadline (%s)", async (shared) => {
    const f = fixture();
    const h = harness(f.receipt);
    const deadline = new AbortController();
    const expiration = new DOMException("Visibility deadline expired", "TimeoutError");
    const originalTimeout = AbortSignal.timeout;
    vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => milliseconds === (shared ? 600_000 : 20_000) ? deadline.signal : originalTimeout(milliseconds));
    const original = h.services.fetch;
    h.services.fetch = (async (input, init) => {
      const response = await original(input, init);
      if (String(input).endsWith(".tgz")) vi.spyOn(response, "arrayBuffer").mockImplementation(() => {
        deadline.abort(expiration);
        return new Promise<never>(() => {});
      });
      return response;
    }) as typeof fetch;
    const result = publishRelease(sourceSha, f.cwd, h.services);
    if (shared) await expect(result).rejects.toMatchObject({ message: `Timed out waiting for public npm version ${f.receipt.name}@${f.receipt.version} and tarball within 10 minutes.`, cause: expiration });
    else await expect(result).rejects.toBe(expiration);
    expect(h.events).not.toContain("tag:create");
  });

  it("exposes npm metadata failure after publication", async () => {
    const f = fixture();
    const h = harness(f.receipt);
    const failure = new Error("registry connection reset");
    const original = h.services.npmView;
    h.services.npmView = async (...args) => {
      if (h.publish.mock.calls.length > 0) throw failure;
      return original(...args);
    };
    await expect(publishRelease(sourceSha, f.cwd, h.services)).rejects.toBe(failure);
    expect(h.events).not.toContain("tag:create");
  });

  it("rejects a tampered local tarball before publishing a new version", async () => {
    const f = fixture();
    const h = harness(f.receipt);
    writeFileSync(path.join(f.artifact, "package.tgz"), "tampered");
    await expect(publishRelease(sourceSha, f.cwd, h.services)).rejects.toThrow("Prepared tarball integrity differs");
    expect(h.publish).not.toHaveBeenCalled();
  });

  it.each(["name", "version", "sourceSha", "repository", "tag", "tarball", "integrity"])("rejects invalid receipt field %s before external requests", async (field) => {
    const f = fixture();
    const h = harness(f.receipt);
    writeFileSync(path.join(f.artifact, "release.json"), JSON.stringify({ ...f.receipt, [field]: "invalid" }));
    await expect(publishRelease(sourceSha, f.cwd, h.services)).rejects.toThrow("Release receipt does not match");
    expect(h.fetchMock).not.toHaveBeenCalled();
    expect(h.npmView).not.toHaveBeenCalled();
  });
});

const packedManifest = (tarball: Buffer): Record<string, unknown> => {
  const tar = gunzipSync(tarball);
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    const name = header.subarray(0, 100).toString().replace(/\0.*$/, "");
    const size = Number.parseInt(header.subarray(124, 136).toString().replace(/\0.*$/, "").trim(), 8);
    if (name === "package/package.json") return JSON.parse(tar.subarray(offset + 512, offset + 512 + size).toString()) as Record<string, unknown>;
    if (!Number.isFinite(size)) break;
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error("No manifest in package tarball.");
};

describe("release preparation and command wrappers", () => {
  describe("authored package packing", () => {
    const prepare = () => {
      const f = fixture();
      const app = path.join(f.cwd, "packages/daynight");
      mkdirSync(path.join(app, "dist"), { recursive: true });
      mkdirSync(path.join(app, "node_modules/private-package"), { recursive: true });
      writeFileSync(path.join(app, "dist/main.js"), "console.log('release');\n");
      writeFileSync(path.join(app, "README.md"), "# Package\n");
      writeFileSync(path.join(app, "package.json"), JSON.stringify({
        name: "@codetreker/daynight", version: "1.2.3", files: ["dist"],
        repository: { type: "git", url: "git+https://github.com/codetreker/daynight.git", directory: "packages/daynight" },
        scripts: { prepack: "node -e \"process.exit(91)\"" },
      }));
      return { f, app, sha: sourceCheckout(f.cwd) };
    };
    let prepared: ReturnType<typeof prepare>;
    beforeEach(() => { prepared = prepare(); });

    it("packs authored metadata and built output with the exact source gitHead and a matching receipt", async () => {
      const { f, app, sha } = prepared;
      await expect(prepareRelease(otherSha, f.cwd)).rejects.toThrow("differs from release source");
      const receipt = await prepareRelease(sha, f.cwd);
      const tarball = readFileSync(path.join(f.artifact, "package.tgz"));
      expect(receipt.sourceSha).toBe(sha);
      expect(receipt.integrity).toBe(hash(tarball));
      expect(packedManifest(tarball)).toMatchObject({ name: "@codetreker/daynight", version: "1.2.3", gitHead: sha });
      expect(gunzipSync(tarball).includes(Buffer.from("package/dist/main.js"))).toBe(true);
      expect(gunzipSync(tarball).includes(Buffer.from("package/README.md"))).toBe(true);
      expect(readFileSync(path.join(app, "package.json"), "utf8")).not.toContain("gitHead");
      expect(readFileSync(path.join(f.artifact, "release.json"), "utf8")).toBe(`${JSON.stringify(receipt, null, 2)}\n`);
    });
  });

  it.each([0, 17])("runs the pinned pnpm CLI with inherited OIDC and npm configuration (exit %s)", async (status) => {
    const f = fixture();
    const cli = path.join(f.cwd, "pnpm cli.mjs");
    const output = path.join(f.cwd, "invocation.json");
    const inherited = {
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.example.invalid/token",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "fixture-oidc-request-token",
      NODE_AUTH_TOKEN: "fixture-node-auth-token",
      NPM_TOKEN: "fixture-npm-token",
      NPM_CONFIG_USERCONFIG: path.join(f.cwd, "configured.npmrc"),
      npm_config_registry: "https://configured.example.invalid/",
    };
    writeFileSync(cli, `import {writeFileSync} from 'node:fs';\nwriteFileSync(${JSON.stringify(output)}, JSON.stringify({args: process.argv.slice(2), cwd: process.cwd(), env: Object.fromEntries(${JSON.stringify(Object.keys(inherited))}.map(key => [key, process.env[key]]))}));\nprocess.exit(${status});\n`);
    vi.stubEnv("PNPM_CLI_JS", cli);
    vi.stubEnv("NPM_CLI_JS", path.join(f.cwd, "unused-npm-cli.mjs"));
    for (const [key, value] of Object.entries(inherited)) vi.stubEnv(key, value);
    const publication = runPnpmPublish(path.join(f.artifact, "package.tgz"), f.cwd);
    if (status === 0) await expect(publication).resolves.toBeUndefined();
    else await expect(publication).rejects.toThrow("pnpm publish failed (exit 17)");
    expect(JSON.parse(readFileSync(output, "utf8"))).toEqual({
      args: ["publish", path.join(f.artifact, "package.tgz"), "--pm-on-fail=ignore", "--no-git-checks", "--access", "public", "--tag", "latest", "--provenance", "--ignore-scripts", "--registry", "https://registry.npmjs.org/"],
      cwd: f.cwd, env: inherited,
    });
    expect(existsSync(path.join(f.cwd, "user.npmrc"))).toBe(false);
    expect(existsSync(path.join(f.cwd, "global.npmrc"))).toBe(false);
  });

  it.each([undefined, ""])("requires an explicit pnpm publication CLI (%j)", async (cli) => {
    const f = fixture();
    vi.stubEnv("PNPM_CLI_JS", cli);
    await expect(runPnpmPublish(path.join(f.artifact, "package.tgz"), f.cwd)).rejects.toThrow("PNPM_CLI_JS must identify the pinned pnpm publication CLI.");
  });

  it.skipIf(process.platform === "win32")("forwards a POSIX signal terminating the pnpm publication CLI", async () => {
    const f = fixture();
    const cli = path.join(f.cwd, "pnpm-cli.mjs");
    writeFileSync(cli, "process.kill(process.pid, 'SIGTERM');\n");
    vi.stubEnv("PNPM_CLI_JS", cli);
    await expect(runPnpmPublish(path.join(f.artifact, "package.tgz"), f.cwd)).rejects.toThrow("pnpm publish failed (signal SIGTERM)");
  });

  it("rejects unsupported CLI commands and missing source arguments", () => {
    for (const args of [[], ["publish"], ["unknown", sourceSha], ["prepare", sourceSha, "extra"]]) {
      const result = spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: "utf8", timeout: 20_000 });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Usage:");
    }
  });
});
