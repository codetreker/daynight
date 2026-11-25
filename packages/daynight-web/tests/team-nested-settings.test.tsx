import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/api/client";
import type { TeamSettingsRead } from "../src/api/team-settings";
import type { TaskCacheScope } from "../src/features/task-cache/TaskCacheProvider";
import { TeamNestedSettings } from "../src/features/teams/TeamNestedSettings";
import { useOperation } from "../src/features/teams/TeamManagement";
import { createLocaleRender } from "./helpers/renderWithLocale";

vi.mock("../src/api/team-settings", () => ({ getTeamSettings: vi.fn(), saveTeamSettings: vi.fn() }));
import { getTeamSettings, saveTeamSettings } from "../src/api/team-settings";

const teamId = "00000000-0000-4000-8000-000000000002", userId = "00000000-0000-4000-8000-000000000001";
const initial = { kind: "available", settings: { version: 9007199254740993n, allowNestedSubtask: false } } as const;
const next = { kind: "available", settings: { version: 9007199254740994n, allowNestedSubtask: true } } as const;
const render = createLocaleRender("en");
const denied = vi.fn(), mismatch = vi.fn(), onWrite = vi.fn(), onSaved = vi.fn();
let scope: TaskCacheScope;
const Panel = ({ blocked = false, editable = true }: { blocked?: boolean; editable?: boolean }) => {
  const operation = useOperation(scope);
  return <TeamNestedSettings teamId={teamId} admission={scope} active blocked={blocked} editable={editable} onIdentityMismatch={mismatch} onDenied={denied} onWrite={onWrite} onSaved={onSaved} operation={operation} />;
};
const toggle = () => screen.getByRole("switch", { name: "Allow nested subtasks" });
const save = () => screen.getByRole("button", { name: "Save changes" });
beforeEach(() => {
  vi.resetAllMocks();
  scope = { userId, signal: new AbortController().signal, isInvalidated: false, ready: async (signal: AbortSignal) => signal.throwIfAborted() } as TaskCacheScope;
  vi.mocked(getTeamSettings).mockResolvedValue(initial);
});
const backgroundRead = async () => {
  let focused = false;
  const focus = vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
  fireEvent.blur(window); focused = true; fireEvent.focus(window);
  await waitFor(() => expect(getTeamSettings).toHaveBeenCalledTimes(2));
  focus.mockRestore();
};

