import type { WebhookActiveEndpoint } from "../../api/webhooks";
import type { WebhookIntentInput } from "../webhook-intents/controller";

export const webhookExpansion = (input: WebhookIntentInput, endpoint: WebhookActiveEndpoint | null): boolean => {
  if (input.kind === "endpoint.create") return true;
  if (input.kind !== "endpoint.patch") return false;
  const body = input.body;
  if ("mode" in body) return false;
  if (body.destination !== undefined || body.enabled === true || body.confirmProjectIds !== undefined && body.confirmProjectIds.length > 0) return true;
  if (body.subscriptions === undefined) return false;
  if (endpoint === null || endpoint.id !== input.endpointId) return true;
  return body.subscriptions.some(subscription => {
    const original = endpoint.subscriptions.find(existing => existing.id === subscription.id);
    return original === undefined || original.projectId !== subscription.projectId || subscription.eventTypes.some(event => !original.eventTypes.includes(event));
  });
};

export const webhookAdmissionError = (name: "WebhookExpansionUnavailable" | "WebhookIntentBusy" | "WebhookAdmissionUnavailable"): Error => {
  const error = new Error(name);
  error.name = name;
  return error;
};
