import type { WebhookDelivery } from "../../api/webhooks";

export const redactWebhookDelivery = (value: WebhookDelivery): WebhookDelivery => ({ ...value, disclosure: "metadata_only", eventType: null, resourceVersion: null, resource: { projectId: null, taskId: null, stepId: null, messageId: null, displayName: null }, target: { ...value.target, url: null, displayUrl: null }, payloadAvailable: false });

type Observation = { readonly epoch: number; readonly generation: string | null; readonly value: WebhookDelivery | null };
const restricted = (value: WebhookDelivery | null): boolean => value === null || value.disclosure === "metadata_only" || !value.payloadAvailable;

// A delivery generation does not change when current disclosure changes. Reads
// begun before a restrictive observation cannot reinstall their older projection.
export class WebhookDeliveryObservations {
  #epoch = 0;
  #values = new Map<string, Observation>();

  beginRead = (): number => this.#epoch;
  current = (id: string): WebhookDelivery | null | undefined => this.#values.get(id)?.value;
  clear = (): void => { this.#epoch++; this.#values.clear(); };

  observe = (value: WebhookDelivery, startedAt: number): WebhookDelivery | null => {
    const previous = this.#values.get(value.id);
    if (previous !== undefined && (startedAt < previous.epoch || previous.generation !== null && BigInt(value.generation) < BigInt(previous.generation))) return previous.value;
    const advances = restricted(value) || previous !== undefined && restricted(previous.value);
    const epoch = advances ? ++this.#epoch : previous?.epoch ?? this.#epoch;
    this.#values.set(value.id, { epoch, generation: value.generation, value });
    return value;
  };

  restrict = (id: string, value: WebhookDelivery | null): void => {
    const previous = this.#values.get(id);
    if (value !== null && previous?.value !== null && previous?.value !== undefined && previous.generation !== null && BigInt(previous.generation) > BigInt(value.generation)) value = value.disclosure === "metadata_only" ? redactWebhookDelivery(previous.value) : { ...previous.value, payloadAvailable: false };
    this.#values.set(id, { epoch: ++this.#epoch, generation: value === null ? previous?.generation ?? null : value.generation, value });
  };
}
