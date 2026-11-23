import { describe, expect, it } from "vitest";
import { parseWebhookCatalog } from "../../src/api/webhook.js";
import { ProtocolError } from "../../src/api/validation.js";
import { continuingWebhookEvents, webhookCatalog } from "../fixtures/webhook-catalog.js";

describe("Webhook catalog decoding", () => {
  it.each([continuingWebhookEvents, ["task.step_updated", ...continuingWebhookEvents].reverse()])("accepts required events with optional Steps and preserves order: %j", (...keys) => {
    const catalog = webhookCatalog(keys);
    expect(parseWebhookCatalog(catalog)).toEqual(catalog);
  });

  it.each(continuingWebhookEvents)("requires %s even when Steps is present", missing => {
    const keys = [...continuingWebhookEvents.filter(key => key !== missing), "task.step_updated"];
    expect(() => parseWebhookCatalog(webhookCatalog(keys))).toThrow(ProtocolError);
  });

  it.each([
    [],
    [...continuingWebhookEvents, "task.created"],
    [...continuingWebhookEvents, "task.step_updated", "task.step_updated"],
    [...continuingWebhookEvents, "task.unknown"],
  ])("rejects incomplete, repeated and unknown event sets: %j", (...keys) => {
    expect(() => parseWebhookCatalog(webhookCatalog(keys))).toThrow(ProtocolError);
  });

  it.each(["task.created", "task.step_updated"])("validates every wire field for %s", key => {
    for (const patch of [{ wireType: "cc.daynight.task.created.v2" }, { schemaVersion: 2 }, { schemaVersion: "1" }, { resourceKind: "task" }, { extra: true }]) {
      const catalog = webhookCatalog([...continuingWebhookEvents, "task.step_updated"]);
      const items = catalog.items.map(item => item.key === key ? { ...item, ...patch } : item);
      expect(() => parseWebhookCatalog({ ...catalog, items })).toThrow(ProtocolError);
    }
  });

  it("retains service and limit validation for both catalog sizes", () => {
    for (const keys of [continuingWebhookEvents, [...continuingWebhookEvents, "task.step_updated"]]) {
      const catalog = webhookCatalog(keys);
      for (const service of [{ ...catalog.service, dispatchEnabled: "true" }, { configurationExpansionAvailable: true }]) {
        expect(() => parseWebhookCatalog({ ...catalog, service })).toThrow(ProtocolError);
      }
      for (const limits of [{ ...catalog.limits, policyVersion: "01" }, { ...catalog.limits, requestBytes: 0 }, { ...catalog.limits, extra: 1 }]) {
        expect(() => parseWebhookCatalog({ ...catalog, limits })).toThrow(ProtocolError);
      }
    }
  });
});
