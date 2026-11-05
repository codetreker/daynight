import { expect, test } from "vitest";
import { shutdownWorkerExecutions } from "../../../src/commands/worker/shutdown.js";

test("a task shutdown failure does not suppress Bot shutdown and both failures remain visible", async () => {
  const attempted: string[] = [], taskError = new Error("task stop unproven"), botError = new Error("bot stop unproven");
  const result = await shutdownWorkerExecutions({
    tasks: async () => { attempted.push("tasks"); throw taskError; },
    bots: async () => { attempted.push("bots"); throw botError; },
  }).catch(error => error);
  expect(attempted).toEqual(["tasks", "bots"]);
  expect(result).toBeInstanceOf(AggregateError); expect(result.errors).toEqual([taskError, botError]);
});

test("Bot-only shutdown awaits the actual stop result", async () => {
  let release!: () => void, complete = false;
  const work = shutdownWorkerExecutions({ bots: () => new Promise(resolve => { release = resolve; }) }).then(() => { complete = true; });
  await Promise.resolve(); expect(complete).toBe(false); release(); await work; expect(complete).toBe(true);
});
