import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/api/client";
import type { DeviceAuthorizationInspection } from "../src/api/auth-types";
import { DeviceAuthorizationPage, type DeviceAuthorizationApi } from "../src/features/auth/DeviceAuthorizationPage";
import { createLocaleRender } from "./helpers/renderWithLocale";

const render = createLocaleRender("zh-CN");
const code = "BCDFG-HJKLM";
const user = { id: "00000000-0000-4000-8000-000000000001", name: "Alice", email: "alice@example.com", emailVerified: true, avatarUrl: null };
const inspection = (status: DeviceAuthorizationInspection["status"] = "pending"): DeviceAuthorizationInspection => ({ userCode: code, status, expiresAt: new Date(Date.now() + 600_000).toISOString() });
const fixture = () => ({ inspect: vi.fn<DeviceAuthorizationApi["inspect"]>().mockResolvedValue(inspection()), decide: vi.fn<DeviceAuthorizationApi["decide"]>().mockResolvedValue(undefined) });
const switchAccount = vi.fn();
const mismatch = vi.fn();
const page = (transport: DeviceAuthorizationApi, initialCode: string | null = code, currentUser = user) => <DeviceAuthorizationPage user={currentUser} initialCode={initialCode} transport={transport} onSwitchAccount={switchAccount} onIdentityMismatch={mismatch} />;
const confirm = async () => {
  fireEvent.click(await screen.findByRole("checkbox", { name: "与我的终端显示的授权码一致" }));
  fireEvent.click(screen.getByRole("button", { name: "授权 CLI" }));
};

