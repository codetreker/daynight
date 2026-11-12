import { directAccessFixture } from "../helpers/taskSync";
import { stringifyWireJson } from "../helpers/wireJson";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthenticatedApp } from "../../src/app/AuthenticatedApp";
import { AccountChangeBanner } from "../../src/features/auth/AccountChangeBanner";
import { CreateProjectDialog } from "../../src/features/auth/CreateProjectDialog";
import { MembersPanel } from "../../src/features/management/MembersPanel";
import { SecretDialog } from "../../src/features/management/feedback";
import { invitationStorageKey } from "../../src/features/auth/invitation";
import { getFormats } from "../../src/i18n/formats";
import { LanguageSelector } from "../../src/i18n/LanguageSelector";
import { en } from "../../src/i18n/messages/en";
import { zhCN } from "../../src/i18n/messages/zh-CN";
import { renderWithLocale } from "../helpers/renderWithLocale";
import { personalTeamPage } from "../helpers/team";

const userId = "00000000-0000-4000-8000-000000000001";
const projectId = "00000000-0000-4000-8000-000000000002";
const tokenId = "00000000-0000-4000-8000-000000000003";
const memberId = "00000000-0000-4000-8000-000000000004";
const timestamp = "2026-10-22T12:34:56Z";
const user = { personalTeam: { id: '00000000-0000-4000-8000-000000000701', kind: 'personal' as const, name: null }, id: userId, name: "Raw 用户", email: "raw@example.com", emailVerified: true, avatarUrl: null };
const member = (id = userId, role = "admin") => ({ projectId, userId: id, name: id === userId ? user.name : "协作者 Raw", email: `${id}@example.com`, avatarUrl: null, role, version: 12, createdAt: timestamp, updatedAt: timestamp });
const participant = (id = userId, role = "admin") => { const { name, email, avatarUrl, ...directGrant } = member(id, role); return { inheritedFrom: null, userId: id, profile: { name, email, avatarUrl }, effectiveRole: role, directGrant }; };
const json = (body: unknown, status = 200) => new Response(stringifyWireJson(body), { status, headers: { "Content-Type": "application/json", "Daynight-User-ID": userId } });
const failure = (status: number, code: string) => json({ error: { code, message: "Untrusted server detail", requestId: "auth-locale-request" } }, status);
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};
const defaults = (url: string): Response => {
  if (url === "/api/v1/me") return json(user);
  if (url.startsWith("/api/v1/teams?")) return json(personalTeamPage(userId));
  if (url === "/api/v1/auth/providers") return json({ providers: ["github"] });
  if (url === "/api/v1/projects" || url.startsWith("/api/v1/projects?")) return json({ items: [], nextCursor: null });
  if (url === "/api/v1/me/tokens") return json({ items: [] });
  if (url === "/api/v2/oauth/grants") return json({ userId, grants: [] });
  if (url === `/api/v1/projects/${projectId}`) return json({ id: projectId, name: "Raw project", repoUrl: "https://example.test/repo", createdAt: timestamp, updatedAt: timestamp, settings: { version: 1n, executionWarningMinutes: 60 }, ownership: { teamId: user.personalTeam.id, version: 1n } });
  if (url === `/api/v1/projects/${projectId}/access`) {
    const { email: _email, name: _name, avatarUrl: _avatarUrl, ...directGrant } = member();
    return json({ ...directAccessFixture(projectId, userId), effectiveRole: directGrant.role, directGrant });
  }
  if (url === `/api/v1/projects/${projectId}/members`) return json({ actorAccess: { ...directAccessFixture(projectId, userId), effectiveRole: "admin", directGrant: participant().directGrant }, items: [participant(), participant(memberId, "member")] });
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
    await screen.findByText("个人", { selector: ".project-list-information .eyebrow" });
    expect(document.title).toBe(zhCN.auth.shell.documentTitle.projects);
    expect(language()).toHaveValue("zh-CN");
    expect(fetcher.mock.calls.filter(([url]) => url === "/api/v1/me")).toHaveLength(1);
  });

  it("retranslates an existing login failure and provider controls without another provider request", async () => {
    window.history.replaceState(null, "", "/login?authError=login_failed");
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
    expect(login).toHaveBeenCalledExactlyOnceWith("/api/v1/auth/login?provider=github&returnPath=%2Fprojects");
  });

  it("translates an existing token error and request ID without refetching or leaving the token tab", async () => {
    window.history.replaceState(null, "", "/account");
    const fetcher = install((url) => url === "/api/v1/me/tokens" ? failure(503, "internal_error") : defaults(url));
    const interaction = userEvent.setup();
    renderWithLocale(<AuthenticatedApp />, { locale: "en" });
    await interaction.click(await screen.findByRole("button", { name: en.auth.management.account.tokensTab }));
    const alert = await screen.findByRole("alert");
    const requestId = within(alert).getByText("auth-locale-request");
    await waitFor(() => expect(fetcher.mock.calls.some(([url]) => url.startsWith("/api/v1/projects?"))).toBe(true));
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

  it("keeps token inputs and one pending creation across an application language change, then preserves the revealed secret", async () => {
    window.history.replaceState(null, "", "/account");
    const pending = deferred<Response>();
    const fetcher = install((url, init) => url === "/api/v1/me/tokens" && init?.method === "POST" ? pending.promise : defaults(url));
    const interaction = userEvent.setup();
    const view = renderWithLocale(<AuthenticatedApp />, { locale: "en" });
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
    expect(within(dialog).queryByRole("combobox", { name: "语言 / Language" })).toBeNull();
    view.setLocale("zh-CN");
    expect(screen.getByRole("dialog", { name: zhCN.auth.management.account.createTitle })).toBe(dialog);
    expect(within(dialog).getByLabelText(/令牌名称/)).toBe(input);
    expect(input).toHaveValue("原始 device");
    expect(expiry).toHaveValue("custom");
    expect(date).toHaveValue("2099-10-22T12:45");
    expect(creation[1]!.signal!.aborted).toBe(false);
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    await act(async () => pending.resolve(json({ id: tokenId, name: "原始 device", lastUsedAt: null, createdAt: timestamp, expiresAt: "2099-10-22T12:34:56Z", token: "secret-raw-once" }, 201)));
    const revealed = await screen.findByRole("dialog", { name: zhCN.auth.management.secret.tokenTitle });
    const secret = within(revealed).getByLabelText(zhCN.auth.management.secret.tokenLabel);
    expect(within(revealed).queryByRole("combobox", { name: "语言 / Language" })).toBeNull();
    view.setLocale("en");
    expect(screen.getByRole("dialog", { name: en.auth.management.secret.tokenTitle })).toBe(revealed);
    expect(within(revealed).getByLabelText(en.auth.management.secret.tokenLabel)).toBe(secret);
    expect(secret).toHaveValue("secret-raw-once");
    expect(screen.getByText("原始 device")).toBeVisible();
    expect(screen.getByText(getFormats("en").dateTime(timestamp))).toBeVisible();
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(fetcher.mock.calls.filter(([url]) => url === "/api/v1/me/tokens")).toHaveLength(2);
  });

  it("keeps preference failure feedback with the page selector outside a management dialog", () => {
    renderWithLocale(<><LanguageSelector /><SecretDialog kind="token" secret="once" onClose={vi.fn()} /></>, {
      locale: "en", issue: { kind: "write", cause: new Error("storage unavailable") },
    });
    const dialog = screen.getByRole("dialog");
    expect(screen.getByText(en.language.preferenceNotice.write)).toBeVisible();
    expect(screen.getByRole("button", { name: en.common.retrySave })).toBeVisible();
    expect(within(dialog).queryByText(en.language.preferenceNotice.write)).toBeNull();
    expect(within(dialog).queryByRole("button", { name: en.common.retrySave })).toBeNull();
    expect(within(dialog).queryByRole("combobox", { name: "语言 / Language" })).toBeNull();
  });

  it.each(["token", "invitation"] as const)("retranslates %s copy failures and close warnings while keeping the one-time value", async (kind) => {
    const interaction = userEvent.setup();
    const copy = vi.fn().mockRejectedValue(new Error("Controlled clipboard failure"));
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: copy } });
    const close = vi.fn();
    const view = renderWithLocale(<SecretDialog kind={kind} secret="raw-once-秘密" onClose={close} />, { locale: "en" });
    const dialog = screen.getByRole("dialog");
    const secret = within(dialog).getByRole("textbox");
    await interaction.click(within(dialog).getByRole("button", { name: kind === "token" ? en.auth.management.secret.copy : en.auth.management.secret.copyLink }));
    await screen.findByText(en.auth.management.secret.copyFailed);
    await interaction.click(within(dialog).getByRole("button", { name: en.auth.management.common.closeDialog }));
    expect(screen.getByRole("alert")).toHaveTextContent(kind === "token" ? en.auth.management.secret.tokenCloseWarning : en.auth.management.secret.invitationCloseWarning);
    expect(within(dialog).queryByRole("combobox", { name: "语言 / Language" })).toBeNull();
    view.setLocale("zh-CN");
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
    const view = renderWithLocale(<CreateProjectDialog userId={userId} onIdentityMismatch={vi.fn()} onClose={vi.fn()} onCreated={vi.fn()} />, { locale: "en" });
    const dialog = screen.getByRole("dialog", { name: en.auth.createProject.title });
    expect(within(dialog).queryByRole("combobox", { name: "语言 / Language" })).toBeNull();
    const name = within(dialog).getByLabelText(/Project name/);
    const repository = within(dialog).getByLabelText(/Repository URL/);
    await interaction.type(name, "项目 Raw");
    await interaction.type(repository, "https://example.com/raw");
    await interaction.click(within(dialog).getByRole("button", { name: en.auth.createProject.submit }));
    view.setLocale("zh-CN");
    expect(screen.getByRole("dialog", { name: zhCN.auth.createProject.title })).toBe(dialog);
    expect(within(dialog).getByLabelText(/项目名称/)).toBe(name);
    expect(name).toHaveValue("项目 Raw");
    expect(repository).toHaveValue("https://example.com/raw");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![1]!.signal!.aborted).toBe(false);
    await act(async () => pending.resolve(failure(503, "internal_error")));
    expect(screen.getByRole("alert")).toHaveTextContent(zhCN.auth.createProject.unknown);
    expect(screen.getByText("auth-locale-request")).toBeVisible();
    expect(within(dialog).queryByRole("button", { name: zhCN.auth.createProject.submit })).not.toBeInTheDocument();
    fetcher.mockResolvedValueOnce(json({ items: [], nextCursor: null }));
    await interaction.click(within(dialog).getByRole("button", { name: zhCN.auth.createProject.checkProjects }));
    await screen.findByText(zhCN.auth.createProject.noProjects);
    expect(screen.getByText(zhCN.auth.createProject.unknown)).toBeVisible();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1]![0]).toBe("/api/v1/projects?limit=50");
  });

  it("keeps preference failure feedback with the page selector outside project creation", () => {
    renderWithLocale(<><LanguageSelector /><CreateProjectDialog userId={userId} onIdentityMismatch={vi.fn()} onClose={vi.fn()} onCreated={vi.fn()} /></>, {
      locale: "en", issue: { kind: "write", cause: new Error("storage unavailable") },
    });
    const dialog = screen.getByRole("dialog");
    expect(screen.getByText(en.language.preferenceNotice.write)).toBeVisible();
    expect(screen.getByRole("button", { name: en.common.retrySave })).toBeVisible();
    expect(within(dialog).queryByText(en.language.preferenceNotice.write)).toBeNull();
    expect(within(dialog).queryByRole("button", { name: en.common.retrySave })).toBeNull();
    expect(within(dialog).queryByRole("combobox", { name: "语言 / Language" })).toBeNull();
  });

  it("keeps an unknown result and rejects a different account's project list", async () => {
    const mismatch = vi.fn();
    const fetcher = install((_url, init) => init?.method === "POST" ? failure(503, "write_outcome_unknown") : new Response(JSON.stringify({ items: [], nextCursor: null }), { headers: { "Content-Type": "application/json", "Daynight-User-ID": memberId } }));
    const interaction = userEvent.setup();
    renderWithLocale(<CreateProjectDialog userId={userId} onIdentityMismatch={mismatch} onClose={vi.fn()} onCreated={vi.fn()} />, { locale: "en" });
    const dialog = screen.getByRole("dialog", { name: en.auth.createProject.title });
    await interaction.type(within(dialog).getByLabelText(/Project name/), "Original");
    await interaction.type(within(dialog).getByLabelText(/Repository URL/), "https://example.com/repo");
    await interaction.click(within(dialog).getByRole("button", { name: en.auth.createProject.submit }));
    await screen.findByText(en.auth.createProject.unknown);
    await interaction.click(within(dialog).getByRole("button", { name: en.auth.createProject.checkProjects }));
    await screen.findByText(en.auth.createProject.checkFailed);
    expect(screen.getByText(en.auth.createProject.unknown)).toBeVisible();
    expect(within(dialog).queryByText(en.auth.createProject.noProjects)).toBeNull();
    expect(mismatch).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("keeps unknown while reading and retrying project pages", async () => {
    const observed = (id: string, name: string) => ({ id, name, repoUrl: "git@example.com:org/repo.git", settings: { version: 1, executionWarningMinutes: 60 }, ownership: { teamId: user.personalTeam.id, version: 1 }, createdAt: timestamp, updatedAt: timestamp });
    let continuation = 0;
    const fetcher = install((url, init) => {
      if (init?.method === "POST") return failure(503, "write_outcome_unknown");
      if (!url.includes("cursor=")) return json({ items: [observed(projectId, "Observed one")], nextCursor: "next" });
      if (++continuation === 1) return failure(503, "internal_error");
      return json({ items: [observed(tokenId, "Observed two")], nextCursor: null });
    });
    const interaction = userEvent.setup();
    renderWithLocale(<CreateProjectDialog userId={userId} onIdentityMismatch={vi.fn()} onClose={vi.fn()} onCreated={vi.fn()} />, { locale: "en" });
    const dialog = screen.getByRole("dialog", { name: en.auth.createProject.title });
    await interaction.type(within(dialog).getByLabelText(/Project name/), "Original");
    await interaction.type(within(dialog).getByLabelText(/Repository URL/), "https://example.com/repo");
    await interaction.click(within(dialog).getByRole("button", { name: en.auth.createProject.submit }));
    await screen.findByText(en.auth.createProject.unknown);
    await interaction.click(within(dialog).getByRole("button", { name: en.auth.createProject.checkProjects }));
    expect(await screen.findByRole("link", { name: "Observed one" })).toHaveAttribute("href", `/projects/${projectId}`);
    await interaction.click(within(dialog).getByRole("button", { name: en.auth.createProject.loadMore }));
    await screen.findByText(en.auth.createProject.checkFailed);
    expect(screen.getByText(en.auth.createProject.unknown)).toBeVisible();
    await interaction.click(within(dialog).getByRole("button", { name: en.auth.createProject.loadMore }));
    expect(await screen.findByRole("link", { name: "Observed two" })).toHaveAttribute("href", `/projects/${tokenId}`);
    expect(screen.getByText(en.auth.createProject.unknown)).toBeVisible();
    expect(within(dialog).queryByRole("button", { name: en.auth.createProject.submit })).toBeNull();
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("keeps the observed member and role while switching the pending role dialog", async () => {
    const pending = deferred<Response>();
    const fetcher = install((url, init) => url === `/api/v1/projects/${projectId}/grants/${memberId}` && init?.method === "PUT" ? pending.promise : defaults(url));
    const interaction = userEvent.setup();
    const view = renderWithLocale(<MembersPanel projectId={projectId} user={user} onRemoved={vi.fn()} />, { locale: "en", taskCache: { viewerId: userId } });
    const role = await screen.findByRole("combobox", { name: en.auth.management.members.roleLabel({ name: "协作者 Raw" }) });
    await interaction.selectOptions(role, "admin");
    const dialog = screen.getByRole("dialog", { name: en.auth.management.members.roleTitle({ name: "协作者 Raw" }) });
    await interaction.click(within(dialog).getByRole("button", { name: en.auth.management.members.saveRole }));
    await waitFor(() => expect(fetcher.mock.calls.some(([url, init]) => url === `/api/v1/projects/${projectId}/grants/${memberId}` && init?.method === "PUT")).toBe(true));
    const requests = fetcher.mock.calls.length;
    expect(within(dialog).queryByRole("combobox", { name: "语言 / Language" })).toBeNull();
    view.setLocale("zh-CN");
    expect(screen.getByRole("dialog", { name: zhCN.auth.management.members.roleTitle({ name: "协作者 Raw" }) })).toBe(dialog);
    expect(within(dialog).getByRole("button", { name: zhCN.auth.management.common.submitPending })).toBeDisabled();
    expect(fetcher).toHaveBeenCalledTimes(requests);
    const mutation = fetcher.mock.calls.find(([url, init]) => url === `/api/v1/projects/${projectId}/grants/${memberId}` && init?.method === "PUT")!;
    expect(mutation[1]!.body).toBe(`{"version":12,"role":"admin","expectedUserId":"${userId}"}`);
    expect(mutation[1]!.signal!.aborted).toBe(false);
    await act(async () => pending.resolve(failure(503, "internal_error")));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText(zhCN.auth.management.members.grantUnknown)).toBeVisible();
    expect(screen.getByRole("button", { name: zhCN.auth.management.members.readCurrentMembers })).toBeVisible();
    expect(screen.getByText("auth-locale-request")).toBeVisible();
    expect(fetcher.mock.calls.filter(([url, init]) => url === `/api/v1/projects/${projectId}/grants/${memberId}` && init?.method === "PUT")).toHaveLength(1);
  });

  it.each(["token", "member", "invitation"] as const)("keeps the %s revocation target while translating confirmation and cancellation", async (kind) => {
    const invitationId = "00000000-0000-4000-8000-000000000005";
    const fetcher = install((url) => {
      if (url === "/api/v1/me/tokens") return json({ items: [{ id: tokenId, name: "Raw 令牌", lastUsedAt: null, createdAt: timestamp, expiresAt: "2099-10-22T12:34:56Z" }] });
      if (url === `/api/v1/projects/${projectId}/invitations`) return json({ items: [{ id: invitationId, projectId, createdBy: userId, createdAt: timestamp, expiresAt: "2099-10-29T12:34:56Z", consumedBy: null, consumedAt: null, revokedAt: null }] });
      return defaults(url);
    });
    const interaction = userEvent.setup();
    let view: ReturnType<typeof renderWithLocale>;
    if (kind === "token") {
      window.history.replaceState(null, "", "/account");
      view = renderWithLocale(<AuthenticatedApp />, { locale: "en" });
      await interaction.click(await screen.findByRole("button", { name: en.auth.management.account.tokensTab }));
      await interaction.click(await screen.findByRole("button", { name: en.auth.management.account.revokeLabel({ name: "Raw 令牌" }) }));
      await waitFor(() => expect(fetcher.mock.calls.some(([url]) => url.startsWith("/api/v1/projects?"))).toBe(true));
    } else {
      view = renderWithLocale(<MembersPanel projectId={projectId} user={user} onRemoved={vi.fn()} />, { locale: "en", taskCache: { viewerId: userId } });
      await interaction.click(await screen.findByRole("button", { name: kind === "member" ? en.auth.management.members.removeLabel({ name: "协作者 Raw" }) : en.auth.management.members.revokeLabel({ id: invitationId }) }));
    }
    const dialog = screen.getByRole("dialog");
    if (kind !== "token") {
      const confirm = kind === "member" ? en.auth.management.members.removeConfirm : en.auth.management.members.revokeConfirm;
      await waitFor(() => expect(within(dialog).getByRole("button", { name: confirm })).not.toBeDisabled());
    }
    const requests = fetcher.mock.calls.length;
    if (kind === "token") expect(dialog).toHaveTextContent(en.auth.management.account.revokeBody({ name: "Raw 令牌" }));
    expect(within(dialog).queryByRole("combobox", { name: "语言 / Language" })).toBeNull();
    view.setLocale("zh-CN");
    const title = kind === "token" ? zhCN.auth.management.account.revokeTitle : kind === "member" ? zhCN.auth.management.members.removeTitle({ name: "协作者 Raw" }) : zhCN.auth.management.members.revokeTitle;
    expect(screen.getByRole("dialog", { name: title })).toBe(dialog);
    if (kind === "token") expect(dialog).toHaveTextContent(zhCN.auth.management.account.revokeBody({ name: "Raw 令牌" }));
    expect(fetcher).toHaveBeenCalledTimes(requests);
    await interaction.click(within(dialog).getByRole("button", { name: zhCN.auth.management.common.cancel }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(requests);
    expect(fetcher.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
  });

  it.each(["direct", "inherited"] as const)("shows the %s invitation relationship in both languages", async (kind) => {
    window.history.replaceState(null, "", "/invitations#relationship-secret");
    const direct = directAccessFixture(projectId, userId, "admin");
    const inherited = { ...direct, directGrant: null, teamRole: "admin", canTransfer: true };
    const access = kind === "direct" ? direct : inherited;
    const fetcher = install((url) => url === "/api/v1/invitations/inspect" ? json({ projectId, projectName: "Project", directGrant: access.directGrant, access }) : defaults(url));
    const interaction = userEvent.setup();
    renderWithLocale(<AuthenticatedApp />, { locale: "en" });
    await screen.findByText(kind === "direct" ? en.auth.invitation.preserveDirect : en.auth.invitation.inheritedAdmin);
    if (kind === "direct") expect(screen.getByText(`${en.auth.invitation.currentDirectRole}: ${en.auth.roles.admin}`)).toBeVisible();
    else expect(screen.getByText(en.auth.invitation.memberRole)).toBeVisible();
    await interaction.selectOptions(language(), "zh-CN");
    expect(screen.getByText(kind === "direct" ? zhCN.auth.invitation.preserveDirect : zhCN.auth.invitation.inheritedAdmin)).toBeVisible();
    if (kind === "direct") expect(screen.getByText(`${zhCN.auth.invitation.currentDirectRole}: ${zhCN.auth.roles.admin}`)).toBeVisible();
    else expect(screen.getByText(zhCN.auth.invitation.memberRole)).toBeVisible();
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/accept"))).toHaveLength(0);
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
    expect(window.sessionStorage.getItem(invitationStorageKey)).toBeNull();
    expect(document.title).toBe(zhCN.auth.shell.documentTitle.invitations);
    expect(fetcher).toHaveBeenCalledTimes(requests);
    await act(async () => pending.resolve(json({ projectId, projectName: "项目 Raw", directGrant: null, access: null })));
    expect(screen.getByRole("heading", { name: zhCN.auth.invitation.invited })).toBeVisible();
    expect(screen.getByRole("heading", { name: "项目 Raw" })).toBeVisible();
    expect(fetcher.mock.calls.filter(([url]) => url === "/api/v1/invitations/accept")).toHaveLength(0);
  });

  it("retranslates an account-change notice without removing a revealed token", async () => {
    const focused = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    window.history.replaceState(null, "", "/account");
    let checks = 0;
    const fetcher = install((url, init) => {
      if (url === "/api/v1/me") checks++;
      if (url === "/api/v1/me/tokens" && init?.method === "POST") return json({ id: tokenId, name: "Raw device", lastUsedAt: null, createdAt: timestamp, expiresAt: "2099-10-22T12:34:56Z", token: "kept-raw-secret" }, 201);
      return defaults(url);
    });
    const interaction = userEvent.setup();
    const { setLocale } = renderWithLocale(<AuthenticatedApp />, { locale: "en", getStorage: () => { throw new Error("storage unavailable"); } });
    await interaction.click(await screen.findByRole("button", { name: en.auth.management.account.tokensTab }));
    await interaction.click(await screen.findByRole("button", { name: en.auth.management.account.createToken }));
    const creating = screen.getByRole("dialog");
    await interaction.type(within(creating).getByLabelText(/Token name/), "Raw device");
    await interaction.click(within(creating).getByRole("button", { name: en.auth.management.account.createToken }));
    const secret = await screen.findByLabelText(en.auth.management.secret.tokenLabel);
    const reveal = screen.getByRole("dialog");
    focused.mockReturnValue(false); fireEvent(window, new Event("blur")); focused.mockReturnValue(true); fireEvent(window, new Event("focus"));
    expect(checks).toBe(1);
    act(() => { window.localStorage.setItem("daynight.activeUser", JSON.stringify("00000000-0000-4000-8000-000000000099")); window.dispatchEvent(new StorageEvent("storage", { key: "daynight.activeUser" })); });
    expect(await within(reveal).findByText("Account changed")).toBeVisible();
    const requests = fetcher.mock.calls.length;
    setLocale("zh-CN");
    expect(screen.getByRole("dialog", { name: zhCN.auth.management.secret.tokenTitle })).toBe(reveal);
    expect(within(reveal).getByText("账户已变化")).toBeVisible();
    expect(within(reveal).getByRole("button", { name: "刷新页面" })).toBeVisible();
    expect(within(reveal).queryByRole("combobox")).toBeNull();
    expect(secret).toHaveValue("kept-raw-secret");
    expect(screen.getByLabelText(zhCN.auth.management.secret.tokenLabel)).toBe(secret);
    expect(fetcher).toHaveBeenCalledTimes(requests);
    expect(checks).toBe(1);
  });
});

it("localizes the account change notice and refresh action", () => {
  const { setLocale } = renderWithLocale(<AccountChangeBanner active onReload={() => {}} />, { locale: "en" });
  expect(screen.getByRole("status")).toHaveTextContent("Account changed");
  expect(screen.getByRole("button", { name: "Refresh page" })).toBeVisible();
  setLocale("zh-CN");
  expect(screen.getByRole("status")).toHaveTextContent("账户已变化");
  expect(screen.getByRole("button", { name: "刷新页面" })).toBeVisible();
});
