import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { execFileSync, type ChildProcess } from "node:child_process";
import path from "node:path";
import crossSpawn from "cross-spawn";
import { afterAll, beforeAll, expect, it } from "vitest";
import { terminateInstalledProcess } from "../../fixtures/installed-cli.js";

const workspace = path.resolve(import.meta.dirname, "../../../../..");
const packageDirectory = path.join(workspace, "packages/daynight");
const packageName = "@codetreker/daynight";
type Manifest = { name: string; version: string; [key: string]: unknown };
type Result = { status: number | null; stdout: string; stderr: string };

const skillTree = (directory: string): Record<string, string> => Object.fromEntries(
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => entry.isDirectory()
    ? Object.entries(skillTree(path.join(directory, entry.name))).map(([relative, contents]) => [`${entry.name}/${relative}`, contents])
    : [[entry.name, readFileSync(path.join(directory, entry.name)).toString("base64")]]),
);

const createUpdateFixture = () => {
  const temporary = path.join(workspace, ".tmp");
  const evidenceFile = path.join(temporary, "update-evidence.json");
  const cancellation = new AbortController();
  const children = new Map<ChildProcess, Promise<unknown>>();
  const server = createServer();
  let ownedDirectory: string | undefined;
  let preparation: Promise<() => Promise<Record<string, unknown>>> | undefined;
  let behavior: Promise<Record<string, unknown>> | undefined;
  let evidence: Record<string, unknown> | undefined;
  let failure: unknown;
  const terminate = async (child: ChildProcess, closed: Promise<unknown>): Promise<void> => {
    const failures: unknown[] = [];
    if (process.platform !== "win32" && child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      try {
        const processes = execFileSync("ps", ["-eo", "pid=,ppid="], { encoding: "utf8", timeout: 5_000 }).trim().split("\n").map((line) => line.trim().split(/\s+/).map(Number));
        const owned = new Set([child.pid]);
        let previous = 0;
        while (owned.size !== previous) {
          previous = owned.size;
          for (const [pid, parent] of processes) if (pid !== undefined && parent !== undefined && owned.has(parent)) owned.add(pid);
        }
        for (const pid of [...owned].reverse()) {
          try { process.kill(pid, "SIGKILL"); }
          catch (cause) { if (!(cause instanceof Error && "code" in cause && cause.code === "ESRCH")) failures.push(cause); }
        }
      } catch (cause) { failures.push(cause); }
    }
    try { await terminateInstalledProcess(child, closed); }
    catch (cause) { failures.push(cause); }
    if (failures.length !== 0) throw new AggregateError(failures, "Update fixture process cleanup failed.");
  };
  const prepare = (): Promise<() => Promise<Record<string, unknown>>> => {
    preparation = (async () => {
      mkdirSync(temporary, { recursive: true });
      rmSync(evidenceFile, { force: true });
      const directory = mkdtempSync(path.join(temporary, "npm self update 中文 "));
      ownedDirectory = directory;
      cancellation.signal.throwIfAborted();
      const home = path.join(directory, "isolated home 中文");
      const prefix = path.join(directory, "original npm prefix 中文");
      const unrelatedPrefix = path.join(directory, "unrelated default prefix 中文");
      const caller = path.join(directory, "caller project 中文");
      const callerSubdirectory = path.join(caller, "nested commands 中文");
      const artifacts = path.join(directory, "packed artifacts");
      const cache = path.join(directory, "npm cache 中文");
      const state = path.join(home, ".daynight");
      const agentLaunchers = path.join(directory, "agent launchers");
      const agentSentinel = path.join(directory, "agent-executed.txt");
      for (const location of [home, prefix, callerSubdirectory, artifacts, state, agentLaunchers]) mkdirSync(location, { recursive: true });
      const launcherSource = `import("node:fs").then(({ writeFileSync }) => { writeFileSync(${JSON.stringify(agentSentinel)}, "Agent launcher executed."); process.exitCode = 87; });\n`;
      const launcherModule = path.join(agentLaunchers, "fail-if-executed.cjs");
      writeFileSync(launcherModule, launcherSource);
      for (const agent of ["codex", "copilot", "claude"]) {
        const filename = path.join(agentLaunchers, process.platform === "win32" ? `${agent}.cmd` : agent);
        const contents = process.platform === "win32"
          ? `@echo off\r\n"${process.execPath}" "${launcherModule}"\r\n`
          : `#!/usr/bin/env node\n${launcherSource}`;
        writeFileSync(filename, contents, { mode: 0o755 });
      }
      const userConfiguration = path.join(directory, "user.npmrc");
      const globalConfiguration = path.join(directory, "global.npmrc");
      writeFileSync(globalConfiguration, "");
      const projectConfiguration = path.join(caller, ".npmrc");
      const projectContents = "@codetreker:registry=http://127.0.0.1:1/\nregistry=http://127.0.0.1:1/\n";
      writeFileSync(projectConfiguration, projectContents);
      writeFileSync(path.join(caller, "package.json"), JSON.stringify({ name: "unrelated-caller", private: true }));
      const configurationContents = "invalid: [yaml\n";
      const databaseContents = Buffer.from("This is deliberately not a SQLite database.\n");
      writeFileSync(path.join(state, "config.yml"), configurationContents);
      writeFileSync(path.join(state, "state.sqlite"), databaseContents);
      const environment: NodeJS.ProcessEnv = { ...process.env };
      for (const name of Object.keys(environment)) {
        if (/^(?:npm_config_|node_options$|daynight_|path$)/i.test(name)) delete environment[name];
      }
      Object.assign(environment, {
        HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, "config"),
        XDG_CACHE_HOME: path.join(home, "cache"), APPDATA: path.join(home, "AppData", "Roaming"),
        LOCALAPPDATA: path.join(home, "AppData", "Local"),
        PATH: `${agentLaunchers}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? process.env.Path ?? ""}`,
        NPM_CONFIG_USERCONFIG: userConfiguration, NPM_CONFIG_GLOBALCONFIG: globalConfiguration,
        NPM_CONFIG_PREFIX: unrelatedPrefix, NO_COLOR: "1",
      });
      const nodeDirectory = path.dirname(realpathSync(process.execPath));
      const npmCli = [path.join(nodeDirectory, "node_modules/npm/bin/npm-cli.js"), path.resolve(nodeDirectory, "../lib/node_modules/npm/bin/npm-cli.js")].find(existsSync);
      if (npmCli === undefined) throw new Error("The acceptance fixture requires npm bundled with the current Node.js installation.");
      const run = async (executable: string, args: string[], cwd: string, commandEnvironment = environment): Promise<Result> => {
        cancellation.signal.throwIfAborted();
        // The owned POSIX group remains reapable when a launcher exits before its stdout holders.
      const child = crossSpawn(executable, args, { cwd, env: commandEnvironment, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        let launchFailure: Error | undefined;
        child.stdout!.setEncoding("utf8");
        child.stderr!.setEncoding("utf8");
        child.stdout!.on("data", (chunk: string) => { stdout += chunk; process.stdout.write(chunk); });
        child.stderr!.on("data", (chunk: string) => { stderr += chunk; process.stderr.write(chunk); });
        child.once("error", (error) => { launchFailure = error; });
        const closed = new Promise<number | null>((resolve) => child.once("close", (status) => { children.delete(child); resolve(status); }));
        children.set(child, closed);
        const aborted = Promise.withResolvers<"cancelled">();
        const cancel = (): void => aborted.resolve("cancelled");
        cancellation.signal.addEventListener("abort", cancel, { once: true });
        if (cancellation.signal.aborted) cancel();
        let timer: ReturnType<typeof setTimeout> | undefined;
        let outcome: { status: number | null } | "timeout" | "cancelled";
        try {
          outcome = await Promise.race([closed.then((status) => ({ status })), aborted.promise, new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), 120_000); })]);
        } finally {
          if (timer !== undefined) clearTimeout(timer);
          cancellation.signal.removeEventListener("abort", cancel);
        }
        if (outcome === "timeout" || outcome === "cancelled") {
          const cause: unknown = outcome === "cancelled" ? cancellation.signal.reason : new Error(`Acceptance command timed out: ${path.basename(executable)} ${args.join(" ")}`);
          try { await terminate(child, closed); }
          catch (cleanupError) { throw new AggregateError([cause, cleanupError], "Acceptance command and cleanup failed."); }
          throw cause;
        }
        if (launchFailure !== undefined) throw launchFailure;
        cancellation.signal.throwIfAborted();
        return { status: outcome.status, stdout, stderr };
      };
      const npm = (args: string[], cwd = directory): Promise<Result> => run(process.execPath, [npmCli, ...args], cwd);
      const success = (result: Result): Result => {
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
        return result;
      };
      success(await run("git", ["init", "--quiet", caller], directory));
      cancellation.signal.throwIfAborted();
      const listening = Promise.withResolvers<void>();
      const cancelListen = (): void => listening.reject(cancellation.signal.reason);
      server.once("error", listening.reject);
      cancellation.signal.addEventListener("abort", cancelListen, { once: true });
      try {
        if (cancellation.signal.aborted) cancelListen();
        else server.listen({ port: 0, host: "127.0.0.1", signal: cancellation.signal }, listening.resolve);
        await listening.promise;
      } finally {
        server.removeListener("error", listening.reject);
        cancellation.signal.removeEventListener("abort", cancelListen);
      }
      cancellation.signal.throwIfAborted();
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("The registry fixture did not receive a TCP port.");
      const registry = `http://127.0.0.1:${address.port}`;
      writeFileSync(userConfiguration, [
        "registry=https://registry.npmjs.org/", `@codetreker:registry=${registry}/`,
        `cache=${cache.replaceAll("\\", "/")}`,
        "fetch-retries=0", "fetch-timeout=30000", "ignore-scripts=true", "progress=false",
        "audit=false", "fund=false", "update-notifier=false", "loglevel=warn", "",
      ].join("\n"));
      const npmConfigurationContents = readFileSync(userConfiguration, "utf8");
      const sourceManifest = JSON.parse(readFileSync(path.join(packageDirectory, "package.json"), "utf8")) as Manifest;
      const skillRelativeFile = "commands/review/skills/daynight-review/SKILL.md";
      const sourceSkillContents = readFileSync(path.join(packageDirectory, "src", skillRelativeFile), "utf8");
      expect(readFileSync(path.join(packageDirectory, "dist", skillRelativeFile), "utf8")).toBe(sourceSkillContents);
      const fixtureSkills = new Map<string, string>();
      const publicSkillRelativeDirectory = "commands/skill/skills/using-daynight";
      const publicSkillEntrypoint = path.join(publicSkillRelativeDirectory, "SKILL.md");
      const sourcePublicSkill = readFileSync(path.join(packageDirectory, "src", publicSkillEntrypoint), "utf8");
      const fixturePublicSkills = new Map<string, Record<string, string>>();
      const versions: Record<string, Manifest> = {};
      const tarballs = new Map<string, Buffer>();
      const requests: { pathname: string; status: number }[] = [];
      let latest = "1.0.1";
      let advanceLatestAfterQuery = false;
      let metadataFailure = false;
      let tarballFailure = false;
      server.on("request", (request, response) => {
        const pathname = decodeURIComponent(new URL(request.url!, registry).pathname);
        const reply = (status: number, body: string | Buffer, contentType = "application/json"): void => {
          requests.push({ pathname, status });
          response.writeHead(status, { "content-type": contentType, "cache-control": "no-store" });
          response.end(body);
        };
        if (pathname === `/${packageName}`) {
          if (metadataFailure) reply(503, JSON.stringify({ error: "Controlled registry metadata failure" }));
          else {
            reply(200, JSON.stringify({ _id: packageName, name: packageName, "dist-tags": { latest }, versions }));
            if (advanceLatestAfterQuery) { latest = "1.0.2"; advanceLatestAfterQuery = false; }
          }
          return;
        }
        const tarball = tarballs.get(pathname);
        if (tarball !== undefined) {
          if (tarballFailure) reply(503, JSON.stringify({ error: "Controlled registry tarball failure" }));
          else reply(200, tarball, "application/octet-stream");
          return;
        }
        reply(404, JSON.stringify({ error: "The fixture only serves daynight metadata and its packed tarballs." }));
      });
      for (const version of ["1.0.0", "1.0.1", "1.0.2"]) {
        const fixture = path.join(directory, `package ${version}`);
        mkdirSync(fixture);
        cpSync(path.join(packageDirectory, "dist"), path.join(fixture, "dist"), { recursive: true });
        const skillContents = `${sourceSkillContents}\n<!-- Npm update acceptance: package ${version}. -->\n`;
        writeFileSync(path.join(fixture, "dist", skillRelativeFile), skillContents);
        fixtureSkills.set(version, skillContents);
        writeFileSync(path.join(fixture, "dist", publicSkillEntrypoint), `${sourcePublicSkill}\n<!-- Public skill package ${version}. -->\n`);
        fixturePublicSkills.set(version, skillTree(path.join(fixture, "dist", publicSkillRelativeDirectory)));
        const manifest = { ...sourceManifest, version };
        writeFileSync(path.join(fixture, "package.json"), JSON.stringify(manifest, null, 2));
        const packed = success(await npm(["pack", "--ignore-scripts", "--pack-destination", artifacts], fixture));
        expect(packed.stdout.trim()).toBe(`codetreker-daynight-${version}.tgz`);
        const tarball = readFileSync(path.join(artifacts, packed.stdout.trim()));
        const pathname = `/tarballs/daynight-${version}.tgz`;
        tarballs.set(pathname, tarball);
        versions[version] = { ...manifest, dist: {
          tarball: `${registry}${pathname}`, integrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}`,
          shasum: createHash("sha1").update(tarball).digest("hex"),
        } };
      }
      rmSync(cache, { recursive: true, force: true });
      const oldTarball = path.join(artifacts, "codetreker-daynight-1.0.0.tgz");
      success(await npm(["install", oldTarball, "--global", "--prefix", prefix, "--engine-strict", "--force=false", "--no-audit", "--no-fund"]));

      cancellation.signal.throwIfAborted();
      return async (): Promise<Record<string, unknown>> => {
        const installedPackage = process.platform === "win32" ? path.join(prefix, "node_modules", packageName) : path.join(prefix, "lib/node_modules", packageName);
        const installedBin = process.platform === "win32" ? path.join(prefix, "daynight.cmd") : path.join(prefix, "bin/daynight");
        const shortBin = process.platform === "win32" ? path.join(prefix, "dn.cmd") : path.join(prefix, "bin/dn");
        const shortCli = (args: string[]): Promise<Result> => run(shortBin, args, callerSubdirectory);
        const installedSkill = path.join(installedPackage, "dist", skillRelativeFile);
        const cli = (args: string[], commandEnvironment = environment): Promise<Result> => run(installedBin, args, callerSubdirectory, commandEnvironment);
        const userSkill = path.join(home, ".agents", "skills", "using-daynight");
        const projectSkill = path.join(caller, ".claude", "skills", "using-daynight");
        const missingUserSkill = path.join(home, ".claude", "skills", "using-daynight");
        const missingProjectSkill = path.join(caller, ".agents", "skills", "using-daynight");
        const sibling = path.join(home, ".agents", "skills", "unrelated", "SKILL.md");
        mkdirSync(path.dirname(sibling), { recursive: true });
        writeFileSync(sibling, "Preserve this unrelated skill.\n");
        for (const target of [userSkill, projectSkill]) {
          cpSync(path.join(installedPackage, "dist", publicSkillRelativeDirectory), target, { recursive: true });
          writeFileSync(path.join(target, "SKILL.md"), "Local skill customization.\n");
          writeFileSync(path.join(target, "obsolete.md"), "Remove this obsolete resource.\n");
        }
        const expectPublicSkills = (version: string): void => {
          for (const target of [userSkill, projectSkill]) expect(skillTree(target)).toEqual(fixturePublicSkills.get(version));
          expect(existsSync(missingUserSkill)).toBe(false);
          expect(existsSync(missingProjectSkill)).toBe(false);
          expect(readFileSync(sibling, "utf8")).toBe("Preserve this unrelated skill.\n");
        };
        expect(success(await cli(["--version"])).stdout.trim()).toBe("1.0.0");
        expect(success(await shortCli(["--version"])).stdout.trim()).toBe("1.0.0");
        expect(readFileSync(installedSkill, "utf8")).toBe(fixtureSkills.get("1.0.0"));
        const emptyHome = path.join(directory, "empty home 中文");
        mkdirSync(emptyHome);
        expect(success(await cli(["update", "--help"], { ...environment, HOME: emptyHome, USERPROFILE: emptyHome })).stdout).toContain("Usage: daynight update");
        expect(existsSync(path.join(emptyHome, ".daynight"))).toBe(false);
        const metadata = success(await npm(["view", `${packageName}@latest`, "version", "--json", "--global", "--prefix", prefix, "--prefer-online"], caller));
        const queriedVersion: unknown = JSON.parse(metadata.stdout);
        expect(Array.isArray(queriedVersion) ? queriedVersion : [queriedVersion]).toEqual(["1.0.1"]);
        advanceLatestAfterQuery = true;
        const upgraded = success(await shortCli(["update"]));
        expect(upgraded.stdout).toContain("Updated daynight from 1.0.0 to 1.0.1.\nRestart any running reviewer to use the new version.\n");
        expect(success(await cli(["--version"])).stdout.trim()).toBe("1.0.1");
        expect(success(await shortCli(["--version"])).stdout.trim()).toBe("1.0.1");
        expect(latest).toBe("1.0.2");
        expect((JSON.parse(readFileSync(path.join(installedPackage, "package.json"), "utf8")) as Manifest).version).toBe("1.0.1");
        expect(readFileSync(installedSkill, "utf8")).toBe(fixtureSkills.get("1.0.1"));
        expect(readFileSync(installedSkill, "utf8")).not.toBe(fixtureSkills.get("1.0.0"));
        expectPublicSkills("1.0.1");
        expect(upgraded.stdout).toContain(userSkill);
        expect(upgraded.stdout).toContain(projectSkill);
        expect(requests.filter((item) => item.pathname === "/tarballs/daynight-1.0.1.tgz" && item.status === 200)).toHaveLength(1);
        const downloads = requests.filter((item) => item.pathname.startsWith("/tarballs/")).length;
        latest = "1.0.1";
        writeFileSync(path.join(projectSkill, "SKILL.md"), "Repair an interrupted project skill refresh.\n");
        expect(success(await cli(["update"], { ...environment, HOME: emptyHome, USERPROFILE: emptyHome })).stdout).toContain("daynight 1.0.1 is already up to date.\n");
        expectPublicSkills("1.0.1");
        expect(existsSync(path.join(emptyHome, ".daynight"))).toBe(false);
        expect(existsSync(path.join(emptyHome, ".agents"))).toBe(false);
        expect(existsSync(path.join(emptyHome, ".claude"))).toBe(false);
        expect(requests.filter((item) => item.pathname.startsWith("/tarballs/"))).toHaveLength(downloads);
        latest = "1.0.0";
        writeFileSync(path.join(userSkill, "SKILL.md"), "Repair the installed skill without downgrading.\n");
        expect(success(await cli(["update"])).stdout).toContain("daynight 1.0.1 is newer than latest 1.0.0.\n");
        expectPublicSkills("1.0.1");
        expect(requests.filter((item) => item.pathname.startsWith("/tarballs/"))).toHaveLength(downloads);
        metadataFailure = true;
        const unavailable = await cli(["update"]);
        expect(unavailable.status).toBe(1);
        expect(unavailable.stderr).toContain("Controlled registry metadata failure");
        expect(success(await cli(["--version"])).stdout.trim()).toBe("1.0.1");
        metadataFailure = false;
        latest = "1.0.2";
        tarballFailure = true;
        const failedInstall = await cli(["update"]);
        expect(failedInstall.status).toBe(1);
        expect(failedInstall.stderr).toContain("Controlled registry tarball failure");
        expect(requests.some((item) => item.pathname === "/tarballs/daynight-1.0.2.tgz" && item.status === 503)).toBe(true);
        expect(success(await cli(["--version"])).stdout.trim()).toBe("1.0.1");
        expect(readFileSync(path.join(state, "config.yml"), "utf8")).toBe(configurationContents);
        expect(readFileSync(installedSkill, "utf8")).toBe(fixtureSkills.get("1.0.1"));
        expectPublicSkills("1.0.1");
        tarballFailure = false;
        const blockedParent = path.join(home, ".claude");
        writeFileSync(blockedParent, "A regular file cannot be a skill parent.\n");
        const failedRefresh = await cli(["update"]);
        expect(failedRefresh.status).toBe(1);
        expect(failedRefresh.stderr).toMatch(/skill/iu);
        expect(failedRefresh.stderr).toContain(blockedParent);
        expect(success(await cli(["--version"])).stdout.trim()).toBe("1.0.2");
        expect(readFileSync(installedSkill, "utf8")).toBe(fixtureSkills.get("1.0.2"));
        expectPublicSkills("1.0.1");
        rmSync(blockedParent);
        const downloadsBeforeRetry = requests.filter((item) => item.pathname.startsWith("/tarballs/")).length;
        const recovered = success(await cli(["update"]));
        expect(recovered.stdout).toContain("daynight 1.0.2 is already up to date.\n");
        expectPublicSkills("1.0.2");
        expect(requests.filter((item) => item.pathname.startsWith("/tarballs/"))).toHaveLength(downloadsBeforeRetry);
        expect(readFileSync(path.join(state, "state.sqlite"))).toEqual(databaseContents);
        expect(readdirSync(state).sort()).toEqual(["config.yml", "state.sqlite"]);
        expect(readFileSync(userConfiguration, "utf8")).toBe(npmConfigurationContents);
        expect(readFileSync(globalConfiguration, "utf8")).toBe("");
        expect(readFileSync(projectConfiguration, "utf8")).toBe(projectContents);
        expect(existsSync(unrelatedPrefix)).toBe(false);
        expect(existsSync(path.join(caller, "node_modules"))).toBe(false);
        expect(existsSync(agentSentinel)).toBe(false);
        expect(requests.every((item) => item.pathname === `/${packageName}` || item.pathname.startsWith("/tarballs/"))).toBe(true);
        const npmVersion = success(await npm(["--version"])).stdout.trim();

        cancellation.signal.throwIfAborted();
        return {
          success: true, sourcePackageVersion: sourceManifest.version, nodeVersion: process.version, npmVersion,
          npmViewVersionShape: Array.isArray(queriedVersion) ? "singleton-array" : "string",
          platform: process.platform, architecture: process.arch, packagePacked: true,
          fixtureVersions: ["1.0.0", "1.0.1", "1.0.2"], installation: "real npm global", registry: "controlled scoped HTTP registry",
          installedBin: path.relative(prefix, installedBin).replaceAll("\\", "/"), npmCli: "current Node.js installation outside updated package",
          packagePrefix: "original npm prefix 中文", conflictingDefaultPrefixIgnored: true, callerProjectConfigurationIgnored: true,
          userNpmConfigurationPreserved: true, reviewConfigurationAndStateUnchanged: true, runtimeScripts: "disabled by isolated npm user configuration",
          scenarios: ["dn-before-update", "dn-update", "dn-after-update", "npm-global-shim-before-update", "spaces-and-unicode-prefix", "same-installation-replacement", "resolved-target-pinned-after-latest-moves", "npm-global-shim-after-update",
            "configured-scoped-registry", "conflicting-default-prefix", "conflicting-caller-project-npmrc", "update-help-without-state",
            "invalid-review-state-untouched", "already-current-without-install", "ahead-without-downgrade", "metadata-failure-visible", "installation-failure-visible",
            "bundled-skill-in-installed-npm-tarball", "self-update-replaces-skill-bytes", "failed-update-preserves-installed-skill",
            "existing-user-and-project-public-skills-refreshed", "project-skill-found-from-subdirectory", "absent-skills-remain-absent", "public-skill-stale-resources-removed",
            "current-refresh-without-install", "ahead-refresh-without-downgrade", "skill-refresh-failure-preserves-updated-package", "current-retry-recovers-public-skills", "agent-launchers-never-executed"],
          receipts: { previousVersion: "1.0.0", updatedVersion: "1.0.1", finalVersion: "1.0.2", currentSkippedInstall: true,
            aheadSkippedInstall: true, resolvedTargetPinnedAfterLatestMoves: true, metadataFailureExitCode: unavailable.status, installFailureExitCode: failedInstall.status,
            metadataRequests: requests.filter((item) => item.pathname === `/${packageName}`).length,
            successfulUpdateTarballRequests: requests.filter((item) => item.pathname === "/tarballs/daynight-1.0.1.tgz" && item.status === 200).length,
            previousSkillSha256: createHash("sha256").update(fixtureSkills.get("1.0.0")!).digest("hex"),
            updatedSkillSha256: createHash("sha256").update(fixtureSkills.get("1.0.1")!).digest("hex"),
            bundledSkillUpdated: true, failedUpdatePreservesInstalledSkill: true, installedPublicSkillsUpdated: true,
            publicSkillRefreshFailureExitCode: failedRefresh.status, currentRetryRepairsSkillsWithoutInstall: true, agentLaunchersExecuted: false },
        };
      };
    })();
    return preparation.catch((cause) => { failure = cause; throw cause; });
  };

  const exercise = async (signal: AbortSignal): Promise<void> => {
    const cancel = (): void => cancellation.abort(signal.reason);
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    behavior = (async () => {
      if (preparation === undefined) throw new Error("Update fixture preparation did not start.");
      const run = await preparation;
      cancellation.signal.throwIfAborted();
      return run();
    })();
    try { evidence = await behavior; }
    catch (cause) { failure = cause; throw cause; }
    finally { signal.removeEventListener("abort", cancel); }
  };

  const cleanup = async (): Promise<void> => {
    cancellation.abort(new Error("Installed update acceptance is stopping."));
    for (const result of await Promise.allSettled([preparation, behavior])) {
      if (result.status === "rejected" && failure === undefined) failure = result.reason;
    }
    const failures: unknown[] = [];
    for (const [child, closed] of children) { try { await terminate(child, closed); } catch (cause) { failures.push(cause); } }
    try {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => {
        if (error === undefined || "code" in error && error.code === "ERR_SERVER_NOT_RUNNING") resolve();
        else reject(error);
      }));
    } catch (cause) { failures.push(cause); }
    if (ownedDirectory !== undefined) { try { rmSync(ownedDirectory, { recursive: true, force: true }); } catch (cause) { failures.push(cause); } }
    if (children.size !== 0) failures.push(new Error("Update fixture processes did not close."));
    if (server.listening) failures.push(new Error("Update fixture registry did not close."));
    const removed = ownedDirectory === undefined || !existsSync(ownedDirectory);
    if (!removed) failures.push(new Error("Update fixture directory still exists after cleanup."));
    try {
      writeFileSync(evidenceFile, JSON.stringify({ ...evidence, success: evidence !== undefined && failure === undefined && failures.length === 0, cleanup: { directoryRemoved: removed, childrenExited: children.size === 0, serverClosed: !server.listening, errors: failures.length } }, null, 2));
    } catch (cause) { failures.push(cause); }
    if (failures.length !== 0) throw new AggregateError(failure === undefined ? failures : [failure, ...failures], "Installed update acceptance or cleanup failed.");
    if (failure !== undefined) throw failure;
  };
  return { prepare, exercise, cleanup };
};

const fixture = createUpdateFixture();
beforeAll(async () => { await fixture.prepare(); });
afterAll(async () => { await fixture.cleanup(); });
it("replaces its real npm global installation, refreshes existing agent skills and preserves configuration and review state", async ({ signal }) => {
  await fixture.exercise(signal);
}, 180_000);
