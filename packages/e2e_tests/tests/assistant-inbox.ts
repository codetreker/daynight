import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { cli, confidentialCli, expect, topology } from "./fixtures.ts";

export type PeerEvent = { method: string; threadId: string; botId?: string | null; text?: string };
type Bot = { id: string; sessionId: string | null; startupResult: { state: string } };
type AssistantTask = { id: string; version: string; holderBotId: string | null; claimState: string };
type InboxEnable = { inbox: { inboxId: string; enabled: boolean }; token: string | null };
type Receipt = { eventId: string; classification: string; duplicate: boolean; suppressed: boolean };
type EventPage = { items: { id: string; type: string; state: string; targetBotId: string; payload: { classification?: string; body?: string } }[] };

const json = async <T>(args: string[]): Promise<T> => JSON.parse((await cli([...args, "--json"])).stdout) as T;

/**
 * An external sender posts to the public inbox of an auto-takeover assistant
 * task. The Worker hosting the holder Bot pulls the inbound event and renders
 * it into the Bot's native Session; the controlled peer records that input.
 * Claiming and delivery follow the Worker's normal minute-loop cadence.
 */
export const verifyAssistantInbox = async (input: { workerId: string; root: string; events(): Promise<PeerEvent[]>; registerBot(botId: string): Promise<void>; verifyBotLaunch(botId: string): Promise<void> }): Promise<void> => {
  const cwd = path.join(input.root, "assistant");
  await mkdir(cwd);
  // Enable the inbox before any Bot exists: an auto-takeover claim saves the
  // task, so a ready Bot could advance its version between creation and the
  // version-guarded enablement.
  const created = await json<AssistantTask>(["assistant-task", "create", "--name", "Inbox product flow", "--takeover", "auto",
    "--body", "Read inbound notifications and record what they report."]);
  // The response carries the bearer token, so it stays out of test output and diagnostics.
  let enabled: InboxEnable;
  try { enabled = JSON.parse(await confidentialCli(["assistant-task", "inbox", "enable", created.id, "--if-version", created.version, "--json"])) as InboxEnable; }
  catch (error) { throw new Error("Inbox enablement failed; its response is withheld.", { cause: error instanceof SyntaxError ? undefined : error }); }
  expect(enabled.inbox.enabled).toBe(true);
  const token = enabled.token;
  if (token === null) throw new Error("Inbox enablement did not return its token.");

  // Recovery stops the Bot's Controller tree from this identity if the Worker is stopped forcibly.
  const botId = randomUUID();
  await input.registerBot(botId);
  await cli(["bot", "create", "--name", "Inbox assistant", "--worker", input.workerId, "--agent", "codex", "--cwd", cwd, "--request-id", botId, "--json"]);
  await expect.poll(async () => (await json<Bot>(["bot", "show", botId])).startupResult.state, { timeout: 120_000, intervals: [1_000] }).toBe("ready");
  await input.verifyBotLaunch(botId);
  await expect.poll(async () => {
    const task = await json<AssistantTask>(["assistant-task", "show", created.id]);
    return task.holderBotId === botId && task.claimState === "active";
  }, { timeout: 150_000, intervals: [2_000] }).toBe(true);

  const marker = `inbox-${randomUUID()}`, body = JSON.stringify({ source: "product-e2e", marker });
  const response = await fetch(`${topology.baseURL}/api/v1/assistant-task-inbox/${enabled.inbox.inboxId}`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Idempotency-Key": marker }, body,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  expect(response.status, text).toBe(202);
  const receipt = JSON.parse(text) as Receipt;
  expect(receipt).toMatchObject({ eventId: expect.any(String), classification: "external", duplicate: false, suppressed: false });

  // The Worker acknowledges only after the native Session accepted the input.
  await expect.poll(async () => {
    const page = await json<EventPage>(["assistant-task", "events", "pull", created.id, "--state", "delivered", "--target-bot", botId]);
    return page.items.find(event => event.id === receipt.eventId)?.type ?? null;
  }, { timeout: 150_000, intervals: [2_000] }).toBe("inbound");
  const delivered = (await json<EventPage>(["assistant-task", "events", "pull", created.id, "--state", "delivered", "--target-bot", botId])).items.find(event => event.id === receipt.eventId)!;
  expect(delivered.payload).toMatchObject({ classification: "external", body });

  const events = await input.events();
  const threads = new Set(events.filter(event => event.botId === botId && (event.method === "thread/start" || event.method === "thread/resume")).map(event => event.threadId));
  expect(threads.size).toBe(1);
  const turns = events.filter(event => event.method === "turn/start" && event.text?.includes(marker));
  expect(turns).toHaveLength(1);
  // The peer rejects a turn addressed to another thread, so this ties the delivery to the holder's native thread.
  expect(turns[0]).toMatchObject({ botId, threadId: [...threads][0] });
  const notification = turns[0]!.text!;
  const header = notification.indexOf(`入站外部事件 ${receipt.eventId}`);
  expect(header).toBeGreaterThanOrEqual(0);
  // The whole external body is the only content of its untrusted-data fence.
  const fenced = "\n```untrusted-external-data\n" + body + "\n```\n";
  expect(notification.indexOf(fenced, header)).toBeGreaterThan(header);
  expect(notification).toContain(`daynight assistant-task manual show ${created.id}`);
  const session = (await json<Bot>(["bot", "show", botId])).sessionId;
  expect(session).not.toBeNull();
};
