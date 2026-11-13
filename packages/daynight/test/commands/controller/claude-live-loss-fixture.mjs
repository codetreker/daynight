import { connect } from "node:net";

if (!process.argv.includes("--version")) {
  const control = connect(Number(process.env.DAYNIGHT_TEST_CLAUDE_CONTROL_PORT), "127.0.0.1");
  control.on("connect", () => control.write(process.env.DAYNIGHT_TEST_CLAUDE_CONTROL_TOKEN));
  control.on("data", () => process.exit(0));
}
await import("./fixtures/claude-live-native.mjs");
