import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ApiError } from "../src/api/client";
import type { Team } from "../src/api/teams";
import type { TaskCacheScope } from "../src/features/task-cache/TaskCacheProvider";
import { TeamSettingsPanel } from "../src/features/teams/TeamManagement";
import { createLocaleRender } from "./helpers/renderWithLocale";

vi.mock("../src/api/teams", () => ({ getTeam: vi.fn(), listTeams: vi.fn(), createTeam: vi.fn(), renameTeam: vi.fn(), deleteTeam: vi.fn() }));
vi.mock("../src/api/team-settings", () => ({ getTeamSettings: vi.fn(), saveTeamSettings: vi.fn() }));
import { getTeam, renameTeam } from "../src/api/teams";
import { getTeamSettings, saveTeamSettings } from "../src/api/team-settings";

const userId = "00000000-0000-4000-8000-000000000001", teamId = "00000000-0000-4000-8000-000000000002";
const time = "2026-10-20T09:00:00Z";
const team = (version: bigint, name = "Alpha"): Team => ({ id: teamId, kind: "ordinary", name, version, createdAt: time, updatedAt: time,
  membership: { teamId, userId, role: "admin", version: 1n, createdAt: time, updatedAt: time } });

it.each([true, false])("refreshes full Team after an unknown save readback (current setting: %s)", async enabled => {
  vi.resetAllMocks();
  const scope = { userId, signal: new AbortController().signal, isInvalidated: false, ready: async (signal: AbortSignal) => signal.throwIfAborted() } as TaskCacheScope;
  const version = enabled ? 2n : 1n, refreshed = Promise.withResolvers<Team>();
  vi.mocked(getTeam).mockResolvedValueOnce(team(1n)).mockReturnValueOnce(refreshed.promise);
  vi.mocked(getTeamSettings).mockResolvedValueOnce({ kind: "available", settings: { version: 1n, allowNestedSubtask: false } })
    .mockResolvedValueOnce({ kind: "available", settings: { version, allowNestedSubtask: enabled } });
  vi.mocked(saveTeamSettings).mockImplementation(async (_team, _user, _base, _value, _signal, _mismatch, dispatch) => { dispatch(); throw new ApiError("network"); });
  vi.mocked(renameTeam).mockImplementation(async (_user, base, name, _signal, _mismatch, dispatch) => { dispatch(); return team(base.version + 1n, name); });
  const updated = vi.fn();
  createLocaleRender("en")(<TeamSettingsPanel teamId={teamId} admission={scope} onIdentityMismatch={vi.fn()} onUpdated={updated} onDeleted={vi.fn()} />);
  fireEvent.click(await screen.findByRole("switch", { name: "Allow nested subtasks" }));
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  expect(await screen.findByText(/save result is unknown/)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Check current state" }));
  await waitFor(() => expect(getTeam).toHaveBeenCalledTimes(2));
  expect(screen.queryByText(/save result is unknown/)).toBeNull();
  expect(screen.getByText(`Saved: ${enabled ? "On" : "Off"}`)).toBeVisible();
  expect(saveTeamSettings).toHaveBeenCalledOnce();
  await act(async () => refreshed.resolve(team(version)));
  fireEvent.click(screen.getByRole("button", { name: /^Edit$/ }));
  const dialog = screen.getByRole("dialog", { name: "Edit Team name" });
  fireEvent.change(within(dialog).getByLabelText("Team name"), { target: { value: "Renamed" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(updated).toHaveBeenCalledOnce());
  expect(renameTeam).toHaveBeenCalledWith(userId, expect.objectContaining({ id: teamId, version }), "Renamed", expect.any(AbortSignal), expect.any(Function), expect.any(Function));
  expect(saveTeamSettings).toHaveBeenCalledOnce();
});

it.each([["version_conflict", 409, 2n], ["invalid_input", 400, 1n]] as const)("refreshes metadata after a definite %s refusal", async (code, status, version) => {
  vi.resetAllMocks();
  const scope = { userId, signal: new AbortController().signal, isInvalidated: false, ready: async (signal: AbortSignal) => signal.throwIfAborted() } as TaskCacheScope;
  vi.mocked(getTeam).mockResolvedValueOnce(team(1n)).mockResolvedValue(team(version));
  vi.mocked(getTeamSettings).mockResolvedValueOnce({ kind: "available", settings: { version: 1n, allowNestedSubtask: false } })
    .mockResolvedValue({ kind: "available", settings: { version, allowNestedSubtask: false } });
  vi.mocked(saveTeamSettings).mockImplementation(async (_team, _user, _base, _value, _signal, _mismatch, dispatch) => { dispatch(); throw new ApiError("server", status, code); });
  vi.mocked(renameTeam).mockImplementation(async (_user, base, name, _signal, _mismatch, dispatch) => { dispatch(); return team(base.version + 1n, name); });
  const updated = vi.fn();
  createLocaleRender("en")(<TeamSettingsPanel teamId={teamId} admission={scope} onIdentityMismatch={vi.fn()} onUpdated={updated} onDeleted={vi.fn()} />);
  fireEvent.click(await screen.findByRole("switch", { name: "Allow nested subtasks" }));
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(getTeam).toHaveBeenCalledTimes(2));
  if (code === "version_conflict") {
    expect(await screen.findByText(/setting changed/)).toBeVisible();
    expect(screen.getByRole("switch", { name: "Allow nested subtasks" })).toHaveAttribute("aria-checked", "true");
    expect(getTeamSettings).toHaveBeenCalledTimes(2);
  } else expect(await screen.findByText("Unable to save. Check the details and try again.")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: /^Edit$/ }));
  const dialog = screen.getByRole("dialog", { name: "Edit Team name" });
  fireEvent.change(within(dialog).getByLabelText("Team name"), { target: { value: "Renamed" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(updated).toHaveBeenCalledOnce());
  expect(renameTeam).toHaveBeenCalledWith(userId, expect.objectContaining({ id: teamId, version }), "Renamed", expect.any(AbortSignal), expect.any(Function), expect.any(Function));
  expect(saveTeamSettings).toHaveBeenCalledOnce();
});
