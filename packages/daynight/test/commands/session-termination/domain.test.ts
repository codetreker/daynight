import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { readTerminationPending, withTerminationDomain, withTerminationDomainCut, withTerminationPhysicalStop, type TerminationDomain } from "../../../src/commands/session-termination/domain.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
const fixture = async (): Promise<string> => {
  const parent = path.resolve(import.meta.dirname, "../../../../../.tmp/termination-domain-tests");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, "domain-"));
  directories.push(directory);
  return directory;
};

it("retains its identity and sequence across independent acquisitions", async () => {
  const directory = await fixture();
  let permit: TerminationDomain | undefined;
  const first = await withTerminationDomain(directory, async domain => { permit = domain; return { id: domain.domainId, sequence: domain.advance() }; });
  expect(first.sequence).toBe("1");
  expect(() => permit!.advance()).toThrow("no longer held");
  const second = await withTerminationDomain(directory, async domain => ({ id: domain.domainId, before: domain.sequence, after: domain.advance() }), { expectedDomainId: first.id });
  expect(second).toEqual({ id: first.id, before: "1", after: "2" });
  await expect(withTerminationDomain(directory, async () => undefined, { expectedDomainId: "00000000-0000-4000-8000-000000000001" })).rejects.toThrow("does not match");
});

it("orders concurrent metadata writes and releases after an error", async () => {
  const directory = await fixture();
  let resume!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { resume = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const first = withTerminationDomain(directory, async domain => { entered(); await held; return domain.advance(); });
  await started;
  let nextEntered = false;
  const second = withTerminationDomain(directory, async domain => { nextEntered = true; return domain.advance(); });
  const cancelled = new AbortController();
  const third = withTerminationDomain(directory, async domain => domain.advance(), { signal: cancelled.signal });
  cancelled.abort(new Error("cancelled while queued"));
  await expect(third).rejects.toThrow("cancelled while queued");
  await Promise.resolve();
  expect(nextEntered).toBe(false);
  resume();
  expect(await first).toBe("1");
  expect(await second).toBe("2");
  await expect(withTerminationDomain(directory, async () => { throw new Error("original failure"); })).rejects.toThrow("original failure");
  expect(await withTerminationDomain(directory, async domain => domain.advance())).toBe("3");
});

it("retains uncertain activation and refuses invalid or missing original state", async () => {
  const directory = await fixture();
  const id = await withTerminationDomain(directory, async domain => domain.domainId);
  const file = path.join(directory, "domain.json");
  const state = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  const activationId = "00000000-0000-4000-8000-000000000001";
  expect(await withTerminationDomainCut(directory, async domain => domain.prepare(activationId))).toBe("1");
  await expect(withTerminationDomain(directory, async () => undefined)).rejects.toThrow("prepared policy activation");
  await withTerminationDomainCut(directory, async domain => {
    expect(domain.prepared).toEqual({ activationId, sequence: "1" });
    expect(() => domain.settle("00000000-0000-4000-8000-000000000002")).toThrow("does not match");
    domain.settle(activationId);
  });
  expect(await withTerminationDomain(directory, async domain => domain.advance())).toBe("2");
  await writeFile(file, JSON.stringify({ ...state, sequence: "01" }));
  await expect(withTerminationDomain(directory, async () => undefined)).rejects.toThrow("state is invalid");
  await rm(file);
  await expect(withTerminationDomain(directory, async () => undefined, { expectedDomainId: id })).rejects.toThrow("original termination domain state is missing");
});

it("keeps a closure intent ahead of a cut across restart and permits physical stop evidence", async () => {
  const directory = await fixture();
  const key = "herdr/00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000002/00000000-0000-4000-8000-000000000003/00000000-0000-4000-8000-000000000004";
  const id = await withTerminationDomain(directory, async domain => { expect(domain.beginClosure(key)).toBe("1"); return domain.domainId; }, { pendingKey: key });
  expect(readTerminationPending(directory)).toEqual({ key, sequence: "1" });
  await expect(withTerminationDomainCut(directory, async () => undefined, { expectedDomainId: id })).rejects.toThrow("must be reconciled");
  await expect(withTerminationDomain(directory, async () => undefined, { expectedDomainId: id })).rejects.toThrow("must be reconciled");
  await withTerminationPhysicalStop(directory, async () => { await writeFile(path.join(directory, "physical-stop"), "confirmed"); }, { expectedDomainId: id });
  await withTerminationDomain(directory, async domain => { expect(domain.beginClosure(key)).toBe("1"); domain.finishClosure(key); }, { expectedDomainId: id, pendingKey: key });
  expect(readTerminationPending(directory)).toBeNull();
  expect(await withTerminationDomainCut(directory, async domain => domain.prepare("00000000-0000-4000-8000-000000000005"), { expectedDomainId: id })).toBe("2");
  await withTerminationPhysicalStop(directory, async () => { expect(await readFile(path.join(directory, "physical-stop"), "utf8")).toBe("confirmed"); }, { expectedDomainId: id });
});

it.each(["pendingClosure", "\\u0070endingClosure"])("rejects a duplicated domain key (%s)", async duplicate => {
  const directory = await fixture();
  await withTerminationDomain(directory, async () => undefined);
  const file = path.join(directory, "domain.json");
  const original = await readFile(file, "utf8");
  await writeFile(file, original.replace('"pendingClosure":null', `"${duplicate}":null,"pendingClosure":null`));
  await expect(withTerminationDomainCut(directory, async () => undefined)).rejects.toThrow();
});

it("rejects malformed UTF-8 in the domain state", async () => {
  const directory = await fixture();
  await withTerminationDomain(directory, async () => undefined);
  const file = path.join(directory, "domain.json");
  const original = await readFile(file);
  await writeFile(file, Buffer.concat([original, Buffer.from([0xff])]));
  await expect(withTerminationDomainCut(directory, async () => undefined)).rejects.toThrow();
});

it("excludes a second process until the original permit is released", async () => {
  const directory = await fixture();
  const moduleUrl = pathToFileURL(path.resolve(import.meta.dirname, "../../../dist/commands/session-termination/domain.js")).href;
  const script = `import { withTerminationDomain } from ${JSON.stringify(moduleUrl)};
    await withTerminationDomain(process.argv[1], async domain => {
      domain.advance(); process.send('locked');
      await new Promise(resolve => process.once('message', resolve));
    }); process.disconnect();`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script, directory], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  const exited = once(child, "exit");
  try {
    const [message] = await Promise.race([once(child, "message"), exited.then(() => { throw new Error("Domain lock owner exited before acquiring its permit."); })]);
    expect(message).toBe("locked");
    await expect(withTerminationDomain(directory, async domain => domain.advance(), { signal: AbortSignal.timeout(200) })).rejects.toThrow();
    child.send("release");
    const [code] = await exited;
    expect(code).toBe(0);
    expect(await withTerminationDomain(directory, async domain => domain.advance())).toBe("2");
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; }
  }
}, 10_000);
