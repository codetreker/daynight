import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, invalidateAuthRequests, pauseAuthRequests } from "../src/api/client";
import type { OwnerGrant } from "../src/api/oauth-grants";
import { OwnerGrantsPanel } from "../src/features/management/OwnerGrantsPanel";
import { TokensPanel, type TokenManagementApi } from "../src/features/management/TokensPanel";
import { createLocaleRender } from "./helpers/renderWithLocale";

const render = createLocaleRender("zh-CN");
const user = { personalTeam: { id: "00000000-0000-4000-8000-000000000701", kind: "personal" as const, name: null }, id: "00000000-0000-4000-8000-000000000001", name: "Alice", email: "alice@example.com", emailVerified: true, avatarUrl: null };
const grant: OwnerGrant = { id: "00000000-0000-4000-8000-000000000002", lastUsedAt: null, clientName: "App", clientId: "https://client.test", resource: "https://daynight.cc/mcp", scope: "daynight:mcp", createdAt: "2026-10-25T10:00:00Z", expiresAt: "2099-10-25T10:00:00Z", revokedAt: null, status: "active" };
const token = { id: "00000000-0000-4000-8000-000000000005", name: "CLI", lastUsedAt: null, createdAt: "2026-10-25T10:00:00Z", expiresAt: null };
const deferred = <T,>() => { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const fixture = (items: readonly OwnerGrant[] = [grant]) => ({ list: vi.fn().mockResolvedValue(items), revoke: vi.fn().mockImplementation((_id, _user, _signal, _mismatch, onDispatch?: () => void) => { onDispatch?.(); return Promise.resolve(true); }) });
const panel = (transport: ReturnType<typeof fixture>) => <OwnerGrantsPanel user={user} onIdentityMismatch={vi.fn()} transport={transport} />;
const open = () => fireEvent.click(screen.getByRole("button", { name: "撤销 App 的应用授权" }));

beforeEach(() => sessionStorage.clear());
afterEach(() => invalidateAuthRequests());

describe("application authorizations", () => {
  it("preserves open details and focus as refreshed usage advances, ignores older values and isolates replacement grants", async () => {
    const old = "2026-11-12T11:00:00Z", recent = "2026-11-12T12:00:00.123456789Z";
    const read = deferred<readonly OwnerGrant[]>();
    const transport = fixture([{ ...grant, lastUsedAt: old }]);
    transport.list.mockResolvedValueOnce([{ ...grant, lastUsedAt: old }]).mockReturnValueOnce(read.promise)
      .mockResolvedValueOnce([{ ...grant, lastUsedAt: null }])
      .mockResolvedValueOnce([{ ...grant, id: "00000000-0000-4000-8000-000000000003", lastUsedAt: null }]);
    render(panel(transport)); await screen.findByText("App");
    const summary = document.querySelector<HTMLElement>(".credential-last-use summary")!;
    fireEvent.click(summary); expect(summary.parentElement).toHaveAttribute("open");
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    summary.focus(); expect(summary).toHaveFocus();
    await act(async () => read.resolve([{ ...grant, lastUsedAt: recent }]));
    expect(document.querySelector(".credential-last-use summary")).toBe(summary);
    expect(summary).toHaveFocus(); expect(summary.parentElement).toHaveAttribute("open");
    expect(summary.querySelector("time")).toHaveAttribute("datetime", recent);
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    await act(async () => {});
    expect(summary.querySelector("time")).toHaveAttribute("datetime", recent);
    expect(summary.parentElement).toHaveAttribute("open");
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    await act(async () => {});
    expect(screen.getByText("最后使用: 暂无使用记录")).toBeInTheDocument();
    expect(document.querySelector(".credential-last-use")).toBeNull();
    expect(transport.list).toHaveBeenCalledTimes(4);
  });

  it("retains the selected grant and dialog focus while an updated list arrives", async () => {
    const first = fixture([{ ...grant, lastUsedAt: "2026-11-12T11:00:00Z" }]);
    const read = deferred<readonly OwnerGrant[]>();
    const next = fixture(); next.list.mockReturnValue(read.promise);
    const node = (transport: ReturnType<typeof fixture>) => <OwnerGrantsPanel user={user} onIdentityMismatch={vi.fn()} transport={transport} />;
    const view = render(node(first)); await screen.findByText("App"); open();
    const dialog = screen.getByRole("dialog"), close = within(dialog).getByRole("button", { name: "关闭对话框" });
    close.focus(); expect(close).toHaveFocus();
    view.rerender(node(next));
    expect(screen.getByRole("dialog")).toBe(dialog); expect(close).toHaveFocus();
    await act(async () => read.resolve([{ ...grant, lastUsedAt: "2026-11-12T12:00:00Z" }]));
    expect(screen.getByRole("dialog")).toBe(dialog); expect(close).toHaveFocus();
    expect(within(dialog).getByText("App")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "撤销授权" }));
    expect(next.revoke.mock.calls[0]?.[0]).toBe(grant.id);
  });

  it("renders active, expired, revoked and empty states without granting PAT controls", async () => {
    const expired = { ...grant, id: "00000000-0000-4000-8000-000000000003", clientName: "Old", status: "expired" as const };
    const revoked = { ...grant, id: "00000000-0000-4000-8000-000000000004", clientName: "Gone", status: "revoked" as const, revokedAt: "2026-10-26T10:00:00Z" };
    const transport = fixture([grant, expired, revoked]); render(panel(transport));
    await screen.findByText("App"); expect(screen.getAllByText("daynight:mcp", { exact: false })).toHaveLength(3);
    expect(screen.getByText("有效")).toBeInTheDocument(); expect(screen.getByText("已过期")).toBeInTheDocument(); expect(screen.getByText("已撤销")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /撤销 .* 的应用授权/ })).toHaveLength(1);
    transport.list.mockResolvedValue([]); fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    await screen.findByText("你还没有授权任何应用。");
  });
  it("displays the intended account and client and restores focus on Escape", async () => {
    const transport = fixture(); render(panel(transport)); await screen.findByText("App");
    const button = screen.getByRole("button", { name: "撤销 App 的应用授权" }); button.focus(); open();
    const dialog = screen.getByRole("dialog", { name: "撤销应用授权？" });
    expect(within(dialog).getByText("Alice")).toBeInTheDocument(); expect(within(dialog).getByText(/https:\/\/daynight.cc\/mcp/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "关闭对话框" })).toHaveFocus();
    fireEvent.keyDown(document, { key: "Escape" }); expect(screen.queryByRole("dialog")).toBeNull(); expect(button).toHaveFocus();
  });
  it("never replays an unknown revoke and requires explicit read even after a failed read", async () => {
    const transport = fixture(); transport.revoke.mockImplementation((_id, _user, _signal, _mismatch, onDispatch?: () => void) => { onDispatch?.(); return Promise.reject(new ApiError("network")); });
    transport.list.mockResolvedValueOnce([grant]).mockRejectedValueOnce(new ApiError("network")).mockResolvedValueOnce([{ ...grant, status: "revoked", revokedAt: "2026-10-26T10:00:00Z" }]);
    render(panel(transport)); await screen.findByText("App"); open(); fireEvent.click(screen.getByRole("button", { name: "撤销授权" }));
    await screen.findByText(/撤销请求的结果尚未确认/); expect(transport.list).toHaveBeenCalledTimes(1); expect(transport.revoke).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "读取当前状态" }));
    await screen.findByText("操作未能完成，请重试。"); expect(transport.revoke).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "读取当前状态" }));
    await screen.findByText(/原请求的结果仍未确认/); expect(screen.getByText("已撤销")).toBeInTheDocument();
    expect(transport.list).toHaveBeenCalledTimes(3); expect(transport.revoke).toHaveBeenCalledTimes(1);
  });
  it("preserves a PAT draft and existing grant rows during a pending refresh", async () => {
    const read = deferred<readonly OwnerGrant[]>(); const transport = fixture(); transport.list.mockResolvedValueOnce([grant]).mockReturnValueOnce(read.promise);
    const pats: TokenManagementApi = { list: vi.fn().mockResolvedValue([token]), create: vi.fn(), revoke: vi.fn(), update: vi.fn() };
    render(<><TokensPanel user={user} onIdentityMismatch={vi.fn()} transport={pats} />{panel(transport)}</>);
    await screen.findByText("App"); await screen.findByText("CLI");
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    expect(screen.getByText("App")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "创建令牌" }));
    fireEvent.change(screen.getByLabelText(/令牌名称/), { target: { value: "draft" } });
    await act(async () => read.resolve([grant]));
    expect(screen.getByLabelText(/令牌名称/)).toHaveValue("draft"); expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
  it("keeps the recovery prompt and useful focus after closing an unknown dialog", async () => {
    const transport = fixture(); transport.revoke.mockImplementation((_id, _user, _signal, _mismatch, onDispatch?: () => void) => { onDispatch?.(); return Promise.reject(new ApiError("network")); });
    render(panel(transport)); await screen.findByText("App"); open(); fireEvent.click(screen.getByRole("button", { name: "撤销授权" }));
    await screen.findByText(/撤销请求的结果尚未确认/); fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByRole("heading", { name: "应用授权" })).toHaveFocus();
    expect(screen.getByRole("button", { name: "读取当前状态" })).toBeEnabled();
  });
  it("does not dispatch when session storage cannot record the recovery marker", async () => {
    const transport = fixture(); render(panel(transport)); await screen.findByText("App"); open();
    const storage = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("denied"); });
    fireEvent.click(screen.getByRole("button", { name: "撤销授权" }));
    expect(within(screen.getByRole("dialog")).getByText(/浏览器会话存储不可用/)).toBeInTheDocument(); expect(transport.revoke).not.toHaveBeenCalled();
    storage.mockRestore(); fireEvent.click(screen.getByRole("button", { name: "撤销授权" }));
    await screen.findByText(/应用授权已撤销/); expect(transport.revoke).toHaveBeenCalledTimes(1);
  });
  it("keeps a dispatched unknown across unmount, reload and account changes until an explicit read", async () => {
    const response = deferred<boolean>(); const transport = fixture(); transport.revoke.mockReturnValue(response.promise);
    const view = render(panel(transport)); await screen.findByText("App"); open(); fireEvent.click(screen.getByRole("button", { name: "撤销授权" }));
    expect(sessionStorage.getItem(`daynight.oauthGrantRecovery.${user.id}`)).toBe(grant.id);
    view.unmount();
    const another = { ...user, id: "00000000-0000-4000-8000-000000000099" };
    const otherView = render(<OwnerGrantsPanel user={another} onIdentityMismatch={vi.fn()} transport={transport} />);
    await screen.findByText("App"); expect(screen.queryByText(/撤销请求的结果尚未确认/)).toBeNull();
    otherView.unmount();
    const restored = render(panel(transport)); await screen.findByText(/撤销请求的结果尚未确认/);
    expect(transport.list).toHaveBeenCalledTimes(2); expect(screen.queryByText("App")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "读取当前状态" }));
    await screen.findByText(/原请求的结果仍未确认/);
    expect(sessionStorage.getItem(`daynight.oauthGrantRecovery.${user.id}`)).toBeNull();
    expect(transport.list).toHaveBeenCalledTimes(3); expect(transport.revoke).toHaveBeenCalledTimes(1); restored.unmount();
  });
  it("holds a delayed grant read while identity is rechecked and discards it on replacement", async () => {
    const read = deferred<readonly OwnerGrant[]>(); const transport = fixture(); transport.list.mockReturnValueOnce(read.promise);
    const view = render(panel(transport)); const release = pauseAuthRequests();
    await act(async () => read.resolve([grant])); expect(screen.queryByText("App")).toBeNull();
    view.unmount(); invalidateAuthRequests(); release();
    const another = { ...user, id: "00000000-0000-4000-8000-000000000099" };
    transport.list.mockResolvedValue([]);
    render(<OwnerGrantsPanel user={another} onIdentityMismatch={vi.fn()} transport={transport} />);
    await screen.findByText("你还没有授权任何应用。"); expect(screen.queryByText("App")).toBeNull();
  });
  it("publishes the original initial read after a temporary pause resumes", async () => {
    const read = deferred<readonly OwnerGrant[]>(); const transport = fixture();
    transport.list.mockReturnValueOnce(read.promise);
    render(panel(transport));
    expect(transport.list).toHaveBeenCalledTimes(1);
    const resume = pauseAuthRequests();
    await act(async () => read.resolve([grant]));
    expect(screen.queryByText("App")).toBeNull();
    expect(transport.list).toHaveBeenCalledTimes(1);
    await act(async () => resume());
    expect(await screen.findByText("App")).toBeInTheDocument();
    expect(screen.getByText("有效")).toBeInTheDocument();
    expect(transport.list).toHaveBeenCalledTimes(1);
  });
  it("starts its initial read only after a mount-time pause resumes", async () => {
    const transport = fixture(); const resume = pauseAuthRequests();
    render(panel(transport));
    expect(transport.list).not.toHaveBeenCalled();
    expect(screen.queryByText("App")).toBeNull();
    await act(async () => resume());
    expect(await screen.findByText("App")).toBeInTheDocument();
    expect(transport.list).toHaveBeenCalledTimes(1);
  });
  it("does not start its initial read after a paused panel is destroyed", async () => {
    const transport = fixture(); const resume = pauseAuthRequests();
    const view = render(panel(transport));
    expect(transport.list).not.toHaveBeenCalled();
    view.unmount();
    await act(async () => resume());
    expect(transport.list).not.toHaveBeenCalled();
  });
  it("clears the dispatch marker after a definite refusal and permits an explicit new attempt", async () => {
    const transport = fixture(); transport.revoke.mockRejectedValue(new ApiError("server", 403, "forbidden"));
    render(panel(transport)); await screen.findByText("App"); open(); fireEvent.click(screen.getByRole("button", { name: "撤销授权" }));
    await screen.findByText("操作未能完成，请重试。"); expect(sessionStorage.getItem(`daynight.oauthGrantRecovery.${user.id}`)).toBeNull();
    expect(screen.getByRole("button", { name: "撤销授权" })).not.toBeDisabled(); expect(transport.list).toHaveBeenCalledTimes(1);
  });
  it("shows a confirmed revocation only after reading current state", async () => {
    const response = deferred<boolean>();
    const read = deferred<readonly OwnerGrant[]>();
    const transport = fixture();
    transport.revoke.mockReturnValueOnce(response.promise);
    transport.list.mockResolvedValueOnce([grant]).mockReturnValueOnce(read.promise);
    render(panel(transport));
    await screen.findByText("App");
    open();
    const dialog = screen.getByRole("dialog", { name: "撤销应用授权？" });
    fireEvent.click(within(dialog).getByRole("button", { name: "撤销授权" }));
    expect(transport.revoke).toHaveBeenCalledTimes(1);
    expect(transport.list).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/应用授权已撤销/)).toBeNull();

    await act(async () => response.resolve(true));
    expect(transport.list).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(dialog).toHaveAttribute("aria-busy", "true");
    expect(screen.getByText("有效")).toBeInTheDocument();
    expect(screen.queryByText(/应用授权已撤销/)).toBeNull();
    expect(screen.queryByText("已撤销")).toBeNull();

    // The read's React updates and passive focus restoration must both settle.
    await act(async () => read.resolve([{ ...grant, status: "revoked", revokedAt: "2026-10-26T10:00:00Z" }]));
    expect(screen.getByText(/应用授权已撤销/)).toBeInTheDocument();
    expect(screen.getByText("已撤销")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("heading", { name: "应用授权" })).toHaveFocus();
    expect(transport.revoke).toHaveBeenCalledTimes(1);
    expect(transport.list).toHaveBeenCalledTimes(2);
    expect(sessionStorage.getItem(`daynight.oauthGrantRecovery.${user.id}`)).toBeNull();
  });
  it("cancels preparation on pause without dispatch or a recovery read", async () => {
    const transport = fixture();
    let operationSignal: AbortSignal | undefined;
    const preparation = deferred<void>(); const dispatched = vi.fn();
    transport.revoke.mockImplementation((_id, _user, signal: AbortSignal, _mismatch, onDispatch?: () => void) => {
      operationSignal = signal;
      return new Promise<boolean>((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        void preparation.promise.then(() => { if (!signal.aborted) { dispatched(); onDispatch?.(); resolve(true); } });
      });
    });
    render(panel(transport)); await screen.findByText("App"); open();
    fireEvent.click(screen.getByRole("button", { name: "撤销授权" }));
    expect(transport.revoke).toHaveBeenCalledTimes(1);
    expect(operationSignal?.aborted).toBe(false);
    let resume!: () => void;
    await act(async () => { resume = pauseAuthRequests(); });
    expect(operationSignal?.aborted).toBe(true);
    expect(dispatched).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-busy", "false");
    expect(screen.getByText("有效")).toBeInTheDocument();
    expect(transport.list).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(`daynight.oauthGrantRecovery.${user.id}`)).toBeNull();
    await act(async () => { preparation.resolve(); resume(); });
    expect(dispatched).not.toHaveBeenCalled();
    expect(transport.revoke).toHaveBeenCalledTimes(1);
    expect(transport.list).toHaveBeenCalledTimes(1);
  });
  it.each([new ApiError("network"), new DOMException("Network cancelled", "AbortError")])("settles a dispatched unknown during pause without reading or replaying: %s", async (failure) => {
    const response = deferred<boolean>(); const transport = fixture();
    transport.revoke.mockImplementation((_id, _user, _signal, _mismatch, onDispatch?: () => void) => { onDispatch?.(); return response.promise; });
    render(panel(transport)); await screen.findByText("App"); open();
    fireEvent.click(screen.getByRole("button", { name: "撤销授权" }));
    const resume = pauseAuthRequests();
    await act(async () => response.reject(failure));
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-busy", "false");
    expect(screen.getByText(/撤销请求的结果尚未确认/)).toBeInTheDocument();
    expect(screen.getByText("有效")).toBeInTheDocument();
    expect(sessionStorage.getItem(`daynight.oauthGrantRecovery.${user.id}`)).toBe(grant.id);
    expect(transport.list).toHaveBeenCalledTimes(1); expect(transport.revoke).toHaveBeenCalledTimes(1);
    await act(async () => resume());
    expect(transport.list).toHaveBeenCalledTimes(1); expect(transport.revoke).toHaveBeenCalledTimes(1);
  });
  it("keeps a definite refusal distinct from an unknown result during pause", async () => {
    const response = deferred<boolean>(); const transport = fixture();
    transport.revoke.mockImplementation((_id, _user, _signal, _mismatch, onDispatch?: () => void) => { onDispatch?.(); return response.promise; });
    render(panel(transport)); await screen.findByText("App"); open();
    fireEvent.click(screen.getByRole("button", { name: "撤销授权" }));
    const resume = pauseAuthRequests();
    await act(async () => response.reject(new ApiError("server", 403, "forbidden")));
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-busy", "false");
    expect(screen.queryByText(/撤销请求的结果尚未确认/)).toBeNull();
    expect(sessionStorage.getItem(`daynight.oauthGrantRecovery.${user.id}`)).toBeNull();
    expect(transport.list).toHaveBeenCalledTimes(1); expect(transport.revoke).toHaveBeenCalledTimes(1);
    await act(async () => resume());
    await screen.findByText("操作未能完成，请重试。");
    expect(transport.list).toHaveBeenCalledTimes(1); expect(transport.revoke).toHaveBeenCalledTimes(1);
  });
  it("does not carry an old refusal into a newly opened grant dialog", async () => {
    const other = { ...grant, id: "00000000-0000-4000-8000-000000000003", clientName: "Other" };
    const response = deferred<boolean>(); const transport = fixture([grant, other]);
    transport.revoke.mockImplementation((_id, _user, _signal, _mismatch, onDispatch?: () => void) => { onDispatch?.(); return response.promise; });
    render(panel(transport)); await screen.findByText("App"); open();
    fireEvent.click(screen.getByRole("button", { name: "撤销授权" }));
    const resume = pauseAuthRequests();
    await act(async () => response.reject(new ApiError("server", 403, "forbidden")));
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    fireEvent.click(screen.getByRole("button", { name: "撤销 Other 的应用授权" }));
    expect(within(screen.getByRole("dialog")).getByText("Other")).toBeInTheDocument();
    await act(async () => resume());
    expect(within(screen.getByRole("dialog")).queryByText("操作未能完成，请重试。")).toBeNull();
    expect(transport.list).toHaveBeenCalledTimes(1); expect(transport.revoke).toHaveBeenCalledTimes(1);
  });
  it("retains a confirmed receipt while paused and publishes only after admission resumes", async () => {
    const response = deferred<boolean>(); const transport = fixture();
    transport.revoke.mockImplementation((_id, _user, _signal, _mismatch, onDispatch?: () => void) => { onDispatch?.(); return response.promise; });
    transport.list.mockResolvedValueOnce([grant]).mockResolvedValueOnce([{ ...grant, status: "revoked", revokedAt: "2026-10-26T10:00:00Z" }]);
    render(panel(transport)); await screen.findByText("App"); open();
    fireEvent.click(screen.getByRole("button", { name: "撤销授权" }));
    const resume = pauseAuthRequests();
    await act(async () => response.resolve(true));
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-busy", "false");
    expect(screen.getByText("有效")).toBeInTheDocument();
    expect(screen.queryByText(/应用授权已撤销/)).toBeNull();
    expect(sessionStorage.getItem(`daynight.oauthGrantRecovery.${user.id}`)).toBe(grant.id);
    expect(transport.list).toHaveBeenCalledTimes(1); expect(transport.revoke).toHaveBeenCalledTimes(1);
    await act(async () => resume());
    await screen.findByText(/应用授权已撤销/);
    expect(screen.getByText("已撤销")).toBeInTheDocument();
    expect(transport.list).toHaveBeenCalledTimes(2); expect(transport.revoke).toHaveBeenCalledTimes(1);
  });
  it("preserves a reopened visible dialog and focus when a confirmed read completes", async () => {
    const response = deferred<boolean>(); const read = deferred<readonly OwnerGrant[]>(); const transport = fixture();
    transport.revoke.mockImplementation((_id, _user, _signal, _mismatch, onDispatch?: () => void) => { onDispatch?.(); return response.promise; });
    transport.list.mockResolvedValueOnce([grant]).mockReturnValueOnce(read.promise);
    const node = (visible: boolean) => <OwnerGrantsPanel user={user} onIdentityMismatch={vi.fn()} transport={transport} visible={visible} />;
    const view = render(node(true)); await screen.findByText("App"); open();
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "撤销授权" }));
    const resume = pauseAuthRequests();
    await act(async () => response.resolve(true));
    view.rerender(node(false)); view.rerender(node(true));
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(transport.list).toHaveBeenCalledTimes(1);
    await act(async () => resume());
    expect(transport.list).toHaveBeenCalledTimes(2);
    const close = within(dialog).getByRole("button", { name: "关闭对话框" });
    close.focus(); expect(close).toHaveFocus();
    await act(async () => read.resolve([{ ...grant, status: "revoked", revokedAt: "2026-10-26T10:00:00Z" }]));
    expect(screen.getByRole("dialog")).toBe(dialog); expect(close).toHaveFocus();
    expect(screen.getByText("已撤销")).toBeInTheDocument();
    const confirm = within(dialog).getByRole("button", { name: "撤销授权" });
    expect(confirm).toBeDisabled(); fireEvent.click(confirm);
    expect(transport.revoke).toHaveBeenCalledTimes(1);
  });
  it("cancels a delayed confirmed publication when its panel is replaced", async () => {
    const response = deferred<boolean>(); const transport = fixture();
    transport.revoke.mockImplementation((_id, _user, _signal, _mismatch, onDispatch?: () => void) => { onDispatch?.(); return response.promise; });
    const view = render(panel(transport)); await screen.findByText("App"); open();
    fireEvent.click(screen.getByRole("button", { name: "撤销授权" }));
    const resume = pauseAuthRequests();
    await act(async () => response.resolve(true));
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-busy", "false");
    view.unmount();
    await act(async () => resume());
    expect(transport.list).toHaveBeenCalledTimes(1); expect(transport.revoke).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(`daynight.oauthGrantRecovery.${user.id}`)).toBe(grant.id);
  });
  it("settles a dispatched revoke as unknown when the panel transport is replaced", async () => {
    const first = fixture(); const second = fixture(); let operationSignal: AbortSignal | undefined;
    first.revoke.mockImplementation((_id, _user, signal: AbortSignal, _mismatch, onDispatch?: () => void) => {
      operationSignal = signal; onDispatch?.();
      return new Promise<boolean>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    });
    const view = render(panel(first)); await screen.findByText("App"); open();
    fireEvent.click(screen.getByRole("button", { name: "撤销授权" }));
    expect(operationSignal?.aborted).toBe(false);
    await act(async () => { view.rerender(panel(second)); });
    expect(operationSignal?.aborted).toBe(true);
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-busy", "false");
    expect(screen.getByText(/撤销请求的结果尚未确认/)).toBeInTheDocument();
    expect(sessionStorage.getItem(`daynight.oauthGrantRecovery.${user.id}`)).toBe(grant.id);
    expect(first.revoke).toHaveBeenCalledTimes(1); expect(second.revoke).not.toHaveBeenCalled();
    expect(second.list).not.toHaveBeenCalled();
  });
  it("keeps a confirmed receipt when its reconciliation read fails", async () => {
    const response = deferred<boolean>(); const transport = fixture();
    transport.revoke.mockImplementation((_id, _user, _signal, _mismatch, onDispatch?: () => void) => { onDispatch?.(); return response.promise; });
    transport.list.mockResolvedValueOnce([grant]).mockRejectedValueOnce(new ApiError("network"))
      .mockResolvedValueOnce([{ ...grant, status: "revoked", revokedAt: "2026-10-26T10:00:00Z" }]);
    render(panel(transport)); await screen.findByText("App"); open();
    fireEvent.click(screen.getByRole("button", { name: "撤销授权" }));
    const resume = pauseAuthRequests();
    await act(async () => response.resolve(true));
    await act(async () => resume());
    await screen.findByText("操作未能完成，请重试。");
    expect(screen.queryByText(/撤销请求的结果尚未确认/)).toBeNull();
    expect(sessionStorage.getItem(`daynight.oauthGrantRecovery.${user.id}`)).toBe(grant.id);
    fireEvent.click(screen.getByRole("button", { name: "读取当前状态" }));
    await screen.findByText(/应用授权已撤销/);
    expect(screen.queryByText(/原请求的结果仍未确认/)).toBeNull();
    expect(transport.revoke).toHaveBeenCalledTimes(1); expect(transport.list).toHaveBeenCalledTimes(3);
  });
});
