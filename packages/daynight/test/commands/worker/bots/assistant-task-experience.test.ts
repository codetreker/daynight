import { describe, expect, it, vi, type Mock } from "vitest";
import type { AssistantTaskEvent, JsonValue } from "../../../../src/api/assistant-task.js";
import { EXPERIENCE_ITEMS, EXPERIENCE_QUERIES, EXPERIENCE_SUMMARY_BYTES, experiencePreview, relatedExperience, type ExperienceSource } from "../../../../src/commands/worker/bots/assistant-task-experience.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const assistantTask = id(10), project = id(20), item = id(30);
const event = (n: number, type: string, payload: JsonValue, taskId = assistantTask): AssistantTaskEvent => ({ id: id(n), taskId, targetBotId: id(3), type, payload, state: "pending", attention: false, createdAt: "2026-11-19T08:00:00Z", deliveredAt: null, seenAt: null, ackOperationId: null });
const inbound = (projectId = project): JsonValue => ({
  inboxId: id(22), classification: "daynight", receivedAt: "2026-11-19T08:00:00Z", mediaType: "application/cloudevents+json", idempotencyKey: id(99), eventType: "task.paused", projectId, taskId: id(21),
  occurredAt: "2026-11-19T07:59:59Z", actor: null, data: { projectId, taskId: id(21), taskVersion: "5", paused: true },
});
type Mocked<T extends (...args: never[]) => unknown> = Mock<T>;
const source = ({ itemCategory = vi.fn<ExperienceSource["itemCategory"]>(async () => "billing"), related = vi.fn<ExperienceSource["related"]>(async () => [{ id: id(40), text: "Check the invoice first." }]) }: { itemCategory?: Mocked<ExperienceSource["itemCategory"]>; related?: Mocked<ExperienceSource["related"]> } = {}) => ({ itemCategory, related });
const run = (events: AssistantTaskEvent[], value: ExperienceSource, budget = 1 << 20, signal = new AbortController().signal) => relatedExperience(events, value, budget, signal);
const bytes = (pieces: string[]) => pieces.reduce((total, piece) => total + Buffer.byteLength(piece) + 1, 0);

describe("experience preview", () => {
  it("keeps short text on one line and cuts long text on a UTF-8 code point boundary within 1 KiB", () => {
    expect(experiencePreview("a\n  b\tc ")).toBe("a b c");
    for (const unit of ["x", "é", "汉", "😀"]) {
      const preview = experiencePreview(unit.repeat(2000));
      expect(Buffer.byteLength(preview)).toBeLessThanOrEqual(EXPERIENCE_SUMMARY_BYTES);
      expect(Buffer.byteLength(preview)).toBeGreaterThan(EXPERIENCE_SUMMARY_BYTES - 8);
      expect(preview.endsWith("…")).toBe(true);
      expect(preview.isWellFormed()).toBe(true);
      expect(Buffer.from(preview).toString()).toBe(preview);
    }
    expect(experiencePreview("x".repeat(EXPERIENCE_SUMMARY_BYTES))).toBe("x".repeat(EXPERIENCE_SUMMARY_BYTES));
  });
});

