import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
if (process.argv.includes("--version")) { process.stdout.write("2.1.247 (controlled fixture)\n"); process.exit(0); }

createInterface({ input: process.stdin }).on("line", line => {
  const request = JSON.parse(line);
  appendFileSync(process.env.DAYNIGHT_TEST_STARTUP_LOG, `${request.type}:${request.request?.subtype ?? ""}\n`);
  if (request.type !== "control_request" || request.request.subtype !== "initialize") throw new Error("Unexpected fixture request.");
  if (process.env.DAYNIGHT_TEST_STARTUP_MODE === "reject") {
    process.stdout.write(`${JSON.stringify({ type: "control_response", response: { subtype: "error", request_id: request.request_id, error: "Fixture initialization rejected" } })}\n`);
  } else if (process.env.DAYNIGHT_TEST_STARTUP_MODE === "disconnect") process.exit(1);
  else if (process.env.DAYNIGHT_TEST_STARTUP_MODE !== "timeout") throw new Error("Unknown fixture mode.");
});
