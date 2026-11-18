import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CreateProjectDialog } from "../src/features/auth/CreateProjectDialog";
import { ProjectOwnership } from "../src/features/management/ProjectOwnership";
import { ProjectAccessBoundary } from "../src/features/projects/ProjectAccess";
import { createTaskCacheScope } from "../src/features/task-cache/project-cache";
import { createLocaleRender } from "./helpers/renderWithLocale";
import { directAccessFixture, TEST_VIEWER_ID, viewerHeaders } from "./helpers/taskSync";
import { stringifyWireJson } from "./helpers/wireJson";

vi.mock("../src/features/teams/TeamsProvider", () => ({ useTeams: () => ({ list: { items: [], status: "ready", cursor: null }, refreshList: vi.fn(), loadMore: vi.fn() }) }));

const projectId = "10000000-0000-4000-8000-000000000001";
const source = { id: "00000000-0000-4000-8000-000000000701", kind: "personal" as const, name: null };
const target = { id: "00000000-0000-4000-8000-000000000702", kind: "ordinary" as const, name: "Destination" };
const access = { ...directAccessFixture(projectId, TEST_VIEWER_ID, "admin"), teamRole: "admin" as const, canTransfer: true, directGrant: null };
const json = (body: unknown, status = 200) => new Response(stringifyWireJson(body), { status, headers: viewerHeaders(TEST_VIEWER_ID, { "Content-Type": "application/json" }) });
const refusal = (code: string) => json({ error: { code, message: "Private server detail", requestId: "repository-error-123" } }, 409);
const conflictText = { en: "The target Team already has a project for this repository.", "zh-CN": "目标 Team 已有同一仓库的项目。" };
const identityText = { en: "The current repository address cannot be recognized, so this project cannot be transferred.", "zh-CN": "当前仓库地址无法识别，无法转移项目。" };

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it.each(["en", "zh-CN"] as const)("shows a typed creation conflict and retains the original Team and draft (%s)", async (locale) => {
  const pending = Promise.withResolvers<Response>();
  const fetcher = vi.fn((_url: string, _options?: RequestInit) => pending.promise);
  vi.stubGlobal("fetch", fetcher);
  const onCreated = vi.fn(), onClose = vi.fn(), onPublished = vi.fn();
  const props = { userId: TEST_VIEWER_ID, teamPersonal: false, onIdentityMismatch: vi.fn(), onClose, onCreated, onPublished };
  const view = createLocaleRender(locale)(<CreateProjectDialog {...props} teamId={source.id} teamName="Source" />);
  const dialog = screen.getByRole("dialog"), draft = within(dialog).getByLabelText(locale === "en" ? /Project name/ : /项目名称/), repository = within(dialog).getByLabelText(locale === "en" ? /Repository URL/ : /仓库地址/);
  fireEvent.change(draft, { target: { value: "  Retained project  " } });
  fireEvent.change(repository, { target: { value: "git@example.test:repo.git" } });
  view.rerender(<CreateProjectDialog {...props} teamId={target.id} teamName="Destination" />);
  fireEvent.submit(dialog.querySelector("form")!);
  await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  expect(draft).toBeDisabled(); expect(repository).toBeDisabled();
  await act(async () => pending.resolve(refusal("project_repository_conflict")));
  expect(await within(dialog).findByText(conflictText[locale])).toBeVisible();
  expect(within(dialog).getByText("repository-error-123")).toBeVisible();
  expect(draft).toHaveValue("  Retained project  "); expect(repository).toHaveValue("git@example.test:repo.git");
  expect(draft).toBeEnabled(); expect(repository).toBeEnabled();
  expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({ teamId: source.id });
  expect(onCreated).not.toHaveBeenCalled(); expect(onPublished).not.toHaveBeenCalled(); expect(onClose).not.toHaveBeenCalled();
  expect(screen.queryByText("Private server detail")).toBeNull();
  expect(screen.queryByRole("button", { name: locale === "en" ? "Check projects" : "查看项目" })).toBeNull();
  expect(fetcher).toHaveBeenCalledOnce();
});

