import { describe, expect, it } from "vitest";
import { runHerdrToolPlatform } from "./herdr-tool-platform.fixtures.js";

// Dedicated platform CI selects this explicitly and provides pinned official assets.
describe.skipIf(process.env.DAYNIGHT_HERDR_PLATFORM_TEST !== "1")("real Herdr and official native tool mapping", () => {
  it.each(["codex", "copilot"] as const)("preserves %s process ownership, terminal and official Session identity", async agent => {
    const evidence = await runHerdrToolPlatform(agent);
    const context = JSON.stringify({ evidenceFile: evidence.evidenceFile, error: evidence.error, cleanup: evidence.cleanup });
    expect(evidence.error, context).toBeUndefined();
    expect(evidence.observation, context).toMatchObject({ kind: agent, interactiveReady: true, launchPending: false });
    expect(evidence.receipt, context).toMatchObject({ file: evidence.launch.command.file, prefixArgs: evidence.launch.command.prefixArgs });
    expect(evidence.receipt.helperPid).not.toBe(evidence.receipt.childPid);
    const last = evidence.observations.at(-1);
    expect(last.pane.workspace_id).toBe(evidence.observation.binding.workspaceId);
    expect(last.pane.terminal_id).toBe(evidence.observation.binding.terminalId);
    expect(last.process.process_info.foreground_processes.some((process: { pid: number }) => process.pid === evidence.receipt.childPid)).toBe(true);
    if (process.platform === "darwin") expect(evidence.shellIdentityAfter, context).toEqual(evidence.shellIdentityBefore);
    if (process.platform !== "win32") {
      const rows = evidence.processRows.trim().split("\n") as string[];
      expect(rows, context).toHaveLength(3);
      expect(new Set(rows.map(row => row.trim().split(/\s+/)[3])).size, context).toBe(1);
      expect(rows.every(row => !["?", "??", "-"].includes(row.trim().split(/\s+/)[3]!)), context).toBe(true);
    } else {
      expect(evidence.windowsProcesses.version, context).toMatch(/^5\.1\./);
      expect(evidence.windowsRootCommand[0], context).toMatch(/WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/i);
    }
    expect(evidence.businessPromptsSent).toBe(0);
    expect(evidence.driverNode.version).toMatch(/^v24\./);
    expect(evidence.processProofCompleted, context).toBe(true);
    expect(evidence.sameOriginalNativeAfterInput, context).toBe(true);
    expect(evidence.beforeInitialInput, context).toMatchObject({ kind: agent, status: "idle", interactiveReady: true, launchPending: false, nativeSession: null });
    expect(evidence.requestsBeforeInitialInput, context).toEqual([]);
    expect(evidence.initialInputAttempts, "Unknown submission is never replayed.").toBe(1);
    expect(evidence.initialInputReceipt, context).toMatchObject({ submission: "submitted" });
    expect(evidence.receiptAfterInitialInput, context).toEqual(evidence.receipt);
    const pane = evidence.afterInitialInput.snapshot.panes.find((pane: { pane_id: string }) => pane.pane_id === evidence.observation.binding.paneId);
    expect(pane.agent_session, context).toMatchObject({ source: `herdr:${agent}`, agent, kind: "id", value: evidence.observation.nativeSession.sessionId });
    expect(evidence.cleanup, context).toMatchObject({ workspaceClosed: true, apiClosed: true, clientClosed: true, mockClosed: true, runtimeDirectoryRemoved: true });
    expect(evidence.cleanup.originalProcesses.every((process: { observation: string }) => process.observation === "exited"), context).toBe(true);
    expect(evidence.cleanup.instance, context).toMatchObject({ apiClosed: true, clientClosed: true, ownedChildClosed: true });
    expect(evidence.observation.nativeSession, `The official SessionStart hook must identify the same native Session. ${context}`).toMatchObject({ source: `herdr:${agent}`, agent, sessionId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
  }, 120_000);

  it.skipIf(process.platform !== "win32")("round-trips exact arguments through the real PS5 ExternalScript mapping", async () => {
    const evidence = await runHerdrToolPlatform("codex", true);
    const context = JSON.stringify({ evidenceFile: evidence.evidenceFile, error: evidence.error, cleanup: evidence.cleanup });
    expect(evidence.error, context).toBeUndefined();
    expect(evidence.officialNativeIdentification).toBe(false);
    expect(evidence.argumentRoundTrip.args, context).toEqual(evidence.expectedArguments);
    expect(evidence.argumentRoundTrip.tty, context).toEqual({ stdin: true, stdout: true, stderr: true });
    expect(evidence.externalScript, context).toMatchObject({ version: expect.stringMatching(/^5\.1\./), type: "ExternalScript" });
    expect(evidence.originalShellPreserved, context).toBe(true);
    expect(evidence.initialInputAttempts).toBe(0);
    expect(evidence.cleanup, context).toMatchObject({ workspaceClosed: true, apiClosed: true, clientClosed: true, mockClosed: true, runtimeDirectoryRemoved: true });
    expect(evidence.cleanup.originalProcesses.every((process: { observation: string }) => process.observation === "exited"), context).toBe(true);
  }, 120_000);

  it.skipIf(process.platform !== "win32")("closes the original workspace after a controlled readiness deadline", async () => {
    const evidence = await runHerdrToolPlatform("codex", false, true);
    const context = JSON.stringify({ evidenceFile: evidence.evidenceFile, error: evidence.error, cleanup: evidence.cleanup });
    expect(evidence.controlledReadinessFailure, context).toMatchObject({ kind: "after-real-readiness", realRootVerified: true, failureKind: "deadline", totalMs: 20_000, shellPid: expect.any(Number), remainingMs: expect.any(Number) });
    expect(evidence.controlledReadinessFailure.remainingMs).toBeGreaterThan(0);
    expect(evidence.controlledReadinessFailure.remainingMs).toBeLessThanOrEqual(20_000);
    expect(evidence.error, context).toMatch(/The original PowerShell root readiness phase failed.*Operation deadline exceeded/);
    expect(evidence.officialNativeIdentification).toBe(false);
    expect(evidence.initialInputAttempts).toBe(0);
    expect(evidence.requests).toEqual([]);
    expect(evidence.cleanup, context).toMatchObject({ workspaceClosed: true, apiClosed: true, clientClosed: true, mockClosed: true, runtimeDirectoryRemoved: true, readinessVerified: true,
      partialWorkspace: { failurePhase: "root-readiness", shellPid: evidence.controlledReadinessFailure.shellPid, layoutVerified: true, noAgentLaunch: true, closeConfirmed: true, readyValidation: "verified", after: { ownerAbsent: true, workspaceAbsent: true, paneAbsent: true, terminalAbsent: true, tabAbsent: true } },
      instance: { apiClosed: true, clientClosed: true, ownedChildClosed: true } });
    const { partialWorkspace: partial, partialWorkspaceObservation: observed, partialWorkspaceIndependent: independent, processCapture, originalProcesses } = evidence.cleanup;
    expect(observed, context).toMatchObject({ owner: partial.owner, binding: partial.binding, shellPid: partial.shellPid, tabId: partial.tabId, initialTabId: partial.initialTabId, initialPaneId: partial.initialPaneId, initialTerminalId: partial.initialTerminalId });
    expect(independent, context).toMatchObject({ owner: partial.owner, binding: partial.binding, tabId: partial.tabId, initialTabId: partial.initialTabId, initialPaneId: partial.initialPaneId, initialTerminalId: partial.initialTerminalId, ownerAbsent: true, workspaceAbsent: true, paneAbsent: true, terminalAbsent: true, tabAbsent: true });
    expect(processCapture.roots, context).toContain(partial.shellPid);
    expect(processCapture.roots, context).toHaveLength(2);
    expect(processCapture.processes, context).toEqual(expect.arrayContaining(processCapture.roots.map((pid: number) => expect.objectContaining({ pid, startToken: expect.stringMatching(/^\d+$/) }))));
    expect(originalProcesses, context).toHaveLength(processCapture.processes.length);
    expect(originalProcesses.every((process: { observation: string }) => process.observation === "exited"), context).toBe(true);
  }, 120_000);
});
