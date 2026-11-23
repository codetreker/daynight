import { once } from "node:events";
import { setImmediate } from "node:timers/promises";

const frame = Buffer.from(JSON.stringify({ method: "item/commandExecution/outputDelta", params: { itemId: "tool", delta: "0123456789" } }) + "\n");
let stop = false;
let credits = 64, continueOutput;
const write = async bytes => { if (!process.stdout.write(bytes)) await once(process.stdout, "drain"); };
process.on("message", async message => {
  if (message.kind === "stop-output") { stop = true; continueOutput?.(); return; }
  if (message.kind === "continue") { credits += 32; continueOutput?.(); return; }
  if (message.kind === "close") { process.disconnect(); process.stdin.destroy(); return; }
  if (message.kind !== "start") throw new Error("Unexpected producer command.");
  const startedAt = performance.timeOrigin + performance.now();
  let produced = 0;
  if (message.mode === "single") { await write(Buffer.from(frame.toString().repeat(400))); produced = 400; }
  else {
    do {
      if (message.sustained) {
        while (!stop && credits === 0) await new Promise(resolve => { continueOutput = resolve; });
        if (stop) break;
        credits--;
      }
      await write(frame); produced++;
      if (message.sustained) await setImmediate();
    } while (message.sustained ? !stop : produced < 400);
  }
  await write(Buffer.from(JSON.stringify({ method: "fixture/finished", params: { produced, startedAt, finishedAt: performance.timeOrigin + performance.now(), frameBytes: frame.length } }) + "\n"));
  process.send({ kind: "written", produced });
});
process.send({ kind: "ready", frameBytes: frame.length });
