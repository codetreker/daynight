import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/api/client";
import type { Team } from "../src/api/teams";
import { CreateTeamDialog, TeamSettingsPanel } from "../src/features/teams/TeamManagement";
import type { TaskCacheScope } from "../src/features/task-cache/TaskCacheProvider";
import { createLocaleRender } from "./helpers/renderWithLocale";

vi.mock("../src/api/teams", () => ({ getTeam: vi.fn(), listTeams: vi.fn(), createTeam: vi.fn(), renameTeam: vi.fn(), deleteTeam: vi.fn() }));
import { createTeam, deleteTeam, getTeam, listTeams, renameTeam } from "../src/api/teams";
const render = createLocaleRender("en");
const userId = "00000000-0000-4000-8000-000000000001", teamId = "00000000-0000-4000-8000-000000000002";
const time = "2026-10-20T09:00:00Z";
const team = (name = "  Alpha\r\nTeam  ", version = 9007199254740993n, role: "admin" | "member" = "admin"): Team => ({ id: teamId, kind: "ordinary", name, version, createdAt: time, updatedAt: time, membership: { teamId, userId, role, version: 1n, createdAt: time, updatedAt: time } });
let controller: AbortController;
let scope: TaskCacheScope;
const mismatch = vi.fn(), closed = vi.fn(), created = vi.fn(), updated = vi.fn(), deleted = vi.fn();
beforeEach(() => {
  vi.clearAllMocks(); controller = new AbortController();
  scope = { userId, signal: controller.signal, isInvalidated: false, ready: async (signal: AbortSignal) => signal.throwIfAborted() } as TaskCacheScope;
  vi.mocked(getTeam).mockResolvedValue(team());
});
const settings = () => render(<TeamSettingsPanel teamId={teamId} admission={scope} onIdentityMismatch={mismatch} onUpdated={updated} onDeleted={deleted} />);
const create = () => render(<CreateTeamDialog admission={scope} onIdentityMismatch={mismatch} onClose={closed} onCreated={created} />);

