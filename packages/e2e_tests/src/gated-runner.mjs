import { spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { captureProcessEvidence, inspectProcessEvidence } from "./process-evidence.ts";
import { readGateReceipt, writeGateReceipt } from "./gated-record.ts";

const [runDirectory, gateId, command, ...args] = process.argv.slice(2);
let child, starting = false, closing = false, settled = false;
const waitForGroup = async () => {
  // Keep the proven leader until descendants exit so recovery can attribute the group.
  for (;;) {
    let active = false;
    for (const entry of await readdir("/proc")) {
      if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
      try {
        const stat = await readFile(`/proc/${entry}/stat`, "utf8"), fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        if (Number(fields[2]) === process.pid && !["Z", "X"].includes(fields[0])) { active = true; break; }
      } catch (error) { if (error?.code !== "ENOENT" && error?.code !== "ESRCH") throw error; }
    }
    if (!active) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
};
const finish = () => { if (settled) return; closing = true; if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGINT"); else process.exitCode = 1; };
process.on("SIGINT", finish); process.on("SIGTERM", finish);
process.stdin.on("end", finish); process.stdin.on("error", finish);
let input = "";
process.stdin.on("data", async chunk => {
  input += String(chunk);
  if (starting || input.length > 3 || !"GO\n".startsWith(input)) { finish(); return; }
  if (input !== "GO\n") return;
  starting = true;
  try {
    const receipt = await readGateReceipt(runDirectory, gateId);
    if (closing || receipt.state !== "released" || receipt.leader.pid !== process.pid || await inspectProcessEvidence(receipt.leader) !== "running") throw new Error("Gate authorization is unavailable.");
    if (closing) throw new Error("Gate authorization was withdrawn.");
    child = spawn(process.execPath, [path.join(import.meta.dirname, "gated-target.mjs"), command, ...args], { stdio: ["pipe", "inherit", "inherit", "ipc"], env: process.env, cwd: process.cwd() });
    child.on("message", message => {
      if (process.connected) process.send(message);
    });
    child.stdin.on("error", finish);
    child.once("error", () => { settled = true; process.exitCode = 1; process.stdin.destroy(); });
    child.once("exit", code => { settled = true; process.exitCode = code ?? 1; process.stdin.destroy(); void waitForGroup().catch(() => { process.exitCode = 1; }); });
    try {
      const proof = await captureProcessEvidence(child.pid);
      if (proof.group !== receipt.leader.group) throw new Error("Gate child group conflicts.");
      await writeGateReceipt(runDirectory, { ...receipt, child: proof });
      if (closing) throw new Error("Gate authorization was withdrawn.");
      child.stdin.write("GO\n");
    } catch { if (child.exitCode === null && child.signalCode === null) child.kill("SIGINT"); process.exitCode = 1; }
  } catch { process.exitCode = 1; process.stdin.destroy(); }
});
process.stdout.write("DAYNIGHT_GATE_READY\n");
