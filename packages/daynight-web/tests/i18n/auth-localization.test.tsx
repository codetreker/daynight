import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthenticatedApp } from "../../src/app/AuthenticatedApp";
import { CreateProjectDialog } from "../../src/features/auth/CreateProjectDialog";
import { MembersPanel } from "../../src/features/management/MembersPanel";
import { SecretDialog } from "../../src/features/management/feedback";
import { invitationStorageKey } from "../../src/features/auth/invitation";
import { getFormats } from "../../src/i18n/formats";
import { en } from "../../src/i18n/messages/en";
import { zhCN } from "../../src/i18n/messages/zh-CN";
import { renderWithLocale } from "../helpers/renderWithLocale";

const userId = "00000000-0000-4000-8000-000000000001";
const projectId = "00000000-0000-4000-8000-000000000002";
const tokenId = "00000000-0000-4000-8000-000000000003";
const memberId = "00000000-0000-4000-8000-000000000004";
const timestamp = "2026-10-22T12:34:56Z";
const user = { id: userId, name: "Raw 用户", email: "raw@example.com", emailVerified: true, avatarUrl: null };
const member = (id = userId, role = "admin") => ({ projectId, userId: id, name: id === userId ? user.name : "协作者 Raw", email: `${id}@example.com`, avatarUrl: null, role, version: 12, createdAt: timestamp, updatedAt: timestamp });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Daynight-User-ID": userId } });
const failure = (status: number, code: string) => json({ error: { code, message: "Untrusted server detail", requestId: "auth-locale-request" } }, status);
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};
const defaults = (url: string): Response => {
  if (url === "/api/v1/me") return json(user);
  if (url === "/api/v1/auth/providers") return json({ providers: ["github"] });
  if (url === "/api/v1/projects" || url.startsWith("/api/v1/projects?")) return json({ items: [], nextCursor: null });
  if (url === "/api/v1/me/tokens") return json({ items: [] });
  if (url === `/api/v1/projects/${projectId}/members`) return json({ items: [member(), member(memberId, "member")] });
  if (url === `/api/v1/projects/${projectId}/invitations`) return json({ items: [] });
  throw new Error(`Unexpected test request: ${url}`);
};
const install = (handler: (url: string, init?: RequestInit) => Response | Promise<Response> = defaults) => {
  const fetcher = vi.fn((url: string, init?: RequestInit) => Promise.resolve(handler(url, init)));
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
};
const language = (scope: typeof screen | ReturnType<typeof within> = screen) => scope.getByRole("combobox", { name: "语言 / Language" });

beforeEach(() => {
  window.sessionStorage.clear();
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value: function (this: HTMLDialogElement) { this.open = true; },
  });
});

