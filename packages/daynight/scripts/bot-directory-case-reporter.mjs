import { appendFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export default class BotDirectoryCaseReporter {
  constructor() {
    const repository = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
    this.filename = path.resolve(process.env.BOT_DIRECTORY_CASE_REPORT);
    if (!this.filename.startsWith(path.join(repository, ".tmp") + path.sep)) throw new Error("Diagnostic case receipts must stay in the checkout's .tmp.");
    const ready = process.env.BOT_DIRECTORY_CASE_READY_REPORT;
    if (ready !== undefined) {
      this.readyFilename = path.resolve(ready);
      if (!this.readyFilename.startsWith(path.join(repository, ".tmp") + path.sep)) throw new Error("Diagnostic ready receipts must stay in the checkout's .tmp.");
    }
    const modules = process.env.BOT_DIRECTORY_CASE_MODULES;
    this.modules = modules === undefined ? null : new Set(JSON.parse(modules).map(value => path.normalize(value)));
    this.readyWritten = false;
  }
  onTestCaseReady(test) {
    if (this.modules !== null && !this.modules.has(path.normalize(test.module.moduleId))) return;
    if (this.readyFilename === undefined || this.readyWritten) return;
    const temporary = `${this.readyFilename}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ kind: "ready", moduleId: test.module.moduleId, name: test.fullName, observedAt: new Date().toISOString() })}\n`, { flag: "wx" });
    renameSync(temporary, this.readyFilename);
    this.readyWritten = true;
  }
  onTestCaseResult(test) {
    if (this.modules !== null && !this.modules.has(path.normalize(test.module.moduleId))) return;
    const result = test.result();
    if (result.state !== "passed" && result.state !== "failed") return;
    const diagnostic = test.diagnostic();
    if (diagnostic === undefined || !Number.isFinite(diagnostic.startTime) || !Number.isFinite(diagnostic.duration)) throw new Error("An executed diagnostic case has no public timing receipt.");
    appendFileSync(this.filename, `${JSON.stringify({ kind: "result", moduleId: test.module.moduleId, name: test.fullName, status: result.state,
      startTime: new Date(diagnostic.startTime).toISOString(), endTime: new Date(diagnostic.startTime + diagnostic.duration).toISOString() })}\n`);
  }
}
