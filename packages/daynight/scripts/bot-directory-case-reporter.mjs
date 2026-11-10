import { appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export default class BotDirectoryCaseReporter {
  constructor() {
    const repository = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
    this.filename = path.resolve(process.env.BOT_DIRECTORY_CASE_REPORT);
    if (!this.filename.startsWith(path.join(repository, ".tmp") + path.sep)) throw new Error("Diagnostic case receipts must stay in the checkout's .tmp.");
  }
  onTestCaseResult(test) {
    const result = test.result();
    if (result.state !== "passed" && result.state !== "failed") return;
    const diagnostic = test.diagnostic();
    if (diagnostic === undefined || !Number.isFinite(diagnostic.startTime) || !Number.isFinite(diagnostic.duration)) throw new Error("An executed diagnostic case has no public timing receipt.");
    appendFileSync(this.filename, `${JSON.stringify({ name: test.fullName, status: result.state,
      startTime: new Date(diagnostic.startTime).toISOString(), endTime: new Date(diagnostic.startTime + diagnostic.duration).toISOString() })}\n`);
  }
}
