import { fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { TaskCacheScope } from "../src/features/task-cache/TaskCacheProvider";
import { TeamNestedSettings } from "../src/features/teams/TeamNestedSettings";
import { useOperation } from "../src/features/teams/TeamManagement";
import { createLocaleRender } from "./helpers/renderWithLocale";

vi.mock("../src/api/team-settings", () => ({ getTeamSettings: vi.fn(), saveTeamSettings: vi.fn() }));
import { getTeamSettings, saveTeamSettings } from "../src/api/team-settings";

it("keeps its confirmed version and draft through an old router and stale read", async () => {
  const teamId = "00000000-0000-4000-8000-000000000002", userId = "00000000-0000-4000-8000-000000000001";
  const scope = { userId, signal: new AbortController().signal, isInvalidated: false, ready: async (signal: AbortSignal) => signal.throwIfAborted() } as TaskCacheScope;
  const confirmed = { version: 8n, allowNestedSubtask: false };
  vi.mocked(getTeamSettings).mockResolvedValueOnce({ kind: "available", settings: confirmed })
    .mockResolvedValueOnce({ kind: "unavailable" })
    .mockResolvedValueOnce({ kind: "available", settings: { version: 7n, allowNestedSubtask: true } })
    .mockResolvedValueOnce({ kind: "available", settings: confirmed });
  vi.mocked(saveTeamSettings).mockImplementation(async (_team, _user, base, value, _signal, _mismatch, dispatch) => { dispatch(); return { version: base.version + 1n, allowNestedSubtask: value }; });
  const mismatch = vi.fn(), denied = vi.fn(), onWrite = vi.fn(), onSaved = vi.fn();
  const Panel = () => {
    const operation = useOperation(scope);
    return <TeamNestedSettings teamId={teamId} admission={scope} active blocked={false} editable onIdentityMismatch={mismatch} onDenied={denied} onWrite={onWrite} onSaved={onSaved} operation={operation} />;
  };
  createLocaleRender("en")(<Panel />);
  fireEvent.click(await screen.findByRole("switch", { name: "Allow nested subtasks" }));
  const focus = vi.spyOn(document, "hasFocus");
  const foreground = async (count: number) => {
    focus.mockReturnValue(false); fireEvent.blur(window);
    focus.mockReturnValue(true); fireEvent.focus(window);
    await waitFor(() => expect(getTeamSettings).toHaveBeenCalledTimes(count));
  };
  await foreground(2);
  expect(await screen.findByText("This service does not support this setting.")).toBeVisible();
  await foreground(3);
  expect(await screen.findByText("Unable to read settings.")).toBeVisible();
  expect(saveTeamSettings).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("Saved: Off")).toBeVisible();
  expect(screen.getByRole("switch", { name: "Allow nested subtasks" })).toHaveAttribute("aria-checked", "true");
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
  expect(saveTeamSettings).toHaveBeenCalledWith(teamId, userId, confirmed, true, expect.any(AbortSignal), mismatch, expect.any(Function));
  focus.mockRestore();
});