describe("authentication language changes", () => {
  it("translates a pending identity check without restarting it, then keeps the selected locale in the workspace", async () => {
    const pending = deferred<Response>();
    const fetcher = install((url) => url === "/api/v1/me" ? pending.promise : defaults(url));
    const interaction = userEvent.setup();
    renderWithLocale(<AuthenticatedApp />, { locale: "en" });
    const heading = screen.getByRole("heading", { name: en.auth.shell.identityLoading });
    const selector = language();
    const signal = fetcher.mock.calls[0]![1]!.signal!;
    await interaction.selectOptions(selector, "zh-CN");
    expect(screen.getByRole("heading", { name: zhCN.auth.shell.identityLoading })).toBe(heading);
    expect(document.documentElement.lang).toBe("zh-CN");
    expect(document.title).toBe(zhCN.auth.shell.documentTitle.loading);
    expect(selector).toHaveFocus();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(signal.aborted).toBe(false);
    await act(async () => pending.resolve(json(user)));
    await screen.findByRole("heading", { name: zhCN.workspace.app.projects });
    expect(document.title).toBe(zhCN.auth.shell.documentTitle.projects);
    expect(language()).toHaveValue("zh-CN");
    expect(fetcher.mock.calls.filter(([url]) => url === "/api/v1/me")).toHaveLength(1);
  });

  it("retranslates an existing login failure and provider controls without another provider request", async () => {
    window.history.replaceState(null, "", "/?authError=login_failed");
    const fetcher = install((url) => url === "/api/v1/me" ? failure(401, "unauthenticated") : defaults(url));
    const login = vi.fn();
    const interaction = userEvent.setup();
    renderWithLocale(<AuthenticatedApp navigateToLogin={login} />, { locale: "en" });
    const provider = await screen.findByRole("button", { name: en.auth.login.providerButton({ provider: "GitHub" }) });
    const notice = screen.getByText(en.auth.shell.notice.loginFailed).closest("[role=status]")!;
    const requests = fetcher.mock.calls.length;
    await interaction.selectOptions(language(), "zh-CN");
    expect(screen.getByText(zhCN.auth.shell.notice.loginFailed).closest("[role=status]")).toBe(notice);
    expect(screen.getByRole("button", { name: zhCN.auth.login.providerButton({ provider: "GitHub" }) })).toBe(provider);
    expect(document.title).toBe(zhCN.auth.shell.documentTitle.login);
    expect(fetcher).toHaveBeenCalledTimes(requests);
    await interaction.click(provider);
    expect(login).toHaveBeenCalledExactlyOnceWith("/api/v1/auth/login?provider=github&returnPath=%2F");
  });

  it("translates an existing token error and request ID without refetching or leaving the token tab", async () => {
    window.history.replaceState(null, "", "/account");
    const fetcher = install((url) => url === "/api/v1/me/tokens" ? failure(503, "internal_error") : defaults(url));
    const interaction = userEvent.setup();
    renderWithLocale(<AuthenticatedApp />, { locale: "en" });
    await interaction.click(await screen.findByRole("button", { name: en.auth.management.account.tokensTab }));
    const alert = await screen.findByRole("alert");
    const requestId = within(alert).getByText("auth-locale-request");
    const requests = fetcher.mock.calls.length;
    await interaction.selectOptions(language(), "zh-CN");
    expect(screen.getByRole("alert")).toBe(alert);
    expect(alert).toHaveTextContent(zhCN.auth.management.common.operationFailed);
    expect(within(alert).getByText("auth-locale-request")).toBe(requestId);
    expect(screen.getByRole("button", { name: zhCN.auth.management.account.tokensTab })).toHaveAttribute("aria-current", "page");
    expect(document.title).toBe(zhCN.auth.shell.documentTitle.account);
    expect(fetcher).toHaveBeenCalledTimes(requests);
    expect(screen.queryByText("Untrusted server detail")).toBeNull();
  });

  it("keeps token inputs and one pending creation across a modal language switch, then preserves the revealed secret", async () => {
    window.history.replaceState(null, "", "/account");
    const pending = deferred<Response>();
    const fetcher = install((url, init) => url === "/api/v1/me/tokens" && init?.method === "POST" ? pending.promise : defaults(url));
    const interaction = userEvent.setup();
    renderWithLocale(<AuthenticatedApp />, { locale: "en" });
    await interaction.click(await screen.findByRole("button", { name: en.auth.management.account.tokensTab }));
    await interaction.click(await screen.findByRole("button", { name: en.auth.management.account.createToken }));
    const dialog = screen.getByRole("dialog", { name: en.auth.management.account.createTitle });
    const input = within(dialog).getByLabelText(/Token name/);
    const expiry = within(dialog).getByLabelText(en.auth.management.account.expiryLabel);
    await interaction.type(input, "原始 device");
    await interaction.selectOptions(expiry, "custom");
    const date = within(dialog).getByLabelText(en.auth.management.account.expiryDateLabel);
    fireEvent.change(date, { target: { value: "2099-10-22T12:45" } });
    await interaction.click(within(dialog).getByRole("button", { name: en.auth.management.account.createToken }));
    const creation = fetcher.mock.calls.find(([url, init]) => url === "/api/v1/me/tokens" && init?.method === "POST")!;
    await interaction.selectOptions(language(within(dialog)), "zh-CN");
    expect(screen.getByRole("dialog", { name: zhCN.auth.management.account.createTitle })).toBe(dialog);
    expect(within(dialog).getByLabelText(/令牌名称/)).toBe(input);
    expect(input).toHaveValue("原始 device");
    expect(expiry).toHaveValue("custom");
    expect(date).toHaveValue("2099-10-22T12:45");
    expect(creation[1]!.signal!.aborted).toBe(false);
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    await act(async () => pending.resolve(json({ id: tokenId, name: "原始 device", createdAt: timestamp, expiresAt: "2099-10-22T12:34:56Z", token: "secret-raw-once" }, 201)));
    const revealed = await screen.findByRole("dialog", { name: zhCN.auth.management.secret.tokenTitle });
    const secret = within(revealed).getByLabelText(zhCN.auth.management.secret.tokenLabel);
    await interaction.selectOptions(language(within(revealed)), "en");
    expect(screen.getByRole("dialog", { name: en.auth.management.secret.tokenTitle })).toBe(revealed);
    expect(within(revealed).getByLabelText(en.auth.management.secret.tokenLabel)).toBe(secret);
    expect(secret).toHaveValue("secret-raw-once");
    expect(screen.getByText("原始 device")).toBeVisible();
    expect(screen.getByText(getFormats("en").dateTime(timestamp))).toBeVisible();
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(fetcher.mock.calls.filter(([url]) => url === "/api/v1/me/tokens")).toHaveLength(2);
  });

  it.each(["token", "invitation"] as const)("retranslates %s copy failures and close warnings while keeping the one-time value", async (kind) => {
    const interaction = userEvent.setup();
    const copy = vi.fn().mockRejectedValue(new Error("Controlled clipboard failure"));
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: copy } });
    const close = vi.fn();
    renderWithLocale(<SecretDialog kind={kind} secret="raw-once-秘密" onClose={close} />, { locale: "en" });
    const dialog = screen.getByRole("dialog");
    const secret = within(dialog).getByRole("textbox");
    await interaction.click(within(dialog).getByRole("button", { name: kind === "token" ? en.auth.management.secret.copy : en.auth.management.secret.copyLink }));
    await screen.findByText(en.auth.management.secret.copyFailed);
    await interaction.click(within(dialog).getByRole("button", { name: en.auth.management.common.closeDialog }));
    expect(screen.getByRole("alert")).toHaveTextContent(kind === "token" ? en.auth.management.secret.tokenCloseWarning : en.auth.management.secret.invitationCloseWarning);
    await interaction.selectOptions(language(within(dialog)), "zh-CN");
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(within(dialog).getByRole("textbox")).toBe(secret);
    expect(secret).toHaveValue("raw-once-秘密");
    expect(screen.getByText(zhCN.auth.management.secret.copyFailed)).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent(kind === "token" ? zhCN.auth.management.secret.tokenCloseWarning : zhCN.auth.management.secret.invitationCloseWarning);
    expect(copy).toHaveBeenCalledExactlyOnceWith("raw-once-秘密");
    expect(close).not.toHaveBeenCalled();
  });

  it("keeps a pending private project form and translates its eventual error inside the native modal", async () => {
    const pending = deferred<Response>();
    const fetcher = install(() => pending.promise);
    const interaction = userEvent.setup();
    renderWithLocale(<CreateProjectDialog onClose={vi.fn()} onCreated={vi.fn()} />, { locale: "en" });
    const dialog = screen.getByRole("dialog", { name: en.auth.createProject.title });
    const name = within(dialog).getByLabelText(/Project name/);
    const repository = within(dialog).getByLabelText(/Repository URL/);
    await interaction.type(name, "项目 Raw");
    await interaction.type(repository, "https://example.com/raw");
    await interaction.click(within(dialog).getByRole("button", { name: en.auth.createProject.submit }));
    await interaction.selectOptions(language(within(dialog)), "zh-CN");
    expect(screen.getByRole("dialog", { name: zhCN.auth.createProject.title })).toBe(dialog);
    expect(within(dialog).getByLabelText(/项目名称/)).toBe(name);
    expect(name).toHaveValue("项目 Raw");
    expect(repository).toHaveValue("https://example.com/raw");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![1]!.signal!.aborted).toBe(false);
    await act(async () => pending.resolve(failure(503, "internal_error")));
    expect(screen.getByRole("alert")).toHaveTextContent(zhCN.auth.createProject.error);
    expect(screen.getByText("auth-locale-request")).toBeVisible();
  });

  it("keeps the observed member and role while switching the pending role dialog", async () => {
    const pending = deferred<Response>();
    const fetcher = install((url, init) => init?.method === "PATCH" ? pending.promise : defaults(url));
    const interaction = userEvent.setup();
    renderWithLocale(<MembersPanel projectId={projectId} projectName="项目 Raw" user={user} onRemoved={vi.fn()} />, { locale: "en" });
    const role = await screen.findByRole("combobox", { name: en.auth.management.members.roleLabel({ name: "协作者 Raw" }) });
    await interaction.selectOptions(role, "admin");
    const dialog = screen.getByRole("dialog", { name: en.auth.management.members.roleTitle({ name: "协作者 Raw" }) });
    await interaction.click(within(dialog).getByRole("button", { name: en.auth.management.members.saveRole }));
    const requests = fetcher.mock.calls.length;
    await interaction.selectOptions(language(within(dialog)), "zh-CN");
    expect(screen.getByRole("dialog", { name: zhCN.auth.management.members.roleTitle({ name: "协作者 Raw" }) })).toBe(dialog);
    expect(within(dialog).getByRole("button", { name: zhCN.auth.management.common.submitPending })).toBeDisabled();
    expect(fetcher).toHaveBeenCalledTimes(requests);
    const mutation = fetcher.mock.calls.find(([, init]) => init?.method === "PATCH")!;
    expect(mutation[1]!.body).toBe('{"version":12,"role":"admin"}');
    expect(mutation[1]!.signal!.aborted).toBe(false);
    await act(async () => pending.resolve(failure(503, "internal_error")));
    expect(within(dialog).getByRole("alert")).toHaveTextContent(zhCN.auth.management.common.operationFailed);
    expect(within(dialog).getByText("auth-locale-request")).toBeVisible();
  });

  it.each(["token", "member", "invitation"] as const)("keeps the %s revocation target while translating confirmation and cancellation", async (kind) => {
    const invitationId = "00000000-0000-4000-8000-000000000005";
    const fetcher = install((url) => {
      if (url === "/api/v1/me/tokens") return json({ items: [{ id: tokenId, name: "Raw 令牌", createdAt: timestamp, expiresAt: "2099-10-22T12:34:56Z" }] });
      if (url === `/api/v1/projects/${projectId}/invitations`) return json({ items: [{ id: invitationId, projectId, createdBy: userId, createdAt: timestamp, expiresAt: "2099-10-29T12:34:56Z", consumedBy: null, consumedAt: null, revokedAt: null }] });
      return defaults(url);
    });
    const interaction = userEvent.setup();
    if (kind === "token") {
      window.history.replaceState(null, "", "/account");
      renderWithLocale(<AuthenticatedApp />, { locale: "en" });
      await interaction.click(await screen.findByRole("button", { name: en.auth.management.account.tokensTab }));
      await interaction.click(await screen.findByRole("button", { name: en.auth.management.account.revokeLabel({ name: "Raw 令牌" }) }));
    } else {
      renderWithLocale(<MembersPanel projectId={projectId} projectName="项目 Raw" user={user} onRemoved={vi.fn()} />, { locale: "en" });
      await interaction.click(await screen.findByRole("button", { name: kind === "member" ? en.auth.management.members.removeLabel({ name: "协作者 Raw" }) : en.auth.management.members.revokeLabel({ id: invitationId }) }));
    }
    const dialog = screen.getByRole("dialog");
    const requests = fetcher.mock.calls.length;
    if (kind === "token") expect(dialog).toHaveTextContent(en.auth.management.account.revokeBody({ name: "Raw 令牌" }));
    await interaction.selectOptions(language(within(dialog)), "zh-CN");
    const title = kind === "token" ? zhCN.auth.management.account.revokeTitle : kind === "member" ? zhCN.auth.management.members.removeTitle({ name: "协作者 Raw" }) : zhCN.auth.management.members.revokeTitle;
    expect(screen.getByRole("dialog", { name: title })).toBe(dialog);
    if (kind === "token") expect(dialog).toHaveTextContent(zhCN.auth.management.account.revokeBody({ name: "Raw 令牌" }));
    expect(fetcher).toHaveBeenCalledTimes(requests);
    await interaction.click(within(dialog).getByRole("button", { name: zhCN.auth.management.common.cancel }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(requests);
    expect(fetcher.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
  });

  it("keeps invitation inspection pending across a language change without accepting or losing the fragment secret", async () => {
    window.history.replaceState(null, "", "/invitations#raw-invitation-secret");
    const pending = deferred<Response>();
    const fetcher = install((url) => url === "/api/v1/invitations/inspect" ? pending.promise : defaults(url));
    const interaction = userEvent.setup();
    renderWithLocale(<AuthenticatedApp />, { locale: "en" });
    const heading = await screen.findByRole("heading", { name: en.auth.invitation.loading });
    await waitFor(() => expect(fetcher.mock.calls.filter(([url]) => url === "/api/v1/invitations/inspect")).toHaveLength(1));
    const requests = fetcher.mock.calls.length;
    await interaction.selectOptions(language(), "zh-CN");
    expect(screen.getByRole("heading", { name: zhCN.auth.invitation.loading })).toBe(heading);
    expect(window.location.hash).toBe("");
    expect(window.sessionStorage.getItem(invitationStorageKey)).toBe("raw-invitation-secret");
    expect(document.title).toBe(zhCN.auth.shell.documentTitle.invitations);
    expect(fetcher).toHaveBeenCalledTimes(requests);
    await act(async () => pending.resolve(json({ projectId, projectName: "项目 Raw" })));
    expect(screen.getByRole("heading", { name: zhCN.auth.invitation.invited })).toBeVisible();
    expect(screen.getByRole("heading", { name: "项目 Raw" })).toBeVisible();
    expect(fetcher.mock.calls.filter(([url]) => url === "/api/v1/invitations/accept")).toHaveLength(0);
  });

  it("retranslates a failed account revalidation without restarting it or removing a revealed token", async () => {
    const focused = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    window.history.replaceState(null, "", "/account");
    const pending = deferred<Response>();
    const retry = deferred<Response>();
    let checks = 0;
    const fetcher = install((url, init) => {
      if (url === "/api/v1/me" && ++checks > 1) return checks === 2 ? pending.promise : retry.promise;
      if (url === "/api/v1/me/tokens" && init?.method === "POST") return json({ id: tokenId, name: "Raw device", createdAt: timestamp, expiresAt: "2099-10-22T12:34:56Z", token: "kept-raw-secret" }, 201);
      return defaults(url);
    });
    const interaction = userEvent.setup();
    renderWithLocale(<AuthenticatedApp />, { locale: "en" });
    await interaction.click(await screen.findByRole("button", { name: en.auth.management.account.tokensTab }));
    await interaction.click(await screen.findByRole("button", { name: en.auth.management.account.createToken }));
    const creating = screen.getByRole("dialog");
    await interaction.type(within(creating).getByLabelText(/Token name/), "Raw device");
    await interaction.click(within(creating).getByRole("button", { name: en.auth.management.account.createToken }));
    const secret = await screen.findByLabelText(en.auth.management.secret.tokenLabel);
    const reveal = screen.getByRole("dialog");
    focused.mockReturnValue(false);
    fireEvent(window, new Event("blur"));
    focused.mockReturnValue(true);
    fireEvent(window, new Event("focus"));
    await waitFor(() => expect(checks).toBe(2));
    expect(screen.queryByRole("dialog", { name: en.auth.shell.revalidationLabel })).toBeNull();
    expect(screen.getByRole("dialog", { name: en.auth.management.secret.tokenTitle })).toBe(reveal);
    await act(async () => pending.resolve(failure(503, "internal")));
    const overlay = await screen.findByRole("dialog", { name: en.auth.shell.revalidationLabel });
    const requests = fetcher.mock.calls.length;
    await interaction.selectOptions(language(within(overlay)), "zh-CN");
    expect(screen.getByRole("dialog", { name: zhCN.auth.shell.revalidationLabel })).toBe(overlay);
    expect(secret).toHaveValue("kept-raw-secret");
    expect(secret.closest("[role=dialog]")).toBe(reveal);
    expect(fetcher).toHaveBeenCalledTimes(requests);
    expect(checks).toBe(2);
    await interaction.click(within(overlay).getByRole("button", { name: zhCN.auth.shell.revalidationRetry }));
    expect(screen.getByRole("dialog", { name: zhCN.auth.shell.revalidationLabel })).toBe(overlay);
    expect(document.body).toHaveClass("auth-session-checking");
    expect(document.querySelector(".auth-shell")).toHaveAttribute("inert");
    await act(async () => retry.resolve(json(user)));
    expect(screen.queryByRole("dialog", { name: zhCN.auth.shell.revalidationLabel })).toBeNull();
    expect(screen.getByRole("dialog", { name: zhCN.auth.management.secret.tokenTitle })).toBe(reveal);
    expect(screen.getByLabelText(zhCN.auth.management.secret.tokenLabel)).toBe(secret);
  });
});
