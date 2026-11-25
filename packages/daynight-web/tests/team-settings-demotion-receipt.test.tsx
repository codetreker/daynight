import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { TeamSettingsRead } from "../src/api/team-settings";
import type { TaskCacheScope } from "../src/features/task-cache/TaskCacheProvider";
import { TeamNestedSettings } from "../src/features/teams/TeamNestedSettings";
import { useOperation } from "../src/features/teams/TeamManagement";
import { createLocaleRender } from "./helpers/renderWithLocale";

vi.mock("../src/api/team-settings", () => ({ getTeamSettings: vi.fn(), saveTeamSettings: vi.fn() }));
import { getTeamSettings, saveTeamSettings } from "../src/api/team-settings";

it("retains a successful receipt's version after demotion and rejects older reads", async () => {
  const teamId = "00000000-0000-4000-8000-000000000002", userId = "00000000-0000-4000-8000-000000000001";
  const scope = { userId, signal: new AbortController().signal, isInvalidated: false, ready: async (signal: AbortSignal) => signal.throwIfAborted() } as TaskCacheScope;
  const v7 = { kind: "available", settings: { version: 7n, allowNestedSubtask: false } } as const;
  const v8 = { kind: "available", settings: { version: 8n, allowNestedSubtask: true } } as const;
  const pendingWrite = Promise.withResolvers<typeof v8.settings>(), staleRead = Promise.withResolvers<TeamSettingsRead>();
  vi.mocked(getTeamSettings).mockResolvedValueOnce(v7).mockResolvedValueOnce(v7).mockReturnValueOnce(staleRead.promise).mockResolvedValueOnce(v8);
  vi.mocked(saveTeamSettings).mockImplementation(async (_team, _user, _base, _value, _signal, _mismatch, dispatch) => { dispatch(); return pendingWrite.promise; });
  const denied = vi.fn(), mismatch = vi.fn(), onWrite = vi.fn(), onSaved = vi.fn();
  const Panel = ({ editable }: { editable: boolean }) => {
    const operation = useOperation(scope);
    return <TeamNestedSettings teamId={teamId} admission={scope} active blocked={false} editable={editable} onIdentityMismatch={mismatch} onDenied={denied} onWrite={onWrite} onSaved={onSaved} operation={operation} />;
  };
  const view = createLocaleRender("en")(<Panel editable />);
  fireEvent.click(await screen.findByRole("switch", { name: "Allow nested subtasks" }));
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(saveTeamSettings).toHaveBeenCalledOnce());
  view.rerender(<Panel editable={false} />);
  await waitFor(() => expect(getTeamSettings).toHaveBeenCalledTimes(2));
  expect(screen.getByText("Saved: Off")).toBeVisible();
  await act(async () => pendingWrite.resolve(v8.settings));
  await waitFor(() => expect(getTeamSettings).toHaveBeenCalledTimes(3));
  expect(screen.queryByText("Saved: Off")).toBeNull();
  expect(screen.queryByRole("switch")).toBeNull();
  await act(async () => staleRead.resolve(v7));
  expect(await screen.findByText("Unable to read settings.")).toBeVisible();
  expect(screen.queryByText("Saved: Off")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("Saved: On")).toBeVisible();
  expect(screen.getByRole("switch", { name: "Allow nested subtasks" })).toBeDisabled();
  expect(saveTeamSettings).toHaveBeenCalledOnce();
});
