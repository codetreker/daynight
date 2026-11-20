import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, invalidateAuthRequests, pauseAuthRequests } from "../src/api/client";
import type { PersonalAccessToken } from "../src/api/auth";
import type { OwnerGrant } from "../src/api/oauth-grants";
import { TokensPanel, type TokenManagementApi } from "../src/features/management/TokensPanel";
import { OwnerGrantsPanel } from "../src/features/management/OwnerGrantsPanel";
import { useCredentialDescriptions } from "../src/features/management/CredentialDescription";
import type { CredentialPanel } from "../src/features/management/useCredentialPanel";
import { createLocaleRender } from "./helpers/renderWithLocale";

const render = createLocaleRender("en");
const user = { personalTeam: { id: "00000000-0000-4000-8000-000000000701", kind: "personal" as const, name: null }, id: "00000000-0000-4000-8000-000000000001", name: "Alice", email: "alice@example.com", emailVerified: true, avatarUrl: null };
const token: PersonalAccessToken = { id: "00000000-0000-4000-8000-000000000002", name: "CLI", description: null, createdAt: "2026-10-25T10:00:00Z", expiresAt: null, lastUsedAt: null };
const other = { ...token, id: "00000000-0000-4000-8000-000000000003", name: "Other" };
const grant: OwnerGrant = { ...token, clientName: "App", clientId: "https://client.test", resource: "https://daynight.cc/mcp", scope: "daynight:mcp", expiresAt: "2099-10-25T10:00:00Z", revokedAt: null, status: "active" };
const deferred = <T,>() => { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const fixture = (items: readonly PersonalAccessToken[] = [token]) => ({
  list: vi.fn<TokenManagementApi["list"]>().mockResolvedValue(items), create: vi.fn<TokenManagementApi["create"]>().mockResolvedValue({ ...token, id: other.id, token: "one-time-secret" }), revoke: vi.fn<TokenManagementApi["revoke"]>().mockResolvedValue(undefined), update: vi.fn<TokenManagementApi["update"]>().mockResolvedValue(token), describe: vi.fn<TokenManagementApi["describe"]>().mockImplementation(async (id, input, _signal, _mismatch, dispatch) => { dispatch?.(); return { id, description: input.description }; }),
});
const page = (transport: TokenManagementApi, extra = {}) => <TokensPanel user={user} onIdentityMismatch={vi.fn()} transport={transport} {...extra} />;
const edit = async (name = "CLI") => fireEvent.click(await screen.findByRole("button", { name: new RegExp(`^Edit description: ${name}`) }));
const openCreate = async () => { const button = screen.getByRole("button", { name: "Create token" }); await waitFor(() => expect(button).toBeEnabled()); fireEvent.click(button); };
const change = (value: string) => fireEvent.change(screen.getByLabelText("Description"), { target: { value } });
const save = () => fireEvent.submit(document.getElementById("credential-description-form")!);
afterEach(() => { invalidateAuthRequests(); sessionStorage.clear(); });

describe("credential descriptions", () => {
  it("restores focus to the moved pencil after a confirmed write finishes settling", async () => {
    const settlement = deferred<void>();
    const transport = fixture();
    const Harness = () => {
      const [items, setItems] = useState<readonly PersonalAccessToken[] | null>([token]);
      const [pending, setPending] = useState(false);
      const panel: CredentialPanel<PersonalAccessToken> = {
        items, setItems, pending, loading: false, error: null, busy: () => pending,
        read: async () => { throw new Error("Unexpected description readback"); },
        write: async operation => {
          setPending(true);
          let dispatched = false;
          await operation({ signal: new AbortController().signal, onDispatch: () => { dispatched = true; }, dispatched: () => dispatched, current: () => true, settled: () => { throw new Error("Unexpected early settlement"); } });
          await settlement.promise;
          setPending(false);
        },
      };
      const descriptions = useCredentialDescriptions({ panel, userId: user.id, mismatch: vi.fn(), transport: transport.describe, visible: true, name: item => item.name, onOpen: () => {} });
      return <>{descriptions.recovery}{items!.map(item => <div key={item.id}>{descriptions.label(item)}</div>)}{descriptions.editor}</>;
    };
    render(<Harness />); await edit(); change("backup"); save();
    await screen.findByText("Description updated.");
    const pencil = screen.getByRole("button", { name: /^Edit description: CLI/ });
    expect(pencil).toBeDisabled();
    expect(pencil.parentElement).toHaveClass("credential-description-line");
    await act(async () => settlement.resolve());
    expect(pencil).toBeEnabled();
    await waitFor(() => expect(pencil).toHaveFocus());
    expect(transport.describe).toHaveBeenCalledOnce();
  });
  it("adds literal text, clears it and restores the pencil after it moves", async () => {
    const transport = fixture(); render(page(transport)); await edit(); change("  <b>backup</b>  "); save();
    await screen.findByText("Description updated.");
    expect(screen.getByText("<b>backup</b>")).toHaveClass("credential-description");
    expect(document.querySelector(".credential-description b")).toBeNull();
    const pencil = screen.getByRole("button", { name: /^Edit description: CLI/ }); await waitFor(() => expect(pencil).toHaveFocus());
    expect(pencil.parentElement).toHaveClass("credential-description-line");
    expect(transport.describe).toHaveBeenLastCalledWith(token.id, { expectedUserId: user.id, expectedDescription: null, description: "<b>backup</b>" }, expect.any(AbortSignal), expect.any(Function), expect.any(Function));
    fireEvent.click(pencil); change("  "); save(); await screen.findByText("Description updated.");
    expect(screen.queryByText("<b>backup</b>")).toBeNull();
    expect(screen.getByRole("button", { name: /^Edit description: CLI/ }).parentElement).toHaveClass("credential-name");
    await waitFor(() => expect(screen.getByRole("button", { name: /^Edit description: CLI/ })).toHaveFocus());
    expect(transport.describe.mock.calls[1]?.[1]).toEqual({ expectedUserId: user.id, expectedDescription: "<b>backup</b>", description: null });
  });
  it("cancels a local edit and distinguishes records with identical names and timestamps", async () => {
    const transport = fixture([token, { ...other, name: token.name }]); render(page(transport));
    const buttons = await screen.findAllByRole("button", { name: /^Edit description: CLI/ });
    expect(buttons[0]?.getAttribute("aria-label")).not.toBe(buttons[1]?.getAttribute("aria-label"));
    fireEvent.click(buttons[0]!); change("discarded"); fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(buttons[0]!); expect(screen.getByLabelText("Description")).toHaveValue(""); expect(transport.describe).not.toHaveBeenCalled();
  });
  it("rejects original multiline paste and 101 code points without truncating; accepts 100 astral code points", async () => {
    const transport = fixture(); render(page(transport)); await edit();
    fireEvent.paste(screen.getByLabelText("Description"), { clipboardData: { getData: () => "a\nb" } }); save();
    expect(screen.getByText("Descriptions must be one line. Remove line breaks.")).toBeInTheDocument(); expect(transport.describe).not.toHaveBeenCalled();
    change("😀".repeat(101)); save(); expect(screen.getByText("Descriptions can contain up to 100 characters.")).toBeInTheDocument(); expect(screen.getByLabelText("Description")).toHaveValue("😀".repeat(101));
    change(" 😀".repeat(1).trim() + "😀".repeat(99)); save(); await screen.findByText("Description updated."); expect(transport.describe).toHaveBeenCalledTimes(1);
  });
  it("keeps drafts on definite refusal and permits an explicit correction", async () => {
    const transport = fixture(); transport.describe.mockRejectedValueOnce(new ApiError("server", 400, "invalid_input", "refused"));
    render(page(transport)); await edit(); change("draft"); save(); await screen.findByText("refused");
    expect(screen.getByLabelText("Description")).toHaveValue("draft"); expect(transport.list).toHaveBeenCalledTimes(1);
    change("corrected"); save(); await screen.findByText("Description updated."); expect(transport.describe).toHaveBeenCalledTimes(2);
  });
  it.each([409, 503])("requires an explicit read and a separate save after %s, retaining the draft across close", async status => {
    const transport = fixture(); transport.describe.mockRejectedValueOnce(new ApiError("server", status, status === 409 ? "version_conflict" : "write_outcome_unknown"));
    transport.list.mockResolvedValueOnce([token]).mockResolvedValue([{ ...token, description: "server value" }]);
    render(page(transport)); await edit(); change("my draft"); save(); await screen.findByRole("button", { name: "Read current state" });
    save(); expect(transport.describe).toHaveBeenCalledTimes(1); expect(transport.list).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" })); await edit(); expect(screen.getByLabelText("Description")).toHaveValue("my draft");
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Read current state" }));
    await screen.findByText("The current description is shown and your draft is preserved. Review it before saving again.");
    expect(screen.getByLabelText("Description")).toHaveValue("my draft"); expect(transport.describe).toHaveBeenCalledTimes(1);
    save(); await screen.findByText("Description updated."); expect(transport.describe.mock.calls[1]?.[1].expectedDescription).toBe("server value");
  });
  it("allows other records while one description is unresolved and serializes its recovery read with writes", async () => {
    const transport = fixture([token, other]); transport.describe.mockRejectedValueOnce(new ApiError("network"));
    const read = deferred<readonly PersonalAccessToken[]>(); transport.list.mockResolvedValueOnce([token, other]).mockReturnValueOnce(read.promise);
    render(page(transport)); await edit(); change("draft"); save(); await screen.findByRole("button", { name: "Read current state" });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" })); await edit("Other"); change("other description"); save(); await screen.findByText("Description updated.");
    await edit(); fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Read current state" }));
    expect(transport.list).toHaveBeenCalledTimes(2); expect(screen.getByRole("button", { name: /^Edit description: Other/ })).toBeDisabled();
    await act(async () => read.resolve([token, { ...other, description: "other description" }]));
    expect(transport.describe).toHaveBeenCalledTimes(2); expect(screen.getByLabelText("Description")).toHaveValue("draft");
  });
  it("removes a trustworthy missing target and ends its save eligibility", async () => {
    const transport = fixture(); transport.describe.mockRejectedValue(new ApiError("server", 404, "not_found")); render(page(transport)); await edit(); change("draft"); save();
    await screen.findByText("This record is no longer available."); expect(screen.queryByRole("dialog")).toBeNull(); expect(screen.queryByText("CLI")).toBeNull(); expect(transport.list).toHaveBeenCalledTimes(1);
  });
  it("retains the editor through a locale change and rejects late publication into a different account", async () => {
    const result = deferred<{ id: string; description: string | null }>(), transport = fixture(); transport.describe.mockImplementation((_id, _input, _signal, _mismatch, dispatch) => { dispatch?.(); return result.promise; });
    const view = render(page(transport)); await edit(); change("draft"); view.setLocale("zh-CN"); expect(screen.getByLabelText("描述")).toHaveValue("draft"); save();
    view.rerender(<TokensPanel user={{ ...user, id: other.id }} onIdentityMismatch={vi.fn()} transport={fixture([{ ...other, name: "New account" }])} />);
    await act(async () => result.resolve({ id: token.id, description: "old account" })); await screen.findByText("New account"); expect(screen.queryByText("old account")).toBeNull();
  });
  it("holds a confirmed description while identity is rechecked and publishes after same-account admission", async () => {
    const result = deferred<{ id: string; description: string | null }>(), transport = fixture(); transport.describe.mockImplementation((_id, _input, _signal, _mismatch, dispatch) => { dispatch?.(); return result.promise; });
    render(page(transport)); await edit(); change("draft"); save(); const resume = pauseAuthRequests();
    await act(async () => result.resolve({ id: token.id, description: "draft" })); expect(document.querySelector(".credential-description")).toBeNull();
    await act(async () => resume()); await screen.findByText("Description updated."); expect(screen.getByText("draft")).toHaveClass("credential-description");
  });
  it("shows a confirmed one-time secret despite post-create list failure and retries reads only", async () => {
    const transport = fixture(); transport.list.mockResolvedValueOnce([token]).mockRejectedValueOnce(new ApiError("network")).mockResolvedValue([other]); render(page(transport));
    await openCreate(); fireEvent.change(screen.getByLabelText(/Token name/), { target: { value: "Build" } }); fireEvent.change(screen.getByLabelText(/Description/), { target: { value: "build description" } }); fireEvent.submit(document.getElementById("create-token-form")!);
    expect(await screen.findByLabelText("One-time access token")).toHaveValue("one-time-secret");
    await screen.findByRole("button", { name: "Retry" }); fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await act(async () => {}); expect(screen.getByLabelText("One-time access token")).toHaveValue("one-time-secret"); expect(transport.create).toHaveBeenCalledTimes(1); expect(transport.list).toHaveBeenCalledTimes(3);
  });
  it("checks a legacy expiry 404 through v2 and keeps an expired record editable", async () => {
    const transport = fixture(); transport.update.mockRejectedValue(new ApiError("server", 404, "not_found")); transport.list.mockResolvedValueOnce([token]).mockResolvedValue([{ ...token, expiresAt: "2000-01-01T00:00:00Z", description: "expired" }]);
    render(page(transport)); fireEvent.click(await screen.findByRole("button", { name: "Edit expiration for CLI" })); fireEvent.change(screen.getByRole("combobox", { name: "Expiration" }), { target: { value: "custom" } }); fireEvent.change(screen.getByLabelText("Expiration date and time"), { target: { value: "2099-12-01T10:00" } }); fireEvent.submit(document.getElementById("edit-token-expiry-form")!);
    await screen.findByText("expired"); await edit(); expect(screen.getByLabelText("Description")).toHaveValue("expired"); expect(transport.list).toHaveBeenCalledTimes(2);
  });
  it("edits descriptions of retained revoked authorizations without changing their status", async () => {
    const transport = { list: vi.fn().mockResolvedValue([{ ...grant, revokedAt: "2026-10-26T10:00:00Z", status: "revoked" }]), revoke: vi.fn(), describe: vi.fn().mockResolvedValue({ id: grant.id, description: "old laptop" }) };
    render(<OwnerGrantsPanel user={user} onIdentityMismatch={vi.fn()} transport={transport} />); await edit("App"); change("old laptop"); save(); await screen.findByText("Description updated."); expect(screen.getByText("Revoked")).toBeInTheDocument(); expect(screen.getByText("old laptop")).toHaveClass("credential-description"); expect(transport.revoke).not.toHaveBeenCalled();
  });
  it("keeps creation unknown after failed reads and offers a keyboard-reachable read without replaying POST", async () => {
    const transport = fixture(); transport.create.mockRejectedValue(new ApiError("server", 503, "write_outcome_unknown"));
    transport.list.mockResolvedValueOnce([token]).mockRejectedValueOnce(new ApiError("server", 503, "internal", "create-read-failed")).mockResolvedValue([token, other]);
    render(page(transport)); await openCreate();
    fireEvent.change(screen.getByLabelText(/Token name/), { target: { value: "Build" } }); fireEvent.submit(document.getElementById("create-token-form")!);
    const dialog = screen.getByRole("dialog");
    fireEvent.click(await within(dialog).findByRole("button", { name: "Read current state" })); await act(async () => {});
    expect(within(dialog).getByText("create-read-failed")).toBeInTheDocument();
    expect(screen.getByLabelText(/Token name/)).toHaveValue("Build");
    expect(within(dialog).getByRole("button", { name: "Read current state" })).toBeEnabled();
    fireEvent.submit(document.getElementById("create-token-form")!); expect(transport.create).toHaveBeenCalledTimes(1);
    fireEvent.click(within(dialog).getByRole("button", { name: "Read current state" }));
    await screen.findByText("The current token list is shown. Check whether a token was issued before creating another.");
    expect(within(dialog).getByRole("button", { name: "Create token" })).toBeEnabled(); expect(transport.create).toHaveBeenCalledTimes(1); expect(transport.list).toHaveBeenCalledTimes(3);
  });
});
