import { randomUUID } from "node:crypto";
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { cli, expect, topology } from "./fixtures.ts";

type Participant = {
  userId: string;
  effectiveRole: string;
  inheritedFrom: { role: string; team: { id: string; kind: string } } | null;
  directGrant: { role: string } | null;
};
type Members = { items: Participant[]; actorAccess: { effectiveRole: string; teamRole: string | null; directGrant: { role: string } | null; ownerTeam: { kind: string } } };

const signIn = async (browser: Browser, identity: "member" | "collaborator"): Promise<{ context: BrowserContext; page: Page; id: string }> => {
  const context = await browser.newContext({
    locale: "en-US", ignoreHTTPSErrors: true,
    proxy: { server: topology.proxyURL, bypass: "127.0.0.1,localhost,*.localhost" },
  });
  try {
    const page = await context.newPage();
    await page.goto(`${topology.baseURL}/login`);
    await page.getByRole("button", { name: "Sign in with GitHub", exact: true }).click();
    await page.getByRole("button", { name: `Authorize ${identity} identity`, exact: true }).click();
    await expect(page.getByRole("link", { name: "Projects", exact: true })).toBeVisible();
    const response = await page.request.get(`${topology.baseURL}/api/v1/me`);
    expect(response.status()).toBe(200);
    const account = await response.json() as { id: string; email: string };
    expect(account.email).toBe(`${identity}@example.test`);
    return { context, page, id: account.id };
  } catch (error) {
    await context.close();
    throw error;
  }
};

const createProject = async (name: string, team: string): Promise<string> => {
  const result = await cli(["project", "create", name, "--repo", `https://example.test/e2e/${randomUUID()}.git`, "--team", team, "--confirm"]);
  const id = result.stdout.match(/^ID: ([0-9a-f-]{36})$/m)?.[1];
  if (id === undefined) throw new Error("Project creation did not return an ID");
  return id;
};

const readMembers = async (page: Page, projectId: string): Promise<Members> => {
  const response = await page.request.get(`${topology.baseURL}/api/v1/projects/${projectId}/members`);
  expect(response.status()).toBe(200);
  return await response.json() as Members;
};

const addCollaborator = async (page: Page, projectId: string, userId: string): Promise<void> => {
  await page.goto(`${topology.baseURL}/projects/${projectId}/settings?tab=members`);
  const search = page.getByRole("searchbox", { name: "Search and add members", exact: true });
  await search.fill("collaborator@example.test");
  const add = page.getByRole("button", { name: new RegExp(`^Add .*${userId}$`) });
  await expect(add).toBeVisible();
  const result = page.waitForResponse(response => new URL(response.url()).pathname === `/api/v1/projects/${projectId}/members/${userId}` && response.request().method() === "POST");
  await add.click();
  const response = await result;
  expect(response.status()).toBe(200);
  expect(await response.json()).toMatchObject({ added: true, participant: { userId, effectiveRole: "member", inheritedFrom: null, directGrant: { role: "member" } } });
  await expect(page.getByLabel("Direct grant for E2E Collaborator", { exact: true })).toHaveValue("member");
  const participant = (await readMembers(page, projectId)).items.find(item => item.userId === userId);
  expect(participant).toMatchObject({ userId, effectiveRole: "member", inheritedFrom: null, directGrant: { role: "member" } });
};

export const verifyProjectMemberFlow = async (page: Page): Promise<void> => {
  const browser = page.context().browser();
  if (browser === null) throw new Error("Browser is unavailable");
  const member = await signIn(browser, "member");
  try {
    const collaborator = await signIn(browser, "collaborator");
    await collaborator.context.close();
    const collaboratorId = collaborator.id;
    expect(member.id).not.toBe(collaboratorId);
    const team = JSON.parse((await cli(["team", "create", "Project member E2E", "--confirm", "--json"])).stdout) as { id: string };
    const teamMembers = async () => JSON.parse((await cli(["team", "member", "list", "--team", team.id, "--json"])).stdout) as { userId: string; role: string }[];
    const originalTeam = (await teamMembers()).map(({ userId, role }) => ({ userId, role })).sort((a, b) => a.userId.localeCompare(b.userId));
    expect(originalTeam.some(item => item.userId === member.id || item.userId === collaboratorId)).toBe(false);

    const independent = await createProject("Independent project admin E2E", team.id);
    await page.goto(`${topology.baseURL}/projects/${independent}/settings?tab=members`);
    await page.getByRole("button", { name: "Invite member", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Create invitation link", exact: true }).click();
    const link = await page.getByLabel("One-time invitation link").inputValue();
    await page.getByRole("button", { name: "I have saved it, close", exact: true }).click();
    await member.page.goto(link);
    await member.page.getByRole("button", { name: "Accept invitation and join", exact: true }).click();
    await expect(member.page).toHaveURL(new RegExp(`/projects/${independent}(?:[/?]|$)`));
    await page.reload();
    const role = page.getByLabel("Direct grant for E2E Member", { exact: true });
    await role.selectOption("admin");
    await page.getByRole("dialog").getByRole("button", { name: "Save role", exact: true }).click();
    await expect(role).toHaveValue("admin");
    const independentAccess = await readMembers(member.page, independent);
    expect(independentAccess.actorAccess).toMatchObject({ effectiveRole: "admin", teamRole: null, directGrant: { role: "admin" } });
    await addCollaborator(member.page, independent, collaboratorId);

    const reconnect = await signIn(browser, "collaborator");
    try {
      expect(reconnect.id).toBe(collaboratorId);
      await reconnect.page.goto(`${topology.baseURL}/projects/${independent}`);
      await expect(reconnect.page.getByRole("heading", { name: "Independent project admin E2E", exact: true })).toBeVisible();
      const collaboratorAccess = await readMembers(reconnect.page, independent);
      expect(collaboratorAccess.actorAccess).toMatchObject({ effectiveRole: "member", teamRole: null, directGrant: { role: "member" } });
    } finally { await reconnect.context.close(); }
    expect((await teamMembers()).map(({ userId, role }) => ({ userId, role })).sort((a, b) => a.userId.localeCompare(b.userId))).toEqual(originalTeam);

    const inheritedTeam = JSON.parse((await cli(["team", "create", "Inherited admin E2E", "--confirm", "--json"])).stdout) as { id: string };
    await page.goto(`${topology.baseURL}/teams/${inheritedTeam.id}/members`);
    await page.getByRole("searchbox", { name: "Search and add members", exact: true }).fill("member@example.test");
    await page.getByRole("button", { name: new RegExp(`^Add .*${member.id}$`) }).click();
    await expect(page.locator(`#team-role-${inheritedTeam.id}-${member.id}`)).toHaveValue("member");
    await cli(["team", "member", "set-role", member.id, "admin", "--team", inheritedTeam.id, "--confirm", "--json"]);
    const inherited = await createProject("Inherited project admin E2E", inheritedTeam.id);
    expect((await readMembers(member.page, inherited)).actorAccess).toMatchObject({ effectiveRole: "admin", teamRole: "admin", directGrant: null });
    await addCollaborator(member.page, inherited, collaboratorId);

    const personal = await createProject("Personal project admin E2E", "personal");
    expect((await readMembers(page, personal)).actorAccess).toMatchObject({ effectiveRole: "admin", teamRole: "admin", ownerTeam: { kind: "personal" } });
    await addCollaborator(page, personal, collaboratorId);
    expect((await teamMembers()).map(({ userId, role }) => ({ userId, role })).sort((a, b) => a.userId.localeCompare(b.userId))).toEqual(originalTeam);
  } finally { await member.context.close(); }
};
