import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/api/client";
import type { PersonalAccessToken } from "../src/api/auth-types";
import { TokensPanel, type TokenManagementApi } from "../src/features/management/TokensPanel";
import { parseTokenExpiryDraft, tokenExpiryDraft } from "../src/features/management/TokenExpiryField";
import { createLocaleRender } from "./helpers/renderWithLocale";

const render = createLocaleRender("zh-CN");
const user = { id: "00000000-0000-4000-8000-000000000001", name: "Alice", email: "alice@example.com", emailVerified: true, avatarUrl: null };
const token: PersonalAccessToken = { id: "00000000-0000-4000-8000-000000000002", name: "Daynight CLI", createdAt: "2026-10-25T08:00:00Z", expiresAt: null };
const exactExpiry = "2099-10-25T12:34:56.123456789Z";
const futureInput = "2099-11-26T10:30";
const mismatch = vi.fn();
const fixture = (items: readonly PersonalAccessToken[] = [token]) => ({ list: vi.fn<TokenManagementApi["list"]>().mockResolvedValue(items), create: vi.fn<TokenManagementApi["create"]>().mockResolvedValue({ ...token, token: "created-once" }), revoke: vi.fn<TokenManagementApi["revoke"]>().mockResolvedValue(undefined), update: vi.fn<TokenManagementApi["update"]>().mockResolvedValue(token) });
const page = (transport: TokenManagementApi, currentUser = user) => <TokensPanel user={currentUser} transport={transport} onIdentityMismatch={mismatch} />;
const ready = async () => { await screen.findByText(token.name); };
const edit = () => fireEvent.click(screen.getByRole("button", { name: "修改令牌 Daynight CLI 的有效期" }));
const mode = (value: "never" | "custom") => fireEvent.change(screen.getByRole("combobox", { name: "有效期" }), { target: { value } });
const date = (value = futureInput) => fireEvent.change(screen.getByLabelText("到期日期和时间"), { target: { value } });
const save = () => fireEvent.submit(document.getElementById("edit-token-expiry-form")!);
const deferred = <T,>() => { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

describe("optional token expiration", () => {
  it("renders an unlimited token without an invalid date and creates another unlimited token by default", async () => {
    const transport = fixture(); render(page(transport)); await ready();
    expect(screen.getByText(/到期 永不过期/)).toBeInTheDocument();
    expect(screen.queryByText(/Invalid Date|1970/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "创建令牌" }));
    expect(screen.getByRole("combobox", { name: "有效期" })).toHaveValue("never");
    expect(screen.queryByLabelText("到期日期和时间")).toBeNull();
    fireEvent.change(screen.getByLabelText(/令牌名称/), { target: { value: "Build agent" } });
    fireEvent.submit(document.getElementById("create-token-form")!);
    await screen.findByLabelText("一次性访问令牌");
    expect(transport.create).toHaveBeenCalledExactlyOnceWith({ name: "Build agent", expiresAt: null }, expect.any(AbortSignal));
    expect(transport.list).toHaveBeenCalledWith(expect.any(AbortSignal), user.id, mismatch);
  });

  it("validates optional dates and submits a chosen future expiration", async () => {
    const transport = fixture(); render(page(transport)); await ready();
    fireEvent.click(screen.getByRole("button", { name: "创建令牌" }));
    fireEvent.change(screen.getByLabelText(/令牌名称/), { target: { value: "Build agent" } });
    mode("custom"); fireEvent.submit(document.getElementById("create-token-form")!);
    expect(screen.getByText("请选择未来的日期和时间，或选择永不过期。")).toBeInTheDocument();
    expect(transport.create).not.toHaveBeenCalled();
    date("2000-01-01T12:00"); fireEvent.submit(document.getElementById("create-token-form")!);
    expect(transport.create).not.toHaveBeenCalled();
    date(); fireEvent.submit(document.getElementById("create-token-form")!);
    await screen.findByLabelText("一次性访问令牌");
    expect(transport.create).toHaveBeenCalledWith({ name: "Build agent", expiresAt: new Date(futureInput).toISOString() }, expect.any(AbortSignal));
  });

  it("retains the original timestamp precision and never saves an untouched expiration", async () => {
    const transport = fixture([{ ...token, expiresAt: exactExpiry }]); render(page(transport)); await ready(); edit();
    expect(screen.getByRole("button", { name: "保存有效期" })).toBeDisabled();
    save(); expect(transport.update).not.toHaveBeenCalled();
    expect(parseTokenExpiryDraft(tokenExpiryDraft(exactExpiry))).toBe(exactExpiry);
    mode("never"); mode("custom");
    expect(screen.getByRole("button", { name: "保存有效期" })).toBeDisabled();
  });

  it("removes a saved expiration with the exact observed value and displayed account", async () => {
    const transport = fixture([{ ...token, expiresAt: exactExpiry }]); render(page(transport)); await ready(); edit(); mode("never"); save();
    await screen.findByText("令牌有效期已更新。");
    expect(transport.update).toHaveBeenCalledExactlyOnceWith(token.id, { expiresAt: null, expectedExpiresAt: exactExpiry, expectedUserId: user.id }, expect.any(AbortSignal), mismatch);
    expect(screen.getByText(/到期 永不过期/)).toBeInTheDocument();
    expect(screen.queryByLabelText("一次性访问令牌")).toBeNull();
  });

  it("sets an expiration on an unlimited token without creating a replacement credential", async () => {
    const expiresAt = new Date(futureInput).toISOString();
    const transport = fixture(); transport.update.mockResolvedValue({ ...token, expiresAt });
    render(page(transport)); await ready(); edit(); mode("custom"); date(); save();
    await screen.findByText("令牌有效期已更新。");
    expect(transport.update).toHaveBeenCalledWith(token.id, { expiresAt, expectedExpiresAt: null, expectedUserId: user.id }, expect.any(AbortSignal), mismatch);
    expect(transport.create).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.querySelector(`time[datetime="${expiresAt}"]`)).not.toBeNull();
  });

  it("blocks duplicate updates and preserves the editor through a language change", async () => {
    const pending = deferred<PersonalAccessToken>();
    const transport = fixture(); transport.update.mockReturnValue(pending.promise);
    const view = render(page(transport)); await ready(); edit(); mode("custom"); date(); save(); save();
    expect(transport.update).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "创建令牌" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "正在保存…" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "有效期" })).toBeDisabled();
    view.setLocale("en");
    expect(screen.getByLabelText("Expiration date and time")).toHaveValue(futureInput);
    expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
    await act(async () => pending.resolve({ ...token, expiresAt: new Date(futureInput).toISOString() }));
    await screen.findByText("Token expiration updated.");
  });

  it("reloads a conflict and requires a new explicit update against the refreshed expiration", async () => {
    const transport = fixture();
    transport.update.mockRejectedValueOnce(new ApiError("server", 409, "version_conflict"));
    transport.list.mockResolvedValueOnce([token]).mockResolvedValue([{ ...token, expiresAt: exactExpiry }]);
    render(page(transport)); await ready(); edit(); mode("custom"); date(); save();
    await screen.findByText("有效期已被其他操作修改。已显示当前值，请重新核对后保存。");
    expect(screen.getByRole("button", { name: "保存有效期" })).toBeDisabled();
    expect(transport.update).toHaveBeenCalledTimes(1);
    mode("never"); save(); await screen.findByText("令牌有效期已更新。");
    expect(transport.update.mock.calls[1]![1]).toEqual({ expiresAt: null, expectedExpiresAt: exactExpiry, expectedUserId: user.id });
  });

  it("reads back a lost update response without replaying the PATCH", async () => {
    const actual = { ...token, expiresAt: exactExpiry };
    const readback = deferred<readonly PersonalAccessToken[]>();
    const transport = fixture(); transport.update.mockRejectedValue(new ApiError("network"));
    transport.list.mockResolvedValueOnce([token]).mockReturnValueOnce(readback.promise);
    render(page(transport)); await ready(); edit(); mode("custom"); date(); save();
    await screen.findByText("尚未确认有效期修改结果。请先读取令牌实际状态，再进行其他修改。");
    expect(screen.getByRole("button", { name: "读取令牌实际状态" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "取消" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "创建令牌" })).toBeDisabled();
    await act(async () => readback.resolve([actual]));
    await screen.findByText("已显示实际到期时间，请重新核对后操作。");
    expect(screen.getByRole("button", { name: "保存有效期" })).toBeDisabled();
    expect(transport.update).toHaveBeenCalledTimes(1);
    expect(transport.list).toHaveBeenCalledTimes(2);
  });

  it("preserves metadata and blocks all writes after failed reconciliation until a read succeeds", async () => {
    const transport = fixture(); transport.update.mockRejectedValue(new ApiError("protocol", 200));
    transport.list.mockResolvedValueOnce([token]).mockRejectedValueOnce(new ApiError("server", 503, "internal", "readback-rq")).mockResolvedValue([token]);
    render(page(transport)); await ready(); edit(); mode("custom"); date(); save();
    await screen.findByText("readback-rq");
    expect(screen.getByText(token.name)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存有效期" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "创建令牌" })).toBeDisabled();
    fireEvent.keyDown(document, { key: "Escape" }); expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "读取令牌实际状态" }));
    await screen.findByText("已显示实际到期时间，请重新核对后操作。");
    expect(screen.getByRole("combobox", { name: "有效期" })).toHaveValue("never");
    expect(transport.update).toHaveBeenCalledTimes(1);
    expect(transport.list).toHaveBeenCalledTimes(3);
  });

  it.each(["missing", "refused"])("removes an unavailable token after %s without recreating it", async (result) => {
    const transport = fixture(); transport.update.mockRejectedValue(new ApiError(result === "missing" ? "network" : "server", result === "missing" ? null : 404));
    transport.list.mockResolvedValueOnce([token]).mockResolvedValue([]);
    render(page(transport)); await ready(); edit(); mode("custom"); date(); save();
    await screen.findByText("此令牌已不可用，可能已过期或已撤销。");
    expect(screen.queryByText(token.name)).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(transport.create).not.toHaveBeenCalled();
    expect(transport.update).toHaveBeenCalledTimes(1);
  });

  it("allows a confirmed validation refusal to be corrected without reloading or exposing raw details", async () => {
    const transport = fixture(); transport.update.mockRejectedValueOnce(new ApiError("server", 400, "invalid_input", "invalid-expiry"));
    render(page(transport)); await ready(); edit(); mode("custom"); date(); save();
    await screen.findByText("invalid-expiry");
    expect(screen.getByRole("button", { name: "保存有效期" })).toBeEnabled();
    expect(transport.list).toHaveBeenCalledTimes(1);
    date("2099-12-26T10:30"); save(); await screen.findByText("令牌有效期已更新。");
    expect(transport.update).toHaveBeenCalledTimes(2);
  });

  it("discards pending updates and metadata when the displayed account changes", async () => {
    const pending = deferred<PersonalAccessToken>(); const transport = fixture(); transport.update.mockReturnValue(pending.promise);
    const view = render(page(transport)); await ready(); edit(); mode("custom"); date(); save();
    const oldSignal = transport.update.mock.calls[0]![2];
    transport.list.mockResolvedValue([]);
    view.rerender(page(transport, { ...user, id: "00000000-0000-4000-8000-000000000003" }));
    expect(oldSignal.aborted).toBe(true);
    await act(async () => pending.resolve({ ...token, name: "Old account secret" }));
    await screen.findByText(/还没有访问令牌/);
    expect(screen.queryByText("Old account secret")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("rejects invalid local dates and keeps the unlimited choice independent of a stale custom draft", () => {
    for (const input of ["", "2000-01-01T12:00", "2099-02-30T12:00", "not-a-date", "2099-01-01T12:00:00"]) expect(parseTokenExpiryDraft({ ...tokenExpiryDraft(null), mode: "custom", input })).toBeUndefined();
    expect(parseTokenExpiryDraft({ ...tokenExpiryDraft(null), mode: "never", input: "bad" })).toBeNull();
    expect(parseTokenExpiryDraft(tokenExpiryDraft("2000-01-01T12:00:00Z"))).toBeUndefined();
  });

  it.each([null, "00000000-0000-4000-8000-000000000003"])("keeps failed reconciliation locked when its response principal is %s", async (principal) => {
    const changed = vi.fn(); let finish!: (response: Response) => void; let reads = 0;
    const fetcher = vi.fn((_url: string, options?: RequestInit) => {
      if (options?.method === "PATCH") return Promise.reject(new Error("Connection ended"));
      if (++reads === 1) return Promise.resolve(new Response(JSON.stringify({ items: [token] }), { headers: { "Content-Type": "application/json", "Daynight-User-ID": user.id } }));
      return new Promise<Response>((resolve) => { finish = resolve; });
    });
    vi.stubGlobal("fetch", fetcher);
    render(<TokensPanel user={user} onIdentityMismatch={changed} />); await ready(); edit(); mode("custom"); date(); save();
    await waitFor(() => expect(reads).toBe(2));
    await act(async () => finish(new Response(JSON.stringify({ items: principal === null ? [] : [{ ...token, name: "Other account credential" }] }), { headers: { "Content-Type": "application/json", ...(principal === null ? {} : { "Daynight-User-ID": principal }) } })));
    await waitFor(() => expect(screen.getByRole("button", { name: "读取令牌实际状态" })).toBeEnabled());
    expect(screen.getByRole("button", { name: "保存有效期" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "创建令牌" })).toBeDisabled();
    expect(screen.queryByText("Other account credential")).toBeNull();
    expect(screen.queryByText("此令牌已不可用，可能已过期或已撤销。")).toBeNull();
    expect(changed).toHaveBeenCalledTimes(principal === null ? 0 : 1);
    expect(fetcher.mock.calls.filter(([, options]) => options?.method === "PATCH")).toHaveLength(1);
  });
});
