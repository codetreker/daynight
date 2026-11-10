import { createHash } from "node:crypto";
import type { WindowsFile } from "./local-source-windows.js";
import type { LocalImageCheckpoint, LocalImageSourceProof } from "./local-source-proof.js";

const { openWindowsImageRoot, windowsImageIdentity }: typeof import("./local-source-windows.js") = await import(new URL(`./local-source-windows.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`, import.meta.url).href);
const { parseLocalImageCheckpoint }: typeof import("./local-source-proof.js") = await import(new URL(`./local-source-proof.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`, import.meta.url).href);

let root: ReturnType<typeof openWindowsImageRoot> | undefined, active = false, resume: (() => void) | undefined;
const post = (message: object): void => { if (process.connected) process.send!(message); };
const checkpoint = (stage: LocalImageCheckpoint["stage"], proof: LocalImageSourceProof) => {
  const checked = parseLocalImageCheckpoint({ stage, proof });
  return new Promise<void>(resolve => { resume = resolve; post({ type: "checkpoint", ...checked }); });
};
const fail = (code: string): never => { throw Object.assign(new Error("Local image source is unavailable."), { code }); };
const copy = async (locator: string, value: string, outputPath: string) => {
  const held: WindowsFile[] = [], current = root!;
  try {
    const initial: LocalImageSourceProof = { requested: { locator, path: value }, root: current.proof(), traversal: [], opened: null };
    await checkpoint("initial", initial); current.verifyRoot();
    const source = current.source(value); held.push(...source.held);
    if (source.file.size === 0n) fail("source_unavailable");
    if (source.file.size > 10_485_760n) fail("source_too_large");
    const proof: LocalImageSourceProof = { ...initial, traversal: source.traversal, opened: windowsImageIdentity(source.file) };
    const output = current.output(outputPath); held.push(...output.held);
    if (source.file.id === output.file.id) fail("source_forbidden");
    await checkpoint("opened", proof);
    const bytes = Buffer.alloc(524288), hash = createHash("sha256"); let total = 0;
    for (;;) {
      const count = current.read(source.file, bytes, Math.min(bytes.length, 10_485_761 - total));
      if (!count) break;
      if (total + count > 10_485_760) fail("source_too_large");
      await checkpoint("block", proof); current.verifyRoot();
      if (current.inspect(source.file).snapshot !== source.file.snapshot) fail("source_changed");
      current.write(output.file, bytes.subarray(0, count)); hash.update(bytes.subarray(0, count)); total += count;
    }
    if (BigInt(total) !== source.file.size || current.inspect(source.file).snapshot !== source.file.snapshot) fail("source_changed");
    await checkpoint("final", proof); current.verifyRoot();
    const final = current.inspect(output.file);
    if (current.inspect(source.file).snapshot !== source.file.snapshot || final.id !== output.file.id || final.size !== BigInt(total) || final.links !== 1) fail("source_changed");
    current.flush(output.file); return { byteLength: total, sha256: hash.digest("hex") };
  } finally { current.closeFiles(held); }
};
process.on("message", (message: { type: string; cwd?: string; locator?: string; path?: string; outputPath?: string; expectedRoot?: { dev: string; ino: string } }) => {
  if (message.type === "continue") { const next = resume; resume = undefined; next?.(); return; }
  if (message.type === "init" && !root) {
    try { root = openWindowsImageRoot(message.cwd!, message.expectedRoot); post({ type: "ready" }); }
    catch (error) { post({ type: "error", code: (error as { code?: string }).code ?? "context_unavailable" }); process.disconnect(); }
  } else if (message.type === "copy" && root && !active) {
    active = true;
    void copy(message.locator!, message.path!, message.outputPath!).then(result => post({ type: "result", ...result }), error => {
      post({ type: "error", code: (error as { code?: string }).code ?? "source_unavailable" });
    }).finally(() => { active = false; });
  }
});
process.on("disconnect", () => { root?.close(); process.exit(0); });
