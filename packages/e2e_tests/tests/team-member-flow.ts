import type { Page } from "@playwright/test";
import { cli, expect, topology } from "./fixtures.ts";

export const verifyTeamMemberFlow = async (page: Page): Promise<void> => {
  const browser = page.context().browser();
  if (browser === null) throw new Error("Browser is unavailable");
  const context = await browser.newContext({
    locale: "en-US", ignoreHTTPSErrors: true,
    proxy: { server: topology.proxyURL, bypass: "127.0.0.1,localhost,*.localhost" },
  });
  let memberId: string;
  try {
    const memberPage = await context.newPage();
    await memberPage.goto(`${topology.baseURL}/login`);
    await memberPage.getByRole("button", { name: "Sign in with GitHub", exact: true }).click();
    await memberPage.getByRole("button", { name: "Authorize member identity", exact: true }).click();
    await expect(memberPage.getByRole("link", { name: "Projects", exact: true })).toBeVisible();
    const response = await memberPage.request.get(`${topology.baseURL}/api/v1/me`);
    expect(response.status()).toBe(200);
    const account = await response.json() as { id: string; email: string };
    expect(account.email).toBe("member@example.test");
    memberId = account.id;
  } finally { await context.close(); }

  const team = JSON.parse((await cli(["team", "create", "Member search E2E", "--confirm", "--json"])).stdout) as { id: string };
  await page.goto(`${topology.baseURL}/teams/${team.id}/members`);
  const search = page.getByRole("searchbox", { name: "Search and add members" });
  await search.fill("member@example.test");
  const add = page.getByRole("button", { name: new RegExp(`Add.*${memberId}`) });
  await expect(add).toBeVisible();
  await add.click();
  await expect(page.locator(`#team-role-${team.id}-${memberId}`)).toHaveValue("member");
  await expect(search).toHaveValue("member@example.test");
  const members = JSON.parse((await cli(["team", "member", "list", "--team", team.id, "--json"])).stdout) as { userId: string; role: string }[];
  expect(members.filter((member) => member.userId === memberId)).toEqual([expect.objectContaining({ userId: memberId, role: "member" })]);
  await page.reload();
  await expect(page.locator(`#team-role-${team.id}-${memberId}`)).toHaveValue("member");
};
