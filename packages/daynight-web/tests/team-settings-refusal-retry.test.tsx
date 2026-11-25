import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ApiError } from "../src/api/client";
import type { TeamSettingsRead } from "../src/api/team-settings";
import type { TaskCacheScope } from "../src/features/task-cache/TaskCacheProvider";
import { TeamNestedSettings } from "../src/features/teams/TeamNestedSettings";
import { useOperation } from "../src/features/teams/TeamManagement";
import { createLocaleRender } from "./helpers/renderWithLocale";

vi.mock("../src/api/team-settings", () => ({ getTeamSettings: vi.fn(), saveTeamSettings: vi.fn() }));
import { getTeamSettings, saveTeamSettings } from "../src/api/team-settings";

it.each([false, true])("retries a definite 408 only after settings are read (first read fails: %s)", async failRead => {
  vi.resetAllMocks();
  const teamId = "00000000-0000-4000-8000-000000000002", userId = "00000000-0000-4000-8000-000000000001";
  const scope = { userId, signal: new AbortController().signal, isInvalidated: false, ready: async (signal: AbortSignal) => signal.throwIfAborted() } as TaskCacheScope;
  const initial = { kind: "available", settings: { version: 7n, allowNestedSubtask: false } } as const;
  const fresh = { kind: "available", settings: { version: 8n, allowNestedSubtask: false } } as const;
  const heldRead = Promise.withResolvers<TeamSettingsRead>();
  vi.mocked(getTeamSettings).mockResolvedValueOnce(initial).mockReturnValueOnce(heldRead.promise).mockResolvedValueOnce(fresh);
  vi.mocked(saveTeamSettings).mockImplementationOnce(async (_team, _user, _base, _value, _signal, _mismatch, dispatch) => { dispatch(); throw new ApiError("server", 408, "request_timeout"); })
    .mockImplementationOnce(async (_team, _user, base, value, _signal, _mismatch, dispatch) => { dispatch(); return { version: base.version + 1n, allowNestedSubtask: value }; });
  const mismatch = vi.fn(), onSaved = vi.fn();
  const Panel = () => {
    const operation = useOperation(scope);
    return <TeamNestedSettings teamId={teamId} admission={scope} active blocked={false} editable onIdentityMismatch={mismatch} onDenied={vi.fn()} onWrite={vi.fn()} onSaved={onSaved} operation={operation} />;
  };
  createLocaleRender("en")(<Panel />);
  fireEvent.click(await screen.findByRole("switch", { name: "Allow nested subtasks" }));
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(getTeamSettings).toHaveBeenCalledTimes(2));
  expect(saveTeamSettings).toHaveBeenCalledOnce();
  expect(screen.getByRole("switch", { name: "Allow nested subtasks" })).toHaveAttribute("aria-checked", "true");
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  expect(saveTeamSettings).toHaveBeenCalledOnce();
  if (failRead) {
    await act(async () => heldRead.reject(new ApiError("network")));
    expect(await screen.findByText("Unable to read settings.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(getTeamSettings).toHaveBeenCalledTimes(3));
  } else await act(async () => heldRead.resolve(fresh));
  await waitFor(() => expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
  expect(saveTeamSettings).toHaveBeenCalledTimes(2);
  expect(vi.mocked(saveTeamSettings).mock.calls[1]).toEqual([teamId, userId, fresh.settings, true, expect.any(AbortSignal), mismatch, expect.any(Function)]);
  expect(screen.getByText("Saved: On")).toBeVisible();
});

it("preserves a conflict received while the section is inactive until its read on return", async () => {
  vi.resetAllMocks();
  const teamId = "00000000-0000-4000-8000-000000000002", userId = "00000000-0000-4000-8000-000000000001";
  const scope = { userId, signal: new AbortController().signal, isInvalidated: false, ready: async (signal: AbortSignal) => signal.throwIfAborted() } as TaskCacheScope;
  const initial = { kind: "available", settings: { version: 7n, allowNestedSubtask: false } } as const;
  const changed = { kind: "available", settings: { version: 8n, allowNestedSubtask: false } } as const;
  const write = Promise.withResolvers<typeof changed.settings>();
  vi.mocked(getTeamSettings).mockResolvedValueOnce(initial).mockResolvedValueOnce(changed);
  vi.mocked(saveTeamSettings).mockImplementation(async (_team, _user, _base, _value, _signal, _mismatch, dispatch) => { dispatch(); return write.promise; });
  const mismatch = vi.fn(), onSaved = vi.fn(), onDenied = vi.fn(), onWrite = vi.fn();
  const Panel = ({ active }: { active: boolean }) => {
    const operation = useOperation(scope);
    return <TeamNestedSettings teamId={teamId} admission={scope} active={active} blocked={false} editable onIdentityMismatch={mismatch} onDenied={onDenied} onWrite={onWrite} onSaved={onSaved} operation={operation} />;
  };
  const view = createLocaleRender("en")(<Panel active />);
  fireEvent.click(await screen.findByRole("switch", { name: "Allow nested subtasks" }));
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(saveTeamSettings).toHaveBeenCalledOnce());
  view.rerender(<Panel active={false} />);
  await act(async () => write.reject(new ApiError("server", 409, "version_conflict")));
  expect(getTeamSettings).toHaveBeenCalledTimes(1);
  view.rerender(<Panel active />);
  expect(await screen.findByText(/setting changed/)).toBeVisible();
  expect(screen.getByText("Saved: Off")).toBeVisible();
  expect(screen.getByRole("switch", { name: "Allow nested subtasks" })).toHaveAttribute("aria-checked", "true");
  expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
  expect(getTeamSettings).toHaveBeenCalledTimes(2);
  expect(saveTeamSettings).toHaveBeenCalledOnce();
});

it.each(["request_timeout", "version_conflict"] as const)("can retry after %s read encounters an old service", async code => {
  vi.resetAllMocks();
  const teamId = "00000000-0000-4000-8000-000000000002", userId = "00000000-0000-4000-8000-000000000001";
  const scope = { userId, signal: new AbortController().signal, isInvalidated: false, ready: async (signal: AbortSignal) => signal.throwIfAborted() } as TaskCacheScope;
  const initial = { kind: "available", settings: { version: 7n, allowNestedSubtask: false } } as const;
  const changed = { kind: "available", settings: { version: 8n, allowNestedSubtask: false } } as const;
  vi.mocked(getTeamSettings).mockResolvedValueOnce(initial).mockResolvedValueOnce({ kind: "unavailable" }).mockResolvedValueOnce(changed);
  vi.mocked(saveTeamSettings).mockImplementation(async (_team, _user, _base, _value, _signal, _mismatch, dispatch) => { dispatch(); throw new ApiError("server", code === "request_timeout" ? 408 : 409, code); });
  const mismatch = vi.fn(), onDenied = vi.fn(), onWrite = vi.fn(), onSaved = vi.fn();
  const Panel = () => {
    const operation = useOperation(scope);
    return <TeamNestedSettings teamId={teamId} admission={scope} active blocked={false} editable onIdentityMismatch={mismatch} onDenied={onDenied} onWrite={onWrite} onSaved={onSaved} operation={operation} />;
  };
  createLocaleRender("en")(<Panel />);
  fireEvent.click(await screen.findByRole("switch", { name: "Allow nested subtasks" }));
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  expect(await screen.findByText("This service does not support this setting.")).toBeVisible();
  expect(screen.queryByRole("switch")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("Saved: Off")).toBeVisible();
  expect(screen.getByRole("switch", { name: "Allow nested subtasks" })).toHaveAttribute("aria-checked", "true");
  if (code === "version_conflict") expect(screen.getByText(/setting changed/)).toBeVisible();
  expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
  expect(getTeamSettings).toHaveBeenCalledTimes(3);
  expect(saveTeamSettings).toHaveBeenCalledOnce();
});
