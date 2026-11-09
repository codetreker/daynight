import { createInterface } from "node:readline";
import { createWorkerReadOnlyChannel } from "../../dist/commands/worker/read-only/channel.js";
import { browseWorkerDirectory } from "../../dist/commands/worker/read-only/directory.js";

// The Go acceptance fixture sends the temporary credential over stdin only.
const lines = createInterface({ input: process.stdin });
const configuration = await new Promise((resolve, reject) => {
  lines.once("line", line => { try { resolve(JSON.parse(line)); } catch (error) { reject(error); } });
  lines.once("close", () => reject(new Error("Worker fixture configuration was not supplied.")));
});
const channel = createWorkerReadOnlyChannel({
  ...configuration,
  configurationSignature: () => "native-directory-acceptance",
  execute: (_operation, input, signal) => browseWorkerDirectory(input, { defaultCwd: configuration.defaultCwd, signal }),
  onError: message => process.stderr.write(`${message}\n`),
});
let announced = false;
const ready = setInterval(() => {
  if (!announced && channel.connected()) { announced = true; process.stdout.write("WORKER_READONLY_READY\n"); }
}, 25);
const close = () => { clearInterval(ready); channel.close(); lines.close(); };
lines.on("line", line => { if (line === "close") close(); });
lines.on("close", close);
process.once("SIGTERM", close);
process.once("SIGINT", close);
