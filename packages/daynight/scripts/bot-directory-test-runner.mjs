import { appendFileSync } from "node:fs";
import path from "node:path";
import { TestRunner } from "vitest";
import { requestCapture } from "./bot-directory-capture-gate.mjs";

export default class BotDirectoryTestRunner extends TestRunner {
  started = false;
  ended = false;
  async observe(kind, test) {
    try {
      await requestCapture(process.env.BOT_DIRECTORY_CAPTURE_GATE, kind, { moduleId: test.file.filepath, pid: process.pid, name: test.name, at: new Date().toISOString() });
    } catch (error) {
      // Observer failure is separate from the original test result, especially
      // after teardown has already produced the rm failure being investigated.
      try { appendFileSync(path.join(process.env.BOT_DIRECTORY_CAPTURE_GATE, "worker-errors.jsonl"), `${JSON.stringify({ kind, name: error.name, message: error.message })}\n`); }
      catch (recordError) { process.stderr.write(`Bot directory observer failed: ${error.message}; evidence write failed: ${recordError.message}\n`); }
    }
  }
  async onBeforeRunTask(test) {
    await super.onBeforeRunTask(test);
    if (path.normalize(test.file.filepath) !== path.normalize(process.env.BOT_DIRECTORY_CAPTURE_MODULE) || !["run", "queued"].includes(test.mode) || this.started) return;
    this.started = true;
    // The core awaits this hook before the test clock and fixture begin.
    await this.observe("start", test);
  }
  async onAfterRunTask(test) {
    await super.onAfterRunTask(test);
    if (path.normalize(test.file.filepath) !== path.normalize(process.env.BOT_DIRECTORY_CAPTURE_MODULE) || !test.name.includes("unknown parent observation=true, then observes the same writer after browser disconnect") || this.ended) return;
    this.ended = true;
    await this.observe("end", test);
  }
}
