import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ApiError } from "../src/api/client";
import type { TaskCacheScope } from "../src/features/task-cache/TaskCacheProvider";
import { TeamNestedSettings } from "../src/features/teams/TeamNestedSettings";
import { useOperation } from "../src/features/teams/TeamManagement";
import { createLocaleRender } from "./helpers/renderWithLocale";

vi.mock("../src/api/team-settings", () => ({ getTeamSettings: vi.fn(), saveTeamSettings: vi.fn() }));
import { getTeamSettings, saveTeamSettings } from "../src/api/team-settings";

it.each([[403, "forbidden"], [404, "not_found"]] as const)("does not reinstall a late successful receipt after trusted %s", async (status, code) => {
  vi.resetAllMocks();
  const teamId = "00000000-0000-4000-8000-000000000002", userId = "00000000-0000-4000-8000-000000000001";
  const scope = { userId, signal: new AbortController().signal, isInvalidated: false, ready: async (signal: AbortSignal) => signal.throwIfAborted() } as TaskCacheScope;
  const pending = Promise.withResolvers<{ version: bigint; allowNestedSubtask: boolean }>();
  vi.mocked(getTeamSettings).mockResolvedValueOnce({ kind: "available", settings: { version: 7n, allowNestedSubtask: false } }).mockRejectedValueOnce(new ApiError("server", status, code));
  vi.mocked(saveTeamSettings).mockImplementation(async (_team, _user, _base, _value, _signal, _mismatch, dispatch) => { dispatch(); return pending.promise; });
  const denied = vi.fn(), mismatch = vi.fn(), onWrite = vi.fn(), onSaved = vi.fn();
  const Panel = ({ active }: { active: boolean }) => {
    const operation = useOperation(scope);
    return <TeamNestedSettings teamId={teamId} admission={scope} active={active} blocked={false} editable onIdentityMismatch={mismatch} onDenied={denied} onWrite={onWrite} onSaved={onSaved} operation={operation} />;
  };
  const view = createLocaleRender("en")(<Panel active />);
  fireEvent.click(await screen.findByRole("switch", { name: "Allow nested subtasks" }));
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(saveTeamSettings).toHaveBeenCalledOnce());
  view.rerender(<Panel active={false} />); view.rerender(<Panel active />);
  await waitFor(() => expect(denied).toHaveBeenCalledOnce());
  expect(screen.queryByRole("switch")).toBeNull();
  await act(async () => pending.resolve({ version: 8n, allowNestedSubtask: true }));
  expect(screen.queryByRole("switch")).toBeNull();
  expect(screen.queryByText("Saved: On")).toBeNull();
  expect(saveTeamSettings).toHaveBeenCalledOnce();
});