it("keeps an unrecognized creation refusal on the default error path", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => refusal("unrecognized_conflict")));
  const onCreated = vi.fn();
  createLocaleRender("en")(<CreateProjectDialog userId={TEST_VIEWER_ID} onIdentityMismatch={vi.fn()} onClose={vi.fn()} onCreated={onCreated} />);
  fireEvent.change(screen.getByLabelText(/Project name/), { target: { value: "Project" } });
  fireEvent.change(screen.getByLabelText(/Repository URL/), { target: { value: "git@example.test:repo.git" } });
  fireEvent.submit(screen.getByRole("dialog").querySelector("form")!);
  expect(await screen.findByText("The project could not be created. Check your input and try again.")).toBeVisible();
  expect(screen.getByText("repository-error-123")).toBeVisible(); expect(onCreated).not.toHaveBeenCalled();
});

it.each((["en", "zh-CN"] as const).flatMap(locale => [
  { locale, code: "project_repository_conflict", text: conflictText[locale] },
  { locale, code: "project_repository_identity_unavailable", text: identityText[locale] },
  { locale, code: "unrecognized_conflict", text: locale === "en" ? "The operation could not be completed. Check the details and try again." : "无法完成操作，请检查后重试。" },
]))("retains the transfer editor after $code ($locale)", async ({ locale, code, text }) => {
  const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() });
  const pending = Promise.withResolvers<Response>(), onTransferred = vi.fn();
  const fetcher = vi.fn(async (url: string) => {
    if (url === `/api/v1/projects/${projectId}/access`) return json(access);
    if (url === `/api/v1/projects/${projectId}/transfer-preview`) return json({ sourceTeam: source, targetTeam: { ...target, version: 1n }, ownership: access.ownership, actorRole: "admin" });
    if (url === `/api/v1/projects/${projectId}/transfer`) return pending.promise;
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetcher);
  try {
    createLocaleRender(locale)(<ProjectAccessBoundary projectId={projectId} initialRead><ProjectOwnership projectId={projectId} projectName="Project" active onTransferred={onTransferred} /></ProjectAccessBoundary>, { taskCache: { scope } });
    const opener = await screen.findByRole("button", { name: locale === "en" ? "Transfer project" : "转移项目" });
    await waitFor(() => expect(opener).toBeEnabled()); fireEvent.click(opener);
    const dialog = screen.getByRole("dialog"), draft = within(dialog).getByLabelText(locale === "en" ? "Team ID or link" : "目标 Team ID 或链接");
    fireEvent.change(draft, { target: { value: target.id } });
    fireEvent.click(within(dialog).getByRole("button", { name: locale === "en" ? "Preview" : "预览" }));
    const confirm = within(dialog).getByRole("button", { name: locale === "en" ? "Confirm transfer" : "确认转移" });
    await waitFor(() => expect(confirm).toBeEnabled()); fireEvent.click(confirm);
    await waitFor(() => expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/transfer"))).toHaveLength(1));
    expect(draft).toBeDisabled(); expect(confirm).toBeDisabled();
    await act(async () => pending.resolve(refusal(code)));
    expect(await within(dialog).findByText(text)).toBeVisible();
    expect(within(dialog).getByText("repository-error-123")).toBeVisible();
    expect(draft).toBeEnabled(); expect(draft).toHaveValue(target.id); expect(confirm).toBeEnabled();
    expect(within(dialog).getByText("Destination")).toBeVisible();
    expect(onTransferred).not.toHaveBeenCalled(); expect(screen.queryByText("Private server detail")).toBeNull();
    expect(within(dialog).queryByRole("button", { name: locale === "en" ? "Check current state" : "查看当前状态" })).toBeNull();
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/transfer"))).toHaveLength(1);
  } finally { pending.resolve(refusal(code)); scope.dispose(); }
});
