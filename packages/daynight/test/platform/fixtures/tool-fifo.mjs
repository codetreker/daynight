import assert from "node:assert/strict";
import path from "node:path";
import fs, { stat } from "node:fs/promises";
import { renameSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { createOperation } from "../../../dist/api/operation.js";
import { resolveToolLaunch } from "../../../dist/platform/tool-executables.js";

const root = process.argv[2];
const operations = Array.from({ length: 4 }, () => createOperation({ limits: { totalMs: 1000 } }));
const healthyFilesystem = async () => {
  let timer;
  try {
    const healthy = await Promise.race([
      stat(path.join(root, "healthy")),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("FIFO resolution exhausted filesystem workers.")), 1000); }),
    ]);
    assert.equal(healthy.isFile(), true);
  } finally { clearTimeout(timer); }
};
const input = file => ({ tool: "codex", context: "web", choice: { kind: "path", path: file }, cwd: root, environment: process.env });
const rejectReplacement = async (name, replacement, openOrdinal) => {
  const file = path.join(root, name), originalOpen = fs.open;
  assert.equal((await stat(file)).isFile(), true);
  let opens = 0, replaced = false;
  // Change the real path immediately before the selected kernel open. Forward
  // its flags unchanged so a blocking-open regression cannot pass this case.
  fs.open = (selected, ...args) => {
    if (selected === file && ++opens === openOrdinal) {
      renameSync(path.join(root, replacement), file);
      replaced = true;
    }
    return originalOpen(selected, ...args);
  };
  syncBuiltinESMExports();
  const operation = createOperation({ limits: { totalMs: 1000 } });
  try {
    await assert.rejects(resolveToolLaunch(input(file), operation), { code: "not_executable" });
    assert.equal(replaced, true);
    await healthyFilesystem();
  } finally {
    operation.dispose(); fs.open = originalOpen; syncBuiltinESMExports();
  }
};
try {
  const codes = await Promise.all(operations.map((operation, i) => resolveToolLaunch(input(path.join(root, `fifo-${i}`)), operation)
    .then(() => "unexpected_success", error => error.code)));
  await healthyFilesystem();
  assert.deepEqual(codes, Array(4).fill("not_executable"));
  await rejectReplacement("race-entry", "entry-replacement", 1);
  await rejectReplacement("race-artifact", "artifact-replacement", 2);
  process.stdout.write(JSON.stringify({ rejected: codes.length, replacementsRejected: 2, filesystemResponsive: true }));
} finally { operations.forEach(operation => operation.dispose()); }
