import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { runCommand } from "./command.ts";
import { preparePinnedSource } from "./source.ts";

export const authRevision = "0978963813fcefd9d553f6cb9bcc319084c764b3";
const authRepository = "https://github.com/codetreker/uniauth.git";

export type Artifacts = {
  directory: string;
  cliEntry: string;
  sourceRevision: string;
  sourceFingerprint: string;
  authRevision: string;
  hashes: Record<string, string>;
};

const hashFile = async (filename: string): Promise<string> => createHash("sha256").update(await readFile(filename)).digest("hex");

const hashDirectory = async (directory: string): Promise<string> => {
  const hash = createHash("sha256");
  const files = (await readdir(directory, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name)).sort();
  for (const filename of files) hash.update(path.relative(directory, filename)).update("\0").update(await readFile(filename)).update("\0");
  return hash.digest("hex");
};

export const sourceFingerprint = async (repository: string, signal?: AbortSignal): Promise<string> => {
  const result = await runCommand("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: repository, signal, timeoutMs: 15_000, onOutput: () => {},
  });
  const relevant = /^(?:packages\/(?:daynight|daynight-web|daynight-server)\/|package\.json$|pnpm-lock\.yaml$|pnpm-workspace\.yaml$|patches\/)/;
  const names = result.stdout.split("\0").filter((name) => name && relevant.test(name)).sort();
  const hash = createHash("sha256");
  for (const name of names) {
    hash.update(name).update("\0");
    try { hash.update(await readFile(path.join(repository, name))); }
    catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      hash.update("<deleted>");
    }
    hash.update("\0");
  }
  return hash.digest("hex");
};

export const buildArtifacts = async (options: {
  repository: string;
  runDirectory: string;
  authSource?: string;
  signal?: AbortSignal;
}): Promise<Artifacts> => {
  const { repository, runDirectory, signal } = options;
  const directory = path.join(runDirectory, "artifacts");
  const cache = path.join(repository, ".tmp", "product-e2e-cache");
  await mkdir(directory, { recursive: true });
  await mkdir(path.join(cache, "tmp"), { recursive: true });
  const environment = {
    ...process.env,
    GOCACHE: path.join(cache, "go-build"),
    GOMODCACHE: path.join(cache, "go-mod"),
    GOPATH: path.join(cache, "go"),
    GOENV: "off",
    GOTOOLCHAIN: "go1.27.2",
    CGO_ENABLED: "0",
    TMPDIR: path.join(cache, "tmp"),
    GIT_TERMINAL_PROMPT: "0",
  };
  const run = async (command: string, args: string[], cwd = repository, timeoutMs = 1_200_000) => {
    console.log(`Build: ${command} ${args.join(" ")}`);
    return await runCommand(command, args, { cwd, env: environment, signal, timeoutMs });
  };

  const before = await sourceFingerprint(repository, signal);
  const revision = await runCommand("git", ["rev-parse", "HEAD"], { cwd: repository, signal, timeoutMs: 15_000, onOutput: () => {} });
  await run("pnpm", ["--filter", "@codetreker/daynight-e2e", "build"]);
  await run("pnpm", ["--filter", "@codetreker/daynight", "build"]);
  await run("pnpm", ["web:build"]);
  await run("go", ["build", "-trimpath", "-o", path.join(directory, "daynight-server"), "./cmd/daynight-server"], path.join(repository, "packages/daynight-server"));
  const cliDirectory = path.join(directory, "cli");
  await mkdir(cliDirectory);
  const cliSource = path.join(repository, "packages/daynight");
  await cp(path.join(cliSource, "dist"), path.join(cliDirectory, "dist"), { recursive: true });
  await cp(path.join(cliSource, "package.json"), path.join(cliDirectory, "package.json"));
  await cp(path.join(cliSource, "config.example.yml"), path.join(cliDirectory, "config.example.yml"));
  await symlink(path.join(cliSource, "node_modules"), path.join(cliDirectory, "node_modules"), "dir");
  await cp(path.join(repository, "packages/e2e_tests/dist/src"), path.join(directory, "runtime/src"), { recursive: true });
  await writeFile(path.join(directory, "runtime/package.json"), '{"type":"module"}\n');

  const checkout = await preparePinnedSource({
    checkout: path.join(cache, "uniauth-source"), revision: authRevision, upstream: authRepository,
    localSource: options.authSource, signal, environment,
  });
  const authConsole = path.join(checkout, "web/console");
  await run("pnpm", ["--config.manage-package-manager-versions=false", "--config.package-manager-strict=false", "--ignore-workspace", "install", "--frozen-lockfile", "--store-dir", path.join(cache, "pnpm-store")], authConsole);
  await run(path.join(authConsole, "node_modules/.bin/tsc"), ["--noEmit"], authConsole);
  await run(path.join(authConsole, "node_modules/.bin/vite"), ["build"], authConsole);
  await run("go", ["build", "-trimpath", "-o", path.join(directory, "uniauth"), "./cmd/uniauth"], checkout);
  await run("git", ["diff", "--exit-code", "--stat", "HEAD", "--"], checkout, 15_000);
  await run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "1", "-subj", "/CN=Product E2E local provider", "-addext", "subjectAltName=DNS:github.com,DNS:api.github.com", "-addext", "basicConstraints=critical,CA:TRUE", "-keyout", path.join(directory, "provider-key.pem"), "-out", path.join(directory, "provider-ca.pem")], repository, 30_000);
  const after = await sourceFingerprint(repository, signal);
  if (before !== after) throw new Error("Product sources changed while the E2E artifacts were built.");
  return {
    directory,
    cliEntry: path.join(cliDirectory, "dist/main.js"),
    sourceRevision: revision.stdout.trim(),
    sourceFingerprint: after,
    authRevision,
    hashes: {
      server: await hashFile(path.join(directory, "daynight-server")),
      cli: await hashDirectory(path.join(cliDirectory, "dist")),
      web: await hashDirectory(path.join(repository, "packages/daynight-web/dist")),
      auth: await hashFile(path.join(directory, "uniauth")),
    },
  };
};
