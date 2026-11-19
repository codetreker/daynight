import { nonzeroCanonicalId } from "./validation.js";

// The service accepts this declaration only as the exact canonical lowercase
// spelling of a nonzero UUID, the same rule assistant-task commands apply.
export const BOT_ID_HEADER = "X-Daynight-Bot-Id";

export const botIdentity = (value: string): string => nonzeroCanonicalId(value);

export const botIdentityHeaders = (botId: string | undefined): Record<string, string> => botId === undefined ? {} : { [BOT_ID_HEADER]: botId };
