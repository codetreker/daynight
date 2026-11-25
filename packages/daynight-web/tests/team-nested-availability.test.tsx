import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ApiError } from "../src/api/client";
import type { Team } from "../src/api/teams";
import type { TaskCacheScope } from "../src/features/task-cache/TaskCacheProvider";
import { TeamSettingsPanel } from "../src/features/teams/TeamManagement";
import { createLocaleRender } from "./helpers/renderWithLocale";

vi.mock("../src/api/teams", () => ({ getTeam: vi.fn(), listTeams: vi.fn(), createTeam: vi.fn(), renameTeam: vi.fn(), deleteTeam: vi.fn() }));
vi.mock("../src/api/team-settings", () => ({ getTeamSettings: vi.fn(), saveTeamSettings: vi.fn() }));
import { getTeam } from "../src/api/teams";
import { getTeamSettings, saveTeamSettings } from "../src/api/team-settings";

const userId = "00000000-0000-4000-8000-000000000001", teamId = "00000000-0000-4000-8000-000000000002";
const time = "2026-10-20T09:00:00Z";
const team: Team = { id: teamId, kind: "ordinary", name: "Alpha", version: 1n, createdAt: time, updatedAt: time,
  membership: { teamId, userId, role: "admin", version: 1n, createdAt: time, updatedAt: time } };

it.each(["pending", "unknown"] as const)("keeps a %s settings write when Team becomes unavailable", async phase => {
  vi.resetAllMocks();
  const scope = { userId, signal: new AbortController().signal, isInvalidated: false, ready: async (signal: AbortSignal) => signal.throwIfAborted() } as TaskCacheScope;
  const write = Promise.withResolvers<{ version: bigint; allowNestedSubtask: boolean }>();
  vi.mocked(getTeam).mockResolvedValueOnce(team).mockRejectedValueOnce(new ApiError("server", 404, "not_found")).mockResolvedValue(team);
  vi.mocked(getTeamSettings).mockResolvedValue({ kind: "available", settings: { version: 1n, allowNestedSubtask: false } });
  vi.mocked(saveTeamSettings).mockImplementation(async (_team, _user, _settings, _value, _signal, _mismatch, dispatch) => { dispatch(); return write.promise; });
  const unavailable = vi.fn(() => "forgotten" as const), guarded = vi.fn();
  const panel = (blocked: boolean) => <TeamSettingsPanel teamId={teamId} admission={scope} admissionBlocked={blocked} onIdentityMismatch={vi.fn()} onUpdated={vi.fn()} onDeleted={vi.fn()} onUnavailable={unavailable} onGuardChange={guarded} />;
  const view = createLocaleRender("en")(panel(false));
  fireEvent.click(await screen.findByRole("switch", { name: "Allow nested subtasks" }));
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(saveTeamSettings).toHaveBeenCalledOnce());
  if (phase === "unknown") {
    await act(async () => write.reject(new ApiError("network")));
    expect(await screen.findByText(/save result is unknown/)).toBeVisible();
  }
  view.rerender(panel(true)); view.rerender(panel(false));
  await waitFor(() => expect(screen.getByText("This Team is unavailable or you do not have access.")).toBeVisible());
  expect(unavailable).not.toHaveBeenCalled();
  if (phase === "pending") await act(async () => write.reject(new ApiError("network")));
  await waitFor(() => expect(screen.getAllByText(/result is unknown/).some(node => !node.closest("[hidden]"))).toBe(true));
  expect(saveTeamSettings).toHaveBeenCalledOnce();
  expect(guarded).toHaveBeenCalledWith(true);
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText(/save result is unknown/)).toBeVisible();
  expect(saveTeamSettings).toHaveBeenCalledOnce();
});
