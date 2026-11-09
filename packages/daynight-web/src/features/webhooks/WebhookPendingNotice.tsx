import type { WebhookIntentState } from "../webhook-intents/controller";
import { useWebhookMessages } from "./messages";
import { WebhookIcon } from "./WebhookIcon";

export const WebhookPendingNotice = ({ state, active, onCheck }: { readonly state: WebhookIntentState; readonly active: boolean; readonly onCheck: () => void }) => {
  const m = useWebhookMessages();
  if (state.phase !== "unknown" || state.prepared === null) return null;
  return <div className="warning-box webhook-pending-notice" role="status">
    <p>{m.unknown}</p><span className="tiny">{m.operationId}</span><code>{state.prepared.operationId}</code>
    <button className="button small" type="button" disabled={!active || state.reconciling} onClick={onCheck}>{state.reconciling ? <span className="spinner"/> : <WebhookIcon name="refresh"/>}{m.checkOperation}</button>
  </div>;
};
