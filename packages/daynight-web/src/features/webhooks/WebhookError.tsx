import { ApiError } from "../../api/client";
import { WebhookIcon } from "./WebhookIcon";
import { useWebhookMessages } from "./messages";

export const WebhookError = ({ error }: { readonly error: unknown }) => {
  const m = useWebhookMessages();
  const text = error instanceof ApiError ? error.kind === "network" ? m.networkError : error.kind === "protocol" ? m.protocolError : error.status === 409 ? m.versionConflict : m.error : m.error;
  return <div className="inline-error" role="alert"><WebhookIcon name="alert"/><span>{text}{error instanceof ApiError && <><span className="webhook-error-code"> {error.code}</span>{error.requestId !== null && <small className="webhook-error-id">{error.requestId}</small>}</>}</span></div>;
};