describe("Team management", () => {
  it("validates whitespace and submits the entered raw name once", async () => {
    vi.mocked(createTeam).mockImplementation(async (_id, name, _signal, _mismatch, dispatch) => { dispatch(); return team(name); });
    create(); const dialog = screen.getByRole("dialog"), name = within(dialog).getByLabelText(/Team name/);
    fireEvent.change(name, { target: { value: "\u2003\n " } }); fireEvent.click(within(dialog).getByRole("button", { name: "Create Team" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("valid name"); expect(createTeam).not.toHaveBeenCalled();
    fireEvent.change(name, { target: { value: "  Duplicate\nName  " } }); fireEvent.click(within(dialog).getByRole("button", { name: "Create Team" }));
    await waitFor(() => expect(created).toHaveBeenCalledWith(expect.objectContaining({ name: "  Duplicate\nName  " })));
    expect(createTeam).toHaveBeenCalledTimes(1); expect(vi.mocked(createTeam).mock.calls[0]?.[1]).toBe("  Duplicate\nName  ");
  });
  it("does not submit on Escape or cancellation", () => {
    create(); fireEvent.keyDown(document, { key: "Escape" }); expect(closed).toHaveBeenCalledTimes(1); expect(createTeam).not.toHaveBeenCalled();
  });
  it("retains unknown after a lost response and only reads current Teams", async () => {
    vi.mocked(createTeam).mockImplementation(async (_id, _name, _signal, _mismatch, dispatch) => { dispatch(); throw new ApiError("network"); });
    vi.mocked(listTeams).mockResolvedValue({ items: [team("Existing")], nextCursor: null });
    create(); fireEvent.change(screen.getByLabelText(/Team name/), { target: { value: "Existing" } }); fireEvent.click(screen.getByRole("button", { name: "Create Team" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("result is unknown");
    fireEvent.click(screen.getByRole("button", { name: "Check current state" })); await screen.findByText("Existing", { exact: false });
    expect(createTeam).toHaveBeenCalledTimes(1); expect(screen.queryByRole("button", { name: "Create Team" })).toBeNull();
  });
  it("treats a dispatched abort as unknown and does not replay", async () => {
    vi.mocked(createTeam).mockImplementation(async (_id, _name, _signal, _mismatch, dispatch) => { dispatch(); throw new DOMException("Connection ended", "AbortError"); });
    create(); fireEvent.change(screen.getByLabelText(/Team name/), { target: { value: "Name" } }); fireEvent.click(screen.getByRole("button", { name: "Create Team" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("unknown"); expect(createTeam).toHaveBeenCalledTimes(1); expect(created).not.toHaveBeenCalled();
  });
  it("blocks a repeated submission before unknown state has rendered", async () => {
    const response = Promise.withResolvers<Team>(); vi.mocked(createTeam).mockImplementation(async (_id, _name, _signal, _mismatch, dispatch) => { dispatch(); return response.promise; });
    create(); fireEvent.change(screen.getByLabelText(/Team name/), { target: { value: "Name" } }); const form = document.getElementById("create-team-form")!;
    fireEvent.submit(form); await waitFor(() => expect(createTeam).toHaveBeenCalledTimes(1));
    await act(async () => { response.reject(new ApiError("network")); for (let i = 0; i < 10; i++) await Promise.resolve(); fireEvent.submit(form); });
    expect(await screen.findByRole("alert")).toHaveTextContent("unknown"); expect(createTeam).toHaveBeenCalledTimes(1);
  });
  it("keeps Personal and member settings read-only", async () => {
    vi.mocked(getTeam).mockResolvedValueOnce(team("Member Team", 1n, "member")); settings();
    expect(await screen.findByText("Member Team")).toBeInTheDocument(); expect(screen.queryByRole("button", { name: "Edit" })).toBeNull(); expect(screen.getByRole("button", { name: "Delete Team" })).toBeDisabled();
  });
  it("localizes Team roles in both languages", async () => {
    const rendered = settings(); expect(await screen.findByText("Administrator")).toBeInTheDocument(); rendered.unmount();
    vi.mocked(getTeam).mockResolvedValue(team("Member", 1n, "member"));
    createLocaleRender("zh-CN")(<TeamSettingsPanel teamId={teamId} admission={scope} onIdentityMismatch={mismatch} onUpdated={updated} onDeleted={deleted} />);
    expect(await screen.findByText("成员")).toBeInTheDocument();
  });
  it("does not offer mutations on the Personal Team", async () => {
    vi.mocked(getTeam).mockResolvedValueOnce({ ...team("unused"), kind: "personal", name: null });
    settings(); expect(await screen.findByText("Personal")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.getByRole("button", { name: "Delete Team" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
  });
  it("does not install a wrong-principal mutation response", async () => {
    vi.mocked(createTeam).mockImplementation(async (_id, _name, _signal, onMismatch, dispatch) => { dispatch(); onMismatch(); throw new ApiError("protocol", 201, "principal_mismatch"); });
    create(); fireEvent.change(screen.getByLabelText(/Team name/), { target: { value: "Name" } }); fireEvent.click(screen.getByRole("button", { name: "Create Team" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("unknown"); expect(mismatch).toHaveBeenCalled(); expect(created).not.toHaveBeenCalled();
  });
  it("keeps newer membership when a rename receipt arrives after demotion", async () => {
    const write = Promise.withResolvers<Team>();
    const initial = team("Old", 1n), demoted = { ...team("Old", 1n, "member"), membership: { ...team("Old", 1n, "member").membership, version: 2n } };
    vi.mocked(getTeam).mockResolvedValueOnce(initial).mockResolvedValue(demoted);
    vi.mocked(renameTeam).mockImplementation(async (_id, _old, _name, _signal, _mismatch, dispatch) => { dispatch(); return write.promise; });
    const panel = (blocked: boolean) => <TeamSettingsPanel teamId={teamId} admission={scope} admissionBlocked={blocked} onIdentityMismatch={mismatch} onUpdated={updated} onDeleted={deleted} />;
    const view = render(panel(false)); fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const dialog = screen.getByRole("dialog", { name: "Edit Team name" });
    fireEvent.change(within(dialog).getByLabelText("Team name"), { target: { value: "New" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(renameTeam).toHaveBeenCalledOnce());
    view.rerender(panel(true)); view.rerender(panel(false));
    await waitFor(() => expect(getTeam).toHaveBeenCalledTimes(2));
    await act(async () => write.resolve(team("New", 2n)));
    await waitFor(() => expect(updated).toHaveBeenCalledOnce());
    expect(updated).toHaveBeenCalledWith(expect.objectContaining({ name: "New", version: 2n, membership: expect.objectContaining({ role: "member", version: 2n }) }));
    expect(screen.getByText("Only an admin of an ordinary Team can change its settings.")).toBeInTheDocument();
    expect(renameTeam).toHaveBeenCalledOnce();
  });
  it.each(["unguarded", "guarded"] as const)("isolates settings on a trusted 403 and recovers the %s editor", async (kind) => {
    const write = Promise.withResolvers<Team>();
    vi.mocked(renameTeam).mockImplementation(async (_id, _old, _name, _signal, _mismatch, dispatch) => { dispatch(); return write.promise; });
    vi.mocked(getTeam).mockResolvedValueOnce(team()).mockRejectedValueOnce(new ApiError("server", 403, "forbidden")).mockResolvedValue(team());
    const panel = (blocked: boolean) => <TeamSettingsPanel teamId={teamId} admission={scope} admissionBlocked={blocked} onIdentityMismatch={mismatch} onUpdated={updated} onDeleted={deleted} />;
    const view = render(panel(false)); fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const dialog = screen.getByRole("dialog", { name: "Edit Team name" });
    const name = within(dialog).getByLabelText("Team name"); fireEvent.change(name, { target: { value: "Draft" } });
    if (kind === "guarded") { fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" })); await waitFor(() => expect(renameTeam).toHaveBeenCalledOnce()); }
    view.rerender(panel(true)); view.rerender(panel(false));
    await waitFor(() => expect(dialog.parentElement).toHaveAttribute("hidden"));
    expect(screen.getAllByText("This Team is unavailable or you do not have access.").some((node) => node.offsetParent !== null || !node.closest('[hidden]'))).toBe(true);
    expect(document.querySelector(".team-settings-page")).toBeNull();
    if (kind === "guarded") { await act(async () => write.reject(new ApiError("network"))); await waitFor(() => expect(screen.getAllByText(/result is unknown/).some((node) => !node.closest('[hidden]'))).toBe(true)); }
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(dialog.parentElement).not.toHaveAttribute("hidden"));
    expect(screen.getByRole("dialog", { name: "Edit Team name" })).toBe(dialog);
    expect(within(dialog).getByLabelText("Team name")).toHaveValue("Draft");
    expect(renameTeam).toHaveBeenCalledTimes(kind === "guarded" ? 1 : 0);
  });
  it("retains an open editor and reports an ordinary recheck network failure", async () => {
    vi.mocked(getTeam).mockResolvedValueOnce(team()).mockRejectedValueOnce(new ApiError("network"));
    const panel = (blocked: boolean) => <TeamSettingsPanel teamId={teamId} admission={scope} admissionBlocked={blocked} onIdentityMismatch={mismatch} onUpdated={updated} onDeleted={deleted} />;
    const view = render(panel(false)); fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const dialog = screen.getByRole("dialog", { name: "Edit Team name" });
    view.rerender(panel(true)); view.rerender(panel(false));
    await waitFor(() => expect(screen.getAllByText("Unable to read the current state.").length).toBeGreaterThan(0));
    expect(dialog).toBeVisible(); expect(document.querySelector(".team-settings-page")).toBeVisible();
  });
  it("keeps delete outcome unknown after an unavailable reread", async () => {
    vi.mocked(deleteTeam).mockImplementation(async (_id, _team, _signal, _mismatch, dispatch) => { dispatch(); throw new ApiError("network"); });
    settings(); await screen.findByRole("button", { name: "Edit" }); fireEvent.click(screen.getByRole("button", { name: "Delete Team" }));
    const dialog = await screen.findByRole("dialog"); fireEvent.change(within(dialog).getByLabelText("Enter the Team name to confirm"), { target: { value: "  Alpha\nTeam  " } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete Team" })); expect(await within(dialog).findByRole("alert")).toHaveTextContent("unknown");
    vi.mocked(getTeam).mockRejectedValue(new ApiError("server", 404, "not_found")); fireEvent.click(within(dialog).getByRole("button", { name: "Check current state" }));
    await waitFor(() => expect(dialog.parentElement).toHaveAttribute("hidden"));
    expect(document.querySelector(".team-settings-page")).toBeNull();
    expect(screen.getByText("This Team is unavailable or you do not have access.", { selector: ".notice p" })).toBeVisible();
    expect(screen.getAllByText(/result is unknown/).some((node) => !node.closest("[hidden]"))).toBe(true);
    expect(deleteTeam).toHaveBeenCalledTimes(1); expect(deleted).not.toHaveBeenCalled();
  });
  it("requires typed name and sends original CRLF and exact version", async () => {
    vi.mocked(deleteTeam).mockImplementation(async (_id, target, _signal, _mismatch, dispatch) => { dispatch(); return { teamId: target.id, deleted: true }; });
    settings(); await screen.findByRole("button", { name: "Edit" }); fireEvent.click(screen.getByRole("button", { name: "Delete Team" }));
    const dialog = await screen.findByRole("dialog"), input = within(dialog).getByLabelText("Enter the Team name to confirm");
    fireEvent.change(input, { target: { value: "Alpha" } }); fireEvent.click(within(dialog).getByRole("button", { name: "Delete Team" })); expect(deleteTeam).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "  Alpha\nTeam  " } }); fireEvent.click(within(dialog).getByRole("button", { name: "Delete Team" }));
    await waitFor(() => expect(deleted).toHaveBeenCalledTimes(1)); expect(vi.mocked(deleteTeam).mock.calls[0]?.[1]).toMatchObject({ name: "  Alpha\r\nTeam  ", version: 9007199254740993n });
  });
  it("restores delete button focus after a delayed pre-confirmation read", async () => {
    const pending = Promise.withResolvers<Team>(); vi.mocked(getTeam).mockResolvedValueOnce(team("Old", 1n)).mockReturnValueOnce(pending.promise);
    settings(); await screen.findByText("Old"); const opener = screen.getByRole("button", { name: "Delete Team" }); opener.focus(); fireEvent.click(opener);
    expect(opener).toBeDisabled(); opener.blur(); await act(async () => pending.resolve(team("Old", 1n)));
    const dialog = await screen.findByRole("dialog"); fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(opener).toHaveFocus());
  });
  it("shows the newest name when opening delete observes a newer version", async () => {
    vi.mocked(getTeam).mockResolvedValueOnce(team("Old", 1n)).mockResolvedValue(team("New", 2n));
    settings(); await screen.findByText("Old");
    fireEvent.click(screen.getByRole("button", { name: "Delete Team" })); const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Team changed"); fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.getByText("New")).toBeInTheDocument(); expect(renameTeam).not.toHaveBeenCalled();
  });
  it("re-reads a conflicting name and requires a new typed confirmation", async () => {
    vi.mocked(getTeam).mockResolvedValueOnce(team("Old", 1n)).mockResolvedValueOnce(team("Old", 1n)).mockResolvedValue(team("New", 2n));
    vi.mocked(deleteTeam).mockImplementation(async (_id, _team, _signal, _mismatch, dispatch) => { dispatch(); throw new ApiError("server", 409, "version_conflict"); });
    settings(); await screen.findByText("Old"); fireEvent.click(screen.getByRole("button", { name: "Delete Team" }));
    const dialog = await screen.findByRole("dialog"); fireEvent.change(within(dialog).getByLabelText("Enter the Team name to confirm"), { target: { value: "Old" } }); fireEvent.click(within(dialog).getByRole("button", { name: "Delete Team" }));
    expect(await within(dialog).findByText("New")).toBeInTheDocument(); expect(within(dialog).getByLabelText("Enter the Team name to confirm")).toHaveValue("");
    expect(deleteTeam).toHaveBeenCalledTimes(1);
  });
  it("does not install a late success after unmount", async () => {
    const result = Promise.withResolvers<Team>(); vi.mocked(createTeam).mockImplementation(async (_id, _name, _signal, _mismatch, dispatch) => { dispatch(); return result.promise; });
    const rendered = create(); fireEvent.change(screen.getByLabelText(/Team name/), { target: { value: "Name" } }); fireEvent.click(screen.getByRole("button", { name: "Create Team" }));
    await waitFor(() => expect(createTeam).toHaveBeenCalledTimes(1)); rendered.unmount(); await act(async () => result.resolve(team("Name"))); expect(created).not.toHaveBeenCalled();
  });
  it("saves raw names with the version read and reports a nonempty Team rejection", async () => {
    vi.mocked(renameTeam).mockImplementation(async (_id, old, name, _signal, _mismatch, dispatch) => { dispatch(); return team(name, old.version + 1n); });
    vi.mocked(deleteTeam).mockImplementation(async (_id, _target, _signal, _mismatch, dispatch) => { dispatch(); throw new ApiError("server", 409, "team_not_empty"); });
    settings(); fireEvent.click(await screen.findByRole("button", { name: "Edit" })); fireEvent.change(screen.getByLabelText("Team name"), { target: { value: " New " } }); fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(updated).toHaveBeenCalledTimes(1)); expect(vi.mocked(renameTeam).mock.calls[0]?.[1].version).toBe(9007199254740993n);
    vi.mocked(getTeam).mockResolvedValue(team(" New ", 9007199254740994n)); fireEvent.click(screen.getByRole("button", { name: "Delete Team" })); const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Enter the Team name to confirm"), { target: { value: " New " } }); fireEvent.click(within(dialog).getByRole("button", { name: "Delete Team" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("still has projects"); expect(deleted).not.toHaveBeenCalled();
  });
  it("shows static Team information and resets cancelled or escaped rename drafts", async () => {
    settings(); const edit = await screen.findByRole("button", { name: "Edit" });
    expect(screen.getByText(teamId)).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.click(edit); let dialog = screen.getByRole("dialog");
    expect(within(dialog).getByLabelText("Team name")).toHaveValue("  Alpha\nTeam  ");
    fireEvent.change(within(dialog).getByLabelText("Team name"), { target: { value: "Cancelled" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(edit); dialog = screen.getByRole("dialog");
    expect(within(dialog).getByLabelText("Team name")).toHaveValue("  Alpha\nTeam  ");
    fireEvent.change(within(dialog).getByLabelText("Team name"), { target: { value: "Escaped" } });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull(); expect(renameTeam).not.toHaveBeenCalled();
  });
  it("retains the draft after rejection, validates names and prevents duplicate writes", async () => {
    const response = Promise.withResolvers<Team>();
    vi.mocked(renameTeam).mockImplementation(async (_id, _old, _name, _signal, _mismatch, dispatch) => { dispatch(); return response.promise; });
    const view = settings(); fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const dialog = screen.getByRole("dialog"), input = within(dialog).getByLabelText("Team name"), save = within(dialog).getByRole("button", { name: "Save changes" });
    fireEvent.change(input, { target: { value: "\u2003\n " } }); fireEvent.click(save);
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("valid name"); expect(renameTeam).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: " Duplicate\nName " } }); fireEvent.click(save); fireEvent.click(save);
    await waitFor(() => expect(renameTeam).toHaveBeenCalledTimes(1));
    expect(vi.mocked(renameTeam).mock.calls[0]?.[0]).toBe(userId);
    expect(vi.mocked(renameTeam).mock.calls[0]?.[1].version).toBe(9007199254740993n);
    expect(vi.mocked(renameTeam).mock.calls[0]?.[2]).toBe(" Duplicate\nName ");
    expect(within(dialog).queryByRole("combobox", { name: "语言 / Language" })).toBeNull();
    view.setLocale("zh-CN");
    expect(screen.getByRole("dialog", { name: "修改 Team 名称" })).toBe(dialog);
    expect(input).toHaveValue(" Duplicate\nName ");
    expect(within(dialog).getByRole("button", { name: "正在提交" })).toBeDisabled();
    expect(renameTeam).toHaveBeenCalledTimes(1);
    view.setLocale("en");
    await act(async () => response.reject(new ApiError("server", 400, "bad_request")));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("operation failed"); expect(input).toHaveValue(" Duplicate\nName ");
  });
  it("does not allow a lost rename to be replayed after closing the dialog", async () => {
    vi.mocked(renameTeam).mockImplementation(async (_id, _old, _name, _signal, _mismatch, dispatch) => { dispatch(); throw new ApiError("network"); });
    settings(); fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const dialog = screen.getByRole("dialog"); fireEvent.change(within(dialog).getByLabelText("Team name"), { target: { value: "New" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("unknown");
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    const edit = screen.getByRole("button", { name: "Edit" }); expect(edit).toBeDisabled();
    fireEvent.click(edit); expect(screen.queryByRole("dialog")).toBeNull(); expect(renameTeam).toHaveBeenCalledTimes(1);
  });

  it("retains the rename draft after a conflict and retries only on explicit submission with the latest version", async () => {
    const reread = Promise.withResolvers<Team>();
    vi.mocked(getTeam).mockResolvedValueOnce(team("Old", 1n)).mockReturnValueOnce(reread.promise);
    vi.mocked(renameTeam).mockImplementationOnce(async (_id, _old, _name, _signal, _mismatch, dispatch) => { dispatch(); throw new ApiError("server", 409, "version_conflict"); })
      .mockImplementationOnce(async (_id, old, name, _signal, _mismatch, dispatch) => { dispatch(); return team(name, old.version + 1n); });
    settings(); fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const dialog = screen.getByRole("dialog"), input = within(dialog).getByLabelText("Team name");
    fireEvent.change(input, { target: { value: "Draft" } }); fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(getTeam).toHaveBeenCalledTimes(2));
    expect(within(dialog).getByRole("button", { name: "Save changes" })).toBeDisabled();
    await act(async () => reread.resolve(team("Concurrent", 2n)));
    expect(await within(dialog).findByText("Concurrent")).toBeInTheDocument();
    expect(input).toHaveValue("Draft"); expect(renameTeam).toHaveBeenCalledTimes(1);
    fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(updated).toHaveBeenCalledTimes(1));
    expect(vi.mocked(renameTeam).mock.calls[1]?.[1]).toMatchObject({ name: "Concurrent", version: 2n });
    expect(vi.mocked(renameTeam).mock.calls[1]?.[2]).toBe("Draft");
  });

});

describe("Team ID copy", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each(["admin", "member"] as const)("copies the complete displayed ID for an %s without business writes", async (role) => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    vi.mocked(getTeam).mockResolvedValue(team("Alpha", 1n, role));
    settings();
    const copy = await screen.findByRole("button", { name: "Copy Team ID" });
    expect(copy).toHaveAttribute("title", "Copy Team ID");
    expect(copy.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByText(teamId)).toBeInTheDocument();
    fireEvent.click(copy);
    expect(await screen.findByRole("status", { name: "" })).toHaveTextContent("Copied");
    expect(writeText).toHaveBeenCalledExactlyOnceWith(teamId);
    expect(renameTeam).not.toHaveBeenCalled(); expect(deleteTeam).not.toHaveBeenCalled();
  });

  it("localizes the accessible name, hover text, success and failure", async () => {
    const writeText = vi.fn().mockRejectedValueOnce(new Error("denied")).mockResolvedValueOnce(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    createLocaleRender("zh-CN")(<TeamSettingsPanel teamId={teamId} admission={scope} onIdentityMismatch={mismatch} onUpdated={updated} onDeleted={deleted} />);
    const copy = await screen.findByRole("button", { name: "复制 Team ID" });
    expect(copy).toHaveAttribute("title", "复制 Team ID");
    fireEvent.click(copy);
    expect(await screen.findByRole("alert")).toHaveTextContent("无法复制，请手动选择 Team ID 复制。");
    expect(screen.getByText(teamId)).toBeInTheDocument();
    fireEvent.click(copy);
    expect(await screen.findByText("已复制")).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledTimes(2);
    expect(writeText).toHaveBeenLastCalledWith(teamId);
  });

  it("reports unavailable clipboard access and permits retry", async () => {
    vi.stubGlobal("navigator", {});
    settings(); const copy = await screen.findByRole("button", { name: "Copy Team ID" });
    fireEvent.click(copy);
    expect(await screen.findByRole("alert")).toHaveTextContent("Clipboard unavailable. Select and copy the Team ID manually.");
    expect(screen.getByText(teamId)).toBeInTheDocument();
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    fireEvent.click(copy);
    expect(await screen.findByText("Copied")).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledExactlyOnceWith(teamId);
  });

  it("prevents repeated activation while the clipboard write is pending", async () => {
    const result = Promise.withResolvers<void>();
    const writeText = vi.fn().mockReturnValue(result.promise);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    settings(); const copy = await screen.findByRole("button", { name: "Copy Team ID" });
    fireEvent.click(copy); fireEvent.click(copy);
    expect(copy).toHaveAttribute("aria-disabled", "true"); expect(writeText).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Copied")).toBeNull();
    await act(async () => result.resolve());
    expect(await screen.findByText("Copied")).toBeInTheDocument(); expect(copy).not.toHaveAttribute("aria-disabled", "true");
  });

  it("does not show a late result on another Team after unmount", async () => {
    const result = Promise.withResolvers<void>();
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn().mockReturnValue(result.promise) } });
    const view = settings(); fireEvent.click(await screen.findByRole("button", { name: "Copy Team ID" }));
    view.unmount();
    const nextId = "00000000-0000-4000-8000-000000000003";
    vi.mocked(getTeam).mockResolvedValue({ ...team("Next"), id: nextId, membership: { ...team().membership, teamId: nextId } });
    render(<TeamSettingsPanel teamId={nextId} admission={scope} onIdentityMismatch={mismatch} onUpdated={updated} onDeleted={deleted} />);
    await screen.findByText(nextId);
    await act(async () => result.resolve());
    expect(screen.queryByText("Copied")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("retains pending and focus across a same-user identity recheck until admission is ready", async () => {
    const result = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
    const writeText = vi.fn().mockReturnValue(result.promise);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    let checking = false;
    const checkedScope = scope;
    vi.spyOn(checkedScope, "ready").mockImplementation(async (signal: AbortSignal) => { if (checking) await gate.promise; signal.throwIfAborted(); });
    const panel = (blocked: boolean) => <TeamSettingsPanel teamId={teamId} admission={checkedScope} admissionBlocked={blocked} onIdentityMismatch={mismatch} onUpdated={updated} onDeleted={deleted} />;
    const view = render(panel(false));
    const copy = await screen.findByRole("button", { name: "Copy Team ID" });
    copy.focus(); fireEvent.click(copy);
    checking = true; view.rerender(panel(true));
    await act(async () => result.resolve());
    expect(copy).toHaveFocus(); expect(copy).toHaveAttribute("aria-disabled", "true");
    expect(screen.queryByText("Copied")).toBeNull();
    fireEvent.click(copy); expect(writeText).toHaveBeenCalledTimes(1);
    checking = false; view.rerender(panel(false));
    expect(screen.queryByText("Copied")).toBeNull();
    await act(async () => gate.resolve());
    expect(await screen.findByText("Copied")).toBeInTheDocument();
    expect(copy).toHaveFocus(); expect(copy).not.toHaveAttribute("aria-disabled", "true");
  });

  it("suppresses a clipboard result after identity invalidation", async () => {
    const result = Promise.withResolvers<void>();
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn().mockReturnValue(result.promise) } });
    settings(); fireEvent.click(await screen.findByRole("button", { name: "Copy Team ID" }));
    await act(async () => { controller.abort(); result.reject(new Error("denied")); });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("Copied")).toBeNull();
  });

  it("offers no copy action while the initial Team read has no data", async () => {
    const result = Promise.withResolvers<Team>(); vi.mocked(getTeam).mockReturnValue(result.promise);
    settings();
    expect(screen.queryByRole("button", { name: "Copy Team ID" })).toBeNull();
    await act(async () => result.resolve(team()));
    expect(await screen.findByRole("button", { name: "Copy Team ID" })).toBeInTheDocument();
  });
});