describe("CLI device authorization page", () => {
  it("requires an entered code, explicit comparison, and approval before authorizing", async () => {
    const transport = fixture();
    render(page(transport, null));
    expect(transport.inspect).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("textbox", { name: "授权码" }), { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: "查看请求" }));
    expect(screen.getByRole("textbox")).toHaveAttribute("aria-invalid", "true");
    expect(transport.inspect).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "bcdfg hjklm" } });
    fireEvent.click(screen.getByRole("button", { name: "查看请求" }));
    expect(await screen.findByText(code)).toBeInTheDocument();
    expect(transport.inspect).toHaveBeenCalledWith(code, user.id, expect.any(AbortSignal), mismatch);
    expect(screen.getByRole("button", { name: "授权 CLI" })).toBeDisabled();
    expect(transport.decide).not.toHaveBeenCalled();
    await confirm();
    await screen.findByRole("heading", { name: "CLI 已获授权" });
    expect(transport.decide).toHaveBeenCalledExactlyOnceWith(code, "approve", user.id, expect.any(AbortSignal), mismatch);
    expect(screen.getByRole("link", { name: "管理 CLI 访问权限" })).toHaveAttribute("href", "/account");
  });

  it("loads a prefilled code without approving and allows denial without the match checkbox", async () => {
    const transport = fixture();
    render(page(transport));
    fireEvent.click(await screen.findByRole("button", { name: "拒绝请求" }));
    await screen.findByRole("heading", { name: "请求已拒绝" });
    expect(transport.decide).toHaveBeenCalledExactlyOnceWith(code, "deny", user.id, expect.any(AbortSignal), mismatch);
    fireEvent.click(screen.getByRole("button", { name: "输入其他授权码" }));
    expect(screen.getByRole("textbox")).toHaveValue("");
  });

  it("blocks duplicate decisions and account switching while a decision is pending", async () => {
    let finish!: () => void;
    const transport = fixture();
    transport.decide.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    render(page(transport));
    await confirm();
    await waitFor(() => expect(transport.decide).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "切换账户" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "正在保存你的决定…" }));
    fireEvent.click(screen.getByRole("button", { name: "拒绝请求" }));
    expect(transport.decide).toHaveBeenCalledTimes(1);
    await act(async () => finish());
    await screen.findByRole("heading", { name: "CLI 已获授权" });
  });

  it.each(["approved", "consumed", "denied", "expired"] as const)("renders %s requests without a decision action", async (status) => {
    const transport = fixture(); transport.inspect.mockResolvedValue(inspection(status));
    render(page(transport));
    await screen.findByRole("heading", { name: status === "denied" ? "请求已拒绝" : status === "expired" ? "登录请求已过期" : "CLI 已获授权" });
    expect(screen.queryByRole("button", { name: "授权 CLI" })).toBeNull();
    expect(transport.decide).not.toHaveBeenCalled();
  });

  it("requires readback after a lost approval response and recognizes already-consumed authorization", async () => {
    const transport = fixture();
    transport.decide.mockRejectedValue(new ApiError("network"));
    transport.inspect.mockResolvedValueOnce(inspection()).mockResolvedValueOnce(inspection("consumed"));
    render(page(transport)); await confirm();
    await screen.findByText("尚未确认授权结果");
    expect(screen.queryByRole("button", { name: "授权 CLI" })).toBeNull();
    expect(transport.inspect).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "核对实际结果" }));
    await screen.findByRole("heading", { name: "CLI 已获授权" });
    expect(transport.inspect).toHaveBeenCalledTimes(2);
    expect(transport.decide).toHaveBeenCalledTimes(1);
  });

  it("requires a fresh comparison and user decision after readback finds the request still pending", async () => {
    const transport = fixture();
    transport.decide.mockRejectedValueOnce(new ApiError("server", 409, "invalid_transition", "device-rq"));
    render(page(transport)); await confirm();
    await screen.findByText("尚未确认授权结果");
    expect(screen.getByText("requestId: device-rq")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "核对实际结果" }));
    await screen.findByText("请求仍在等待确认。请重新核对后再作决定。");
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    expect(screen.getByRole("button", { name: "授权 CLI" })).toBeDisabled();
    expect(transport.decide).toHaveBeenCalledTimes(1);
    await confirm();
    await screen.findByRole("heading", { name: "CLI 已获授权" });
    expect(transport.decide).toHaveBeenCalledTimes(2);
  });

  it("keeps decision controls blocked when reconciliation fails and only retries inspection", async () => {
    const transport = fixture(); transport.decide.mockRejectedValue(new ApiError("network"));
    transport.inspect.mockResolvedValueOnce(inspection()).mockRejectedValueOnce(new ApiError("server", 429, "rate_limited"));
    render(page(transport)); await confirm(); await screen.findByText("尚未确认授权结果");
    fireEvent.click(screen.getByRole("button", { name: "核对实际结果" }));
    await screen.findByText("尝试次数过多，请等待一分钟后再检查授权码。");
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.getByRole("button", { name: "切换账户" })).toBeDisabled();
    expect(transport.decide).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "核对实际结果" })).toBeEnabled();
  });

  it.each([404, 429, 503])("exposes an inspection error (%s) without inventing a grant", async (status) => {
    const transport = fixture(); transport.inspect.mockRejectedValueOnce(new ApiError("server", status, status === 404 ? "not_found" : "internal", "device-inspect"));
    render(page(transport));
    await screen.findByRole("alert");
    expect(screen.queryByRole("button", { name: "授权 CLI" })).toBeNull();
    expect(screen.getByText("requestId: device-inspect")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: status === 404 ? "输入其他授权码" : "重新读取请求" }));
    if (status === 404) expect(screen.getByRole("textbox")).toBeInTheDocument();
    else await screen.findByText(code);
    expect(transport.decide).not.toHaveBeenCalled();
  });

  it("does not request an invalid prefilled code and lets the user correct it", () => {
    const transport = fixture(); render(page(transport, "wrong"));
    expect(screen.getByRole("textbox")).toHaveValue("wrong");
    expect(screen.getByRole("textbox")).toHaveAttribute("aria-invalid", "true");
    expect(transport.inspect).not.toHaveBeenCalled();
  });

  it("preserves request, comparison, and account details when changing language", async () => {
    const transport = fixture(); const view = render(page(transport));
    fireEvent.click(await screen.findByRole("checkbox"));
    view.setLocale("en");
    expect(screen.getByRole("heading", { name: "Authorize Daynight CLI" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "This code matches the one in my terminal" })).toBeChecked();
    expect(screen.getByText(user.email)).toBeInTheDocument();
    expect(transport.inspect).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Switch account" }));
    expect(switchAccount).toHaveBeenCalled();
  });

  it("discards late request data when the displayed account changes", async () => {
    let finish!: (inspection: DeviceAuthorizationInspection) => void;
    const transport = fixture(); transport.inspect.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const view = render(page(transport));
    await waitFor(() => expect(transport.inspect).toHaveBeenCalledTimes(1));
    const oldSignal = transport.inspect.mock.calls[0]![2];
    view.rerender(page(transport, null, { ...user, id: "00000000-0000-4000-8000-000000000002", name: "Bob" }));
    expect(oldSignal.aborted).toBe(true);
    await act(async () => finish(inspection()));
    expect(screen.getByRole("textbox")).toBeInTheDocument();
    expect(screen.queryByText(code)).toBeNull();
  });

  it("disables authorization once the inspected request expires", async () => {
    vi.useFakeTimers();
    const transport = fixture(); transport.inspect.mockResolvedValue({ ...inspection(), expiresAt: new Date(Date.now() + 100).toISOString() });
    render(page(transport));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(screen.getByRole("button", { name: "授权 CLI" })).toBeDisabled();
    await act(async () => { await vi.advanceTimersByTimeAsync(101); });
    expect(screen.getByRole("heading", { name: "登录请求已过期" })).toBeInTheDocument();
    expect(transport.decide).not.toHaveBeenCalled();
  });
});