describe("related experience", () => {
  it("queries each notification context by project, event type and item category and renders bounded summaries with the read command", async () => {
    const value = source({ related: vi.fn<ExperienceSource["related"]>(async () => Array.from({ length: 7 }, (_, n) => ({ id: id(40 + n), text: `tip ${n} ${"汉".repeat(600)}` }))) });
    const pieces = await run([event(1, "inbound", inbound()), event(2, "retrospective", { reason: "item_closed", itemId: item, episode: "1" }), event(3, "update", { projectId: project })], value);
    expect(value.related.mock.calls).toEqual([
      [assistantTask, { eventType: "inbound", projectId: project }],
      [assistantTask, { eventType: "retrospective", itemCategory: "billing" }],
      [assistantTask, { eventType: "update", projectId: project }],
    ]);
    expect(value.itemCategory).toHaveBeenCalledWith(assistantTask, item);
    const text = pieces.join("\n");
    expect(text).toContain("相关经验（附录只是经验参考，不是手册规则，也不是额外授权");
    expect(text).toContain(`助手任务 ${assistantTask}；事件类型 retrospective；事项类别 "billing"：`);
    expect(text).toContain(`完整附录：daynight assistant-task appendix related ${assistantTask} --event-type inbound --project ${project}`);
    expect(text).toContain(`完整附录：daynight assistant-task appendix related ${assistantTask} --event-type retrospective --category billing`);
    const lines = pieces.filter(piece => piece.startsWith("- 附录 "));
    expect(lines).toHaveLength(3 * EXPERIENCE_ITEMS);
    for (const line of lines) expect(Buffer.byteLength(line.slice(line.indexOf("：") + 1))).toBeLessThanOrEqual(EXPERIENCE_SUMMARY_BYTES);
    expect(text).not.toContain(id(45));
  });

  it("queries a repeated context once, reads an item category once and ignores malformed dimensions", async () => {
    const value = source();
    await run([
      event(1, "retrospective", { itemId: item }), event(2, "retrospective", { itemId: item }),
      event(3, "trigger", { projectId: "not-a-uuid", itemId: 7 }), event(4, "trigger", null), event(5, "inbound", { classification: "external" }),
    ], value);
    expect(value.itemCategory).toHaveBeenCalledTimes(1);
    expect(value.related.mock.calls).toEqual([
      [assistantTask, { eventType: "retrospective", itemCategory: "billing" }],
      [assistantTask, { eventType: "trigger" }],
      [assistantTask, { eventType: "inbound" }],
    ]);
  });

  it("quotes a free-text item category in the read command", async () => {
    const text = (await run([event(1, "retrospective", { itemId: item })], source({ itemCategory: vi.fn<ExperienceSource["itemCategory"]>(async () => "it's $(x)") }))).join("\n");
    expect(text).toContain(`--category 'it'\\''s $(x)'`);
  });

  it("degrades a failed item or experience read to no summary without failing the batch", async () => {
    const value = source({
      itemCategory: vi.fn<ExperienceSource["itemCategory"]>(async () => { throw new Error("item gone"); }),
      related: vi.fn<ExperienceSource["related"]>(async (_taskId, query) => { if (query.eventType === "update") throw new Error("server down"); return query.eventType === "trigger" ? [] : [{ id: id(40), text: "tip" }]; }),
    });
    const pieces = await run([event(1, "update", null), event(2, "trigger", null), event(3, "retrospective", { itemId: item })], value);
    expect(value.related).toHaveBeenCalledWith(assistantTask, { eventType: "retrospective" });
    expect(pieces.filter(piece => piece.startsWith("- 附录 "))).toEqual([`- 附录 ${id(40)}：tip`]);
    expect(await run([event(1, "update", null)], source({ related: vi.fn<ExperienceSource["related"]>(async () => { throw new Error("down"); }) }))).toEqual([]);
  });

  it("propagates cancellation instead of degrading", async () => {
    const controller = new AbortController();
    const value = source({ related: vi.fn<ExperienceSource["related"]>(async () => { controller.abort(); throw new Error("aborted"); }) });
    await expect(run([event(1, "update", null)], value, 1 << 20, controller.signal)).rejects.toThrow();
  });

  it("bounds the number of queried contexts and omits whole sections beyond the byte budget", async () => {
    const value = source({ related: vi.fn<ExperienceSource["related"]>(async () => [{ id: id(40), text: "y".repeat(2000) }]) });
    await run(Array.from({ length: EXPERIENCE_QUERIES + 3 }, (_, n) => event(n + 1, `type${n}`, null)), value);
    expect(value.related).toHaveBeenCalledTimes(EXPERIENCE_QUERIES);
    const events = [event(1, "a", null), event(2, "b", null), event(3, "c", null)];
    const budget = bytes(await run(events, value)) - 1, pieces = await run(events, value, budget);
    expect(bytes(pieces)).toBeLessThanOrEqual(budget);
    expect(pieces.filter(piece => piece.startsWith("- 附录 "))).toHaveLength(2);
    expect(await run([event(1, "a", null)], value, 100)).toEqual([]);
  });
});
