import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

// A real disposable host owns the original SQLite connections and process handles.
// Its abrupt death leaves the Controller for the replacement host to reconcile.
const input = JSON.parse(await readFile(process.argv[2], "utf8"));
const moduleAt = name => import(pathToFileURL(path.join(input.dist, name)).href);
const { createOperation } = await moduleAt("api/operation.js");
const { resolveToolLaunch } = await moduleAt("platform/tool-executables.js");
const { createBotProcess } = await moduleAt("commands/worker/bots/process.js");
const { openLocalBotStores } = await moduleAt("commands/worker/bots/local-store.js");
const { openBotRecoveryStore } = await moduleAt("commands/worker/bots/recovery-store.js");
const { createBotReconciliation } = await moduleAt("commands/worker/bots/reconciliation.js");
const { createBotRecoveryApi } = await moduleAt("commands/worker/bots/recovery-api.js");
const { createBotSessionApi } = await moduleAt("commands/worker/bots/session-api.js");
const { resolveWorkerPaths } = await moduleAt("commands/worker/paths.js");
const { home, state, owner, bot, native, cwd, packageDirectory, requests } = input;
const paths = resolveWorkerPaths(home);
const local = openLocalBotStores({ stateDirectory: state, legacyDatabaseFile: paths.databaseFile, owner, onMigration: () => {} });
local.store.observe(owner, bot, Date.now());
const recovery = createBotReconciliation({ owner, store: openBotRecoveryStore({ stateDirectory: state, owner, assertLocked: local.assertLocked }),
  api: createBotRecoveryApi({ owner, serverToken: "fixture-parent-token" }), canSubmit: () => true });
const sessionApi = createBotSessionApi({ owner, serverToken: "fixture-parent-token", recovery });
const register = sessionApi.register;
sessionApi.register = async (record, signal) => {
  await new Promise((resolve, reject) => {
    process.once("message", message => message?.kind === "intent-received" ? resolve() : reject(new Error("Unexpected parent acknowledgement")));
    process.send({ kind: "intent", intent: record.intent });
  });
  return register(record, signal);
};
const manager = createBotProcess({ homeDirectory: home, packageDirectory, store: local.store, executions: local.executions, sessionApi,
  recoveryLimit: 3, canAdmitNewExecution: () => true,
  selectToolLaunch: async (_agent, signal) => {
    const operation = createOperation({ signal });
    try { return await resolveToolLaunch({ tool: "codex", context: "web", choice: { kind: "path", path: native }, environment: process.env, cwd }, operation); }
    finally { operation.dispose(); }
  },
  dependencies: { prepareEnvironment: async () => ({ environment: { ...process.env, DN_CONFIG_DIR: state,
    CODEX_HOME: path.join(home, "native-home"), CODEX_BOT_REQUEST_LOG: requests }, aliasDirectory: null, bindings: [], release: async () => {} }) },
});
await manager.advance(local.store.get(owner, bot.id), AbortSignal.timeout(45_000));
process.send({ kind: "ready", ticket: await manager.readTicket(local.store.get(owner, bot.id)) });
setInterval(() => {}, 1000);