describe("Team nested subtask settings", () => {
  it("loads the confirmed value, cancels a draft, and saves an explicit change", async () => {
    vi.mocked(saveTeamSettings).mockImplementation(async (_team, _user, _base, _value, _signal, _mismatch, dispatch) => { dispatch(); return next.settings; });
    render(<Panel />);
    expect(await screen.findByRole("switch")).toHaveAttribute("aria-checked", "false");
    fireEvent.click(toggle()); expect(save()).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" })); expect(toggle()).toHaveAttribute("aria-checked", "false");
    expect(saveTeamSettings).not.toHaveBeenCalled();
    fireEvent.click(toggle()); fireEvent.click(save());
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(saveTeamSettings).toHaveBeenCalledWith(teamId, userId, initial.settings, true, expect.any(AbortSignal), mismatch, expect.any(Function));
    expect(screen.getByText("Saved: On")).toBeVisible(); expect(save()).toBeDisabled();
  });

  it("shows a member the confirmed setting without allowing edits", async () => {
    render(<Panel editable={false} />);
    expect(await screen.findByRole("switch")).toBeDisabled();
    expect(screen.getByText(/Only Team administrators/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
  });

  it("keeps a late background GET from reverting a successful save or its next version", async () => {
    const late = Promise.withResolvers<TeamSettingsRead>();
    vi.mocked(getTeamSettings).mockResolvedValueOnce(initial).mockReturnValueOnce(late.promise);
    vi.mocked(saveTeamSettings).mockImplementation(async (_team, _user, base, value, _signal, _mismatch, dispatch) => {
      dispatch(); return { version: base.version + 1n, allowNestedSubtask: value };
    });
    render(<Panel />); await screen.findByRole("switch");
    fireEvent.click(toggle()); await backgroundRead();
    fireEvent.click(save()); await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    await act(async () => late.resolve(initial));
    expect(screen.getByText("Saved: On")).toBeVisible(); expect(toggle()).toHaveAttribute("aria-checked", "true");
    fireEvent.click(toggle()); fireEvent.click(save());
    await waitFor(() => expect(saveTeamSettings).toHaveBeenCalledTimes(2));
    expect(vi.mocked(saveTeamSettings).mock.calls[1]?.[2]).toEqual(next.settings);
  });

  it("requires a new explicit read after an unknown save even if an older GET returns", async () => {
    const late = Promise.withResolvers<TeamSettingsRead>();
    vi.mocked(getTeamSettings).mockResolvedValueOnce(initial).mockReturnValueOnce(late.promise).mockResolvedValueOnce(next);
    vi.mocked(saveTeamSettings).mockImplementation(async (_team, _user, _base, _value, _signal, _mismatch, dispatch) => { dispatch(); throw new ApiError("network"); });
    render(<Panel />); await screen.findByRole("switch");
    fireEvent.click(toggle()); await backgroundRead();
    fireEvent.click(save()); expect(await screen.findByText(/save result is unknown/)).toBeVisible();
    await act(async () => late.resolve(initial));
    expect(screen.getByText(/save result is unknown/)).toBeVisible(); expect(toggle()).toBeDisabled();
    expect(getTeamSettings).toHaveBeenCalledTimes(2); expect(saveTeamSettings).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Check current state" }));
    await waitFor(() => expect(toggle()).toBeEnabled());
    expect(getTeamSettings).toHaveBeenCalledTimes(3); expect(saveTeamSettings).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Saved: On")).toBeVisible();
  });

  it("retains the draft after conflict and uses the newly read version on retry", async () => {
    const newer = { kind: "available", settings: { version: initial.settings.version + 3n, allowNestedSubtask: false } } as const;
    vi.mocked(getTeamSettings).mockResolvedValueOnce(initial).mockResolvedValueOnce(newer);
    vi.mocked(saveTeamSettings).mockImplementationOnce(async (_team, _user, _base, _value, _signal, _mismatch, dispatch) => { dispatch(); throw new ApiError("server", 409, "version_conflict"); });
    vi.mocked(saveTeamSettings).mockImplementationOnce(async (_team, _user, base, value, _signal, _mismatch, dispatch) => { dispatch(); return { version: base.version + 1n, allowNestedSubtask: value }; });
    render(<Panel />); await screen.findByRole("switch"); fireEvent.click(toggle()); fireEvent.click(save());
    expect(await screen.findByText(/setting changed/)).toBeVisible(); expect(toggle()).toHaveAttribute("aria-checked", "true");
    fireEvent.click(save()); await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(vi.mocked(saveTeamSettings).mock.calls[1]?.[2]).toEqual(newer.settings);
  });

  it("retains conflict reconciliation after a failed read and retry", async () => {
    const newer = { kind: "available", settings: { version: initial.settings.version + 3n, allowNestedSubtask: false } } as const;
    vi.mocked(getTeamSettings).mockResolvedValueOnce(initial).mockRejectedValueOnce(new ApiError("network")).mockResolvedValueOnce(newer);
    vi.mocked(saveTeamSettings).mockImplementationOnce(async (_team, _user, _base, _value, _signal, _mismatch, dispatch) => { dispatch(); throw new ApiError("server", 409, "version_conflict"); });
    render(<Panel />); await screen.findByRole("switch"); fireEvent.click(toggle()); fireEvent.click(save());
    expect(await screen.findByText("Unable to read settings.")).toBeVisible(); expect(save()).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText(/setting changed/)).toBeVisible(); expect(toggle()).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("Saved: Off")).toBeVisible(); expect(save()).toBeEnabled(); expect(saveTeamSettings).toHaveBeenCalledTimes(1);
  });

  it("does not show a default while the initial read fails and offers a retry", async () => {
    vi.mocked(getTeamSettings).mockRejectedValueOnce(new ApiError("network")).mockResolvedValueOnce(initial);
    render(<Panel />); expect(await screen.findByText("Unable to read settings.")).toBeVisible();
    expect(screen.queryByRole("switch")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" })); expect(await screen.findByRole("switch")).toHaveAttribute("aria-checked", "false");
  });

  it("retries publication of a confirmed save without sending the write again", async () => {
    let failPublication = false;
    scope = { ...scope, ready: async (signal: AbortSignal) => { signal.throwIfAborted(); if (failPublication) throw new Error("admission unavailable"); } } as TaskCacheScope;
    vi.mocked(saveTeamSettings).mockImplementation(async (_team, _user, _base, _value, _signal, _mismatch, dispatch) => { dispatch(); failPublication = true; return next.settings; });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<Panel />); await screen.findByRole("switch"); fireEvent.click(toggle()); fireEvent.click(save());
    expect(await screen.findByText("The operation succeeded, but its result could not be displayed.")).toBeVisible();
    expect(saveTeamSettings).toHaveBeenCalledTimes(1); expect(save()).toBeDisabled(); expect(onSaved).not.toHaveBeenCalled();
    failPublication = false; fireEvent.click(screen.getByRole("button", { name: "Retry showing result" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(screen.getByText("Saved: On")).toBeVisible(); expect(saveTeamSettings).toHaveBeenCalledTimes(1);
    log.mockRestore();
  });

  it("invalidates an older read and clears the draft across role changes", async () => {
    const late = Promise.withResolvers<TeamSettingsRead>();
    vi.mocked(getTeamSettings).mockResolvedValueOnce(initial).mockReturnValueOnce(late.promise).mockResolvedValueOnce(initial).mockResolvedValueOnce(initial);
    const view = render(<Panel />); await screen.findByRole("switch");
    fireEvent.click(toggle()); await backgroundRead();
    view.rerender(<Panel editable={false} />);
    await waitFor(() => expect(getTeamSettings).toHaveBeenCalledTimes(3));
    expect(toggle()).toBeDisabled(); expect(toggle()).toHaveAttribute("aria-checked", "false");
    view.rerender(<Panel />); await waitFor(() => expect(getTeamSettings).toHaveBeenCalledTimes(4));
    await act(async () => late.resolve(next));
    expect(toggle()).toBeEnabled(); expect(toggle()).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText("Saved: Off")).toBeVisible(); expect(save()).toBeDisabled(); expect(saveTeamSettings).not.toHaveBeenCalled();
  });

  it("keeps unknown and permits another explicit check if the first check finds an old service", async () => {
    vi.mocked(getTeamSettings).mockResolvedValueOnce(initial).mockResolvedValueOnce({ kind: "unavailable" }).mockResolvedValueOnce(next);
    vi.mocked(saveTeamSettings).mockImplementation(async (_team, _user, _base, _value, _signal, _mismatch, dispatch) => { dispatch(); throw new ApiError("network"); });
    render(<Panel />); await screen.findByRole("switch"); fireEvent.click(toggle()); fireEvent.click(save());
    expect(await screen.findByText(/save result is unknown/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Check current state" }));
    expect(await screen.findByText("This service does not support this setting.")).toBeVisible();
    expect(screen.getByText(/save result is unknown/)).toBeVisible(); expect(screen.queryByRole("switch")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Check current state" }));
    expect(await screen.findByText("Saved: On")).toBeVisible(); expect(toggle()).toBeEnabled();
    expect(getTeamSettings).toHaveBeenCalledTimes(3); expect(saveTeamSettings).toHaveBeenCalledTimes(1);
  });
});
