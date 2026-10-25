import { hostname } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { createOperation, OperationError } from "../../api/operation.js";
import type { OperationLimits } from "../../api/operation.js";
import { withCliCancellation } from "../../cli/cancellation.js";
import type { CliContext } from "../../cli/context.js";
import { parseCommand, renderCommandHelp } from "../../cli/schema.js";
import { resolveConfigurationPaths } from "../../config/paths.js";
import { loadServerConfiguration } from "../../config/server.js";
import { openBrowser } from "./browser.js";
import { createDeviceClient, DeviceRequestTimeoutError } from "./client.js";
import { updateCredential } from "./credentials.js";
import { loginDefinition, logoutDefinition } from "./definition.js";

export type AuthDependencies = {
  fetch?: typeof globalThis.fetch;
  openBrowser?: typeof openBrowser;
  hostname?: typeof hostname;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  limits?: Partial<OperationLimits>;
  signal?: AbortSignal;
};

export const runLoginCommand = async (args: readonly string[], context: CliContext, dependencies: AuthDependencies = {}): Promise<void> => {
  const command = parseCommand(loginDefinition, args, ["daynight", "login"], "daynight login --help");
  if (command.kind !== "run") { context.stdout(renderCommandHelp(command.command, command.path)); return; }
  await withCliCancellation(context, async (signal) => {
    const operation = createOperation({ signal, limits: { totalMs: 600_000, ...dependencies.limits } });
    let authorizationExpiry: AbortSignal | undefined;
    try {
      const paths = resolveConfigurationPaths(context.homeDirectory());
      const observed = await loadServerConfiguration(paths, operation.signal);
      const deviceName = (dependencies.hostname ?? hostname)();
      const client = createDeviceClient(observed.serverUrl, operation, dependencies.fetch);
      const authorization = await client.begin();
      authorizationExpiry = AbortSignal.timeout(Math.min(600_000, authorization.expiresIn * 1000));
      const authorizationSignal = AbortSignal.any([operation.signal, authorizationExpiry]);
      context.stderr(`Sign in to ${observed.serverUrl}\nOpen ${authorization.verificationUri}\nEnter code: ${authorization.userCode}\nThis code expires in ${authorization.expiresIn} seconds.\n`);
      if (!command.options.has("--no-browser")) {
        try { await (dependencies.openBrowser ?? openBrowser)(authorization.verificationUriComplete ?? authorization.verificationUri, authorizationSignal); }
        catch {
          authorizationSignal.throwIfAborted();
          context.stderr("Could not open a browser. Open the displayed link on any device.\n");
        }
      }
      let interval = authorization.interval * 1000;
      for (;;) {
        await (dependencies.wait ?? ((milliseconds, currentSignal) => delay(milliseconds, undefined, { signal: currentSignal })))(interval, authorizationSignal);
        authorizationSignal.throwIfAborted();
        let result;
        try { result = await client.poll(authorization.deviceCode, deviceName, authorizationSignal); }
        catch (cause) {
          authorizationSignal.throwIfAborted();
          if (!(cause instanceof DeviceRequestTimeoutError)) throw cause;
          interval = Math.min(600_000, interval * 2);
          context.stderr("Authorization request timed out; waiting longer before checking again.\n");
          continue;
        }
        authorizationSignal.throwIfAborted();
        if ("token" in result) {
          await updateCredential(paths, observed, result.token, authorizationSignal);
          context.stderr(`Logged in to ${observed.serverUrl}.\n`);
          return;
        }
        if (result.slowDown) interval = Math.min(600_000, interval + 5000);
      }
    } catch (cause) {
      if (authorizationExpiry?.aborted === true) throw new Error("Device authorization expired. Run daynight login again.", { cause });
      if (operation.signal.reason instanceof OperationError && operation.signal.reason.kind === "deadline") throw new Error("Device login deadline exceeded. Run daynight login again.", { cause });
      throw cause;
    } finally { operation.dispose(); }
  }, dependencies.signal);
};

export const runLogoutCommand = async (args: readonly string[], context: CliContext, dependencies: AuthDependencies = {}): Promise<void> => {
  const command = parseCommand(logoutDefinition, args, ["daynight", "logout"], "daynight logout --help");
  if (command.kind !== "run") { context.stdout(renderCommandHelp(command.command, command.path)); return; }
  await withCliCancellation(context, async (signal) => {
    const operation = createOperation({ signal, ...(dependencies.limits === undefined ? {} : { limits: dependencies.limits }) });
    try {
      const paths = resolveConfigurationPaths(context.homeDirectory());
      const observed = await loadServerConfiguration(paths, operation.signal);
      if (observed.serverToken === undefined) { context.stderr(`Already logged out of ${observed.serverUrl}.\n`); return; }
      const client = createDeviceClient(observed.serverUrl, operation, dependencies.fetch);
      await client.logout(observed.serverToken);
      await updateCredential(paths, observed, undefined, operation.signal);
      context.stderr(`Logged out of ${observed.serverUrl}.\n`);
    } finally { operation.dispose(); }
  }, dependencies.signal);
};
