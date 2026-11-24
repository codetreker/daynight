import type { ControllerLaunchTicket } from "../../src/commands/controller/launch-ticket.js";

export const controllerRuntimeTicket = (provider: "codex" | "claude" | "copilot" = "codex", overrides: Record<string, unknown> = {}): ControllerLaunchTicket => {
  const test = overrides.testExecutionId !== undefined;
  return {
    schemaVersion: 1, provider, cwd: process.cwd(),
    executionId: "00000000-0000-4000-8000-000000000001", executionGeneration: "2",
    sessionId: "00000000-0000-4000-8000-000000000002", launchId: "00000000-0000-4000-8000-000000000004",
    controllerId: "00000000-0000-4000-8000-000000000005", controllerInstanceId: "00000000-0000-4000-8000-000000000006",
    serverOrigin: "https://daynight.example",
    ...(test ? { ownerUserId: "00000000-0000-4000-8000-000000000007", initialInput: "none" } : {
      claimId: "00000000-0000-4000-8000-000000000003", userId: "00000000-0000-4000-8000-000000000007",
      projectId: "00000000-0000-4000-8000-000000000008", taskId: "00000000-0000-4000-8000-000000000009",
      workerId: "00000000-0000-4000-8000-000000000010", worktreeId: "00000000-0000-4000-8000-000000000011",
    }),
    nativeHome: "/private/native", ipcEndpoint: "/private/ipc", credentialFile: "/private/grant.json", ipcSecret: "a".repeat(64),
    initialOperationId: "00000000-0000-4000-8000-000000000012", initialPrompt: test ? "" : "initial prompt",
    resumeNativeSessionId: null, createdAt: "2026-01-01T00:00:00Z",
    ...Object.fromEntries(Object.entries(overrides).filter(([, value]) => value !== undefined)),
    configuration: { agent: provider, agentControlMode: "web", recoveryLimit: 2, model: null, args: [], ...(overrides.configuration as object | undefined) },
  } as ControllerLaunchTicket;
};
