import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { installCopilotReadAuthorityServer } from "./copilot-read-authority-server.js";
import type { CopilotAuthorityNative } from "./copilot-read-authority-check.js";

const execution = process.env.DAYNIGHT_COPILOT_AUTHORITY;
delete process.env.DAYNIGHT_COPILOT_AUTHORITY;
if (!process.connected || !execution || !/^[a-f0-9-]{36}$/.test(execution) || !process.argv[1]) process.exit(1);
const native = createRequire(import.meta.url)(join(dirname(process.argv[1]), "prebuilds", "darwin-arm64", "runtime.node")) as CopilotAuthorityNative;
installCopilotReadAuthorityServer(native, execution);
