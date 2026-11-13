import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createOperation } from "../../../api/operation.js";
import { toolCommand, verifyToolLaunch } from "../../../platform/tool-executables.js";
import { launchArgvDigest, mappingFiles, publishOwnedJson, readToolManifest, toolManifestEnvironment } from "./tool-launch-protocol.js";
import type { HerdrToolLaunchIntent } from "./tool-launch-protocol.js";
import { establishCurrentHerdrHelperJob } from "./tool-launch-windows-job.js";

const decode = (value: string): string => {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value) || value.length > 2 * 1024 * 1024) throw new TypeError("Invalid encoded Herdr tool launch data.");
  return Buffer.from(value, "base64").toString("utf8");
};
const input = (argv: string[]): { manifestPath: string; agent: string; args: string[] } => {
  let manifestPath: string, agent: string, args: unknown;
  if (argv[0] === "--encoded-manifest") {
    if (argv.length !== 5 || argv[3] !== "--encoded-args") throw new TypeError("Invalid encoded Herdr tool launch arguments.");
    manifestPath = decode(argv[1]!); agent = argv[2]!; args = JSON.parse(decode(argv[4]!));
  } else {
    if (argv.length < 3 || argv[2] !== "--") throw new TypeError("Invalid Herdr tool launch arguments.");
    manifestPath = argv[0]!; agent = argv[1]!; args = argv.slice(3);
  }
  if (!Array.isArray(args) || args.some(arg => typeof arg !== "string" || arg.includes("\0")) || Buffer.byteLength(JSON.stringify(args)) > 1024 * 1024) throw new TypeError("Herdr native arguments must be a bounded string array.");
  return { manifestPath, agent, args: args as string[] };
};

const operation = createOperation({ limits: { totalMs: 30_000 } });
try {
  const parsed = input(process.argv.slice(2)), manifest = await readToolManifest(parsed.manifestPath);
  if (parsed.agent !== manifest.launch.tool || path.normalize(process.execPath) !== path.normalize(manifest.nodeExecutable) || path.normalize(fileURLToPath(import.meta.url)) !== path.normalize(manifest.childEntry) || manifest.platform !== process.platform) throw new Error("The Herdr tool helper differs from its owned manifest.");
  await verifyToolLaunch(manifest.launch, operation);
  const command = toolCommand(manifest.launch, parsed.args), files = mappingFiles(parsed.manifestPath);
  const intent: HerdrToolLaunchIntent = { schemaVersion: 1, owner: manifest.owner, nonce: manifest.nonce, selectionKey: manifest.launch.selectionKey,
    logicalArgvDigest: launchArgvDigest(parsed.agent, parsed.args), file: command.file, prefixArgs: [...manifest.launch.command.prefixArgs], helperPid: process.pid };
  if (process.platform === "win32") await establishCurrentHerdrHelperJob(parsed.manifestPath, manifest, operation);
  await publishOwnedJson(files.intent, intent);
  operation.check();
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !["PATH", toolManifestEnvironment, "DAYNIGHT_HERDR_SHELL_NONCE"].includes(name.toUpperCase())));
  if (manifest.nativePath !== null) environment.PATH = manifest.nativePath;
  const child = spawn(command.file, command.args, { env: environment, stdio: "inherit", shell: false });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  const handlers = signals.map(signal => { const handler = () => { if (child.exitCode === null && child.signalCode === null) child.kill(signal); }; process.on(signal, handler); return handler; });
  try {
    await once(child, "spawn");
    if (child.pid === undefined) throw new Error("The Herdr native tool did not report its original process identifier.");
    await publishOwnedJson(files.receipt, { ...intent, childPid: child.pid });
    operation.dispose();
    const outcome = await closed;
    process.exitCode = outcome.code ?? 1;
    if (outcome.signal !== null && process.platform !== "win32") {
      signals.forEach((signal, index) => process.removeListener(signal, handlers[index]!));
      process.kill(process.pid, outcome.signal);
    }
  } catch (cause) {
    // A missing receipt never authorizes replay. Keep the helper alive until its
    // original child closes so lifecycle cleanup can still prove the full chain.
    process.stderr.write("The original Herdr native launch could not publish a confirmed receipt.\n");
    await closed;
    throw cause;
  } finally { signals.forEach((signal, index) => process.removeListener(signal, handlers[index]!)); }
} catch (cause) {
  process.stderr.write(cause instanceof Error ? `${cause.message}\n` : "The Herdr tool launch could not be confirmed.\n");
  process.exitCode = 1;
} finally { operation.dispose(); }
