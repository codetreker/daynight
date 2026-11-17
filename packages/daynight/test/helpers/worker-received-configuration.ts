import { receiveWorkerDesired } from "../../src/api/worker-configuration.js";
import type { ReceivedWorkerConfigurationReceipt, ReceivedWorkerConfigurationResource, ReceivedWorkerDesired, WorkerCloudDesired, WorkerCloudReceipt, WorkerCloudResource } from "../../src/api/worker-configuration.js";

export const receivedDesired = (value: WorkerCloudDesired | null): ReceivedWorkerDesired | null => value === null ? null : receiveWorkerDesired(JSON.stringify(value));
export const receivedReceipt = (value: WorkerCloudReceipt): ReceivedWorkerConfigurationReceipt => ({ json: JSON.stringify(value), desired: receivedDesired(value.desired), observationRevision: value.observationRevision, observationAccepted: value.observationAccepted });
export const receivedResource = (value: WorkerCloudResource): ReceivedWorkerConfigurationResource => ({ json: JSON.stringify(value), desired: receivedDesired(value.desired), observationRevision: value.observationRevision, observationJson: value.observation === null ? null : JSON.stringify(value.observation) });
