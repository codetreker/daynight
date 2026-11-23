import { spawn } from "node:child_process";
const [command, ...args] = process.argv.slice(2);
let input = "", child, starting = false, closing = false;
const finish = () => { closing = true; if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGINT"); else process.exitCode = 1; };
process.on("SIGINT", finish); process.on("SIGTERM", finish);
process.stdin.on("end", finish); process.stdin.on("error", finish);
process.stdin.on("data", chunk => {
  input += String(chunk);
  if (starting || input.length > 3 || !"GO\n".startsWith(input)) { finish(); return; }
  if (input !== "GO\n") return;
  starting = true;
  if (closing) return;
  child = spawn(command, args, { stdio: ["ignore", "inherit", "inherit"], env: process.env, cwd: process.cwd() });
  child.once("error", () => { process.exitCode = 1; process.stdin.destroy(); if (process.connected) process.disconnect(); });
  child.once("exit", (code, signal) => {
    process.exitCode = code ?? 1; process.stdin.destroy();
    if (process.connected) process.send({ kind: "target-exit", code, signal }, () => process.disconnect());
  });
});
